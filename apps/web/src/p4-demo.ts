export function isChinaP4(vehicle?: { model: string; region: string }) {
  return vehicle?.model === "Polestar 4" && vehicle.region === "中国区";
}

export const p4DemoEquipment = {
  targetTemperatureMode: "temperature" as "temperature" | "Lo" | "Hi",
  driverSeatHeat: 0, passengerSeatHeat: 0,
  driverSeatVent: 0, passengerSeatVent: 0, steeringWheelHeat: false,
  chargeLidOpen: false, trunkLocked: true,
};

export const p4DemoAir = 5;
export const p4DemoTrip = { km: 28.1, kwhPer100Km: 20.3 };

export function p4SetpointLabel(vehicle: { targetTemperature: number; targetTemperatureMode?: string }, temperature: (c: number) => string) {
  return vehicle.targetTemperatureMode === "Lo" || vehicle.targetTemperatureMode === "Hi"
    ? vehicle.targetTemperatureMode : temperature(vehicle.targetTemperature);
}

export const p4DemoTyres = [
  { kpa: 290, temperatureC: 18 }, { kpa: 290, temperatureC: 18 },
  { kpa: 290, temperatureC: 19 }, { kpa: 290, temperatureC: 19 },
];
