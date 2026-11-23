use super::availability::capability;
use super::{
    availability, candidate, now_ms, readings, validate_vin, Api, Client, Method, Session, Value,
    VehicleRead,
};
use crate::{
    models::{Command, Snapshot, Vehicle},
    Result,
};
use serde_json::json;

const CLIMATE: &str = "remote_climate_control_2";
#[cfg(test)]
const TARGET: &str = "remote_charge_2";

pub struct PreparedControl {
    command: Command,
    grant: Value,
    account: String,
    prepared_at: u64,
}

pub fn validate_control(command: &Command) -> Result<()> {
    validate_vin(&command.vin)?;
    if command.schedule.is_some() || command.timer_id.is_some() || command.timezone_offset.is_some()
    {
        return Err("P4 即时控制不接受日程参数".into());
    }
    match command.action.as_str() {
        "climateStart" => {
            let value = command.value.unwrap_or(22.0);
            if !value.is_finite() || value.fract() != 0.0 || !(16.0..=28.0).contains(&value) {
                return Err("P4 空调温度须为 16 至 28 °C 的整数".into());
            }
        }
        "steeringWheelHeat" => validate_level(command.value, 1)?,
        "driverSeatHeat" | "passengerSeatHeat" | "driverSeatVent" | "passengerSeatVent" => {
            validate_level(command.value, 3)?
        }
        "climateStop" | "lock" | "unlock" | "unlockTrunk" | "windowsOpen" | "windowsClose"
        | "windowsVent" | "flash" | "honkFlash" | "honk" | "cleanStart" | "cleanStop"
        | "chargeLidOpen" | "chargeLidClose"
            if command.value.is_none() => {}
        "target" => {
            if command
                .value
                .is_none_or(|v| !v.is_finite() || v.fract() != 0.0 || !(40.0..=100.0).contains(&v))
            {
                return Err("P4 充电上限须为 40 至 100% 的整数".into());
            }
        }
        _ => return Err("此 P4 操作尚未接入".into()),
    }
    Ok(())
}

fn validate_level(value: Option<f64>, max: u8) -> Result<()> {
    if value
        .is_none_or(|v| !v.is_finite() || v.fract() != 0.0 || !(0.0..=f64::from(max)).contains(&v))
    {
        return Err(format!("P4 档位须为 0 至 {max} 的整数"));
    }
    Ok(())
}

pub(super) fn apply_capabilities(vehicle: &mut Vehicle, data: Option<&Value>) {
    vehicle
        .capabilities
        .retain(|key, _| !key.starts_with("geely.") && !key.starts_with("norrP4."));
    if let Some(list) = data.and_then(|data| data["list"].as_array()) {
        for item in list {
            if let Some(flag) = item["functionId"].as_str() {
                vehicle
                    .capabilities
                    .insert(format!("geely.{flag}"), capability(data, flag));
            }
        }
    }
    vehicle.capabilities.remove("norrGeelyReadOnly");
    vehicle
        .capabilities
        .insert("norrXchanger".into(), Some(true));
    vehicle.capabilities.insert(
        "supportsParkingClimatizationCompartmentTemperatureSettings".into(),
        capability(data, CLIMATE),
    );
    vehicle.limits.insert(
        "parkingClimatizationCompartmentTemperatureMinLimit".into(),
        16.0,
    );
    vehicle.limits.insert(
        "parkingClimatizationCompartmentTemperatureMaxLimit".into(),
        28.0,
    );
    vehicle
        .limits
        .insert("targetChargeLevelPercentageMinLimit".into(), 40.0);
}

fn authorize_control(
    car: &Vehicle,
    command: &Command,
    capabilities: &Value,
    snapshot: &Snapshot,
) -> Result<()> {
    validate_control(command)?;
    if !candidate(car) || car.vin != command.vin {
        return Err("P4 指令与当前账号车辆不一致".into());
    }
    match availability::allowed(&command.action, Some(capabilities), snapshot) {
        Some(true) => Ok(()),
        Some(false) => Err("车辆未开放此功能".into()),
        None => Err("P4 服务尚未提供此操作的能力信息，请刷新车辆后重试".into()),
    }
}

