import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  base: "./",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
let widgetData;
let defaultAppearance;
try {
  ({ widgetData } = await server.ssrLoadModule("/src/native/widgets.ts"));
  ({ defaultAppearance } = await server.ssrLoadModule("/src/vehicle-catalog.ts"));
} finally {
  await server.close();
}

const vehicle = { vin: "TEST-VEHICLE", model: "Polestar 2" };

test("widgets preserve zero readings and use the oldest reported data time", () => {
  const data = widgetData({ vehicle, readings: {
    battery: { status: "success", observedAt: 9000, reportedAt: 3000, value: { percent: 0, rangeKm: 0, chargeState: 8 } },
    exterior: { status: "success", observedAt: 8000, reportedAt: 2000, value: { locked: false } },
    climate: { status: "success", observedAt: 7000, value: { activity: "idle" } },
  } }, defaultAppearance());
  assert.equal(data.batteryPercent, 0);
  assert.equal(data.rangeKm, 0);
  assert.equal(data.locked, false);
  assert.equal(data.charging, 8);
  assert.equal(data.updatedAt, 2000);
  assert.match(data.artwork, /^images\/vehicles\/.+-side\.jpg$/);
});

test("failed and missing readings stay unknown even when a cached value exists", () => {
  const data = widgetData({ vehicle, readings: {
    battery: { status: "error", observedAt: 9000, value: { percent: 80, rangeKm: 400 } },
    exterior: { status: "error", observedAt: 9000, value: { locked: true } },
  } }, defaultAppearance());
  assert.equal(data.batteryPercent, null);
  assert.equal(data.rangeKm, null);
  assert.equal(data.locked, null);
  assert.equal(data.climate, "unknown");
  assert.equal(data.updatedAt, null);
});

test("non-finite numeric data cannot become a widget readout", () => {
  const data = widgetData({ vehicle, readings: {
    battery: { status: "success", value: { percent: NaN, rangeKm: Infinity } },
  } }, defaultAppearance("polestar-4"));
  assert.equal(data.batteryPercent, null);
  assert.equal(data.rangeKm, null);
  assert.match(data.artwork, /polestar-4/);
});
