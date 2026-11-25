import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: "custom",
});
let unavailableReason;
let activeControls;
let cabinAirSnapshot;
let openingState;
let chargingOptions;
let commandLimits;
let chargingStatusText;
let chargingTimeText;
let readingText;
let refreshOutcome;
try {
  ({
    unavailableReason,
    activeControls,
    cabinAirSnapshot,
    openingState,
    chargingOptions,
    commandLimits,
    chargingStatusText,
    chargingTimeText,
    readingText,
    refreshOutcome,
  } = await server.ssrLoadModule("/src/native/client.ts"));
} finally {
  await server.close();
}

const sharedVehicle = {
  vin: "12345678901234567",
  model: "Polestar 2",
  modelYear: null,
  owner: false,
  platform: "ICUP",
  capabilities: { supportsParkingClimatization: true },
  limits: {},
};

test("charging duration uses reported time to full even when target time is absent", () => {
  const sample = (minutesToFull, status = "success") => ({
    readings: { battery: { status, value: { minutesToFull, minutesToTarget: null } } },
  });
  assert.equal(chargingTimeText(sample(360)), "6 小时");
  assert.equal(chargingTimeText(sample(78)), "1 小时 18 分钟");
  assert.equal(chargingTimeText(sample(45)), "45 分钟");
  assert.equal(chargingTimeText(sample(0)), "0 分钟");
  for (const value of [null, undefined, -1, 4294967295, Infinity, "360"]) {
    assert.equal(chargingTimeText(sample(value)), null);
  }
  assert.equal(chargingTimeText(sample(360, "failed")), null);
  assert.equal(chargingTimeText(undefined), null);
});

test("refresh completion distinguishes complete, partial, failed and absent readings", () => {
  const success = { status: "success", value: { percent: 0 }, reportedAt: 100, observedAt: 200 };
  const failed = { status: "failed", value: { percent: 80 }, error: "offline", reportedAt: 90, observedAt: 200 };
  const snapshot = readings => ({ vehicle: sharedVehicle, fetchedAt: 200, readings });
  assert.equal(refreshOutcome(snapshot({ battery: success })), "success");
  assert.equal(refreshOutcome(snapshot({ battery: success, climate: failed })), "partial");
  assert.equal(refreshOutcome(snapshot({ battery: failed })), "error");
  assert.equal(refreshOutcome(snapshot({ battery: { ...success, value: null } })), "error");
  assert.equal(refreshOutcome(snapshot({})), "error");
  assert.equal(refreshOutcome(undefined), "error");
  assert.equal(success.reportedAt, 100);
});

test("cabin air uses the current vehicle's reported measurement, including zero", () => {
  const sample = (vin, measuredAt, fields, status = "success") => ({
    vehicle: { vin },
    readings: { airQuality: { status, value: { measuredAt, ...fields }, observedAt: 1000 } },
  });
  const current = sample("A", 30, { pm25: 0 });
  const previous = sample("A", 20, { aqi: 12 });
  const missing = sample("A", 40, { state: 2 });
  const failed = sample("A", 50, { pm25: 9 }, "failed");
  const other = sample("B", 60, { pm25: 8 });
  assert.equal(cabinAirSnapshot("A", current, [previous]), current);
  assert.equal(cabinAirSnapshot("A", missing, [previous, failed, other, sample("A", 10, { pm25: 5 })]), previous);
  assert.equal(cabinAirSnapshot("A", failed, [other, missing]), undefined);
});