pub async fn prepare_control(
    http: &Client,
    session: &Session,
    car: &Vehicle,
    command: &Command,
) -> Result<PreparedControl> {
    validate_control(command)?;
    if car.vin != command.vin || !candidate(car) {
        return Err("P4 指令与当前账号车辆不一致".into());
    }
    let api = Api::new(http)?;
    let grant = api.grant(session, None).await?;
    let reader = VehicleRead {
        api: &api,
        session,
        grant,
        renewed: Default::default(),
    };
    let profile = reader.profile(&command.vin).await?;
    let capabilities = reader.capabilities(&command.vin, &profile).await?;
    let snapshot = reader.status_snapshot(car).await?;
    authorize_control(car, command, &capabilities, &snapshot)?;
    availability::check_seat_mode(command, &snapshot, now_ms())?;
    let grant = match reader.renewed.get() {
        Some(result) => result.clone()?,
        None => reader.grant,
    };
    Ok(PreparedControl {
        command: command.clone(),
        grant,
        account: session.account_scope(),
        prepared_at: now_ms(),
    })
}

fn check_prepared(prepared: &PreparedControl, account: &str, now: u64) -> Result<()> {
    if prepared.account != account {
        return Err("账号已变更，指令尚未发送".into());
    }
    if now.saturating_sub(prepared.prepared_at) >= 60_000 {
        return Err("P4 操作准备已过期，请重新确认".into());
    }
    Ok(())
}

pub async fn execute_control(
    http: &Client,
    session: &Session,
    prepared: PreparedControl,
) -> Result<(String, String)> {
    check_prepared(&prepared, &session.account_scope(), now_ms())?;
    send_control(&Api::new(http)?, &prepared.grant, &prepared.command).await
}

fn body(command: &Command, user_id: &str, time: u64) -> Result<Value> {
    validate_control(command)?;
    if user_id.is_empty() {
        return Err("P4 会话缺少车辆授权".into());
    }
    let target = command.action == "target";
    let level = command.value.unwrap_or(0.0) as u64;
    let (service, start, duration, params) = match command.action.as_str() {
        "target" => (
            "RCS",
            true,
            60,
            json!([
                {"key":"operation","value":"4"},
                {"key":"rcs.setting","value":"1"},
                {"key":"soc","value":((command.value.unwrap() as u64) * 10).to_string()}
            ]),
        ),
        "climateStart" => (
            "RCE_2",
            true,
            180,
            json!([
                {"key":"rce.conditioner","value":"1"},
                {"key":"rce.temp","value":(command.value.unwrap_or(22.0) as u64).to_string()}
            ]),
        ),
        "climateStop" => (
            "RCE_2",
            false,
            0,
            json!([{"key":"rce.conditioner","value":"1"}]),
        ),
        "steeringWheelHeat" => (
            "RCE_2",
            level != 0,
            60,
            json!([{"key":"rce.heat","value":"steering_wheel"}]),
        ),
        "driverSeatHeat" | "passengerSeatHeat" | "driverSeatVent" | "passengerSeatVent" => {
            let key = if command.action.ends_with("Heat") {
                "rce.heat"
            } else {
                "rce.ventilation"
            };
            let seat = if command.action.starts_with("driver") {
                "front-left"
            } else {
                "front-right"
            };
            (
                "RCE_2",
                level != 0,
                60,
                json!([{"key":key,"value":seat},{"key":"rce.level","value":level.to_string()}]),
            )
        }
        "lock" | "unlock" => (
            if command.action == "lock" {
                "RDL_2"
            } else {
                "RDU_2"
            },
            true,
            0,
            json!([{"key":"door","value":"all"}]),
        ),
        "unlockTrunk" => ("RDU_2", true, 0, json!([{"key":"target","value":"trunk"}])),
        "windowsOpen" | "windowsClose" => (
            "RWS_2",
            command.action == "windowsOpen",
            0,
            json!([{"key":"target","value":"window"}]),
        ),
        "windowsVent" => (
            "RWS_2",
            true,
            0,
            json!([{"key":"target","value":"window"},{"key":"pos","value":"15"}]),
        ),
        "chargeLidOpen" | "chargeLidClose" => (
            if command.action == "chargeLidOpen" {
                "RDO"
            } else {
                "RDC"
            },
            true,
            0,
            json!([{"key":"target","value":"front-charge-lid"}]),
        ),
        "cleanStart" | "cleanStop" => (
            "RCC_2",
            command.action == "cleanStart",
            0,
            json!([{"key":"rcc.ventilation","value":"cabin"}]),
        ),
        "flash" | "honkFlash" | "honk" => {
            let mode = match command.action.as_str() {
                "flash" => "light-flash",
                "honk" => "horn",
                _ => "horn-light-flash",
            };
            ("RHL", true, 0, json!([{"key":"rhl","value":mode}]))
        }
        _ => return Err("此 P4 操作尚未接入".into()),
    };
    let mut body = json!({
        "command":if start { "start" } else { "stop" }, "creator":"tc",
        "serviceId":service,
        "serviceParameters":params, "timestamp":time.to_string(), "userId":user_id,
        "operationScheduling":if target {
            json!({"scheduledTime":null,"interval":0,"occurs":0,"recurrentOperation":true,"duration":60})
        } else {
            json!({"duration":duration,"interval":0,"occurs":1,"recurrentOperation":false})
        }
    });
    if target {
        body["latest"] = json!(false);
    }
    Ok(body)
}

