use crate::{models::Reading, now_ms, Result};
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
