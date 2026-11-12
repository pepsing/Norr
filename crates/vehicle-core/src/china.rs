use crate::{
    credentials::{self, Grant, Session},
    models::*,
    now_ms, schedules, telemetry, transport,
    wire::{self, Message},
    Result,
};
use reqwest::{Client, Response, Url};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tonic::transport::Channel;

pub struct ChinaClient {
    http: Client,
    session: Option<Session>,
    pending_save: bool,
    c3: Option<Channel>,
    lbs: Option<Channel>,
    fleet: Vec<Vehicle>,
    metadata_at: u64,
}

pub struct PreparedCommand {
    path: String,
    body: Vec<u8>,
    chronos: bool,
    action: String,
    vin: String,
    pub baseline_timer_ids: Option<Vec<String>>,
}

impl ChinaClient {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法建立安全连接")?,
            session: None,
            pending_save: false,
            c3: None,
            lbs: None,
            fleet: Vec::new(),
            metadata_at: 0,
        })
    }

    async fn authorize(&mut self, force: bool) -> Result<()> {
        if self.pending_save {
            credentials::save_session(self.session.as_ref().ok_or("会话尚未恢复")?)?;
            self.pending_save = false;
        }
        if self.session.is_none() {
            self.session = credentials::load_session()?;
        }
        let session = self
            .session
            .as_ref()
            .ok_or("请先登录中国区 Polestar 账号")?;
        if !force && !session.needs_refresh() {
            return Ok(());
        }
        let key = credentials::signing_key()?;
        let url = gateway_url(
            "/user/api/v2/oauth/refresh-global-token",
            &key,
            &credentials::device_id()?,
            now_ms(),
            &uuid::Uuid::new_v4().to_string().to_uppercase(),
        )?;
        let response = self
            .http
            .post(url)
            .header("psoneid", &session.login.user_uid)
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&json!({"refreshToken":session.login.globle_token.refresh_token}))
            .send()
            .await
            .map_err(|_| "会话续期连接失败，请稍后恢复连接")?;
        let envelope = response_json(response).await?;
        if envelope["code"].as_i64() != Some(200) || envelope["status"].as_i64() != Some(200) {
            return Err("厂商未接受会话续期，已保留本机登录记录".into());
        }
        let grant: Grant =
            serde_json::from_value(envelope["data"].clone()).map_err(|_| "续期响应缺少有效授权")?;
        let session = self.session.as_mut().ok_or("会话尚未恢复")?;
        session.replace_grant(grant);
        self.pending_save = true;
        credentials::save_session(session)?;
        self.pending_save = false;
        Ok(())
    }

    pub async fn connect(&mut self) -> Result<Vec<Vehicle>> {
        self.authorize(false).await?;
        match self.load_fleet().await {
            Err(error) if error == "厂商请求失败（HTTP 401）" => {
                self.authorize(true).await?;
                self.load_fleet().await
            }
            result => result,
        }
    }

    async fn load_fleet(&mut self) -> Result<Vec<Vehicle>> {
        let token = &self
            .session
            .as_ref()
            .ok_or("会话尚未恢复")?
            .login
            .globle_token
            .access_token;
        let response = self
            .http
            .get("https://cnepmob.volvocars.com.cn")
            .bearer_auth(token)
            .header("Accept", "application/volvo.cloud.cnepmob.v1+json")
            .send()
            .await
            .map_err(|_| "服务发现连接失败")?;
        let discovery = response_json(response).await?;
        let mut cars_url = trusted_url(
            discovery["c3"]["url"]
                .as_str()
                .ok_or("服务发现缺少车辆地址")?,
        )?;
        cars_url.set_path(&format!(
            "{}/car-information/car",
            cars_url.path().trim_end_matches('/')
        ));
        let response = self
            .http
            .get(cars_url)
            .bearer_auth(token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| "无法读取车辆列表")?;
        let cars = response_json(response).await?;
        let fleet = cars
            .as_array()
            .ok_or("车辆列表格式无效")?
            .iter()
            .map(parse_car)
            .collect::<Result<Vec<_>>>()?;
        let c3 = transport::channel(&grpc_url(&discovery["c3"])?).await?;
        let lbs = match grpc_url(&discovery["c3Lbs"]) {
            Ok(url) => transport::channel(&url).await.ok(),
            Err(_) => None,
        };
        self.c3 = Some(c3);
        self.lbs = lbs;
        self.fleet = fleet;
        self.metadata_at = now_ms();
        Ok(self.fleet.clone())
    }

    async fn ensure_metadata(&mut self) -> Result<()> {
        if now_ms().saturating_sub(self.metadata_at) >= 600_000 {
            self.connect().await?;
        } else {
            self.authorize(false).await?;
        }
        Ok(())
    }

    fn vehicle(&self, vin: &str) -> Result<Vehicle> {
        let vehicle = self
            .fleet
            .iter()
            .find(|car| car.vin == vin)
            .ok_or("车辆不属于当前会话")?;
        if !matches!(vehicle.platform.as_deref(), Some("ICUP" | "AccountLinking")) {
            return Err("此车辆平台的原生适配尚未完成".into());
        }
        Ok(vehicle.clone())
    }

    async fn call(
        &self,
        vin: &str,
        path: &str,
        body: Vec<u8>,
        chronos: bool,
        first: bool,
    ) -> Result<Vec<u8>> {
        let channel = if chronos { &self.lbs } else { &self.c3 };
        let token = &self
            .session
            .as_ref()
            .ok_or("会话尚未恢复")?
            .login
            .globle_token
            .access_token;
        transport::request(
            channel.clone().ok_or("该服务连接尚未建立")?,
            path,
            body,
            vin,
            token,
            first,
        )
        .await
        .map_err(transport::error)
    }

    async fn read(&self, vin: &str, kind: &str) -> Reading {
        let (path, chronos, first) = match kind {
            "battery" => ("/services.vehiclestates.battery.BatteryService/GetLatestBattery", false, false),
            "exterior" => ("/services.vehiclestates.exterior.ExteriorService/GetLatestExterior", false, false),
            "climate" => ("/services.vehiclestates.parkingclimatization.ParkingClimatizationService/GetLatestParkingClimatization", false, false),
            "odometer" => ("/services.vehiclestates.odometer.OdometerService/GetOdometer", false, true),
            "target" => ("/chronos.services.v1.TargetSocService/GetTargetSoc", true, true),
            "amperage" => ("/chronos.services.v1.AmpLimitService/GetAmpLimit", true, true),
            "health" => ("/services.vehiclestates.health.HealthService/GetHealth", false, true),
            "airQuality" => ("/services.vehiclestates.precleaning.PreCleaningService/GetPreCleaning", false, true),
            "location" => ("/dtlinternet.DtlInternetService/GetLastKnownLocation", true, false),
            "software" => ("/ota_mobcache.OtaDiscoveryService/GetSoftwareInfo", false, true),
            "softwareSchedule" => ("/ota_mobcache.SchedulerService/GetSchedule", false, true),
            "climateTimers" => ("/chronos.services.v1.ParkingClimateTimerService/GetTimers", true, true),
            "chargeTimer" => ("/chronos.services.v2.GlobalChargeTimerService/GetGlobalChargeTimerStream", true, true),
            "chargeLocations" => ("/chronos.services.v1.ChargeLocationService/GetChargeLocations", true, true),
            _ => return Reading::failure("读取项目尚未接入".into()),
        };
        let body = if kind == "software" {
            [wire::string(1, vin), wire::string(2, "zh-CN")].concat()
        } else if matches!(kind, "softwareSchedule" | "location") {
            wire::string(1, vin)
        } else if chronos {
            chronos_request(vin)
        } else if matches!(kind, "odometer" | "health" | "airQuality") {
            wire::string(2, vin)
        } else {
            wire::state_request(vin)
        };
        match self
            .call(vin, path, body, chronos, first)
            .await
            .and_then(|bytes| parse_reading(kind, &bytes, vin))
        {
            Ok((value, timestamp)) => Reading::success(value, timestamp),
            Err(error) => Reading::failure(error),
        }
    }

    pub async fn refresh(&mut self, vin: &str) -> Result<Snapshot> {
        self.ensure_metadata().await?;
        let vehicle = self.vehicle(vin)?;
        let (
            battery,
            exterior,
            climate,
            odometer,
            target,
            amperage,
            health,
            air,
            location,
            software,
            software_schedule,
            climate_timers,
            charge_timer,
            charge_locations,
        ) = tokio::join!(
            self.read(vin, "battery"),
            self.read(vin, "exterior"),
            self.read(vin, "climate"),
            self.read(vin, "odometer"),
            self.read(vin, "target"),
            self.read(vin, "amperage"),
            self.read(vin, "health"),
            self.read(vin, "airQuality"),
            self.read(vin, "location"),
            self.read(vin, "software"),
            self.read(vin, "softwareSchedule"),
            self.read(vin, "climateTimers"),
            self.read(vin, "chargeTimer"),
            self.read(vin, "chargeLocations"),
        );
        let mut snapshot = Snapshot {
            vehicle,
            fetched_at: now_ms(),
            readings: [
                ("battery", battery),
                ("exterior", exterior),
                ("climate", climate),
                ("odometer", odometer),
                ("target", target),
                ("amperage", amperage),
                ("health", health),
                ("airQuality", air),
                ("location", location),
                ("software", software),
                ("softwareSchedule", software_schedule),
                ("climateTimers", climate_timers),
                ("chargeTimer", charge_timer),
                ("chargeLocations", charge_locations),
            ]
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
        };
        let rejected = snapshot
            .readings
            .iter()
            .filter(|(_, reading)| reading.error.as_deref() == Some(transport::AUTH_ERROR))
            .map(|(kind, _)| kind.clone())
            .collect::<Vec<_>>();
        if !rejected.is_empty() {
            self.authorize(true).await?;
            for kind in rejected {
                snapshot
                    .readings
                    .insert(kind.clone(), self.read(vin, &kind).await);
            }
        }
        Ok(snapshot)
    }

    pub async fn refresh_reading(&mut self, vin: &str, kind: &str) -> Result<Reading> {
        self.ensure_metadata().await?;
        self.vehicle(vin)?;
        let mut reading = self.read(vin, kind).await;
        if reading.error.as_deref() == Some(transport::AUTH_ERROR) {
            self.authorize(true).await?;
            reading = self.read(vin, kind).await;
        }
        Ok(reading)
    }

    pub fn validate_command(&self, command: &Command) -> Result<()> {
        command_request(&self.vehicle(&command.vin)?, command).map(|_| ())
    }

    pub async fn prepare(&mut self, command: &Command) -> Result<PreparedCommand> {
        self.ensure_metadata().await?;
        let vehicle = self.vehicle(&command.vin)?;
        let (path, mut body, chronos) = command_request(&vehicle, command)?;
        let mut baseline_timer_ids = None;
        if matches!(
            command.action.as_str(),
            "climateTimer" | "deleteClimateTimer"
        ) {
            let reading = self.read(&command.vin, "climateTimers").await;
            let value = reading
                .value
                .ok_or_else(|| reading.error.unwrap_or("无法核对现有日程".into()))?;
            let timers: Vec<Schedule> =
                serde_json::from_value(value["timers"].clone()).map_err(|_| "日程格式无效")?;
            let id = command
                .timer_id
                .as_ref()
                .or_else(|| command.schedule.as_ref()?.id.as_ref());
            if let Some(id) = id {
                let previous = timers
                    .iter()
                    .find(|timer| timer.id.as_ref() == Some(id))
                    .ok_or("该日程已不存在，请刷新列表")?;
                if command
                    .schedule
                    .as_ref()
                    .is_some_and(|schedule| schedule.index != previous.index)
                {
                    return Err("日程序号已变化，请刷新后重新编辑".into());
                }
            } else if vehicle
                .limits
                .get("parkingClimatizationMaxNumberOfTimers")
                .is_some_and(|maximum| timers.len() as f64 >= *maximum)
            {
                return Err("已达到车辆支持的日程数量上限".into());
            }
            baseline_timer_ids = Some(timers.into_iter().filter_map(|timer| timer.id).collect());
        }
        if command.action.starts_with("ota") {
            let reading = self.read(&command.vin, "software").await;
            let info = reading
                .value
                .ok_or_else(|| reading.error.unwrap_or("无法核对软件状态".into()))?;
            let schedule_reading = self.read(&command.vin, "softwareSchedule").await;
            let schedule = schedule_reading.value.ok_or_else(|| {
                schedule_reading
                    .error
                    .unwrap_or("无法核对软件安装计划".into())
            })?;
            let id = if command.action == "otaCancel" {
                schedule["softwareId"]
                    .as_str()
                    .or_else(|| info["id"].as_str())
            } else {
                info["id"].as_str()
            }
            .filter(|id| !id.is_empty())
            .ok_or("服务未提供可操作的软件版本")?;
            if command.action == "otaCancel" {
                if schedule["status"].as_u64() != Some(2) {
                    return Err("当前没有可取消的安装计划".into());
                }
            } else if !matches!(info["state"].as_u64(), Some(3 | 10 | 12)) {
                return Err("当前软件尚未处于可安装状态".into());
            }
            body.extend(wire::string(
                if command.action == "otaSchedule" {
                    3
                } else {
                    2
                },
                id,
            ));
        }
        Ok(PreparedCommand {
            path,
            body,
            chronos,
            action: command.action.clone(),
            vin: command.vin.clone(),
            baseline_timer_ids,
        })
    }

    pub async fn execute(&self, command: PreparedCommand) -> Result<(String, String)> {
        let result = self
            .call(
                &command.vin,
                &command.path,
                command.body,
                command.chronos,
                false,
            )
            .await?;
        parse_command_response(&command.action, command.chronos, &result)
    }
}

