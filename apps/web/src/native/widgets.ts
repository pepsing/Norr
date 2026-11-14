import type { Snapshot } from "./client";
import { artworkPath } from "../vehicle-catalog";
import type { VehicleAppearance } from "../vehicle-catalog";

export interface WidgetTarget {
  vin: string;
  action: "vehicle" | "lock" | "climate" | "refresh";
}

export function widgetData(snapshot: Snapshot, appearance: VehicleAppearance) {
  const reading = (endpoint: string) => {
    const entry = snapshot.readings[endpoint];
    return entry?.status === "success" ? entry : undefined;
  };
  const battery = reading("battery");
  const exterior = reading("exterior");
  const climate = reading("climate");
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const times = [battery, exterior, climate]
    .map((entry) => entry?.reportedAt ?? entry?.observedAt)
    .filter((time): time is number => typeof time === "number" && time > 0);
  return {
    vin: snapshot.vehicle.vin,
    model: snapshot.vehicle.model,
    batteryPercent: number(battery?.value?.percent),
    rangeKm: number(battery?.value?.rangeKm),
    locked:
      typeof exterior?.value?.locked === "boolean" ? exterior.value.locked : null,
    climate: String(climate?.value?.activity ?? "unknown"),
    charging: number(battery?.value?.chargeState),
    updatedAt: times.length ? Math.min(...times) : null,
    artwork: artworkPath(appearance).replace(/^\.?\//, ""),
  };
}
