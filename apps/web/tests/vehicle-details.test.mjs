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
try {
  ({ VehicleDetails } = await server.ssrLoadModule("/src/native/VehicleDetails.tsx"));
} finally {
  await server.close();
}

function renderDetails(model, includeMap = true) {
  return renderToStaticMarkup(createElement(VehicleDetails, {
    snapshot: {
      vehicle: { vin: "TEST-VEHICLE", model },
      readings: {
        odometer: { status: "success", observedAt: 0, value: { km: 12345 } },
        health: {
          status: "success",
          observedAt: 0,
          value: {
            daysToService: 36,
            tyres: [{ wheel: "frontLeft", kpa: 250, referenceKpa: 260, warning: 3 }],
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