fn parse_command_response(action: &str, chronos: bool, result: &[u8]) -> Result<(String, String)> {
    let message = Message::parse(result)?;
    let response_field = match action {
        "chargeTimer" => Some(2),
        "chargeStart" | "chargeStop" => Some(1),
        _ => None,
    };
    if let Some(field) = response_field {
        return Ok(status_text(match message.int(field) {
            Some(1) => "accepted",
            Some(2..=4) => "rejected",
            _ => "unknown",
        }));
    }
    if action.starts_with("ota") {
        let status = message.nested(1)?.and_then(|value| value.int(1));
        return Ok(status_text(match status {
            Some(1 | 2) => "accepted",
            Some(3) => "delivered",
            _ => "unknown",
        }));
    }
    command_result(result, chronos, action == "lock")
}

async fn response_json(mut response: Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(format!(
            "厂商请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "厂商响应中断")? {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err("厂商响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "厂商响应格式无效".into())
}

fn trusted_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "车辆服务地址无效")?;
    let host = url.host_str().ok_or("车辆服务缺少域名")?;
    let allowed = [
        "volvocars.com.cn",
        "volvocars.com",
        "polestar.cn",
        "polestar.com",
        "polestar-auto.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务发现返回了未经识别的车辆地址".into());
    }
    Ok(url)
}

