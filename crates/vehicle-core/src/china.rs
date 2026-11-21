use crate::{
    credentials::{self, Grant, Session},
    models::*,
    now_ms, schedules, telemetry, transport,
    wire::{self, Message},
    Result,
};
use reqwest::{Client, Response, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tonic::transport::Channel;

/// `Verified` is the protocol path exercised against China Polestar 2
/// (`ICUP` / `AccountLinking`). `Generic` mirrors the vendor-neutral C3 shape
/// observed in C3Companion 0.2.0-beta07: VIN-only read bodies, `GetLatest*`
/// method names and the `PolestarApp` chronos client tag. Polestar 4
/// (`HUANFU` and other platforms) has not been verified on a real vehicle.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Verified,
    Generic,
}

impl Protocol {
    fn other(self) -> Self {
        match self {
            Self::Verified => Self::Generic,
            Self::Generic => Self::Verified,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Verified => 0,
            Self::Generic => 1,
        }
    }

    pub fn payload_fields(self) -> &'static [u32] {
        match self {
            Self::Verified => &[3],
            Self::Generic => &[3, 4],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Verified => "已验证",
            Self::Generic => "通用",
        }
    }
}

pub fn protocol_for(vehicle: &Vehicle) -> Protocol {
    if matches!(vehicle.platform.as_deref(), Some("ICUP" | "AccountLinking")) {
        Protocol::Verified
    } else {
        Protocol::Generic
    }
}

pub struct ChinaClient {
    http: Client,
    session: Option<Session>,
    pending_save: bool,
    c3: Option<Channel>,
    lbs: Option<Channel>,
    fleet: Vec<Vehicle>,
    metadata_at: u64,
    experimental: bool,
    protocol_overrides: BTreeMap<String, Protocol>,
}

