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
let openingState;
try {
  ({ unavailableReason, activeControls, openingState } = await server.ssrLoadModule(
    "/src/native/client.ts",
  ));
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