fn grpc_url(service: &Value) -> Result<String> {
    let host = service["grpcHost"]
        .as_str()
        .ok_or("服务发现缺少 gRPC 地址")?;
    let port = service["grpcPort"]
        .as_u64()
        .or_else(|| service["grpcPort"].as_str()?.parse().ok())
        .unwrap_or(443);
    if host.contains(['/', ':', '@', '?', '#']) || !(1..=65535).contains(&port) {
        return Err("gRPC 地址无效".into());
    }
    Ok(trusted_url(&format!("https://{host}:{port}"))?.to_string())
}

pub(crate) fn gateway_url(
    path: &str,
    key: &str,
    device: &str,
    time: u64,
    nonce: &str,
) -> Result<Url> {
    let parameters = BTreeMap::from([
        ("appId", "polestar-app-android".to_owned()),
        ("appVer", "4.25.0".to_owned()),
        ("brand", "apple".to_owned()),
        ("clientType", "PHONE".to_owned()),
        ("deviceId", device.to_owned()),
        ("deviceModel", "Mac".to_owned()),
        ("nonce", nonce.to_owned()),
        ("systemVer", "macOS".to_owned()),
        ("timestamp", time.to_string()),
    ]);
    let canonical = parameters
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let sign = format!("{:x}", md5::compute(format!("{key}{canonical}{key}")));
    Url::parse(&format!(
        "https://gw.app.polestar-auto.com{path}?{canonical}&sign={sign}"
    ))
    .map_err(|_| "登录服务地址无效".into())
}