test("charging selectors match Hisingen presets and slider increments", () => {
  const target = chargingOptions(sharedVehicle, "target", null);
  assert.deepEqual(target.presets, [40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(
    target.values,
    Array.from({ length: 13 }, (_, index) => 40 + index * 5),
  );
  const current = chargingOptions(sharedVehicle, "amperage", null);
  assert.deepEqual(current.presets, [6, 8, 10, 13, 16, 20, 24, 32]);
  assert.deepEqual(
    current.values,
    Array.from({ length: 27 }, (_, index) => 6 + index),
  );
  assert.equal(commandLimits(sharedVehicle, "target").step, 1);
});

test("charging selectors preserve reported values and unusual bounds", () => {
  const vehicle = {
    ...sharedVehicle,
    limits: {
      targetChargeLevelPercentageMinLimit: 43,
      chargeAmperageMinLimit: 7,
      chargeAmperageMaxLimit: 15,
    },
  };
  const target = chargingOptions(vehicle, "target", 83);
  assert.deepEqual(target.presets, [43, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(
    target.values,
    [43, 45, 50, 55, 60, 65, 70, 75, 80, 83, 85, 90, 95, 100],
  );
  assert.deepEqual(
    chargingOptions(vehicle, "amperage", 12).presets,
    [7, 8, 10, 13, 15],
  );
  assert.deepEqual(
    chargingOptions(vehicle, "amperage", 12).values,
    [7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  for (const current of [NaN, Infinity, 101, 39, 80.5])
    assert.equal(
      chargingOptions(vehicle, "target", current).values.includes(current),
      false,
    );
});

test("charging selectors handle fixed and malformed capability ranges", () => {
  assert.deepEqual(
    chargingOptions(
      {
        ...sharedVehicle,
        limits: {
          chargeAmperageMinLimit: 16,
          chargeAmperageMaxLimit: 16,
        },
      },
      "amperage",
      null,
    ),
    { values: [16], presets: [16] },
  );
  for (const min of [NaN, Infinity, 0, -1, 101, 43.5]) {
    assert.deepEqual(
      chargingOptions(
        {
          ...sharedVehicle,
          limits: {
            targetChargeLevelPercentageMinLimit: min,
          },
        },
        "target",
        null,
      ),
      { values: [], presets: [] },
    );
  }
  assert.deepEqual(
    chargingOptions(
      {
        ...sharedVehicle,
        limits: {
          chargeAmperageMinLimit: 32,
          chargeAmperageMaxLimit: 6,
        },
      },
      "amperage",
      null,
    ),
    { values: [], presets: [] },
  );
});

test("climate controls follow capability for shared, owner and unknown roles", () => {
  for (const owner of [false, true, null]) {
    for (const action of ["climateStart", "climateStop"]) {
      assert.equal(unavailableReason({ ...sharedVehicle, owner }, action), null);
      for (const flag of [false, null, undefined]) {
        const vehicle = {
          ...sharedVehicle,
          owner,
          capabilities: { supportsParkingClimatization: flag },
        };
        assert.equal(
          unavailableReason(vehicle, action),
          flag === false ? "车辆未开放此功能" : "服务尚未提供能力信息",
        );
      }
    }
  }
});

test("shared accounts still require a connected, supported platform", () => {
  assert.equal(unavailableReason(undefined, "climateStart"), "尚未连接车辆");
  for (const platform of ["HUANFU", "Geely", null]) {
    assert.equal(
      unavailableReason({ ...sharedVehicle, platform }, "climateStart"),
      "该平台适配待完成",
    );
  }
});

test("shared account charging and schedules retain their capability gates", () => {
  const vehicle = {
    ...sharedVehicle,
    capabilities: {
      supportsTargetChargeLevelSetting: true,
      supportsParkingClimatizationRepeatedWeekdayTimers: true,
    },
  };
  assert.equal(unavailableReason(vehicle, "target"), "车辆未确认开放充电控制");
  vehicle.capabilities.supportsChargingFunctions = true;
  assert.equal(unavailableReason(vehicle, "target"), null);
  assert.equal(unavailableReason(vehicle, "climateTimer"), null);
  assert.equal(unavailableReason(vehicle, "deleteClimateTimer"), null);
  assert.equal(unavailableReason(vehicle, "unlock"), "服务尚未提供能力信息");
});

test("orange control states require successful vehicle readings", () => {
  const inactive = { climate: false, unlocked: false, cleaning: false };
  const readings = {
    climate: { status: "success", value: { activity: "active" } },
    exterior: { status: "success", value: { locked: false } },
    airQuality: { status: "success", value: { state: 1 } },
  };
  assert.deepEqual(activeControls({ readings }), {
    climate: true,
    unlocked: true,
    cleaning: true,
  });
  assert.deepEqual(activeControls(undefined), inactive);
  assert.deepEqual(activeControls({ readings: {} }), inactive);
  for (const reading of Object.values(readings)) reading.status = "failed";
  assert.deepEqual(activeControls({ readings }), inactive);
  for (const reading of Object.values(readings)) {
    reading.status = "success";
    reading.value = null;
  }
  assert.deepEqual(activeControls({ readings }), inactive);
});

test("orange control states clear after stopping or locking", () => {
  for (const activity of ["idle", "starting", "unknown"]) {
    for (const state of [2, 3, 0]) {
      assert.deepEqual(
        activeControls({
          readings: {
            climate: { status: "success", value: { activity } },
            exterior: { status: "success", value: { locked: true } },
            airQuality: { status: "success", value: { state } },
          },
        }),
        { climate: false, unlocked: false, cleaning: false },
      );
    }
  }
});

test("opening actions follow reported state and retain unknown values", () => {
  const parts = ["frontLeftWindow", "frontRightWindow", "rearLeftWindow", "rearRightWindow"];
  const snapshot = { readings: { exterior: {
    status: "success", value: { openings: Object.fromEntries(parts.map(part => [part, 2])) },
  } } };
  assert.equal(openingState(snapshot, parts), "closed");
  snapshot.readings.exterior.value.openings.frontLeftWindow = 1;
  assert.equal(openingState(snapshot, parts), "open");
  snapshot.readings.exterior.value.openings.frontLeftWindow = 3;
  assert.equal(openingState(snapshot, parts), "open");
  snapshot.readings.exterior.value.openings.frontLeftWindow = null;
  assert.equal(openingState(snapshot, parts), "unknown");
  snapshot.readings.exterior.value.openings.tailgate = 2;
  assert.equal(openingState(snapshot, ["tailgate"]), "closed");
  snapshot.readings.exterior.status = "failed";
  assert.equal(openingState(snapshot, ["tailgate"]), "unknown");
  assert.equal(openingState(undefined, parts), "unknown");
  assert.equal(openingState(snapshot, []), "unknown");
});

test("P4 identifies implemented SDK actions, account capability denials and unsupported controls", () => {
  const car = { ...sharedVehicle, platform: "HUANFU", capabilities: {
    norrGeelyReadOnly: true,
    "geely.remote_control_lock_2": true,
    "geely.remote_control_unlock_2": false,
    supportsParkingClimatization: true,
  } };
  assert.equal(unavailableReason(car, "lock"), "官方 App 有此操作，Norr 尚未接入");
  assert.equal(unavailableReason(car, "unlock"), "车辆未开放此功能");
  for (const action of ["climateStart", "unlockTrunk", "windowsClose", "windowsOpen", "flash", "honk", "cleanStart", "target", "deleteClimateTimer"]) {
    assert.equal(unavailableReason(car, action), "官方 App 有此操作，Norr 尚未接入");
  }
  assert.match(unavailableReason(car, "tailgateOpen"), /未实现电动开关尾门/);
  assert.match(unavailableReason(car, "amperage"), /未实现电流上限/);
  assert.match(unavailableReason(car, "otaInstall"), /尚未找到/);
});

test("P4 enables only xchanger controls with current capability evidence", () => {
  const car = { ...sharedVehicle, platform: "HUANFU", capabilities: {
    norrXchanger: true,
    "geely.remote_climate_control_2": true,
    "geely.remote_charge_2": true,
  } };
  for (const action of ["climateStart", "climateStop", "target"]) {
    assert.equal(unavailableReason(car, action), null);
    const flag = action === "target" ? "geely.remote_charge_2" : "geely.remote_climate_control_2";
    assert.match(unavailableReason({ ...car, capabilities: { ...car.capabilities, [flag]: false } }, action), /未开放/);
    assert.match(unavailableReason({ ...car, capabilities: { ...car.capabilities, [flag]: null } }, action), /尚未提供能力信息/);
    assert.match(unavailableReason({ ...car, capabilities: { ...car.capabilities, norrXchanger: false } }, action), /适配待完成/);
  }
  for (const action of ["lock", "unlock", "windowsOpen", "cleanStart"]) {
    assert.match(unavailableReason(car, action), /能力或对应车况未确认/);
  }
  assert.deepEqual(commandLimits(car, "climateStart"), { min: 16, max: 28, step: 1 });
  assert.deepEqual(commandLimits(car, "target"), { min: 40, max: 100, step: 1 });
});

test("expanded P4 controls use backend availability without bypassing denials or unknowns", () => {
  const car = { ...sharedVehicle, platform: "HUANFU", capabilities: { norrXchanger: true } };
  const actions = ["climateStart", "climateStop", "target", "steeringWheelHeat", "driverSeatHeat", "passengerSeatHeat", "driverSeatVent", "passengerSeatVent", "lock", "unlock", "unlockTrunk", "windowsOpen", "windowsClose", "windowsVent", "flash", "honkFlash", "honk", "cleanStart", "cleanStop", "chargeLidOpen", "chargeLidClose"];
  for (const action of actions) {
    for (const owner of [false, true, null]) {
      for (const enabled of [true, false, null]) {
        const vehicle = { ...car, owner, capabilities: { ...car.capabilities, [`norrP4.${action}`]: enabled } };
        const reason = unavailableReason(vehicle, action);
        if (enabled === null) assert.match(reason, /权限|能力或对应车况未确认/);
        else assert.equal(reason, enabled ? null : "车辆未开放此功能");
      }
    }
  }
  for (const action of ["driverSeatHeat", "passengerSeatHeat", "driverSeatVent", "passengerSeatVent"]) {
    assert.deepEqual(commandLimits(car, action), { min: 0, max: 3, step: 1 });
  }
  assert.deepEqual(commandLimits(car, "steeringWheelHeat"), { min: 0, max: 1, step: 1 });
  assert.match(unavailableReason({ ...car, capabilities: { ...car.capabilities, "norrP4.chargeLidOpen": null,
    "geely.remote_control_open": true } }, "chargeLidOpen"), /尚未取得充电口盖位置/);
  assert.match(unavailableReason(car, "tailgateOpen"), /未实现电动开关尾门/);
});


test("P4 keeps charging state and plug detection distinct on both energy cards", () => {
  const label = (chargeState, plugged, marker = "norrGeelyReadOnly") => chargingStatusText({
    vehicle: { capabilities: marker ? { [marker]: true } : {} },
    readings: { battery: { status: "success", value: { chargeState, plugged } } },
  });
  for (const marker of ["norrGeelyReadOnly", "norrXchanger"]) {
    assert.equal(label(null, false, marker), "未插枪");
    assert.equal(label(null, true, marker), "已插枪");
    assert.equal(label(null, null, marker), "充电状态未知");
    assert.equal(label(3, true, marker), "等待预约");
    assert.equal(label(9, true, marker), "充电准备中");
    assert.equal(readingText({ vehicle: { capabilities: { [marker]: true } }, readings: {} }, "software"), "此项数据待接入");
  }
  assert.equal(label(null, false, false), "充电状态未知");
});