async fn send_control(api: &Api<'_>, grant: &Value, command: &Command) -> Result<(String, String)> {
    let payload = body(
        command,
        grant["userId"].as_str().ok_or("P4 会话缺少车辆授权")?,
        now_ms(),
    )?;
    // A lost write response can mean the vehicle already received it. Only read back; never replay.
    let (status, data) = api
        .raw_request(
            Method::PUT,
            "device-api",
            &format!("/remote-control/vehicle/telematics/{}", command.vin),
            &[],
            Some(payload),
            grant,
        )
        .await?;
    let mut receipt = outcome(status, &data);
    if matches!(command.action.as_str(), "flash" | "honkFlash" | "honk") && receipt.0 != "rejected"
    {
        receipt.1 = if receipt.0 == "accepted" {
            "P4 服务已受理，鸣笛或闪灯结果请现场核对"
        } else {
            "鸣笛或闪灯结果不明确，请现场核对，勿重复发送"
        }
        .into();
    }
    Ok(receipt)
}

fn outcome(http: u16, data: &Value) -> (String, String) {
    let rejected = || ("rejected".into(), "P4 服务拒绝了此操作".into());
    let unknown = || {
        (
            "unknown".into(),
            "P4 服务结果不明确，等待车辆回读，请勿重复发送".into(),
        )
    };
    if matches!(http, 400 | 401 | 403 | 404 | 422 | 429) {
        return rejected();
    }
    if !(200..300).contains(&http) || !data.is_object() {
        return unknown();
    }
    if !data["error"].is_null() || data["success"] == false || data["isSuccess"] == false {
        return rejected();
    }
    if let Some(code) = readings::num(&data["code"]) {
        if code != 1000.0 {
            return rejected();
        }
    } else {
        return unknown();
    }
    let result = &data["data"];
    if !result["error"].is_null() || result["success"] == false || result["isSuccess"] == false {
        return rejected();
    }
    if let Some(operation) = result
        .pointer("/serviceResult/operationResult")
        .or_else(|| result.pointer("/result/serviceResult/operationResult"))
    {
        if !matches!(readings::num(operation), Some(0.0 | 1.0)) {
            return unknown();
        }
    }
    ("accepted".into(), "P4 服务已受理，等待车辆回读".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::hmac;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    fn command(action: &str, value: Option<f64>) -> Command {
        Command {
            vin: "TEST1234567890123".into(),
            action: action.into(),
            value,
            ..Default::default()
        }
    }

    fn vehicle() -> Vehicle {
        serde_json::from_value(json!({"vin":"TEST1234567890123","model":"P4","platform":"HUANFU","owner":false,"capabilities":{},"limits":{}})).unwrap()
    }

    fn capabilities() -> Value {
        json!({"list":[{"functionId":CLIMATE,"valueEnable":true},{"functionId":TARGET,"valueEnable":true}]})
    }

    #[test]
    fn control_body_matches_verified_service_parameters() {
        let start = body(&command("climateStart", Some(23.0)), "fixture-user", 1000).unwrap();
        assert_eq!(
            start,
            json!({"command":"start","creator":"tc","serviceId":"RCE_2",
            "serviceParameters":[{"key":"rce.conditioner","value":"1"},{"key":"rce.temp","value":"23"}],
            "timestamp":"1000","userId":"fixture-user",
            "operationScheduling":{"duration":180,"interval":0,"occurs":1,"recurrentOperation":false}})
        );
        let stop = body(&command("climateStop", None), "fixture-user", 1000).unwrap();
        assert_eq!(stop["command"], "stop");
        assert_eq!(stop["operationScheduling"]["duration"], 0);
        let target = body(&command("target", Some(90.0)), "fixture-user", 1000).unwrap();
        assert_eq!(target["serviceId"], "RCS");
        assert_eq!(target["latest"], false);
        assert_eq!(
            target["serviceParameters"],
            json!([
            {"key":"operation","value":"4"},{"key":"rcs.setting","value":"1"},{"key":"soc","value":"900"}])
        );
        assert_eq!(
            target["operationScheduling"],
            json!({"scheduledTime":null,"interval":0,"occurs":0,"recurrentOperation":true,"duration":60})
        );
    }

    #[test]
    fn validates_actions_values_vehicle_scope_and_account_capabilities() {
        for action in [
            "tailgateOpen",
            "otaInstall",
            "amperage",
            "chargeStart",
            "chargeTimer",
        ] {
            assert!(validate_control(&command(action, None)).is_err());
        }
        for value in [f64::NAN, f64::INFINITY, 15.0, 28.5, 29.0] {
            assert!(validate_control(&command("climateStart", Some(value))).is_err());
        }
        for value in [None, Some(f64::NAN), Some(39.0), Some(90.5), Some(101.0)] {
            assert!(validate_control(&command("target", value)).is_err());
        }
        let mut invalid = command("climateStop", None);
        invalid.vin = "../other".into();
        assert!(validate_control(&invalid).is_err());
        let mut extra = command("climateStart", None);
        extra.timer_id = Some("fixture".into());
        assert!(validate_control(&extra).is_err());
        let car = vehicle();
        let snapshot = Snapshot {
            vehicle: car.clone(),
            fetched_at: 1000,
            readings: Default::default(),
        };
        let command = command("climateStart", None);
        assert!(authorize_control(&car, &command, &capabilities(), &snapshot).is_ok());
        let mut wrong_car = car.clone();
        wrong_car.vin = "OTHER1234567890123".into();
        assert!(authorize_control(&wrong_car, &command, &capabilities(), &snapshot).is_err());
        wrong_car = car.clone();
        wrong_car.platform = Some("ICUP".into());
        assert!(authorize_control(&wrong_car, &command, &capabilities(), &snapshot).is_err());
        let mut denied = capabilities();
        denied["list"][0]["valueEnable"] = json!(false);
        assert!(authorize_control(&car, &command, &denied, &snapshot)
            .unwrap_err()
            .contains("未开放"));
        for unknown in [
            json!({}),
            json!({"list":[]}),
            json!({"list":[{"functionId":CLIMATE,"valueEnable":"true"}]}),
            json!({"list":[{"functionId":CLIMATE,"valueEnable":true},{"functionId":CLIMATE,"valueEnable":false}]}),
        ] {
            assert!(authorize_control(&car, &command, &unknown, &snapshot)
                .unwrap_err()
                .contains("能力信息"));
        }
        assert!(super::super::profile(&json!({"list":[]}), &command.vin).is_err());
        assert!(super::super::profile(
            &json!({"list":[{"vin":command.vin}],"serviceResult":{"operationResult":1}}),
            &command.vin
        )
        .is_err());
    }

    #[test]
    fn cabin_requests_follow_android_phone_parameters_including_stop_duration() {
        for (action, key, seat, max) in [
            ("steeringWheelHeat", "rce.heat", "steering_wheel", 1),
            ("driverSeatHeat", "rce.heat", "front-left", 3),
            ("passengerSeatHeat", "rce.heat", "front-right", 3),
            ("driverSeatVent", "rce.ventilation", "front-left", 3),
            ("passengerSeatVent", "rce.ventilation", "front-right", 3),
        ] {
            for level in 0..=max {
                let payload = body(
                    &command(action, Some(f64::from(level))),
                    "fixture-user",
                    1000,
                )
                .unwrap();
                let mut params = vec![json!({"key":key,"value":seat})];
                if max == 3 {
                    params.push(json!({"key":"rce.level","value":level.to_string()}));
                }
                assert_eq!(
                    payload,
                    json!({"command":if level == 0 {"stop"} else {"start"},"creator":"tc","serviceId":"RCE_2","userId":"fixture-user","timestamp":"1000","serviceParameters":params,"operationScheduling":{"duration":60,"interval":0,"occurs":1,"recurrentOperation":false}})
                );
            }
            for value in [
                None,
                Some(-1.0),
                Some(0.5),
                Some(f64::NAN),
                Some(f64::from(max + 1)),
            ] {
                assert!(validate_control(&command(action, value)).is_err());
            }
        }
    }

    #[test]
    fn body_controls_match_final_android_parameters_not_overwritten_intermediates() {
        for (action, service, start, params) in [
            ("lock", "RDL_2", true, json!([{"key":"door","value":"all"}])),
            (
                "unlock",
                "RDU_2",
                true,
                json!([{"key":"door","value":"all"}]),
            ),
            (
                "unlockTrunk",
                "RDU_2",
                true,
                json!([{"key":"target","value":"trunk"}]),
            ),
            (
                "windowsOpen",
                "RWS_2",
                true,
                json!([{"key":"target","value":"window"}]),
            ),
            (
                "windowsClose",
                "RWS_2",
                false,
                json!([{"key":"target","value":"window"}]),
            ),
            (
                "windowsVent",
                "RWS_2",
                true,
                json!([{"key":"target","value":"window"},{"key":"pos","value":"15"}]),
            ),
            (
                "chargeLidOpen",
                "RDO",
                true,
                json!([{"key":"target","value":"front-charge-lid"}]),
            ),
            (
                "chargeLidClose",
                "RDC",
                true,
                json!([{"key":"target","value":"front-charge-lid"}]),
            ),
            (
                "cleanStart",
                "RCC_2",
                true,
                json!([{"key":"rcc.ventilation","value":"cabin"}]),
            ),
            (
                "cleanStop",
                "RCC_2",
                false,
                json!([{"key":"rcc.ventilation","value":"cabin"}]),
            ),
            (
                "flash",
                "RHL",
                true,
                json!([{"key":"rhl","value":"light-flash"}]),
            ),
            ("honk", "RHL", true, json!([{"key":"rhl","value":"horn"}])),
            (
                "honkFlash",
                "RHL",
                true,
                json!([{"key":"rhl","value":"horn-light-flash"}]),
            ),
        ] {
            let payload = body(&command(action, None), "fixture-user", 1000).unwrap();
            assert_eq!(
                payload,
                json!({"command":if start {"start"} else {"stop"},"creator":"tc","serviceId":service,"userId":"fixture-user","timestamp":"1000","serviceParameters":params,"operationScheduling":{"duration":0,"interval":0,"occurs":1,"recurrentOperation":false}})
            );
            assert!(validate_control(&command(action, Some(1.0))).is_err());
        }
        assert_eq!(
            body(&command("climateStop", None), "fixture-user", 1000).unwrap()["serviceParameters"],
            json!([{"key":"rce.conditioner","value":"1"}])
        );
    }

    #[test]
    fn capability_refresh_clears_old_permissions_and_migrates_snapshot_marker() {
        let mut car = vehicle();
        car.capabilities
            .insert("norrGeelyReadOnly".into(), Some(true));
        car.capabilities.insert("norrP4.lock".into(), Some(true));
        assert!(car.uses_xchanger());
        apply_capabilities(&mut car, Some(&capabilities()));
        assert!(car.uses_xchanger());
        assert!(!car.capabilities.contains_key("norrGeelyReadOnly"));
        assert!(!car.capabilities.contains_key("norrP4.lock"));
        assert_eq!(car.capabilities["geely.remote_charge_2"], Some(true));
        apply_capabilities(&mut car, None);
        assert!(!car.capabilities.contains_key("geely.remote_charge_2"));
        assert_eq!(
            car.capabilities["supportsParkingClimatizationCompartmentTemperatureSettings"],
            None
        );
    }

    #[test]
    fn prepared_command_cannot_cross_accounts_or_outlive_its_grant_check() {
        let prepared = PreparedControl {
            command: command("target", Some(90.0)),
            grant: Value::Null,
            account: "fixture-account".into(),
            prepared_at: 1000,
        };
        assert!(check_prepared(&prepared, "fixture-account", 2000).is_ok());
        assert!(check_prepared(&prepared, "other-account", 2000).is_err());
        assert!(check_prepared(&prepared, "fixture-account", 61_000).is_err());
    }

    fn server(
        status: u16,
        response: Value,
        delay: Duration,
    ) -> (String, thread::JoinHandle<(String, usize)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::trim)
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| "0".into())
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            thread::sleep(delay);
            let payload = response.to_string();
            let _ = write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
            listener.set_nonblocking(true).unwrap();
            let extra = usize::from(listener.accept().is_ok());
            (String::from_utf8(request).unwrap(), 1 + extra)
        });
        (endpoint, handle)
    }

    #[test]
    fn real_http_control_sends_one_signed_put_and_distinguishes_rejection_and_uncertainty() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for action in availability::ACTIONS {
            let value = match *action {
                "climateStart" => Some(22.0),
                "target" => Some(100.0),
                "steeringWheelHeat" => Some(1.0),
                "driverSeatHeat" | "passengerSeatHeat" | "driverSeatVent" | "passengerSeatVent" => {
                    Some(3.0)
                }
                _ => None,
            };
            for (http, response, expected) in [
                (
                    200,
                    json!({"code":"1000","data":{"serviceResult":{"operationResult":1}}}),
                    "accepted",
                ),
                (200, json!({"code":8500}), "rejected"),
                (401, json!({}), "rejected"),
                (500, json!({"code":1000}), "unknown"),
                (200, json!({}), "unknown"),
            ] {
                let (endpoint, captured) = server(http, response, Duration::ZERO);
                let http = Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap();
                let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture-secret");
                let api = Api {
                    http: &http,
                    key,
                    device: "fixture-device".into(),
                    endpoint: Some(endpoint),
                };
                let grant = json!({"userId":"fixture-user","accessToken":"fixture-token","clientId":"fixture-client"});
                let command = command(action, value);
                assert_eq!(
                    runtime
                        .block_on(send_control(&api, &grant, &command))
                        .unwrap()
                        .0,
                    expected
                );
                let (request, count) = captured.join().unwrap();
                assert_eq!(count, 1);
                let (headers, payload) = request.split_once("\r\n\r\n").unwrap();
                assert!(headers.starts_with(
                    "PUT /remote-control/vehicle/telematics/TEST1234567890123 HTTP/1.1\r\n"
                ));
                let header = |name: &str| {
                    headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case(name).then(|| value.trim())
                        })
                        .unwrap()
                };
                assert_eq!(header("Authorization"), "fixture-token");
                assert_eq!(header("X-CLIENT-ID"), "fixture-client");
                let digest = STANDARD.encode(md5::compute(payload.as_bytes()).0);
                let canonical = format!("{}\nx-api-signature-nonce:{}\nx-api-signature-version:1.0\n\n\n{digest}\n{}\nPUT\n/remote-control/vehicle/telematics/TEST1234567890123",
                    header("Accept"), header("X-api-signature-nonce"), header("X-TIMESTAMP"));
                assert_eq!(
                    header("X-SIGNATURE"),
                    STANDARD.encode(hmac::sign(&api.key, canonical.as_bytes()).as_ref())
                );
                let sent: Value = serde_json::from_str(payload).unwrap();
                assert_eq!(
                    sent,
                    body(
                        &command,
                        "fixture-user",
                        sent["timestamp"].as_str().unwrap().parse().unwrap()
                    )
                    .unwrap()
                );
            }
        }
    }

    #[test]
    fn lost_response_does_not_resend_the_control() {
        let (endpoint, captured) = server(200, json!({"code":1000}), Duration::from_millis(200));
        let http = Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(80))
            .build()
            .unwrap();
        let api = Api {
            http: &http,
            key: hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture-secret"),
            device: "fixture".into(),
            endpoint: Some(endpoint),
        };
        let result = tokio::runtime::Runtime::new().unwrap().block_on(send_control(&api,
            &json!({"userId":"fixture-user","accessToken":"fixture-token","clientId":"fixture-client"}), &command("target", Some(90.0))));
        assert!(result.is_err());
        assert_eq!(captured.join().unwrap().1, 1);
    }

    #[test]
    fn control_readback_requests_only_its_endpoint_and_preserves_vehicle_time() {
        let reported = now_ms() - 1000;
        let session: Session = serde_json::from_value(json!({
            "login":{"userUid":"fixture-account","expiresIn":0,"globleToken":{"accessToken":"fixture","refreshToken":"fixture","tokenType":"bearer","expiresIn":3600}},
            "globalIssuedAt":0,"issuedAt":0
        })).unwrap();
        for (kind, data, path) in [
            ("target", json!({"soc":"900","socTime":reported}), "GET /remote-control/vehicle/status/soc/TEST1234567890123?setting=charging "),
            ("climate", json!({"result":{"serviceResult":{"operationResult":0}},"vehicleStatus":{"configuration":{"vin":"TEST1234567890123"},"updateTime":reported,"additionalVehicleStatus":{"climateStatus":{"preClimateActive":1}}}}), "GET /remote-control/vehicle/status/TEST1234567890123?latest=false&target=&userId=fixture-user "),
            ("exterior", json!({"result":{"serviceResult":{"operationResult":0}},"vehicleStatus":{"configuration":{"vin":"TEST1234567890123"},"updateTime":reported,"additionalVehicleStatus":{"drivingSafetyStatus":{"centralLockingStatus":1,"trunkLockStatus":0},"electricVehicleStatus":{"chargeLidDcAcStatus":2},"climateStatus":{"winStatusDriver":0}}}}), "GET /remote-control/vehicle/status/TEST1234567890123?latest=false&target=&userId=fixture-user "),
            ("airQuality", json!({"result":{"serviceResult":{"operationResult":0}},"vehicleStatus":{"configuration":{"vin":"TEST1234567890123"},"updateTime":reported,"additionalVehicleStatus":{"climateStatus":{"airBlowerActive":false}}}}), "GET /remote-control/vehicle/status/TEST1234567890123?latest=false&target=&userId=fixture-user "),
        ] {
            let (endpoint, captured) = server(200, json!({"code":1000,"data":data}), Duration::ZERO);
            let http = Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let api = Api { http: &http, key: hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture-secret"), device: "fixture".into(), endpoint: Some(endpoint) };
            let reader = VehicleRead { api: &api, session: &session, grant: json!({"userId":"fixture-user","accessToken":"fixture-token","clientId":"fixture-client"}), renewed: Default::default() };
            let reading = tokio::runtime::Runtime::new().unwrap().block_on(reader.control_reading(&vehicle(), kind)).unwrap();
            assert_eq!(reading.status, "success");
            assert_eq!(reading.reported_at, Some(reported));
            let value = reading.value.unwrap();
            match kind {
                "target" => assert_eq!(value["percent"], 90.0),
                "climate" => assert_eq!(value["activity"], "active"),
                "airQuality" => assert_eq!(value["state"], 2),
                _ => {
                    assert_eq!(value["locked"], true);
                    assert_eq!(value["trunkLocked"], false);
                    assert_eq!(value["openings"]["chargeLid"], 2);
                    assert_eq!(value["openings"]["frontLeftWindow"], 3);
                }
            }
            let (request, count) = captured.join().unwrap();
            assert!(request.starts_with(path));
            assert_eq!(count, 1);
        }
    }
}
