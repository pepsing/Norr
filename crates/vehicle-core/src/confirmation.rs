use crate::models::{Command, Receipt, Schedule, Snapshot};
use serde_json::{json, Value};

pub const CONFIRMED: &str = "回读一致";
pub const CLIMATE_ACTIVE: &str = "空调已启动，设定温度待核对";
pub const WINDOWS_AJAR: &str = "车窗已留缝，开度待核对";

pub fn unresolved_xchanger<'a>(
    receipts: &'a [Receipt],
    command: &Command,
    account: &str,
    now: u64,
) -> Option<&'a Receipt> {
    let group = command_group(&command.action)?;
    receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.account_scope.as_deref() == Some(account)
                && receipt.command.vin == command.vin
                && command_group(&receipt.command.action) == Some(group)
                && receipt.status != "rejected"
        })
        .filter(|receipt| {
            receipt.readback.as_deref() != Some(CONFIRMED)
                && !(command.action == "climateStop"
                    && receipt.readback.as_deref() == Some(CLIMATE_ACTIVE))
                && !(command.action == "windowsClose"
                    && receipt.readback.as_deref() == Some(WINDOWS_AJAR))
                && now.saturating_sub(receipt.time) < if group == "find" { 60_000 } else { 600_000 }
        })
}

pub fn command_group(action: &str) -> Option<&'static str> {
    match action {
        "steeringWheelHeat" => Some("steeringWheelHeat"),
        "driverSeatHeat" | "driverSeatVent" => Some("driverSeat"),
        "passengerSeatHeat" | "passengerSeatVent" => Some("passengerSeat"),
        "lock" | "unlock" => Some("lock"),
        "windowsOpen" | "windowsClose" | "windowsVent" => Some("windows"),
        "chargeLidOpen" | "chargeLidClose" => Some("chargeLid"),
        "unlockTrunk" | "tailgateOpen" | "tailgateClose" => Some("tailgate"),
        "flash" | "honk" | "honkFlash" => Some("find"),
        _ => endpoint(action),
    }
}

