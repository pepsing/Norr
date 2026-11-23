use crate::{
    models::{Reading, Snapshot},
    now_ms, Result,
};
use serde_json::{json, Value};

pub fn charge_target(result: Result<Value>) -> Reading {
    let data = match result {
        Ok(data) => data,
        Err(error) => return Reading::failure(error),
    };
    // The target-setting endpoint reports tenths of a percent. The battery-status
    // endpoint also calls its field "soc", but reports the current charge in percent.
    let raw = data["soc"]
        .as_str()
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| data["soc"].as_f64());
    let Some(tenths) = raw.filter(|n| (0.0..=1000.0).contains(n) && n.fract() == 0.0) else {
        return Reading::failure("P4 未返回有效的目标电量".into());
    };
    Reading::success(
        json!({"percent":tenths / 10.0}),
        report_time(&data["socTime"]),
    )
}

pub fn recording_sample(snapshot: &Snapshot) -> Value {
    let mut sample = json!({"collectedAt": snapshot.fetched_at});
    sample["controls"] = json!(snapshot
        .vehicle
        .capabilities
        .iter()
        .filter(|(key, _)| key
            .strip_prefix("norrP4.")
            .and_then(crate::confirmation::command_group)
            .is_some())
        .collect::<std::collections::BTreeMap<_, _>>());
    for (kind, reading) in &snapshot.readings {
        let data = reading
            .value
            .as_ref()
            .filter(|_| reading.status == "success")
            .unwrap_or(&Value::Null);
        let mut item = match kind.as_str() {
            "battery" => {
                json!({"percent": data["percent"].as_f64().filter(|n| (0.0..=100.0).contains(n))})
            }
            "exterior" => {
                let openings = [
                    "frontLeftWindow",
                    "frontRightWindow",
                    "rearLeftWindow",
                    "rearRightWindow",
                    "tailgate",
                    "chargeLid",
                ]
                .into_iter()
                .map(|key| {
                    (
                        key,
                        data["openings"][key]
                            .as_u64()
                            .filter(|v| (1..=3).contains(v)),
                    )
                })
                .collect::<std::collections::BTreeMap<_, _>>();
                json!({"locked": data["locked"].as_bool(), "trunkLocked":data["trunkLocked"].as_bool(),"openings":openings})
            }
            "climate" => json!({
                "activity": data["activity"].as_str().filter(|s| matches!(*s, "active" | "idle" | "starting" | "unknown")),
                "interiorTemperature": data["interiorTemperature"].as_f64(),
                "exteriorTemperature": data["exteriorTemperature"].as_f64(),
                "steeringWheelHeatActive":data["steeringWheelHeatActive"].as_bool(),
                "driverSeatHeatLevel":data["driverSeatHeatLevel"].as_u64().filter(|v| *v <= 3),
                "passengerSeatHeatLevel":data["passengerSeatHeatLevel"].as_u64().filter(|v| *v <= 3),
                "driverSeatVentLevel":data["driverSeatVentLevel"].as_u64().filter(|v| *v <= 3),
                "passengerSeatVentLevel":data["passengerSeatVentLevel"].as_u64().filter(|v| *v <= 3)
            }),
            "airQuality" => {
                json!({"state":data["state"].as_u64().filter(|v| matches!(v, 1|2)),"pm25":data["pm25"].as_f64()})
            }
            "target" => {
                json!({
                    "percent": data["percent"].as_f64().filter(|n| (0.0..=100.0).contains(n)),
                    "referencePercent": data["referencePercent"].as_u64().filter(|n| *n <= 100)
                })
            }
            "odometer" => json!({"km": data["km"].as_f64()}),
            "health" => {
                let mut pressures = serde_json::Map::new();
                if let Some(tyres) = data["tyres"].as_array() {
                    for item in tyres {
                        if let Some(wheel) = item["wheel"].as_str().filter(|s| {
                            matches!(*s, "frontLeft" | "frontRight" | "rearLeft" | "rearRight")
                        }) {
                            pressures.insert(
                                wheel.into(),
                                json!(item["kpa"].as_f64().filter(|n| *n > 0.0)),
                            );
                        }
                    }
                }
                json!({"kpa": pressures})
            }
            "software" => {
                json!({"version":data["version"].as_str().filter(|s| !s.is_empty() && s.len() <= 24 && s.split('.').all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))) })
            }
            _ => continue,
        };
        item["status"] = json!(match reading.status.as_str() {
            "success" => "success",
            "failed" => "failed",
            _ => "unavailable",
        });
        item["observedAt"] = json!(reading.observed_at);
        item["reportedAt"] = json!(reading.reported_at);
        item["freshnessPending"] = json!(data["freshnessPending"].as_bool());
        sample[kind] = item;
    }
    sample
}

