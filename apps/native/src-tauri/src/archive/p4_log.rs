use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TestAction {
    ClimateCreate,
    ClimateEdit,
    ClimateDelete,
    ChargeOnce,
    ChargeRepeat,
    ChargeOverride,
    ChargeResume,
    Lock,
    Unlock,
    UnlockTrunk,
    TailgateOpen,
    TailgateClose,
    WindowsOpen,
    WindowsClose,
    Flash,
    HonkFlash,
    Honk,
    ClimateStart,
    ClimateStop,
    ClimateTemperature,
    DriverSeatHeat,
    PassengerSeatHeat,
    DriverSeatVent,
    PassengerSeatVent,
    SteeringWheelHeat,
    CleanStart,
    CleanStop,
    Target,
    Amperage,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    AppAccepted,
    Before,
    Observed,
    Error,
    Missing,
    Unknown,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationSource {
    OfficialApp,
    Vehicle,
}