pub fn endpoint(action: &str) -> Option<&'static str> {
    match action {
        "lock" | "unlock" | "tailgateOpen" | "tailgateClose" | "unlockTrunk" | "windowsOpen"
        | "windowsClose" | "windowsVent" | "chargeLidOpen" | "chargeLidClose" => Some("exterior"),
        "climateStart" | "climateStop" | "steeringWheelHeat" | "driverSeatHeat"
        | "passengerSeatHeat" | "driverSeatVent" | "passengerSeatVent" => Some("climate"),
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
    let p4_control = snapshot
        .vehicle
        .platform
        .as_deref()
        .is_some_and(|platform| platform.eq_ignore_ascii_case("HUANFU"));
    let result = if reading.status != "success" {
        "回读失败，等待核对"
    } else if p4_control
        && (reading
            .value
            .as_ref()
            .is_some_and(|value| value["freshnessPending"] == true)
            || reading.reported_at.is_none_or(|time| {
                time <= receipt.time || time > reading.observed_at || time > snapshot.fetched_at
            }))
    {
        let value = reading.value.as_ref();
        match receipt.command.action.as_str() {
            "unlock" if value.is_some_and(|v| v["locked"] == false) => {
                "最近车况显示已解锁，本次操作待确认"
            }
            "lock" if value.is_some_and(|v| v["locked"] == true) => {
                "最近车况显示已锁定，本次操作待确认"
            }
            "climateStart" if value.is_some_and(|v| v["activity"] == "active") => {
                "最近车况显示空调运行中，本次操作待确认"
            }
            "climateStop" if value.is_some_and(|v| v["activity"] == "idle") => {
                "最近车况显示空调已停止，本次操作待确认"
            }
            _ => "等待操作后的车辆上报",
        }
    } else if p4_control
        && matches!(receipt.command.action.as_str(), "lock" | "unlock")
        && reading
            .value
            .as_ref()
            .and_then(|v| v["locked"].as_bool())
            .is_none()
    {
        "未取得门锁状态，等待核对"
    } else if p4_control
        && endpoint == "target"
        && reading
            .value
            .as_ref()
            .and_then(|v| v["percent"].as_f64())
            .is_none()
    {
        "未取得车辆充电上限，等待核对"
    } else if p4_control
        && matches!(
            receipt.command.action.as_str(),
            "climateStart" | "climateStop"
        )
        && !matches!(
            reading.value.as_ref().and_then(|v| v["activity"].as_str()),
            Some("active" | "idle" | "starting")
        )
    {
        "未取得驻车空调状态，等待核对"
    } else if p4_control && missing_control_value(&receipt.command, reading.value.as_ref()) {
        "未取得对应功能的车辆状态，等待核对"
    } else if !direct && reading.reported_at.is_none_or(|time| time < receipt.time) {
        "车辆数据早于指令，等待新状态"
    } else if p4_control
        && receipt.command.action == "climateStart"
        && receipt.command.value.is_some()
        && reading.value.as_ref().is_some_and(|value| {
            value["activity"] == "active" && value["targetTemperature"].as_f64().is_none()
        })
    {
        CLIMATE_ACTIVE
    } else if p4_control
        && receipt.command.action == "windowsVent"
        && reading
            .value
            .as_ref()
            .is_some_and(|value| matches_target(receipt, value))
    {
        WINDOWS_AJAR
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

fn missing_control_value(command: &Command, value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    match command.action.as_str() {
        "steeringWheelHeat" => value["steeringWheelHeatActive"].as_bool().is_none(),
        "driverSeatHeat" | "passengerSeatHeat" | "driverSeatVent" | "passengerSeatVent" => value
            [format!("{}Level", command.action)]
        .as_u64()
        .is_none_or(|v| v > 3),
        "unlockTrunk" => value["trunkLocked"].as_bool().is_none(),
        "chargeLidOpen" | "chargeLidClose" => {
            !matches!(value["openings"]["chargeLid"].as_u64(), Some(1 | 2))
        }
        "windowsOpen" | "windowsClose" | "windowsVent" => [
            "frontLeftWindow",
            "frontRightWindow",
            "rearLeftWindow",
            "rearRightWindow",
        ]
        .iter()
        .any(|part| !matches!(value["openings"][part].as_u64(), Some(1..=3))),
        "cleanStart" | "cleanStop" => !matches!(value["state"].as_u64(), Some(1 | 2)),
        _ => false,
    }
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
        "unlockTrunk" => value["trunkLocked"] == false,
        "steeringWheelHeat" => command
            .value
            .is_some_and(|v| value["steeringWheelHeatActive"].as_bool() == Some(v == 1.0)),
        "driverSeatHeat" | "passengerSeatHeat" | "driverSeatVent" | "passengerSeatVent" => {
            command.value.is_some()
                && value[format!("{}Level", command.action)].as_f64() == command.value
        }
        "chargeLidOpen" => value["openings"]["chargeLid"] == 1,
        "chargeLidClose" => value["openings"]["chargeLid"] == 2,
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
        "windowsOpen" | "windowsClose" | "windowsVent" => [
            "frontLeftWindow",
            "frontRightWindow",
            "rearLeftWindow",
            "rearRightWindow",
        ]
        .iter()
        .all(|window| {
            value["openings"][window]
                == json!(match command.action.as_str() {
                    "windowsOpen" => 1,
                    "windowsVent" => 3,
                    _ => 2,
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
    fn p4_partial_temperature_readback_allows_stopping_but_not_duplicate_start() {
        let mut receipt: Receipt = serde_json::from_value(json!({
            "id":"fixture","time":1000,"status":"accepted","message":"","accountScope":"account-a",
            "command":{"vin":"TEST","action":"climateStart","value":22}
        }))
        .unwrap();
        let mut snapshot: Snapshot = serde_json::from_value(json!({
            "vehicle":{"vin":"TEST","model":"P4","platform":"HUANFU","capabilities":{"norrXchanger":true},"limits":{}},
            "fetchedAt":2000,"readings":{"climate":{"status":"success","observedAt":2000,"reportedAt":1000,"value":{"activity":"active"}}}
        })).unwrap();
        update(&mut receipt, &snapshot);
        assert_ne!(receipt.readback.as_deref(), Some(CLIMATE_ACTIVE));
        snapshot.readings.get_mut("climate").unwrap().reported_at = Some(1500);
        snapshot
            .readings
            .get_mut("climate")
            .unwrap()
            .value
            .as_mut()
            .unwrap()["freshnessPending"] = json!(true);
        update(&mut receipt, &snapshot);
        assert_eq!(
            receipt.readback.as_deref(),
            Some("最近车况显示空调运行中，本次操作待确认")
        );
        snapshot
            .readings
            .get_mut("climate")
            .unwrap()
            .value
            .as_mut()
            .unwrap()["freshnessPending"] = json!(false);
        update(&mut receipt, &snapshot);
        assert_eq!(receipt.readback.as_deref(), Some(CLIMATE_ACTIVE));
        let stop = Command {
            vin: "TEST".into(),
            action: "climateStop".into(),
            ..Default::default()
        };
        assert!(unresolved_xchanger(&[receipt.clone()], &stop, "account-a", 2500).is_none());
        assert!(
            unresolved_xchanger(&[receipt.clone()], &receipt.command, "account-a", 2500).is_some()
        );
        assert!(
            unresolved_xchanger(&[receipt.clone()], &receipt.command, "account-b", 2500).is_none()
        );
        assert!(
            unresolved_xchanger(&[receipt.clone()], &receipt.command, "account-a", 601_000)
                .is_none()
        );
        snapshot
            .readings
            .get_mut("climate")
            .unwrap()
            .value
            .as_mut()
            .unwrap()["targetTemperature"] = json!(22);
        update(&mut receipt, &snapshot);
        assert_eq!(receipt.readback.as_deref(), Some(CONFIRMED));
        assert!(
            unresolved_xchanger(&[receipt.clone()], &receipt.command, "account-a", 2500).is_none()
        );
    }

    #[test]
    fn p4_unresolved_charge_target_is_scoped_by_account_vehicle_and_endpoint() {
        let receipt: Receipt = serde_json::from_value(json!({
            "id":"fixture","time":1000,"status":"unknown","message":"timeout","accountScope":"account-a",
            "command":{"vin":"TEST","action":"target","value":90}
        })).unwrap();
        let mut next = Command {
            vin: "TEST".into(),
            action: "target".into(),
            value: Some(100.0),
            ..Default::default()
        };
        assert!(
            unresolved_xchanger(std::slice::from_ref(&receipt), &next, "account-a", 2500).is_some()
        );
        next.vin = "OTHER".into();
        assert!(
            unresolved_xchanger(std::slice::from_ref(&receipt), &next, "account-a", 2500).is_none()
        );
        next.vin = "TEST".into();
        next.action = "climateStop".into();
        assert!(
            unresolved_xchanger(std::slice::from_ref(&receipt), &next, "account-a", 2500).is_none()
        );
        let mut rejected = receipt.clone();
        rejected.status = "rejected".into();
        assert!(unresolved_xchanger(&[rejected], &receipt.command, "account-a", 2500).is_none());
    }
    #[test]
    fn p4_reference_and_unknown_activity_cannot_establish_a_mismatch() {
        for (action, endpoint, data, expected) in [
            (
                "target",
                "target",
                json!({"referencePercent":90}),
                "未取得车辆充电上限，等待核对",
            ),
            (
                "climateStop",
                "climate",
                json!({"activity":"unknown"}),
                "未取得驻车空调状态，等待核对",
            ),
        ] {
            let mut receipt = serde_json::from_value(
                json!({"id":"fixture","time":1000,"status":"accepted","message":"",
                "command":{"vin":"TEST","action":action,"value":90}}),
            )
            .unwrap();
            let snapshot = serde_json::from_value(json!({
                "vehicle":{"vin":"TEST","model":"P4","platform":"HUANFU","capabilities":{},"limits":{}},
                "fetchedAt":2000,"readings":{(endpoint):{"status":"success","observedAt":2000,"reportedAt":1500,"value":data}}
            })).unwrap();
            update(&mut receipt, &snapshot);
            assert_eq!(receipt.readback.as_deref(), Some(expected));
        }
    }

    #[test]
    fn cached_p4_state_then_a_fresh_report_for_the_same_command() {
        for (action, field, value, pending) in [
            (
                "unlock",
                "exterior",
                json!({"locked":false}),
                "最近车况显示已解锁，本次操作待确认",
            ),
            (
                "climateStart",
                "climate",
                json!({"activity":"active"}),
                "最近车况显示空调运行中，本次操作待确认",
            ),
        ] {
            let mut receipt: Receipt = serde_json::from_value(json!({"id":"fixture","time":1000,
                "status":"accepted","message":"P4 服务已受理","command":{"vin":"TEST","action":action}})).unwrap();
            let mut snapshot: Snapshot = serde_json::from_value(json!({
                "vehicle":{"vin":"TEST","model":"P4","platform":"HUANFU","capabilities":{},"limits":{}},
                "fetchedAt":2000,"readings":{(field):{"status":"success","observedAt":2000,"reportedAt":990,"value":value}}
            })).unwrap();
            update(&mut receipt, &snapshot);
            assert_eq!(receipt.readback.as_deref(), Some(pending));
            let reading = snapshot.readings.get_mut(field).unwrap();
            reading.reported_at = Some(1500);
            reading.value.as_mut().unwrap()["freshnessPending"] = json!(true);
            update(&mut receipt, &snapshot);
            assert_eq!(receipt.readback.as_deref(), Some(pending));
            snapshot
                .readings
                .get_mut(field)
                .unwrap()
                .value
                .as_mut()
                .unwrap()["freshnessPending"] = json!(false);
            update(&mut receipt, &snapshot);
            assert_eq!(receipt.readback.as_deref(), Some(CONFIRMED));
        }
    }

    #[test]
    fn p4_lock_climate_and_charge_target_require_a_new_matching_vehicle_report() {
        for (action, field, value, parameter) in [
            ("lock", "exterior", json!({"locked":true}), None),
            ("unlock", "exterior", json!({"locked":false}), None),
            ("climateStop", "climate", json!({"activity":"idle"}), None),
            (
                "climateStart",
                "climate",
                json!({"activity":"active"}),
                None,
            ),
            ("target", "target", json!({"percent":90}), Some(90.0)),
            (
                "steeringWheelHeat",
                "climate",
                json!({"steeringWheelHeatActive":true}),
                Some(1.0),
            ),
            (
                "steeringWheelHeat",
                "climate",
                json!({"steeringWheelHeatActive":false}),
                Some(0.0),
            ),
            (
                "driverSeatHeat",
                "climate",
                json!({"driverSeatHeatLevel":3}),
                Some(3.0),
            ),
            (
                "passengerSeatHeat",
                "climate",
                json!({"passengerSeatHeatLevel":0}),
                Some(0.0),
            ),
            (
                "driverSeatVent",
                "climate",
                json!({"driverSeatVentLevel":2}),
                Some(2.0),
            ),
            (
                "passengerSeatVent",
                "climate",
                json!({"passengerSeatVentLevel":0}),
                Some(0.0),
            ),
            (
                "unlockTrunk",
                "exterior",
                json!({"trunkLocked":false}),
                None,
            ),
            (
                "chargeLidOpen",
                "exterior",
                json!({"openings":{"chargeLid":1}}),
                None,
            ),
            (
                "chargeLidClose",
                "exterior",
                json!({"openings":{"chargeLid":2}}),
                None,
            ),
            (
                "windowsVent",
                "exterior",
                json!({"openings":{"frontLeftWindow":3,"frontRightWindow":3,"rearLeftWindow":3,"rearRightWindow":3}}),
                None,
            ),
            ("cleanStart", "airQuality", json!({"state":1}), None),
            ("cleanStop", "airQuality", json!({"state":2}), None),
        ] {
            let initial: Receipt = serde_json::from_value(json!({
                "id":"fixture", "time":1000, "status":"accepted", "message":"",
                "command":{"vin":"TEST","action":action,"value":parameter}
            }))
            .unwrap();
            for (platform, reported, expected) in [
                ("HUANFU", None, false),
                ("HUANFU", Some(999), false),
                ("HUANFU", Some(1000), false),
                ("HUANFU", Some(1001), true),
                ("HUANFU", Some(2001), false),
                ("ICUP", None, field == "target"),
            ] {
                let snapshot = serde_json::from_value(json!({
                    "vehicle":{"vin":"TEST","model":"Polestar","platform":platform,"capabilities":{},"limits":{}},
                    "fetchedAt":2000, "readings":{(field):{
                        "status":"success","value":value,"observedAt":2000,"reportedAt":reported
                    }}
                })).unwrap();
                let mut receipt = initial.clone();
                update(&mut receipt, &snapshot);
                assert_eq!(
                    receipt.readback.as_deref()
                        == Some(if action == "windowsVent" && platform == "HUANFU" {
                            WINDOWS_AJAR
                        } else {
                            CONFIRMED
                        }),
                    expected,
                    "{action} on {platform}, reported at {reported:?}"
                );
            }
        }
    }

    #[test]
    fn independent_cabin_operations_do_not_supersede_each_other_and_find_has_no_readback() {
        let receipt: Receipt = serde_json::from_value(json!({
            "id":"fixture","time":1000,"status":"unknown","message":"","accountScope":"account",
            "command":{"vin":"TEST","action":"driverSeatHeat","value":3}
        }))
        .unwrap();
        for (action, blocked) in [
            ("driverSeatVent", true),
            ("driverSeatHeat", true),
            ("passengerSeatHeat", false),
            ("steeringWheelHeat", false),
            ("climateStop", false),
        ] {
            let command = Command {
                action: action.into(),
                ..receipt.command.clone()
            };
            assert_eq!(
                unresolved_xchanger(std::slice::from_ref(&receipt), &command, "account", 2000)
                    .is_some(),
                blocked
            );
        }
        for action in ["flash", "honk", "honkFlash"] {
            let mut find = receipt.clone();
            find.command.action = action.into();
            assert_eq!(endpoint(action), None);
            assert!(unresolved_xchanger(
                std::slice::from_ref(&find),
                &find.command,
                "account",
                60_999
            )
            .is_some());
            assert!(unresolved_xchanger(
                std::slice::from_ref(&find),
                &find.command,
                "account",
                61_000
            )
            .is_none());
        }
        let mut vent = receipt;
        vent.command.action = "windowsVent".into();
        vent.command.value = None;
        vent.readback = Some(WINDOWS_AJAR.into());
        let close = Command {
            action: "windowsClose".into(),
            ..vent.command.clone()
        };
        assert!(
            unresolved_xchanger(std::slice::from_ref(&vent), &close, "account", 2000).is_none()
        );
        assert!(
            unresolved_xchanger(std::slice::from_ref(&vent), &vent.command, "account", 2000)
                .is_some()
        );
    }

    #[test]
    fn missing_fields_and_pending_reports_cannot_confirm_new_p4_controls() {
        for action in [
            "steeringWheelHeat",
            "driverSeatHeat",
            "passengerSeatHeat",
            "driverSeatVent",
            "passengerSeatVent",
            "unlockTrunk",
            "windowsVent",
            "chargeLidOpen",
            "cleanStart",
        ] {
            let mut receipt: Receipt = serde_json::from_value(json!({
                "id":"fixture","time":1000,"status":"accepted","message":"",
                "command":{"vin":"TEST","action":action,"value":0}
            }))
            .unwrap();
            let mut snapshot: Snapshot = serde_json::from_value(json!({
                "vehicle":{"vin":"TEST","model":"P4","platform":"HUANFU","capabilities":{},"limits":{}},
                "fetchedAt":2000,"readings":{(endpoint(action).unwrap()):{"status":"success","observedAt":2000,"reportedAt":1500,"value":{}}}
            })).unwrap();
            update(&mut receipt, &snapshot);
            assert_eq!(
                receipt.readback.as_deref(),
                Some("未取得对应功能的车辆状态，等待核对"),
                "{action}"
            );
            snapshot
                .readings
                .get_mut(endpoint(action).unwrap())
                .unwrap()
                .value
                .as_mut()
                .unwrap()["freshnessPending"] = json!(true);
            update(&mut receipt, &snapshot);
            assert_eq!(receipt.readback.as_deref(), Some("等待操作后的车辆上报"));
        }
    }

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
            account_scope: None,
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
            account_scope: None,
        };
        assert!(!matches_target(&receipt, &json!({})));
        assert!(!matches_target(&receipt, &json!({"timers":[{"id":"old"}]})));
        assert!(matches_target(&receipt, &json!({"timers":[]})));
    }
}