fn parse_car(car: &Value) -> Result<Vehicle> {
    let vin = car["vin"]
        .as_str()
        .filter(|value| value.len() == 17 && value.bytes().all(|b| b.is_ascii_alphanumeric()))
        .ok_or("车辆身份格式无效")?
        .to_owned();
    let object = car.as_object().ok_or("车辆资料格式无效")?;
    Ok(Vehicle {
        vin,
        model: car["modelName"].as_str().unwrap_or("Polestar").to_owned(),
        model_year: car["modelYear"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| car["modelYear"].as_u64().map(|n| n.to_string())),
        owner: car["userIsOwner"].as_bool(),
        platform: car["remoteControlType"].as_str().map(str::to_owned),
        capabilities: object
            .iter()
            .filter(|(key, _)| key.starts_with("supports"))
            .map(|(key, value)| (key.clone(), value.as_bool()))
            .collect(),
        limits: object
            .iter()
            .filter(|(key, _)| {
                key.ends_with("Limit") || key.as_str() == "parkingClimatizationMaxNumberOfTimers"
            })
            .filter_map(|(key, value)| value.as_f64().map(|n| (key.clone(), n)))
            .collect(),
        installed_version: car["consumerSoftwareVersion"].as_str().map(str::to_owned),
    })
}

fn chronos_request(vin: &str) -> Vec<u8> {
    chronos_request_with_offset(vin, 0)
}

fn chronos_request_with_offset(vin: &str, offset: i32) -> Vec<u8> {
    wire::bytes(
        1,
        &[
            wire::state_request(vin),
            wire::string(3, "RCS"),
            wire::bytes(4, &wire::integer(1, offset as i64 as u64)),
        ]
        .concat(),
    )
}

