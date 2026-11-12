export type PreviewScenario = "connected" | "offline" | "error" | "empty";

export interface Vehicle {
  model: string;
  variant: string;
  battery: number;
  range: number;
  chargeLimit: number;
  charging: boolean;
  locked: boolean;
  climateOn: boolean;
  targetTemperature: number;
  cabinTemperature: number;
  outsideTemperature: number;
  odometer: number;
  updatedAt: number;
}

export const initialVehicle: Vehicle = {
  model: "Polestar 2",
  variant: "Long range Dual motor",
  battery: 78,
  range: 356,
  chargeLimit: 90,
  charging: true,
  locked: true,
  climateOn: false,
  targetTemperature: 21,
  cabinTemperature: 23,
  outsideTemperature: 18,
  odometer: 12846,
  updatedAt: Date.now(),
};
