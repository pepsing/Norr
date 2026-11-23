use super::{readings, Value};
use crate::models::{Command, Snapshot};

pub(super) const ACTIONS: &[&str] = &[
    "climateStart",
    "climateStop",
    "target",
    "steeringWheelHeat",
    "driverSeatHeat",
    "passengerSeatHeat",
    "driverSeatVent",
    "passengerSeatVent",
    "lock",
    "unlock",
    "unlockTrunk",
    "windowsOpen",
    "windowsClose",
    "windowsVent",
    "flash",
    "honkFlash",
    "honk",
    "cleanStart",
    "cleanStop",
    "chargeLidOpen",
    "chargeLidClose",
];

pub(super) fn capability(data: Option<&Value>, flag: &str) -> Option<bool> {
    let data = data?;
    if data
        .pointer("/serviceResult/operationResult")
        .is_some_and(|v| readings::num(v) != Some(0.0))
    {
        return None;
    }
    let mut matches = data["list"]
        .as_array()?
        .iter()
        .filter(|item| item["functionId"] == flag);
    let enabled = matches.next()?["valueEnable"].as_bool();
    if matches.next().is_some() {
        return None;
    }
    enabled
}

fn declared(data: Option<&Value>, flags: &[&str]) -> Option<bool> {
    for flag in flags {
        if data
            .and_then(|v| v["list"].as_array())
            .is_some_and(|list| list.iter().any(|v| v["functionId"] == *flag))
        {
            return capability(data, flag);
        }
    }
    None
}

fn both(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

pub(super) fn value<'a>(snapshot: &'a Snapshot, kind: &str) -> Option<&'a Value> {
    let reading = snapshot.readings.get(kind)?;
    (reading.status == "success")
        .then_some(reading.value.as_ref())
        .flatten()
}

pub(super) fn allowed(action: &str, data: Option<&Value>, snapshot: &Snapshot) -> Option<bool> {
    let climate = value(snapshot, "climate");
    let cabin = |flag: &str, field: &str| {
        let permission = both(
            capability(data, "remote_climate_control_2"),
            declared(data, &[flag, "remote_climate_control_2"]),
        );
        both(
            permission,
            climate.and_then(|v| (!v[field].is_null()).then_some(true)),
        )
    };
    match action {
        "climateStart" | "climateStop" => capability(data, "remote_climate_control_2"),
        "target" => capability(data, "remote_charge_2"),
        // RCE_2 subcommands additionally require the vehicle's corresponding hardware status.
        "steeringWheelHeat" => both(
            capability(data, "remote_climate_control_2"),
            climate
                .and_then(|v| v["steeringWheelHeatActive"].as_bool())
                .map(|_| true),
        ),
        "driverSeatHeat" => cabin("remote_seat_preheat_switch", "driverSeatHeatLevel"),
        "passengerSeatHeat" => cabin("remote_seat_preheat_switch", "passengerSeatHeatLevel"),
        "driverSeatVent" | "passengerSeatVent" => {
            let support = both(
                climate.and_then(|v| v["driverSeatVentSupported"].as_bool()),
                climate.and_then(|v| v["passengerSeatVentSupported"].as_bool()),
            );
            let field = if action == "driverSeatVent" {
                "driverSeatVentLevel"
            } else {
                "passengerSeatVentLevel"
            };
            both(cabin("remote_seat_ventilating_switch", field), support)
        }
        "lock" => declared(
            data,
            &[
                "remote_control_lock_2",
                "remote_control_lock",
                "door_lock_switch_control",
            ],
        ),
        "unlock" => declared(
            data,
            &[
                "remote_control_unlock_2",
                "remote_control_unlock",
                "door_lock_switch_control",
            ],
        ),
        "unlockTrunk" => declared(data, &["remote_trunk_unlock"]),
        "windowsOpen" => declared(data, &["remote_window_open", "remote_control_window"]),
        "windowsClose" => declared(data, &["remote_window_close", "remote_control_window"]),
        "windowsVent" => declared(data, &["remote_window_ventilate", "remote_control_window"]),
        "flash" | "honkFlash" | "honk" => capability(data, "honk_flash"),
        "cleanStart" | "cleanStop" => declared(
            data,
            &["remote_purification", "remote_open_PM2.5_purification"],
        ),
        "chargeLidOpen" => both(
            capability(data, "remote_control_open"),
            value(snapshot, "exterior")
                .and_then(|v| v["openings"]["chargeLid"].as_u64())
                .map(|_| true),
        ),
        "chargeLidClose" => both(
            capability(data, "remote_control_close"),
            value(snapshot, "exterior")
                .and_then(|v| v["openings"]["chargeLid"].as_u64())
                .map(|_| true),
        ),
        _ => None,
    }
}

