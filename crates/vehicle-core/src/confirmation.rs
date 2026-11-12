use crate::models::{Receipt, Schedule, Snapshot};
use serde_json::{json, Value};

pub const CONFIRMED: &str = "回读一致";

pub fn endpoint(action: &str) -> Option<&'static str> {
    match action {
        "lock" | "unlock" | "tailgateOpen" | "tailgateClose" | "windowsOpen" | "windowsClose" => {
            Some("exterior")
        }
        "climateStart" | "climateStop" => Some("climate"),
        "target" => Some("target"),
        "amperage" => Some("amperage"),
        "climateTimer" | "deleteClimateTimer" => Some("climateTimers"),
        "chargeTimer" => Some("chargeTimer"),
        "cleanStart" | "cleanStop" => Some("airQuality"),
        "chargeStart" => Some("battery"),
        _ => None,
    }
}

pub fn update(receipt: &mut Receipt, snapshot: &Snapshot) {
    if receipt.command.vin != snapshot.vehicle.vin
        || receipt.status == "rejected"
        || receipt.readback.as_deref() == Some(CONFIRMED)
        || snapshot.fetched_at <= receipt.time
        || snapshot.fetched_at.saturating_sub(receipt.time) > 600_000
    {
        return;
    }
    let Some(endpoint) = endpoint(&receipt.command.action) else {
        return;
    };
    let Some(reading) = snapshot.readings.get(endpoint) else {
        return;
    };
    if reading.observed_at <= receipt.time {
        return;
    }
    receipt.readback_at = Some(reading.observed_at);
    let direct = matches!(
        endpoint,
        "target" | "amperage" | "climateTimers" | "chargeTimer"
    );
    let result = if reading.status != "success" {
        "回读失败，等待核对"
    } else if !direct && reading.reported_at.is_none_or(|time| time < receipt.time) {
        "车辆数据早于指令，等待新状态"
    } else if reading
        .value
        .as_ref()
        .is_some_and(|value| matches_target(receipt, value))
    {
        CONFIRMED
    } else {
        "当前回读与目标不一致"
    };
    receipt.readback = Some(result.into());
}

fn same_schedule(actual: &Value, expected: &Schedule) -> bool {
    let Ok(actual) = serde_json::from_value::<Schedule>(actual.clone()) else {
        return false;
    };
    let mut actual_days = actual.weekdays;
    let mut expected_days = expected.weekdays.clone();
    actual_days.sort_unstable();
    expected_days.sort_unstable();
    actual.start == expected.start
        && actual.end == expected.end
        && actual.active == expected.active
        && actual.repeats == expected.repeats
        && actual_days == expected_days
}

fn matches_target(receipt: &Receipt, value: &Value) -> bool {
    let command = &receipt.command;
    match command.action.as_str() {
        "lock" => value["locked"] == true,
        "unlock" => value["locked"] == false,
        "climateStart" => {
            value["activity"] == "active"
                && command.value.is_none_or(|temperature| {
                    value["targetTemperature"].as_f64() == Some(temperature)
                })
        }
        "climateStop" => value["activity"] == "idle",
        "target" => command.value.is_some() && value["percent"].as_f64() == command.value,
        "amperage" => command.value.is_some() && value["amps"].as_f64() == command.value,
        "tailgateOpen" => value["openings"]["tailgate"] == 1,
        "tailgateClose" => value["openings"]["tailgate"] == 2,
        "windowsOpen" | "windowsClose" => [
            "frontLeftWindow",
            "frontRightWindow",
            "rearLeftWindow",
            "rearRightWindow",
        ]
        .iter()
        .all(|window| {
            value["openings"][window]
                == json!(if command.action == "windowsOpen" {
                    1
                } else {
                    2
                })
        }),
        "cleanStart" => value["state"] == 1,
        "cleanStop" => value["state"] == 2,
        "chargeStart" => value["chargeState"] == 1,
        "chargeTimer" => command
            .schedule
            .as_ref()
            .is_some_and(|schedule| same_schedule(&value["timer"], schedule)),
        "deleteClimateTimer" => command.timer_id.as_ref().is_some_and(|id| {
            receipt
                .baseline_timer_ids
                .as_ref()
                .is_some_and(|baseline| baseline.contains(id))
                && value["timers"].as_array().is_some_and(|timers| {
                    timers.iter().all(|timer| timer["id"].as_str() != Some(id))
                })
        }),
        "climateTimer" => command.schedule.as_ref().is_some_and(|schedule| {
            value["timers"].as_array().is_some_and(|timers| {
                timers.iter().any(|timer| {
                    let identity_matches = if let Some(id) = &schedule.id {
                        timer["id"].as_str() == Some(id)
                            && timer["index"].as_u64() == schedule.index
                    } else {
                        timer["id"].as_str().is_some_and(|id| {
                            receipt
                                .baseline_timer_ids
                                .as_ref()
                                .is_some_and(|baseline| !baseline.iter().any(|old| old == id))
                        })
                    };
                    identity_matches && same_schedule(timer, schedule)
                })
            })
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Command;
    #[test]
    fn creation_requires_a_new_id_and_every_requested_field() {
        let schedule = Schedule {
            id: None,
            index: None,
            start: 977,
            end: None,
            weekdays: vec![2, 5],
            active: true,
            repeats: Some(false),
        };
        let receipt = Receipt {
            id: "fixture".into(),
            time: 1,
            status: "accepted".into(),
            message: "fixture".into(),
            command: Command {
                action: "climateTimer".into(),
                schedule: Some(schedule.clone()),
                ..Default::default()
            },
            readback_at: None,
            readback: None,
            baseline_timer_ids: Some(vec!["old".into()]),
        };
        let mut actual = serde_json::to_value(schedule).unwrap();
        actual["id"] = json!("old");
        assert!(!matches_target(
            &receipt,
            &json!({"timers":[actual.clone()]})
        ));
        actual["id"] = json!("new");
        actual["repeats"] = json!(true);
        assert!(!matches_target(
            &receipt,
            &json!({"timers":[actual.clone()]})
        ));
        actual["repeats"] = json!(false);
        assert!(matches_target(&receipt, &json!({"timers":[actual]})));
    }
    #[test]
    fn malformed_or_partial_list_cannot_prove_deletion() {
        let receipt = Receipt {
            id: "fixture".into(),
            time: 1,
            status: "accepted".into(),
            message: "fixture".into(),
            command: Command {
                action: "deleteClimateTimer".into(),
                timer_id: Some("old".into()),
                ..Default::default()
            },
            readback_at: None,
            readback: None,
            baseline_timer_ids: Some(vec!["old".into()]),
        };
        assert!(!matches_target(&receipt, &json!({})));
        assert!(!matches_target(&receipt, &json!({"timers":[{"id":"old"}]})));
        assert!(matches_target(&receipt, &json!({"timers":[]})));
    }
}
