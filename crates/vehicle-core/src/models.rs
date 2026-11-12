use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub vin: String,
    pub model: String,
    pub model_year: Option<String>,
    pub owner: Option<bool>,
    pub platform: Option<String>,
    pub capabilities: BTreeMap<String, Option<bool>>,
    pub limits: BTreeMap<String, f64>,
    #[serde(default)]
    pub installed_version: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub status: String,
    pub value: Option<Value>,
    pub observed_at: u64,
    pub reported_at: Option<u64>,
    pub error: Option<String>,
}

impl Reading {
    pub fn success(value: Value, reported_at: Option<u64>) -> Self {
        Self {
            status: "success".into(),
            value: Some(value),
            observed_at: crate::now_ms(),
            reported_at,
            error: None,
        }
    }
    pub fn failure(error: String) -> Self {
        Self {
            status: "failed".into(),
            value: None,
            observed_at: crate::now_ms(),
            reported_at: None,
            error: Some(error),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub vehicle: Vehicle,
    pub fetched_at: u64,
    pub readings: BTreeMap<String, Reading>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub vin: String,
    pub action: String,
    pub value: Option<f64>,
    pub schedule: Option<Schedule>,
    pub timer_id: Option<String>,
    pub timezone_offset: Option<i32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: Option<String>,
    pub index: Option<u64>,
    pub start: u32,
    pub end: Option<u32>,
    pub weekdays: Vec<u64>,
    pub active: bool,
    pub repeats: Option<bool>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub command: Command,
    pub time: u64,
    pub status: String,
    pub message: String,
    pub readback_at: Option<u64>,
    pub readback: Option<String>,
    #[serde(default)]
    pub baseline_timer_ids: Option<Vec<String>>,
}