pub(super) fn apply(snapshot: &mut Snapshot, data: Option<&Value>) {
    for action in ACTIONS {
        let permission = allowed(action, data, snapshot);
        snapshot
            .vehicle
            .capabilities
            .insert(format!("norrP4.{action}"), permission);
    }
}

pub(super) fn check_seat_mode(
    command: &Command,
    snapshot: &Snapshot,
    now: u64,
) -> crate::Result<()> {
    if command.value == Some(0.0) {
        return Ok(());
    }
    let (opposite, support) = match command.action.as_str() {
        "driverSeatHeat" => ("driverSeatVentLevel", Some("driverSeatVentSupported")),
        "passengerSeatHeat" => ("passengerSeatVentLevel", Some("passengerSeatVentSupported")),
        "driverSeatVent" => ("driverSeatHeatLevel", None),
        "passengerSeatVent" => ("passengerSeatHeatLevel", None),
        _ => return Ok(()),
    };
    let reading = snapshot.readings.get("climate").ok_or("请先刷新座椅状态")?;
    let fresh = reading
        .reported_at
        .is_some_and(|time| time <= now && now - time <= 600_000)
        && reading
            .value
            .as_ref()
            .is_some_and(|v| v["freshnessPending"] != true);
    if !fresh {
        return Err("座椅状态尚未更新，请刷新车辆后再操作".into());
    }
    let climate = value(snapshot, "climate").ok_or("请先刷新座椅状态")?;
    if support.is_some_and(|key| climate[key] == false) {
        return Ok(());
    }
    match climate[opposite].as_u64() {
        Some(0) => Ok(()),
        Some(1..=3) => Err("请先关闭该座椅正在运行的加热或通风，回读确认后再切换".into()),
        _ => Err("座椅加热或通风状态不完整，请刷新后再操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Snapshot {
        serde_json::from_value(json!({
            "vehicle":{"vin":"TEST","model":"P4","platform":"HUANFU","capabilities":{},"limits":{}},
            "fetchedAt":2000,"readings":{"climate":{"status":"success","observedAt":2000,"reportedAt":1500,
                "value":{"driverSeatHeatLevel":0,"passengerSeatHeatLevel":0,"driverSeatVentLevel":0,"passengerSeatVentLevel":0,
                    "driverSeatVentSupported":true,"passengerSeatVentSupported":true,"steeringWheelHeatActive":false}}}
        })).unwrap()
    }

    #[test]
    fn cabin_requires_climate_permission_and_returned_hardware_and_respects_specific_denials() {
        let mut caps =
            json!({"list":[{"functionId":"remote_climate_control_2","valueEnable":true}]});
        let car = snapshot();
        for action in &ACTIONS[3..8] {
            assert_eq!(allowed(action, Some(&caps), &car), Some(true), "{action}");
            assert_eq!(allowed(action, None, &car), None);
            let mut missing = car.clone();
            missing.readings.clear();
            assert_eq!(allowed(action, Some(&caps), &missing), None);
        }
        for (flag, actions) in [
            (
                "remote_seat_preheat_switch",
                ["driverSeatHeat", "passengerSeatHeat"],
            ),
            (
                "remote_seat_ventilating_switch",
                ["driverSeatVent", "passengerSeatVent"],
            ),
        ] {
            for enabled in [json!(false), Value::Null, json!("true")] {
                let mut specific = caps.clone();
                specific["list"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"functionId":flag,"valueEnable":enabled}));
                for action in actions {
                    assert_eq!(
                        allowed(action, Some(&specific), &car),
                        if enabled == false { Some(false) } else { None }
                    );
                }
            }
        }
        caps["list"][0]["valueEnable"] = json!(false);
        caps["list"]
            .as_array_mut()
            .unwrap()
            .push(json!({"functionId":"remote_seat_preheat_switch","valueEnable":true}));
        assert_eq!(allowed("driverSeatHeat", Some(&caps), &car), Some(false));
    }

    #[test]
    fn body_controls_require_write_capabilities_and_preserve_missing_or_false() {
        let car = snapshot();
        for (actions, flag) in [
            (vec!["lock"], "remote_control_lock_2"),
            (vec!["unlock"], "remote_control_unlock_2"),
            (vec!["unlockTrunk"], "remote_trunk_unlock"),
            (
                vec!["windowsOpen", "windowsClose", "windowsVent"],
                "remote_control_window",
            ),
            (vec!["flash", "honkFlash", "honk"], "honk_flash"),
            (vec!["cleanStart", "cleanStop"], "remote_purification"),
        ] {
            for action in actions {
                for enabled in [true, false] {
                    let caps = json!({"list":[{"functionId":flag,"valueEnable":enabled}]});
                    assert_eq!(allowed(action, Some(&caps), &car), Some(enabled));
                    let failed = json!({"serviceResult":{"operationResult":1},"list":caps["list"]});
                    assert_eq!(allowed(action, Some(&failed), &car), None);
                    let duplicate = json!({"list":[caps["list"][0], caps["list"][0]]});
                    assert_eq!(allowed(action, Some(&duplicate), &car), None);
                }
                assert_eq!(
                    allowed(
                        action,
                        Some(&json!({"list":[{"functionId":"remote_status","valueEnable":true}]})),
                        &car
                    ),
                    None
                );
            }
        }
        let caps = json!({"list":[{"functionId":"remote_control_window","valueEnable":true},{"functionId":"remote_window_open","valueEnable":false}]});
        assert_eq!(allowed("windowsOpen", Some(&caps), &car), Some(false));
        assert_eq!(allowed("windowsClose", Some(&caps), &car), Some(true));
    }

    #[test]
    fn seat_switching_requires_fresh_known_opposite_mode_but_stopping_is_always_allowed() {
        for (action, opposite, support) in [
            (
                "driverSeatHeat",
                "driverSeatVentLevel",
                Some("driverSeatVentSupported"),
            ),
            (
                "passengerSeatHeat",
                "passengerSeatVentLevel",
                Some("passengerSeatVentSupported"),
            ),
            ("driverSeatVent", "driverSeatHeatLevel", None),
            ("passengerSeatVent", "passengerSeatHeatLevel", None),
        ] {
            let mut command = Command {
                action: action.into(),
                value: Some(3.0),
                ..Default::default()
            };
            let mut car = snapshot();
            assert!(check_seat_mode(&command, &car, 2000).is_ok());
            for state in [json!(3), Value::Null] {
                car.readings
                    .get_mut("climate")
                    .unwrap()
                    .value
                    .as_mut()
                    .unwrap()[opposite] = state;
                assert!(check_seat_mode(&command, &car, 2000).is_err());
            }
            if let Some(field) = support {
                car.readings
                    .get_mut("climate")
                    .unwrap()
                    .value
                    .as_mut()
                    .unwrap()[field] = json!(false);
                assert!(check_seat_mode(&command, &car, 2000).is_ok());
            }
            car = snapshot();
            for reported in [None, Some(2001), Some(0)] {
                car.readings.get_mut("climate").unwrap().reported_at = reported;
                assert!(check_seat_mode(
                    &command,
                    &car,
                    if reported == Some(0) { 600_001 } else { 2000 }
                )
                .is_err());
            }
            command.value = Some(0.0);
            car.readings.clear();
            assert!(check_seat_mode(&command, &car, 2000).is_ok());
        }
    }

    #[test]
    fn ventilation_distinguishes_unsupported_hardware_and_missing_readings() {
        let caps = json!({"list":[{"functionId":"remote_climate_control_2","valueEnable":true}]});
        for state in [json!(false), Value::Null] {
            let mut car = snapshot();
            car.readings
                .get_mut("climate")
                .unwrap()
                .value
                .as_mut()
                .unwrap()["passengerSeatVentSupported"] = state.clone();
            apply(&mut car, Some(&caps));
            for action in ["driverSeatVent", "passengerSeatVent"] {
                assert_eq!(
                    car.vehicle.capabilities[&format!("norrP4.{action}")],
                    if state == false { Some(false) } else { None }
                );
            }
        }
    }
}
