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
let vehicleMapLinks;
let VehicleMap;
try {
  ({ vehicleMapLinks } = await server.ssrLoadModule("/src/native/mapLinks.ts"));
  ({ VehicleMap } = await server.ssrLoadModule("/src/native/VehicleMap.tsx"));
} finally {
  await server.close();
}

const longitude = 116.397128;
const latitude = 39.916527;

test("AMap embed and jump use the same coordinate without an extra conversion", () => {
  const links = vehicleMapLinks(longitude, latitude, "gcj02", "wgs84");
  const embed = new URL(links.embed);
  const jump = new URL(links.amap);
  assert.equal(embed.searchParams.get("lng"), "116.397128");
  assert.equal(embed.searchParams.get("lat"), "39.916527");
  assert.equal(jump.searchParams.get("position"), "116.397128,39.916527");
  assert.equal(jump.searchParams.get("coordinate"), "gaode");
  assert.equal(links.google, "https://www.google.com/maps/search/?api=1&query=39.916527,116.397128");
  assert.equal(links.apple, "https://maps.apple.com/?ll=39.91512325075406,116.39088350597522&q=Polestar");
});

test("GPS option converts once for AMap and preserves the Google URL", () => {
  for (const externalSystem of ["wgs84", "gcj02"]) {
    const direct = vehicleMapLinks(longitude, latitude, "gcj02", externalSystem);
    const converted = vehicleMapLinks(longitude, latitude, "wgs84", externalSystem);
    const embed = new URL(converted.embed);
    const position = new URL(converted.amap).searchParams.get("position").split(",").map(Number);
    assert.equal(embed.searchParams.get("lng"), "116.403372");
    assert.equal(embed.searchParams.get("lat"), "39.917931");
    assert.equal(position[0].toFixed(6), embed.searchParams.get("lng"));
    assert.equal(position[1].toFixed(6), embed.searchParams.get("lat"));
    assert.equal(converted.google, direct.google);
    assert.equal(converted.apple, "https://maps.apple.com/?ll=39.916527,116.397128&q=Polestar");
  }
});

test("Apple converts GCJ-02 independently of the legacy Google coordinate preference", () => {
  for (const externalSystem of ["wgs84", "gcj02"]) {
    const links = vehicleMapLinks(longitude, latitude, "gcj02", externalSystem);
    const apple = new URL(links.apple);
    const [lat, lon] = apple.searchParams.get("ll").split(",").map(Number);
    assert.ok(Math.abs(lat - 39.91512325075406) < 1e-9);
    assert.ok(Math.abs(lon - 116.39088350597522) < 1e-9);
    assert.equal(apple.searchParams.get("q"), "Polestar");
    assert.equal(new URL(links.amap).searchParams.get("position"), "116.397128,39.916527");
  }
  for (const system of ["wgs84", "gcj02"]) {
    const links = vehicleMapLinks(11.9746, 57.7089, system, "wgs84");
    assert.equal(links.apple, "https://maps.apple.com/?ll=57.7089,11.9746&q=Polestar");
  }
});

test("coordinates outside the conversion area pass through", () => {
  const links = vehicleMapLinks(11.9746, 57.7089, "wgs84", "wgs84");
  assert.equal(new URL(links.amap).searchParams.get("position"), "11.9746,57.7089");
});

test("vehicle map defaults and saved AMap settings are isolated per vehicle", () => {
  const saved = new Map([
    ["norr-coordinate-first", "wgs84"],
    ["norr-amap-coordinate-second", "wgs84"],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => saved.get(key) ?? null },
  });
  const render = (vin, value = { longitude, latitude }) => renderToStaticMarkup(
    createElement(VehicleMap, {
      snapshot: { vehicle: { vin }, readings: { location: { status: "success", value } } },
      onError: () => {},
    }),
  );
  try {
    assert.match(render("first"), /lng=116\.397128&amp;lat=39\.916527/);
    assert.match(render("second"), /lng=116\.403372&amp;lat=39\.917931/);
    assert.match(render("first"), /lng=116\.397128&amp;lat=39\.916527/);
    assert.doesNotMatch(render("first", { longitude: null, latitude: null }), /<iframe/);
    assert.doesNotMatch(render("first", { longitude: 181, latitude: 91 }), /<iframe/);
    saved.set("norr-amap-coordinate-first", "invalid");
    assert.match(render("first"), /lng=116\.397128&amp;lat=39\.916527/);
    globalThis.localStorage.getItem = () => { throw new Error("Storage unavailable"); };
    assert.match(render("first"), /lng=116\.397128&amp;lat=39\.916527/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});


test("P4 displays trusted GPS locally and keeps legacy or unknown coordinate systems out of the map", () => {
  const render = (coordinateSystem) => renderToStaticMarkup(createElement(VehicleMap, {
    snapshot: { vehicle: { vin: "P4TEST", capabilities: { norrGeelyReadOnly: true } },
      readings: { location: { status: "success", value: { longitude, latitude, coordinateSystem }, reportedAt: 1700000000000 } } },
    onError: () => {},
  }));
  assert.match(render("wgs84"), /显示高德地图/);
  assert.match(render("wgs84"), /车辆上报/);
  assert.doesNotMatch(render("wgs84"), /<iframe|<select/);
  for (const system of ["gcj02", undefined]) assert.doesNotMatch(render(system), /显示高德地图|<iframe/);
});

test("P4 loads a remembered map only for the selected VIN with valid GPS", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: key => key === "norr-amap-auto-consented" ? "true" : null },
  });
  const render = (vin, coordinateSystem) => renderToStaticMarkup(createElement(VehicleMap, {
    snapshot: { vehicle: { vin, capabilities: { norrGeelyReadOnly: true } },
      readings: { location: { status: "success", value: { longitude, latitude, coordinateSystem } } } },
    onError: () => {},
  }));
  try {
    assert.match(render("consented", "wgs84"), /<iframe/);
    assert.doesNotMatch(render("another", "wgs84"), /<iframe/);
    assert.doesNotMatch(render("consented", "gcj02"), /<iframe/);
    assert.match(render("consented", "gcj02"), /type="checkbox"/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
