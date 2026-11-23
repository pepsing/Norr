import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
let VehicleDetails;
let SchedulePanel;
try {
  ({ VehicleDetails } = await server.ssrLoadModule("/src/native/VehicleDetails.tsx"));
  ({ SchedulePanel } = await server.ssrLoadModule("/src/native/SchedulePanel.tsx"));
} finally {
  await server.close();
}

function renderDetails(model, includeMap = true, capabilities, tyres = [
  { wheel: "frontLeft", kpa: 250, referenceKpa: 260, warning: 3 },
]) {
  return renderToStaticMarkup(createElement(VehicleDetails, {
    snapshot: {
      vehicle: { vin: "TEST-VEHICLE", model, capabilities },
      readings: {
        odometer: { status: "success", observedAt: 0, value: { km: 12345 } },
        health: {
          status: "success",
          observedAt: 0,
          value: {
            daysToService: 36,
            tyres,
          },
        },
      },
    },
    includeMap,
    onError: () => {},
  }));
}

test("Polestar 2 details hide tyre values and warnings while retaining service and trip readings", () => {
  for (const model of ["Polestar 2", "Polestar 2 Long range", "POLESTAR 2"]) {
    const html = renderDetails(model);
    assert.doesNotMatch(html, /实测压力|参考压力|左前轮|偏低/);
    assert.match(html, /36 天/);
    assert.match(html, /行程读数/);
    assert.match(html, /总里程/);
    assert.match(html, /12,345 km/);
  }
});

test("other or unidentified models retain returned tyre details", () => {
  for (const model of ["Polestar 4", "Polestar 20", undefined]) {
    const html = renderDetails(model);
    assert.match(html, /左前轮/);
    assert.match(html, /250 kPa/);
    assert.match(html, /260 kPa/);
    assert.match(html, /偏低/);
  }
});

test("mobile details can omit the map while the default desktop view retains it", () => {
  assert.doesNotMatch(renderDetails("Polestar 2", false), /车辆位置/);
  assert.match(renderDetails("Polestar 2"), /车辆位置/);
});

test("P4 rounds each pressure to whole kPa and keeps missing values and warnings distinct", () => {
  const html = renderDetails("Polestar 4", true, { norrGeelyReadOnly: true }, [
    { wheel: "frontLeft", kpa: 285.584, sourceWarning: 0, temperatureC: 18 }, { wheel: "frontRight", kpa: 280.092, sourceWarning: 3, temperatureC: 0 },
    { wheel: "rearLeft", kpa: 278.5 }, { wheel: "rearRight", sourceWarning: 0 },
  ]);
  const readings = html.replace(/<[^>]+>/g, " ");
  for (const wheel of [/左前轮\s+286\s+kPa\s+18 °C · 正常/, /右前轮\s+280\s+kPa\s+0 °C · 状态待核实/,
    /左后轮\s+279\s+kPa\s+未返回 · 状态待核实/, /右后轮\s+未返回\s+未返回 · 正常/]) {
    assert.match(readings, wheel);
  }
  assert.match(html, /车辆详情分类/);
  assert.match(html, /位置/);
  assert.doesNotMatch(html, /参考压力|偏低/);
});

test("P4 reservations distinguish an empty vehicle list from failure, and render existing starts read-only", () => {
  const vehicle = { capabilities: { norrGeelyReadOnly: true }, limits: {} };
  const render = (reading) => renderToStaticMarkup(createElement(SchedulePanel, {
    kind: "charging", vehicle, snapshot: { vehicle, readings: { p4Reservations: reading } },
    disabled: false, onCommand: () => { throw Error("unexpected command"); },
  }));
  const empty = render({ status: "success", observedAt: 0, value: { entries: [] } });
  assert.match(empty, /暂无充电预约/);
  const failed = render({ status: "failed", error: "读取失败" });
  assert.match(failed, /读取失败/);
  assert.doesNotMatch(failed, /暂无充电预约/);
  assert.doesNotMatch(render({ status: "failed", error: "读取失败", value: { entries: [] } }), /暂无充电预约/);
  const planned = render({ status: "success", observedAt: 0, value: { entries: [{start: "23:30"}] } });
  assert.match(planned, /23:30/);
  assert.doesNotMatch(planned, /<button|<input/);
});