fn parse_reading(kind: &str, bytes: &[u8], vin: &str) -> Result<(Value, Option<u64>)> {
    if !matches!(
        kind,
        "battery" | "exterior" | "climate" | "odometer" | "target" | "amperage"
    ) {
        return telemetry::parse(kind, bytes, vin);
    }
    let message = wire::payload(bytes, vin)?;
    let timestamp = message.timestamp(1);
    let value = match kind {
        "battery" => json!({
            "percent":message.number(2).filter(|n| (0.0..=100.0).contains(n)),
            "rangeKm":message.number(4), "powerKw":message.number(10).map(|n| n/1000.0),
            "currentA":message.number(11), "voltage":message.number(18),
            "minutesToFull":message.int(5), "minutesToTarget":message.int(9),
            "connection":message.int(6), "chargeState":message.int(7), "chargeStateV2":message.int(28),
            "consumption":message.number(3),
        }),
        "exterior" => {
            let digital = (2..=16).any(|n| message.int(n).is_some());
            let lock = if digital {
                message.int(2)
            } else {
                message.nested(1)?.and_then(|m| m.int(1))
            };
            let openings = if digital {
                [
                    "frontLeftDoor",
                    "frontRightDoor",
                    "rearLeftDoor",
                    "rearRightDoor",
                    "frontLeftWindow",
                    "frontRightWindow",
                    "rearLeftWindow",
                    "rearRightWindow",
                    "hood",
                    "tailgate",
                    "chargeLid",
                    "sunroof",
                ]
                .iter()
                .enumerate()
                .map(|(i, name)| ((*name).to_owned(), json!(message.int(i as u32 + 3))))
                .collect::<BTreeMap<_, _>>()
            } else {
                BTreeMap::new()
            };
            return Ok((
                json!({"locked":match lock { Some(2)=>Some(true), Some(1)=>Some(false), _=>None }, "openings":openings}),
                if digital { timestamp } else { None },
            ));
        }
        "climate" => {
            let digital = message.bytes(1).is_some();
            let running = message.int(if digital { 2 } else { 1 });
            let activity = match (digital, running) {
                (_, None | Some(0)) => "unknown",
                (true, Some(1)) | (false, Some(4..=8)) => "active",
                (true, Some(3)) | (false, Some(2..=3)) => "starting",
                _ => "idle",
            };
            json!({"activity":activity, "interiorTemperature":if digital {message.number(7)} else {None},
                "targetTemperature":if digital {message.number(8)} else {None}, "remainingMinutes":message.int(3)})
        }
        "odometer" => json!({"km":message.number(2).map(|n| n/1000.0), "tripKm":message.number(3),
            "automaticTripKm":message.number(4), "manualAverageSpeed":message.int(5), "automaticAverageSpeed":message.int(6),
            "sinceChargeTripKm":message.number(7), "sinceChargeAverageSpeed":message.int(8)}),
        "target" => json!({"percent":message.int(1).filter(|n| (1..=100).contains(n))}),
        "amperage" => json!({"amps":message.int(1).filter(|n| (1..=64).contains(n))}),
        _ => return Err("未知车辆读取项目".into()),
    };
    Ok((value, timestamp))
}