fn report_time(value: &Value) -> Option<u64> {
    let raw = value.as_u64().or_else(|| value.as_str()?.parse().ok())?;
    let millis = match raw {
        1_000_000_000..=9_999_999_999 => raw * 1000,
        1_000_000_000_000..=9_999_999_999_999 => raw,
        _ => return None,
    };
    (millis <= now_ms()).then_some(millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_exports_only_selected_vehicle_readings_and_preserves_missing_clocks() {
        let snapshot = serde_json::from_value(json!({
            "vehicle":{"vin":"PRIVATE","model":"Polestar 4","platform":"HUANFU","capabilities":{},"limits":{}},
            "fetchedAt":5500,"readings":{
                "battery":{"status":"success","observedAt":5100,"reportedAt":4100,"value":{"percent":42,"other":"PRIVATE"}},
                "climate":{"status":"failed","observedAt":5200,"error":"PRIVATE","value":{"activity":"idle"}},
                "target":{"status":"success","observedAt":5300,"value":{"referencePercent":90}},
                "location":{"status":"success","observedAt":5400,"value":{"coordinates":"PRIVATE"}}
            }
        })).unwrap();
        let sample = recording_sample(&snapshot);
        assert!(!sample.to_string().contains("PRIVATE"));
        assert_eq!(sample["battery"]["percent"], 42.0);
        assert_eq!(sample["target"]["referencePercent"], 90);
        assert!(sample["target"]["reportedAt"].is_null());
        assert_eq!(sample["battery"]["reportedAt"], 4100);
        assert_eq!(sample["climate"]["status"], "failed");
        assert!(sample["climate"]["activity"].is_null());
    }

    #[test]
    fn recording_preserves_vehicle_target_and_outside_temperature() {
        let mut snapshot: Snapshot = serde_json::from_value(json!({
            "vehicle":{"vin":"TEST","model":"Polestar 4","capabilities":{},"limits":{}},
            "fetchedAt":5500,"readings":{
                "climate":{"status":"success","observedAt":5200,"value":{"exteriorTemperature":0}}
            }
        }))
        .unwrap();
        snapshot.readings.insert(
            "target".into(),
            charge_target(Ok(json!({"soc":"905","socTime":"1700000000"}))),
        );
        let sample = recording_sample(&snapshot);
        assert_eq!(sample["target"]["percent"], 90.5);
        assert!(sample["target"]["referencePercent"].is_null());
        assert_eq!(sample["target"]["reportedAt"], 1_700_000_000_000u64);
        assert_eq!(sample["climate"]["exteriorTemperature"], 0.0);
    }

    #[test]
    fn charge_settings_keep_the_target_and_its_own_report_time() {
        for (soc, expected) in [
            (json!("1000"), 100.0),
            (json!(900), 90.0),
            (json!("100"), 10.0),
        ] {
            let reading = charge_target(Ok(json!({"soc":soc, "socTime":"1700000000"})));
            assert_eq!(reading.value.unwrap()["percent"], expected);
            assert_eq!(reading.reported_at, Some(1_700_000_000_000));
        }
        for time in [Value::Null, json!("invalid"), json!(9_000_000_000_000u64)] {
            let reading = charge_target(Ok(json!({"soc":"905","socTime":time})));
            assert_eq!(reading.value.unwrap()["percent"], 90.5);
            assert_eq!(reading.reported_at, None);
        }
        assert_eq!(
            report_time(&json!(1_700_000_000_123u64)),
            Some(1_700_000_000_123)
        );
        for soc in [
            Value::Null,
            json!(-1),
            json!(1001),
            json!(955.5),
            json!("NaN"),
        ] {
            assert_eq!(charge_target(Ok(json!({"soc":soc}))).status, "failed");
        }
        assert_eq!(charge_target(Err("offline".into())).status, "failed");
    }
}