pub struct PreparedCommand {
    path: String,
    body: Vec<u8>,
    chronos: bool,
    action: String,
    vin: String,
    pub baseline_timer_ids: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEndpoint {
    pub kind: String,
    pub status: String,
    pub error: Option<String>,
    pub fields: usize,
    pub protocol: String,
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_hex: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub vin: String,
    pub model: String,
    pub platform: Option<String>,
    pub protocol: String,
    pub succeeded: usize,
    pub total: usize,
    pub endpoints: Vec<ProbeEndpoint>,
    pub summary: String,
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
            experimental: false,
            protocol_overrides: BTreeMap::new(),
        })
    }

    /// Enables commands for platforms that have no verified protocol path.
    /// Reads are always allowed; this switch only unlocks writes.
    pub fn set_experimental(&mut self, enabled: bool) {
        self.experimental = enabled;
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

    pub fn account_scope(&self) -> Option<String> {
        use sha2::{Digest, Sha256};
        self.session
            .as_ref()
            .map(|session| format!("{:x}", Sha256::digest(session.login.user_uid.as_bytes())))
    }

    pub async fn vehicles(&mut self) -> Result<&[Vehicle]> {
        self.ensure_metadata().await?;
        Ok(&self.fleet)
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
        let fleet = parse_fleet(&cars)?;
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

    /// Commands require a verified platform, unless the user explicitly opted
    /// into the unverified generic protocol.
    pub fn vehicle(&self, vin: &str) -> Result<Vehicle> {
        let vehicle = self.vehicle_for_read(vin)?;
        if protocol_for(&vehicle) == Protocol::Generic && !self.experimental {
            return Err("此车辆平台尚未完成实车验证，请先在设置中开启“未验证平台”".into());
        }
        Ok(vehicle)
    }

    /// Reads are harmless and stay available for every vehicle in the fleet,
    /// so an unknown platform can still be diagnosed before enabling writes.
    fn vehicle_for_read(&self, vin: &str) -> Result<Vehicle> {
        self.fleet
            .iter()
            .find(|car| car.vin == vin)
            .cloned()
            .ok_or_else(|| "车辆不属于当前会话".into())
    }

    fn protocol_for(&self, vin: &str) -> Protocol {
        if let Some(protocol) = self.protocol_overrides.get(vin) {
            return *protocol;
        }
        self.fleet
            .iter()
            .find(|car| car.vin == vin)
            .map(protocol_for)
            .unwrap_or(Protocol::Verified)
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
        self.read_with(vin, kind, self.protocol_for(vin)).await
    }

    async fn read_with(&self, vin: &str, kind: &str, protocol: Protocol) -> Reading {
        self.read_with_raw(vin, kind, protocol).await.0
    }

    async fn read_with_raw(
        &self,
        vin: &str,
        kind: &str,
        protocol: Protocol,
    ) -> (Reading, Option<Vec<u8>>) {
        let Some((path, chronos, first)) = read_path(kind, protocol) else {
            return (Reading::failure("读取项目尚未接入".into()), None);
        };
        let Some(body) = read_request(vin, kind, protocol) else {
            return (Reading::failure("读取项目尚未接入".into()), None);
        };
        match self.call(vin, path, body, chronos, first).await {
            Ok(bytes) => {
                let reading = match parse_reading(kind, &bytes, vin, protocol) {
                    Ok((value, timestamp)) => Reading::success(value, timestamp),
                    Err(error) => Reading::failure(error),
                };
                (reading, Some(bytes))
            }
            Err(error) => (Reading::failure(error), None),
        }
    }

    pub async fn refresh(&mut self, vin: &str) -> Result<Snapshot> {
        self.ensure_metadata().await?;
        let vehicle = self.vehicle_for_read(vin)?;
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
        self.vehicle_for_read(vin)?;
        let mut reading = self.read(vin, kind).await;
        if reading.error.as_deref() == Some(transport::AUTH_ERROR) {
            self.authorize(true).await?;
            reading = self.read(vin, kind).await;
        }
        Ok(reading)
    }

    pub fn validate_command(&self, command: &Command) -> Result<()> {
        let vehicle = self.vehicle(&command.vin)?;
        command_request(&vehicle, command, self.protocol_for(&command.vin)).map(|_| ())
    }

    pub async fn prepare(&mut self, command: &Command) -> Result<PreparedCommand> {
        self.ensure_metadata().await?;
        let vehicle = self.vehicle(&command.vin)?;
        let (path, mut body, chronos) =
            command_request(&vehicle, command, self.protocol_for(&command.vin))?;
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

    /// Try the known location request shapes on both c3 and c3Lbs. Read-only.
    pub async fn location_variants(&mut self, vin: &str) -> Result<Value> {
        self.ensure_metadata().await?;
        let variants: [(&str, &str, Vec<u8>, bool); 6] = [
            (
                "known/lbs/vin1",
                "/dtlinternet.DtlInternetService/GetLastKnownLocation",
                wire::string(1, vin),
                true,
            ),
            (
                "known/lbs/state",
                "/dtlinternet.DtlInternetService/GetLastKnownLocation",
                wire::state_request(vin),
                true,
            ),
            (
                "known/c3/state",
                "/dtlinternet.DtlInternetService/GetLastKnownLocation",
                wire::state_request(vin),
                false,
            ),
            (
                "parked/lbs/vin1",
                "/dtlinternet.DtlInternetService/GetLastParkedLocation",
                wire::string(1, vin),
                true,
            ),
            (
                "parked/lbs/state",
                "/dtlinternet.DtlInternetService/GetLastParkedLocation",
                wire::state_request(vin),
                true,
            ),
            (
                "parked/c3/state",
                "/dtlinternet.DtlInternetService/GetLastParkedLocation",
                wire::state_request(vin),
                false,
            ),
        ];
        let mut results = Vec::new();
        for (name, path, body, chronos) in variants {
            match self.call(vin, path, body, chronos, false).await {
                Ok(bytes) => {
                    let parsed = telemetry::parse("location", &bytes, vin, Protocol::Generic);
                    results.push(json!({
                        "variant": name,
                        "status": "ok",
                        "bytes": bytes.len(),
                        "raw": hex(&bytes),
                        "parsed": parsed.ok().map(|(value, _)| value),
                    }));
                }
                Err(error) => {
                    results.push(json!({"variant": name, "status": "failed", "error": error}))
                }
            }
        }
        Ok(json!(results))
    }

    /// Raw service-discovery document, for diagnosing which base URLs the
    /// account is entitled to. Contains no credentials.
    pub async fn discovery(&mut self) -> Result<Value> {
        self.authorize(false).await?;
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
        response_json(response).await
    }

    /// Online/usage state. Explains why an invocation may be refused while
    /// cached readings still look plausible.
    pub async fn availability(&mut self, vin: &str) -> Result<Value> {
        self.ensure_metadata().await?;
        let path = "/services.vehiclestates.availability.AvailabilityService/GetLatestAvailability";
        let mut last_error = "车辆未返回可用性数据".to_string();
        for body in [wire::state_request(vin), wire::string(2, vin)] {
            match self.call(vin, path, body, false, true).await {
                Ok(bytes) => match Message::parse(&bytes).and_then(|outer| {
                    outer
                        .nested(3)?
                        .ok_or_else(|| "车辆未返回可用性数据".to_string())
                }) {
                    Ok(value) => {
                        return Ok(json!({
                            "status": value.int(3),
                            "reason": value.int(4),
                            "usageMode": value.int(5),
                            "reportedAt": value.timestamp(1),
                        }))
                    }
                    Err(error) => last_error = error,
                },
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }

    /// Read-only invocation used to check the command channel without
    /// actuating anything on the vehicle.
    pub async fn ping(&mut self, vin: &str) -> Result<(String, String)> {
        self.ensure_metadata().await?;
        let vehicle = self.vehicle_for_read(vin)?;
        if protocol_for(&vehicle) == Protocol::Generic && !self.experimental {
            return Err("此车辆平台尚未完成实车验证，请先在设置中开启“未验证平台”".into());
        }
        let body = wire::bytes(1, &wire::string(1, vin));
        let raw = self
            .call(
                vin,
                "/invocation.InvocationService/UpdateStatus",
                body,
                false,
                false,
            )
            .await?;
        parse_command_response("ping", false, &raw)
    }

    pub async fn execute_verbose(
        &self,
        command: PreparedCommand,
    ) -> Result<(Vec<u8>, String, String)> {
        let raw = self
            .call(
                &command.vin,
                &command.path,
                command.body.clone(),
                command.chronos,
                false,
            )
            .await?;
        let (status, message) = parse_command_response(&command.action, command.chronos, &raw)?;
        Ok((raw, status, message))
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

    /// Read-only diagnostic: tries every supported endpoint with the platform's
    /// primary protocol, then retries empty or failed endpoints with the other
    /// body/method variant. Nothing is written to the vehicle.
    pub async fn probe(&mut self, vin: &str) -> Result<ProbeReport> {
        self.ensure_metadata().await?;
        let vehicle = self.vehicle_for_read(vin)?;
        let primary = protocol_for(&vehicle);
        let kinds = [
            "battery",
            "exterior",
            "climate",
            "odometer",
            "target",
            "amperage",
            "health",
            "airQuality",
            "location",
            "software",
            "softwareSchedule",
            "climateTimers",
            "chargeTimer",
            "chargeLocations",
        ];
        let mut endpoints = Vec::new();
        let mut succeeded = 0;
        let mut score = [0usize; 2];
        for kind in kinds {
            let mut used = primary;
            let mut fallback = false;
            let (mut reading, mut raw) = self.read_with_raw(vin, kind, primary).await;
            if reading_is_empty(&reading) {
                let (alternative, alternative_raw) =
                    self.read_with_raw(vin, kind, primary.other()).await;
                if !reading_is_empty(&alternative) {
                    reading = alternative;
                    raw = alternative_raw;
                    used = primary.other();
                    fallback = true;
                }
            }
            let fields = reading_field_count(&reading);
            if reading.status == "success" && fields > 0 {
                succeeded += 1;
                score[used.index()] += 1;
            }
            endpoints.push(ProbeEndpoint {
                kind: kind.to_owned(),
                status: reading.status,
                error: reading.error,
                fields,
                protocol: used.label().to_owned(),
                fallback,
                raw_hex: raw
                    .filter(|bytes| bytes.len() <= 65_536)
                    .map(|bytes| hex(&bytes)),
            });
        }
        let total = endpoints.len();
        let winner = if score[Protocol::Generic.index()] > score[Protocol::Verified.index()] {
            Protocol::Generic
        } else if score[Protocol::Verified.index()] > 0 {
            Protocol::Verified
        } else {
            primary
        };
        // Never override the verified P2 path from a diagnostic probe; only an
        // unverified platform may be re-routed to the other body/method shape.
        if protocol_for(&vehicle) == Protocol::Generic && winner != primary {
            self.protocol_overrides.insert(vin.to_owned(), winner);
        }
        let summary = if succeeded == total {
            format!(
                "{total} 项读取均返回数据，本次使用{}协议；仍需实车核对数值与字段含义，不能据此执行写入。",
                winner.label()
            )
        } else {
            format!(
                "{succeeded}/{total} 项读取返回数据，本次主要使用{}协议；平台 {} 尚未验证，失败项不代表车辆不支持。",
                winner.label(),
                primary.label()
            )
        };
        Ok(ProbeReport {
            vin: vehicle.vin,
            model: vehicle.model,
            platform: vehicle.platform,
            protocol: primary.label().to_owned(),
            succeeded,
            total,
            endpoints,
            summary,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn reading_field_count(reading: &Reading) -> usize {
    reading
        .value
        .as_ref()
        .and_then(Value::as_object)
        .map(|object| object.values().filter(|value| !value.is_null()).count())
        .unwrap_or(0)
}

fn reading_is_empty(reading: &Reading) -> bool {
    reading.status != "success" || reading_field_count(reading) == 0
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

fn normalized<'a>(object: &'a serde_json::Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    object.iter().find_map(|(key, value)| {
        let key = key.to_ascii_lowercase().replace(['_', '-'], "");
        names.contains(&key.as_str()).then_some(value)
    })
}

fn parse_car(car: &Value) -> Result<Vehicle> {
    let object = car.as_object().ok_or("车辆资料格式无效")?;
    let vin = normalized(
        object,
        &["vin", "vehiclevin", "vehicleidentificationnumber"],
    )
    .and_then(Value::as_str)
    .filter(|value| value.len() == 17 && value.bytes().all(|b| b.is_ascii_alphanumeric()))
    .ok_or("车辆身份格式无效")?
    .to_owned();
    Ok(Vehicle {
        vin,
        model: normalized(object, &["modelname", "model"])
            .and_then(Value::as_str)
            .unwrap_or("Polestar")
            .to_owned(),
        model_year: normalized(object, &["modelyear", "year"]).and_then(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|n| n.to_string()))
        }),
        owner: normalized(object, &["userisowner"]).and_then(Value::as_bool),
        platform: normalized(object, &["remotecontroltype"])
            .and_then(Value::as_str)
            .map(str::to_owned),
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

fn parse_fleet(value: &Value) -> Result<Vec<Vehicle>> {
    if let Some(cars) = value.as_array() {
        if let Ok(fleet) = cars.iter().map(parse_car).collect::<Result<Vec<_>>>() {
            if !fleet.is_empty() {
                return Ok(fleet);
            }
        }
    }
    let mut fleet = Vec::new();
    collect_fleet(value, 0, &mut fleet)?;
    if fleet.is_empty() {
        return Err("车辆列表格式无效".into());
    }
    Ok(fleet)
}

/// Some accounts return the fleet wrapped in envelopes or grouped by model.
/// Walk the payload and pick up every object that carries a VIN.
fn collect_fleet(value: &Value, depth: u32, fleet: &mut Vec<Vehicle>) -> Result<()> {
    if depth > 16 {
        return Err("车辆列表嵌套过深".into());
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect_fleet(item, depth + 1, fleet)?;
            }
        }
        Value::Object(map) => {
            if normalized(map, &["vin", "vehiclevin", "vehicleidentificationnumber"]).is_some() {
                if let Ok(vehicle) = parse_car(value) {
                    if !fleet.iter().any(|car| car.vin == vehicle.vin) {
                        fleet.push(vehicle);
                    }
                    return Ok(());
                }
            }
            for child in map.values() {
                collect_fleet(child, depth + 1, fleet)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn chronos_request(vin: &str) -> Vec<u8> {
    chronos_request_with(vin, "RCS", 0)
}

fn chronos_request_with_offset(vin: &str, offset: i32) -> Vec<u8> {
    chronos_request_with(vin, "RCS", offset)
}

fn chronos_request_with(vin: &str, client: &str, offset: i32) -> Vec<u8> {
    wire::bytes(
        1,
        &[
            wire::state_request(vin),
            wire::string(3, client),
            wire::bytes(4, &wire::integer(1, offset as i64 as u64)),
        ]
        .concat(),
    )
}

fn chronos_for(vin: &str, protocol: Protocol) -> Vec<u8> {
    match protocol {
        Protocol::Verified => chronos_request(vin),
        Protocol::Generic => chronos_request_with(vin, "PolestarApp", 0),
    }
}

fn chronos_for_offset(vin: &str, offset: i32, protocol: Protocol) -> Vec<u8> {
    match protocol {
        Protocol::Verified => chronos_request_with_offset(vin, offset),
        Protocol::Generic => chronos_request_with(vin, "PolestarApp", offset),
    }
}

fn read_path(kind: &str, protocol: Protocol) -> Option<(&'static str, bool, bool)> {
    let generic = protocol == Protocol::Generic;
    Some(match kind {
        "battery" => (
            "/services.vehiclestates.battery.BatteryService/GetLatestBattery",
            false,
            false,
        ),
        "exterior" => (
            "/services.vehiclestates.exterior.ExteriorService/GetLatestExterior",
            false,
            false,
        ),
        "climate" => (
            "/services.vehiclestates.parkingclimatization.ParkingClimatizationService/GetLatestParkingClimatization",
            false,
            false,
        ),
        "odometer" if generic => (
            "/services.vehiclestates.odometer.OdometerService/GetLatestOdometer",
            false,
            true,
        ),
        "odometer" => (
            "/services.vehiclestates.odometer.OdometerService/GetOdometer",
            false,
            true,
        ),
        "target" => ("/chronos.services.v1.TargetSocService/GetTargetSoc", true, true),
        "amperage" => ("/chronos.services.v1.AmpLimitService/GetAmpLimit", true, true),
        "health" if generic => (
            "/services.vehiclestates.health.HealthService/GetLatestHealth",
            false,
            true,
        ),
        "health" => ("/services.vehiclestates.health.HealthService/GetHealth", false, true),
        "airQuality" if generic => (
            "/services.vehiclestates.precleaning.PreCleaningService/GetLatestPreCleaning",
            false,
            true,
        ),
        "airQuality" => (
            "/services.vehiclestates.precleaning.PreCleaningService/GetPreCleaning",
            false,
            true,
        ),
        "location" if generic => (
            "/dtlinternet.DtlInternetService/GetLastParkedLocation",
            true,
            false,
        ),
        "location" => (
            "/dtlinternet.DtlInternetService/GetLastKnownLocation",
            true,
            false,
        ),
        "software" => (
            "/ota_mobcache.OtaDiscoveryService/GetSoftwareInfo",
            false,
            true,
        ),
        "softwareSchedule" => (
            "/ota_mobcache.SchedulerService/GetSchedule",
            false,
            true,
        ),
        "climateTimers" if generic => (
            "/chronos.services.v1.ParkingClimateTimerService/GetLatestTimers",
            true,
            true,
        ),
        "climateTimers" => (
            "/chronos.services.v1.ParkingClimateTimerService/GetTimers",
            true,
            true,
        ),
        "chargeTimer" => (
            "/chronos.services.v2.GlobalChargeTimerService/GetGlobalChargeTimerStream",
            true,
            true,
        ),
        "chargeLocations" => (
            "/chronos.services.v1.ChargeLocationService/GetChargeLocations",
            true,
            true,
        ),
        _ => return None,
    })
}

fn read_request(vin: &str, kind: &str, protocol: Protocol) -> Option<Vec<u8>> {
    Some(match kind {
        "software" => [wire::string(1, vin), wire::string(2, "zh-CN")].concat(),
        "softwareSchedule" | "location" => wire::string(1, vin),
        "target" | "amperage" | "climateTimers" | "chargeTimer" | "chargeLocations" => {
            chronos_for(vin, protocol)
        }
        "battery" | "exterior" | "climate" => match protocol {
            Protocol::Verified => wire::state_request(vin),
            Protocol::Generic => wire::string(2, vin),
        },
        "odometer" | "health" | "airQuality" => wire::string(2, vin),
        _ => return None,
    })
}

fn parse_reading(
    kind: &str,
    bytes: &[u8],
    vin: &str,
    protocol: Protocol,
) -> Result<(Value, Option<u64>)> {
    if !matches!(
        kind,
        "battery" | "exterior" | "climate" | "odometer" | "target" | "amperage"
    ) {
        return telemetry::parse(kind, bytes, vin, protocol);
    }
    let message = wire::payload_from(bytes, vin, protocol.payload_fields())?;
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

fn command_request(
    vehicle: &Vehicle,
    command: &Command,
    protocol: Protocol,
) -> Result<(String, Vec<u8>, bool)> {
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
                chronos_for(vin, protocol),
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
            body = chronos_for_offset(vin, offset, protocol);
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
            body = chronos_for(vin, protocol);
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
            match protocol {
                // P2 accepts a 32-bit float; the C3/Volvo 5.68 contract used by
                // HUANFU declares `compartmentTemperatureCelsius` as double.
                Protocol::Verified => body.extend(wire::float(3, value as f32)),
                Protocol::Generic => body.extend(wire::double(3, value)),
            }
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
            body = chronos_for(vin, protocol);
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
            assert!(command_request(&car, &command, Protocol::Verified).is_err());
            car.capabilities.insert(flag.into(), Some(false));
            assert!(command_request(&car, &command, Protocol::Verified).is_err());
            car.capabilities.insert(flag.into(), Some(true));
            let (path, body, chronos) =
                command_request(&car, &command, Protocol::Verified).unwrap();
            assert_eq!(path, format!("/invocation.InvocationService/{method}"));
            assert!(!chronos);
            assert_eq!(Message::parse(&body).unwrap().int(2), Some(field));
            car.owner = Some(false);
            assert!(command_request(&car, &command, Protocol::Verified).is_ok());
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
    fn generic_climate_temperature_uses_double_wire_type() {
        let vehicle = parse_car(&json!({
            "vin": "12345678901234567",
            "supportsParkingClimatization": true,
            "supportsParkingClimatizationCompartmentTemperatureSettings": true
        }))
        .unwrap();
        let command = Command {
            vin: vehicle.vin.clone(),
            action: "climateStart".into(),
            value: Some(22.0),
            ..Default::default()
        };
        let (_, body, _) = command_request(&vehicle, &command, Protocol::Generic).unwrap();
        let message = Message::parse(&body).unwrap();
        assert!(matches!(message.value(3), Some(wire::Value::Fixed64(_))));
        assert_eq!(Message::parse(&body).unwrap().number(3), Some(22.0));
        let (_, verified, _) = command_request(&vehicle, &command, Protocol::Verified).unwrap();
        assert!(matches!(
            Message::parse(&verified).unwrap().value(3),
            Some(wire::Value::Fixed32(_))
        ));
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
        let (_, bytes, _) = command_request(&vehicle, &command, Protocol::Verified).unwrap();
        assert_eq!(Message::parse(&bytes).unwrap().number(3), Some(22.0));
        command.value = Some(24.0);
        assert!(command_request(&vehicle, &command, Protocol::Verified).is_err());
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
        let (path, bytes, chronos) =
            command_request(&vehicle, &command, Protocol::Verified).unwrap();
        assert!(chronos);
        assert!(path.ends_with("/SetTargetSoc"));
        let message = Message::parse(&bytes).unwrap();
        assert_eq!(message.int(2), Some(90));
        assert_eq!(message.int(3), Some(3));
        for value in [49.0, 101.0, 80.5, f64::NAN] {
            command.value = Some(value);
            assert!(command_request(&vehicle, &command, Protocol::Verified).is_err());
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
        assert!(command_request(&car, &command, Protocol::Verified).is_err());
    }
    #[test]
    fn fleet_payload_may_be_nested_or_use_alias_keys() {
        let payload = json!({"data": {"vehicles": [
            {"vehicleVin": "12345678901234567", "model": "Polestar 4", "year": 2024,
             "remoteControlType": "HUANFU"},
            {"vin": "76543210987654321", "modelName": "Polestar 2", "modelYear": "2024",
             "remoteControlType": "ICUP", "supportsLock": true,
             "targetChargeLevelPercentageMinLimit": 50}
        ]}});
        let fleet = parse_fleet(&payload).unwrap();
        assert_eq!(fleet.len(), 2);
        assert_eq!(fleet[0].vin, "12345678901234567");
        assert_eq!(fleet[0].model, "Polestar 4");
        assert_eq!(fleet[0].model_year.as_deref(), Some("2024"));
        assert_eq!(fleet[0].platform.as_deref(), Some("HUANFU"));
        assert_eq!(fleet[1].capabilities.get("supportsLock"), Some(&Some(true)));
        assert_eq!(
            fleet[1].limits.get("targetChargeLevelPercentageMinLimit"),
            Some(&50.0)
        );
    }

    #[test]
    fn generic_protocol_uses_vin_only_reads_and_latest_methods() {
        let generic = Protocol::Generic;
        let body = read_request("12345678901234567", "battery", generic).unwrap();
        let message = Message::parse(&body).unwrap();
        assert_eq!(message.string(2).as_deref(), Some("12345678901234567"));
        assert!(message.value(1).is_none());
        assert_eq!(
            read_path("odometer", generic).unwrap().0,
            "/services.vehiclestates.odometer.OdometerService/GetLatestOdometer"
        );
        assert_eq!(
            read_path("climateTimers", generic).unwrap().0,
            "/chronos.services.v1.ParkingClimateTimerService/GetLatestTimers"
        );
        assert_eq!(
            read_path("location", generic).unwrap().0,
            "/dtlinternet.DtlInternetService/GetLastParkedLocation"
        );
        let verified = read_request("12345678901234567", "battery", Protocol::Verified).unwrap();
        assert!(Message::parse(&verified).unwrap().value(1).is_some());
    }

    #[test]
    fn unverified_platform_requires_explicit_opt_in_for_commands() {
        let mut client = ChinaClient::new().unwrap();
        client.fleet.push(
            parse_car(
                &json!({"vin": "12345678901234567", "modelName": "Polestar 4",
                "remoteControlType": "HUANFU", "supportsLock": true}),
            )
            .unwrap(),
        );
        let command = Command {
            vin: "12345678901234567".into(),
            action: "lock".into(),
            ..Default::default()
        };
        assert!(client.validate_command(&command).is_err());
        client.set_experimental(true);
        assert!(client.validate_command(&command).is_ok());
        // Reads stay available without the switch.
        client.set_experimental(false);
        assert!(client.vehicle_for_read(&command.vin).is_ok());
    }

    #[test]
    fn p4_envelope_and_fixed64_values_are_decoded() {
        let vin = "12345678901234567";
        // HUANFU chronos responses carry the payload in field 4, not field 3.
        let target = [
            wire::bytes(1, &[]),
            wire::string(2, vin),
            wire::bytes(4, &wire::integer(1, 90)),
        ]
        .concat();
        let (value, _) = parse_reading("target", &target, vin, Protocol::Generic).unwrap();
        assert_eq!(value["percent"], 90);
        assert!(parse_reading("target", &target, vin, Protocol::Verified).is_err());

        // P4 battery percentage is fixed64, and the envelope still uses field 3.
        let data = [
            wire::bytes(1, &[]),
            wire::double(2, 49.0),
            wire::integer(4, 227),
        ]
        .concat();
        let battery = [wire::string(2, vin), wire::bytes(3, &data)].concat();
        let (value, _) = parse_reading("battery", &battery, vin, Protocol::Generic).unwrap();
        assert_eq!(value["percent"], 49.0);
        assert_eq!(value["rangeKm"], 227.0);

        // P4 exterior: field 2 is the lock, fields 3..14 the openings.
        let exterior_data = [
            wire::bytes(1, &[]),
            wire::integer(2, 2),
            (3..=14)
                .flat_map(|field| wire::integer(field, 2))
                .collect::<Vec<_>>(),
            wire::integer(16, 2),
        ]
        .concat();
        let exterior = [wire::string(2, vin), wire::bytes(3, &exterior_data)].concat();
        let (value, _) = parse_reading("exterior", &exterior, vin, Protocol::Generic).unwrap();
        assert_eq!(value["locked"], true);
        assert_eq!(value["openings"]["tailgate"], 2);
    }

    #[test]
    fn missing_battery_is_unknown() {
        let (value, _) =
            parse_reading("battery", &wire::bytes(3, &[]), "test", Protocol::Verified).unwrap();
        assert!(value["percent"].is_null());
    }
}