fn command_request(vehicle: &Vehicle, command: &Command) -> Result<(String, Vec<u8>, bool)> {
    let (method, capability) = match command.action.as_str() {
        "lock" => ("Lock", "supportsLock"),
        "unlock" => ("Unlock", "supportsUnlock"),
        "climateStart" => ("ClimatizationStart", "supportsParkingClimatization"),
        "climateStop" => ("ClimatizationStop", "supportsParkingClimatization"),
        "target" => ("SetTargetSoc", "supportsTargetChargeLevelSetting"),
        "amperage" => ("SetAmpLimit", "supportsGlobalChargeAmperageLimitSetting"),
        "flash" => ("HonkFlash", "supportsFlash"),
        "honkFlash" => ("HonkFlash", "supportsHonkAndFlash"),
        "unlockTrunk" => ("Unlock", "supportsRemoteTrunkUnlock"),
        "tailgateOpen" | "tailgateClose" => ("TailgateControl", "supportsRemoteTrunkControl"),
        "windowsOpen" | "windowsClose" => ("WindowControl", "supportsRemoteWindowControl"),
        "cleanStart" | "cleanStop" => ("PreCleaning", "supportsAirPurification"),
        "chargeStart" => ("StartOverrideChargeTimer", "supportsChargeNowTimerOverride"),
        "chargeStop" => ("StopOverrideChargeTimer", "supportsChargeNowTimerOverride"),
        "chargeTimer" => ("SetGlobalChargeTimer", "supportsGlobalChargeTimer"),
        "climateTimer" | "deleteClimateTimer" => ("", "climateTimers"),
        "otaSchedule" => ("Schedule", "supportsRemoteOtaInstallSchedule"),
        "otaInstall" => ("InstallNow", "supportsRemoteOtaInstallSchedule"),
        "otaCancel" => ("CancelSchedule", "supportsRemoteOtaInstallSchedule"),
        _ => return Err("此操作尚未接入".into()),
    };
    let supported = if capability == "climateTimers" {
        [
            "supportsParkingClimatizationRepeatedWeekdayTimers",
            "supportsParkingClimatizationUnrepeatedWeekdayTimers",
            "supportsParkingClimatization24hTimers",
        ]
        .iter()
        .any(|flag| vehicle.capabilities.get(*flag).copied().flatten() == Some(true))
    } else {
        vehicle.capabilities.get(capability).copied().flatten() == Some(true)
    };
    if !supported {
        return Err("车辆未确认支持此操作".into());
    }
    if matches!(
        command.action.as_str(),
        "target" | "amperage" | "chargeStart" | "chargeStop" | "chargeTimer"
    ) && vehicle
        .capabilities
        .get("supportsChargingFunctions")
        .copied()
        .flatten()
        != Some(true)
    {
        return Err("车辆未确认开放充电控制".into());
    }
    let vin = &command.vin;
    let mut body = wire::bytes(1, &wire::string(1, vin));
    match command.action.as_str() {
        "lock" | "unlock" => body.extend(wire::integer(2, 0)),
        "flash" => body.extend(wire::integer(2, 2)),
        "honkFlash" => body.extend(wire::integer(2, 0)),
        "unlockTrunk" | "tailgateOpen" | "windowsOpen" | "cleanStart" => {
            body.extend(wire::integer(2, 1))
        }
        "tailgateClose" | "windowsClose" => body.extend(wire::integer(2, 2)),
        "cleanStop" => body.extend(wire::integer(2, 0)),
        "chargeStart" | "chargeStop" => {
            return Ok((
                format!("/chronos.services.v1.ChargeNowService/{method}"),
                chronos_request(vin),
                true,
            ));
        }
        "chargeTimer" | "climateTimer" => {
            let climate = command.action == "climateTimer";
            let schedule = command.schedule.as_ref().ok_or("请填写日程")?;
            schedules::validate(schedule, climate, vehicle)?;
            let offset = command
                .timezone_offset
                .filter(|offset| (-840..=840).contains(offset))
                .ok_or("日程时区无效")?;
            body = chronos_request_with_offset(vin, offset);
            body.extend(wire::bytes(
                2,
                &schedules::encode(schedule, climate, offset),
            ));
            let path = if climate {
                "/chronos.services.v1.ParkingClimateTimerService/SetTimers"
            } else {
                body.extend(wire::integer(3, 0));
                "/chronos.services.v2.GlobalChargeTimerService/SetGlobalChargeTimer"
            };
            return Ok((path.into(), body, true));
        }
        "deleteClimateTimer" => {
            let id = command
                .timer_id
                .as_ref()
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .ok_or("日程身份无效")?;
            body = chronos_request(vin);
            body.extend(wire::string(2, id));
            return Ok((
                "/chronos.services.v1.ParkingClimateTimerService/DeleteTimer".into(),
                body,
                true,
            ));
        }
        "otaSchedule" | "otaInstall" | "otaCancel" => {
            body = wire::string(1, vin);
            if command.action == "otaSchedule" {
                let minutes = command
                    .value
                    .filter(|value| {
                        value.is_finite() && value.fract() == 0.0 && (2.0..=10080.0).contains(value)
                    })
                    .ok_or("请选择 2 至 10080 分钟后的安装时间")?;
                body.extend(wire::integer(2, minutes as u64));
            }
            return Ok((
                format!("/ota_mobcache.SchedulerService/{method}"),
                body,
                false,
            ));
        }
        "climateStart" => {
            if command.value.is_some()
                && vehicle
                    .capabilities
                    .get("supportsParkingClimatizationCompartmentTemperatureSettings")
                    .copied()
                    .flatten()
                    != Some(true)
            {
                return Err("车辆未确认支持远程温度设置".into());
            }
            let value = command.value.unwrap_or(22.0);
            let min = vehicle
                .limits
                .get("parkingClimatizationCompartmentTemperatureMinLimit")
                .copied()
                .unwrap_or(16.0)
                .max(16.0);
            let max = vehicle
                .limits
                .get("parkingClimatizationCompartmentTemperatureMaxLimit")
                .copied()
                .unwrap_or(30.0)
                .min(30.0);
            if !value.is_finite() || !(min..=max).contains(&value) || (value * 2.0).fract() != 0.0 {
                return Err("温度超出车辆支持范围".into());
            }
            body.extend(wire::integer(2, 1));
            body.extend(wire::float(3, value as f32));
        }
        "target" | "amperage" => {
            let target = command.action == "target";
            let min = vehicle
                .limits
                .get(if target {
                    "targetChargeLevelPercentageMinLimit"
                } else {
                    "chargeAmperageMinLimit"
                })
                .copied()
                .unwrap_or(if target { 40.0 } else { 6.0 });
            let max = if target {
                100.0
            } else {
                vehicle
                    .limits
                    .get("chargeAmperageMaxLimit")
                    .copied()
                    .unwrap_or(32.0)
            };
            let value = command.value.ok_or("请选择设置值")?;
            if !value.is_finite() || !(min..=max).contains(&value) || value.fract() != 0.0 {
                return Err("设置值超出车辆支持范围".into());
            }
            body = chronos_request(vin);
            body.extend(wire::integer(2, value as u64));
            if target {
                body.extend(wire::integer(3, 3));
            }
            let service = if target {
                "TargetSocService"
            } else {
                "AmpLimitService"
            };
            return Ok((
                format!("/chronos.services.v1.{service}/{method}"),
                body,
                true,
            ));
        }
        _ => {}
    }
    Ok((
        format!("/invocation.InvocationService/{method}"),
        body,
        false,
    ))
}

fn command_result(bytes: &[u8], chronos: bool, lock: bool) -> Result<(String, String)> {
    let outer = Message::parse(bytes)?;
    if lock && outer.bytes(1).is_some() && outer.int(2).is_some_and(|n| n != 0) {
        return Ok((
            "rejected".into(),
            "车辆拒绝锁车，请检查车门、前盖和尾门".into(),
        ));
    }
    let response = if !chronos && outer.int(3).is_none() {
        outer.nested(1)?.unwrap_or(outer)
    } else {
        outer
    };
    let status = match (chronos, response.int(3)) {
        (_, Some(1)) => "accepted",
        (true, Some(2)) | (false, Some(4)) => "delivered",
        (true, Some(3 | 4 | 8)) | (false, Some(6)) => "completed",
        (true, Some(5..=7)) | (false, Some(9 | 10 | 12)) => "rejected",
        _ => "unknown",
    };
    Ok(status_text(status))
}

fn status_text(status: &str) -> (String, String) {
    let message = match status {
        "accepted" => "服务已接受",
        "delivered" => "已送达车辆",
        "completed" => "服务报告已完成",
        "rejected" => "车辆拒绝执行",
        _ => "执行结果待核对",
    };
    (status.into(), message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_methods_match_china_protocol_and_require_explicit_capabilities() {
        for (action, method, field, flag) in [
            ("unlockTrunk", "Unlock", 1, "supportsRemoteTrunkUnlock"),
            (
                "tailgateOpen",
                "TailgateControl",
                1,
                "supportsRemoteTrunkControl",
            ),
            (
                "tailgateClose",
                "TailgateControl",
                2,
                "supportsRemoteTrunkControl",
            ),
            (
                "windowsOpen",
                "WindowControl",
                1,
                "supportsRemoteWindowControl",
            ),
            (
                "windowsClose",
                "WindowControl",
                2,
                "supportsRemoteWindowControl",
            ),
            ("honkFlash", "HonkFlash", 0, "supportsHonkAndFlash"),
            ("cleanStart", "PreCleaning", 1, "supportsAirPurification"),
            ("cleanStop", "PreCleaning", 0, "supportsAirPurification"),
        ] {
            let mut car =
                parse_car(&json!({"vin":"12345678901234567", "userIsOwner":true})).unwrap();
            let command = Command {
                vin: car.vin.clone(),
                action: action.into(),
                ..Default::default()
            };
            assert!(command_request(&car, &command).is_err());
            car.capabilities.insert(flag.into(), Some(false));
            assert!(command_request(&car, &command).is_err());
            car.capabilities.insert(flag.into(), Some(true));
            let (path, body, chronos) = command_request(&car, &command).unwrap();
            assert_eq!(path, format!("/invocation.InvocationService/{method}"));
            assert!(!chronos);
            assert_eq!(Message::parse(&body).unwrap().int(2), Some(field));
            car.owner = Some(false);
            assert!(command_request(&car, &command).is_ok());
        }
    }

    #[test]
    fn shared_account_climate_validation_uses_capabilities_and_session_vehicle() {
        let vehicle = parse_car(&json!({
            "vin": "12345678901234567",
            "userIsOwner": false,
            "remoteControlType": "ICUP",
            "supportsParkingClimatization": true
        }))
        .unwrap();
        let mut client = ChinaClient::new().unwrap();
        client.fleet.push(vehicle);
        for action in ["climateStart", "climateStop"] {
            let mut command = Command {
                vin: client.fleet[0].vin.clone(),
                action: action.into(),
                ..Default::default()
            };
            for owner in [Some(false), None, Some(true)] {
                client.fleet[0].owner = owner;
                for capability in [Some(true), Some(false), None] {
                    client.fleet[0]
                        .capabilities
                        .insert("supportsParkingClimatization".into(), capability);
                    assert_eq!(
                        client.validate_command(&command).is_ok(),
                        capability == Some(true)
                    );
                }
            }
            client.fleet[0].capabilities.clear();
            assert!(client.validate_command(&command).is_err());
            client.fleet[0]
                .capabilities
                .insert("supportsParkingClimatization".into(), Some(true));
            client.fleet[0].platform = Some("HUANFU".into());
            assert!(client.validate_command(&command).is_err());
            client.fleet[0].platform = Some("ICUP".into());
            command.vin = "unlinked-vehicle".into();
            assert!(client.validate_command(&command).is_err());
        }
    }
    #[test]
    fn charging_response_status_is_distinct_from_streaming_command_status() {
        for (action, field) in [("chargeTimer", 2), ("chargeStart", 1), ("chargeStop", 1)] {
            assert_eq!(
                parse_command_response(action, true, &wire::integer(field, 1))
                    .unwrap()
                    .0,
                "accepted"
            );
            for rejected in 2..=4 {
                assert_eq!(
                    parse_command_response(action, true, &wire::integer(field, rejected))
                        .unwrap()
                        .0,
                    "rejected"
                );
            }
            assert_eq!(
                parse_command_response(action, true, &[]).unwrap().0,
                "unknown"
            );
        }
        assert_eq!(
            parse_command_response("deleteClimateTimer", true, &wire::integer(3, 6))
                .unwrap()
                .0,
            "rejected"
        );
        assert_eq!(
            parse_command_response("otaInstall", false, &wire::bytes(1, &wire::integer(1, 3)))
                .unwrap()
                .0,
            "delivered"
        );
    }
    #[test]
    fn legacy_command_json_remains_readable() {
        let command: Command =
            serde_json::from_value(json!({"vin":"fixture", "action":"lock", "value":null}))
                .unwrap();
        assert!(command.schedule.is_none());
        assert!(command.timezone_offset.is_none());
    }
    #[test]
    fn signature_matches_swift_foundation_fixture() {
        let url = gateway_url(
            "/user/api/v2/oauth/refresh-global-token",
            "test",
            "00000000-0000-4000-8000-000000000000",
            1000,
            "fixed",
        )
        .unwrap();
        assert!(url
            .as_str()
            .ends_with("sign=9542c6b54b0312c2535d3ad0b3ebe0e2"));
    }

    #[test]
    fn climate_start_supports_default_comfort_without_temperature_controls() {
        let vehicle = parse_car(&json!({"vin":"12345678901234567", "userIsOwner":true,
            "supportsParkingClimatization":true}))
        .unwrap();
        let mut command = Command {
            vin: vehicle.vin.clone(),
            action: "climateStart".into(),
            value: None,
            ..Default::default()
        };
        let (_, bytes, _) = command_request(&vehicle, &command).unwrap();
        assert_eq!(Message::parse(&bytes).unwrap().number(3), Some(22.0));
        command.value = Some(24.0);
        assert!(command_request(&vehicle, &command).is_err());
    }

    #[test]
    fn target_uses_custom_setting_and_advertised_bounds() {
        let vehicle = parse_car(&json!({"vin":"12345678901234567", "userIsOwner":true,
            "supportsChargingFunctions":true, "supportsTargetChargeLevelSetting":true, "targetChargeLevelPercentageMinLimit":50}))
        .unwrap();
        let mut command = Command {
            vin: vehicle.vin.clone(),
            action: "target".into(),
            value: Some(90.0),
            ..Default::default()
        };
        let (path, bytes, chronos) = command_request(&vehicle, &command).unwrap();
        assert!(chronos);
        assert!(path.ends_with("/SetTargetSoc"));
        let message = Message::parse(&bytes).unwrap();
        assert_eq!(message.int(2), Some(90));
        assert_eq!(message.int(3), Some(3));
        for value in [49.0, 101.0, 80.5, f64::NAN] {
            command.value = Some(value);
            assert!(command_request(&vehicle, &command).is_err());
        }
    }

    #[test]
    fn service_receipts_preserve_progress_and_unknown_results() {
        assert_eq!(
            command_result(&wire::integer(3, 1), false, false)
                .unwrap()
                .0,
            "accepted"
        );
        assert_eq!(
            command_result(&wire::integer(3, 4), false, false)
                .unwrap()
                .0,
            "delivered"
        );
        assert_eq!(
            command_result(&wire::integer(3, 6), false, false)
                .unwrap()
                .0,
            "completed"
        );
        assert_eq!(command_result(&[], false, false).unwrap().0, "unknown");
        assert_eq!(
            command_result(&wire::integer(3, 6), true, false).unwrap().0,
            "rejected"
        );
    }
    #[test]
    fn rejects_foreign_discovery_hosts() {
        for url in [
            "http://api.polestar.cn",
            "https://polestar.cn.attacker.test",
            "https://a@api.polestar.cn",
            "https://api.polestar.cn?token=x",
        ] {
            assert!(trusted_url(url).is_err());
        }
        assert!(trusted_url("https://c3.volvocars.com.cn").is_ok());
    }
    #[test]
    fn missing_capability_does_not_enable_commands() {
        let car = parse_car(&json!({"vin":"12345678901234567","userIsOwner":true})).unwrap();
        let command = Command {
            vin: car.vin.clone(),
            action: "lock".into(),
            value: None,
            ..Default::default()
        };
        assert!(command_request(&car, &command).is_err());
    }
    #[test]
    fn missing_battery_is_unknown() {
        let (value, _) = parse_reading("battery", &wire::bytes(3, &[]), "test").unwrap();
        assert!(value["percent"].is_null());
    }
}
