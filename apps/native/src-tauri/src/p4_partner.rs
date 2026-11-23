use crate::{archive::Archive, confirmation, now_ms, Command, Receipt, Result, Snapshot, Vehicle};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Lock,
    Unlock,
    ClimateStart,
    ClimateStop,
    Target { percent: u8 },
}

impl Action {
    fn command(&self, vin: &str) -> Command {
        let (name, value) = match self {
            Self::Lock => ("lock", None),
            Self::Unlock => ("unlock", None),
            Self::ClimateStart => ("climateStart", None),
            Self::ClimateStop => ("climateStop", None),
            Self::Target { percent } => ("target", Some(f64::from(*percent))),
        };
        Command {
            vin: vin.into(),
            action: name.into(),
            value,
            ..Default::default()
        }
    }

    fn same_setting(&self, other: &Self) -> bool {
        self.reading() == other.reading()
    }

    fn reading(&self) -> &'static str {
        match self {
            Self::Lock | Self::Unlock => "exterior",
            Self::ClimateStart | Self::ClimateStop => "climate",
            Self::Target { .. } => "target",
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grants {
    pub lock: bool,
    pub unlock: bool,
    pub climate_start: bool,
    pub climate_stop: bool,
    pub charge_targets: Vec<u8>,
}

impl Grants {
    fn permits(&self, action: &Action) -> bool {
        match action {
            Action::Lock => self.lock,
            Action::Unlock => self.unlock,
            Action::ClimateStart => self.climate_start,
            Action::ClimateStop => self.climate_stop,
            Action::Target { percent } => self.charge_targets.contains(percent),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    Accepted,
    Rejected,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub request_id: String,
    pub vehicle_ref: String,
    pub requested_at: u64,
    pub action: Action,
    pub status: Disposition,
    pub answered_at: Option<u64>,
    pub readback: Option<String>,
    pub readback_at: Option<u64>,
    pub reported_at: Option<u64>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    MissingClientId,
    AwaitingIntegration,
    AuthorizationRequired,
    Unavailable,
    Ready,
}

pub struct Scope<'a> {
    pub account: &'a str,
    pub vehicle: &'a Vehicle,
    pub vehicle_ref: &'a str,
    pub recording: i64,
}

#[async_trait]
pub trait PartnerAdapter: Send + Sync {
    async fn grants(&self, client_id: &str, account: &str, vin: &str) -> Result<Option<Grants>>;
    async fn submit(
        &self,
        client_id: &str,
        account: &str,
        vin: &str,
        id: &str,
        action: &Action,
    ) -> Disposition;
}

#[async_trait]
pub trait VehicleReadback: Send {
    async fn readback(&mut self, scope: &Scope<'_>, action: &Action) -> Result<Snapshot>;
}

#[async_trait]
impl VehicleReadback for crate::ChinaClient {
    async fn readback(&mut self, scope: &Scope<'_>, action: &Action) -> Result<Snapshot> {
        if self.account_scope().as_deref() != Some(scope.account) {
            return Err("账号已变更，请重新选择车辆".into());
        }
        let endpoint = action.reading();
        let reading = self.refresh_reading(&scope.vehicle.vin, endpoint).await?;
        if self.account_scope().as_deref() != Some(scope.account) {
            return Err("回读期间账号已变更".into());
        }
        Ok(Snapshot {
            vehicle: scope.vehicle.clone(),
            fetched_at: now_ms(),
            readings: [(endpoint.to_owned(), reading)].into(),
        })
    }
}

pub struct Service {
    client_id: Option<&'static str>,
    adapter: Option<Box<dyn PartnerAdapter>>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Status,
    Submit { request_id: String, action: Action },
    Check { request_id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    availability: Availability,
    grants: Grants,
    commands: Vec<CommandRecord>,
}

const SDK_TIMEOUT: Duration = Duration::from_secs(20);
const READBACK_WINDOW_MS: u64 = 600_000;

impl Service {
    pub fn new(client_id: Option<&'static str>, adapter: Option<Box<dyn PartnerAdapter>>) -> Self {
        Self {
            client_id: client_id.filter(|s| !s.trim().is_empty()),
            adapter,
        }
    }

    pub async fn handle(
        &self,
        archive: &mut Archive,
        reader: &mut dyn VehicleReadback,
        scope: Scope<'_>,
        op: Operation,
    ) -> Result<Panel> {
        if !scope
            .vehicle
            .platform
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case("HUANFU"))
        {
            return Err("请先选择当前账号的 Polestar 4".into());
        }
        let commands = archive.active_partner_commands(&scope)?;
        let mut panel = Panel {
            commands,
            grants: Grants::default(),
            availability: Availability::MissingClientId,
        };
        let Some(client_id) = self.client_id else {
            return finish_unavailable(panel, op);
        };
        let Some(adapter) = self.adapter.as_deref() else {
            panel.availability = Availability::AwaitingIntegration;
            return finish_unavailable(panel, op);
        };
        let vin = &scope.vehicle.vin;
        let granted = timeout(SDK_TIMEOUT, adapter.grants(client_id, scope.account, vin)).await;
        match granted {
            Ok(Ok(Some(mut grants))) => {
                grants.charge_targets.retain(|p| (1..=100).contains(p));
                grants.charge_targets.sort_unstable();
                grants.charge_targets.dedup();
                panel.grants = grants;
                panel.availability = Availability::Ready;
            }
            Ok(Ok(None)) => {
                panel.availability = Availability::AuthorizationRequired;
                return finish_unavailable(panel, op);
            }
            _ => {
                panel.availability = Availability::Unavailable;
                return finish_unavailable(panel, op);
            }
        }
        let mut record = match op {
            Operation::Status => return Ok(panel),
            Operation::Submit { request_id, action } => {
                let request_id = Uuid::parse_str(&request_id)
                    .map_err(|_| "请求编号无效")?
                    .to_string();
                if let Some(old) = panel.commands.iter().find(|r| r.request_id == request_id) {
                    if old.action != action {
                        return Err("请求编号已用于另一项操作".into());
                    }
                    return Ok(panel);
                }
                if !panel.grants.permits(&action) {
                    return Err("此账号与车辆尚未获准执行该操作".into());
                }
                if let Some(previous) = panel
                    .commands
                    .iter()
                    .rev()
                    .find(|r| r.action.same_setting(&action))
                {
                    if (previous.status == Disposition::Unknown
                        || (previous.status == Disposition::Accepted && previous.action == action))
                        && previous.readback.as_deref() != Some(confirmation::CONFIRMED)
                        && now_ms().saturating_sub(previous.requested_at) < READBACK_WINDOW_MS
                    {
                        return Err("上一条指令尚待确认，请先核对车辆状态".into());
                    }
                }
                let mut record = CommandRecord {
                    request_id,
                    vehicle_ref: scope.vehicle_ref.into(),
                    requested_at: now_ms(),
                    action,
                    status: Disposition::Unknown,
                    answered_at: None,
                    readback: None,
                    readback_at: None,
                    reported_at: None,
                };
                archive.insert_partner_command(&scope, &record)?;
                match timeout(
                    SDK_TIMEOUT,
                    adapter.submit(
                        client_id,
                        scope.account,
                        vin,
                        &record.request_id,
                        &record.action,
                    ),
                )
                .await
                {
                    Ok(status) => {
                        record.status = status;
                        record.answered_at = (status != Disposition::Unknown).then(now_ms);
                    }
                    Err(_) => record.status = Disposition::Unknown,
                }
                archive.update_partner_command(&scope, &record)?;
                record
            }
            Operation::Check { request_id } => {
                let record = panel
                    .commands
                    .iter()
                    .find(|r| r.request_id == request_id)
                    .ok_or("本轮没有这条指令")?;
                let latest = panel
                    .commands
                    .iter()
                    .rev()
                    .find(|r| r.action.same_setting(&record.action));
                if latest.is_none_or(|r| r.request_id != request_id) {
                    return Err("请核对该项目最近一次操作".into());
                }
                record.clone()
            }
        };
        if record.status != Disposition::Rejected
            && record.readback.as_deref() != Some(confirmation::CONFIRMED)
            && now_ms().saturating_sub(record.requested_at) <= READBACK_WINDOW_MS
        {
            match timeout(SDK_TIMEOUT, reader.readback(&scope, &record.action)).await {
                Ok(Ok(snapshot))
                    if snapshot.vehicle.vin == *vin
                        && snapshot
                            .vehicle
                            .platform
                            .as_deref()
                            .is_some_and(|p| p.eq_ignore_ascii_case("HUANFU"))
                        && snapshot.fetched_at <= now_ms() =>
                {
                    let mut receipt = Receipt {
                        id: record.request_id.clone(),
                        command: record.action.command(vin),
                        time: record.requested_at,
                        status: "unknown".into(),
                        message: String::new(),
                        readback: None,
                        readback_at: None,
                        baseline_timer_ids: None,
                        account_scope: None,
                    };
                    let reading = confirmation::endpoint(&receipt.command.action)
                        .and_then(|kind| snapshot.readings.get(kind))
                        .filter(|r| r.observed_at <= snapshot.fetched_at);
                    record.reported_at =
                        reading.and_then(|r| r.reported_at.filter(|t| *t <= r.observed_at));
                    if reading.is_some() {
                        confirmation::update(&mut receipt, &snapshot);
                    }
                    record.readback = receipt
                        .readback
                        .or_else(|| Some("等待操作后的车辆上报".into()));
                    record.readback_at = receipt.readback_at;
                }
                _ => {
                    record.readback = Some("回读失败，等待核对".into());
                    record.readback_at = None;
                    record.reported_at = None;
                }
            }
            archive.update_partner_command(&scope, &record)?;
        }
        panel.commands = archive.active_partner_commands(&scope)?;
        Ok(panel)
    }
}

fn finish_unavailable(panel: Panel, op: Operation) -> Result<Panel> {
    match op {
        Operation::Status => Ok(panel),
        _ => Err("当前没有可用的官方授权车控服务，未发送指令".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use norr_vehicle_core::models::Reading;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn vehicle() -> Vehicle {
        serde_json::from_value(json!({"vin":"FIXTURE-VIN","platform":"HUANFU","model":"P4","owner":false,"capabilities":{},"limits":{}})).unwrap()
    }

    struct Fixture {
        sent: Arc<AtomicUsize>,
        disposition: Disposition,
    }

    #[async_trait]
    impl PartnerAdapter for Fixture {
        async fn grants(&self, id: &str, account: &str, vin: &str) -> Result<Option<Grants>> {
            assert_eq!(id, "fixture-client");
            if account != "fixture-account" || vin != "FIXTURE-VIN" {
                return Ok(None);
            }
            Ok(Some(Grants {
                lock: true,
                unlock: true,
                climate_start: true,
                climate_stop: true,
                charge_targets: vec![90, 0, 90],
            }))
        }

        async fn submit(&self, _: &str, _: &str, _: &str, _: &str, _: &Action) -> Disposition {
            self.sent.fetch_add(1, Ordering::SeqCst);
            self.disposition
        }
    }

    #[async_trait]
    impl VehicleReadback for AtomicUsize {
        async fn readback(&mut self, _: &Scope<'_>, action: &Action) -> Result<Snapshot> {
            tokio::time::sleep(Duration::from_millis(3)).await;
            let index = self.fetch_add(1, Ordering::SeqCst);
            let reported = now_ms();
            let (kind, data) = match action {
                Action::Lock => ("exterior", json!({"locked":true})),
                Action::Unlock => ("exterior", json!({"locked":false})),
                Action::Target { percent } if index == 0 => {
                    ("target", json!({"referencePercent":percent}))
                }
                Action::Target { percent } => ("target", json!({"percent":percent})),
                Action::ClimateStart => ("climate", json!({"activity":"active"})),
                Action::ClimateStop => ("climate", json!({"activity":"idle"})),
            };
            let mut reading = Reading::success(data, Some(reported));
            if index == 1 && matches!(action, Action::Target { .. }) {
                reading.observed_at += 60_000;
            }
            Ok(Snapshot {
                vehicle: vehicle(),
                readings: [(kind.into(), reading)].into(),
                fetched_at: now_ms(),
            })
        }
    }

    fn scope(v: &Vehicle, id: i64) -> Scope<'_> {
        Scope {
            account: "fixture-account",
            vehicle: v,
            vehicle_ref: "car-one",
            recording: id,
        }
    }

    #[tokio::test]
    async fn submitted_commands_survive_retry_and_export_only_scoped_evidence() {
        let mut reader = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("norr-partner-{}.sqlite", Uuid::new_v4()));
        let mut db = Archive::open(&path).unwrap();
        db.begin_recording("fixture-account", 1).unwrap();
        let id = db.recordings("fixture-account").unwrap()[0].id;
        let vehicle = vehicle();
        let count = Arc::new(AtomicUsize::new(0));
        let service = Service::new(
            Some("fixture-client"),
            Some(Box::new(Fixture {
                sent: count.clone(),
                disposition: Disposition::Accepted,
            })),
        );
        let key = Uuid::new_v4().to_string();
        let send = |action| Operation::Submit {
            request_id: key.clone(),
            action,
        };
        let checkout = || Operation::Check {
            request_id: key.clone(),
        };
        let run = |percent| send(Action::Target { percent });
        assert!(service
            .handle(&mut db, &mut reader, scope(&vehicle, id), run(80))
            .await
            .is_err());
        let first = service
            .handle(&mut db, &mut reader, scope(&vehicle, id), run(90))
            .await
            .unwrap();
        assert_eq!(first.grants.charge_targets, vec![90]);
        assert_ne!(
            first.commands[0].readback.as_deref(),
            Some(confirmation::CONFIRMED)
        );
        service
            .handle(&mut db, &mut reader, scope(&vehicle, id), run(90))
            .await
            .unwrap();
        assert!(service
            .handle(
                &mut db,
                &mut reader,
                scope(&vehicle, id),
                send(Action::ClimateStart)
            )
            .await
            .is_err());
        assert!(service
            .handle(
                &mut db,
                &mut reader,
                scope(&vehicle, id),
                Operation::Submit {
                    request_id: Uuid::new_v4().to_string(),
                    action: Action::Target { percent: 90 }
                }
            )
            .await
            .is_err());
        drop(db);
        let mut db = Archive::open(&path).unwrap();
        let inconsistent = service
            .handle(&mut db, &mut reader, scope(&vehicle, id), checkout())
            .await
            .unwrap();
        assert!(inconsistent.commands[0].readback_at.is_none());
        assert!(inconsistent.commands[0].reported_at.is_none());
        let checked = service
            .handle(&mut db, &mut reader, scope(&vehicle, id), checkout())
            .await
            .unwrap();
        assert_eq!(
            checked.commands[0].readback.as_deref(),
            Some(confirmation::CONFIRMED)
        );
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let wrong = Scope {
            account: "another-account",
            ..scope(&vehicle, id)
        };
        assert!(service
            .handle(&mut db, &mut reader, wrong, checkout())
            .await
            .is_err());
        for action in [
            Action::ClimateStart,
            Action::Unlock,
            Action::ClimateStop,
            Action::Lock,
        ] {
            let out = service
                .handle(
                    &mut db,
                    &mut reader,
                    scope(&vehicle, id),
                    Operation::Submit {
                        request_id: Uuid::new_v4().to_string(),
                        action,
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                out.commands.last().unwrap().readback.as_deref(),
                Some(confirmation::CONFIRMED)
            );
        }
        db.finish_recording("fixture-account", id, now_ms() as i64)
            .unwrap();
        assert!(service
            .handle(&mut db, &mut reader, scope(&vehicle, id), checkout())
            .await
            .is_err());
        let log: serde_json::Value =
            serde_json::from_slice(&db.export_recording("fixture-account", id).unwrap()).unwrap();
        assert_eq!(log["vehicleControlTransport"], "norrPartner");
        assert_eq!(log["vehicleCommands"].as_array().unwrap().len(), 5);
        assert!(log["vehicleCommands"][0]["reportedAt"].is_number());
        for private in ["FIXTURE-VIN", "fixture-client", "fixture-account"] {
            assert!(!log.to_string().contains(private))
        }
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn missing_integration_and_service_rejection_remain_distinct() {
        let mut reader = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("norr-partner-{}.sqlite", Uuid::new_v4()));
        let mut db = Archive::open(&path).unwrap();
        db.begin_recording("fixture-account", 1).unwrap();
        let id = db.recordings("fixture-account").unwrap()[0].id;
        let car = vehicle();
        let submit = || Operation::Submit {
            request_id: Uuid::new_v4().to_string(),
            action: Action::ClimateStop,
        };
        for client_id in [None, Some("fixture-client")] {
            let svc = Service::new(client_id, None);
            let state = svc
                .handle(&mut db, &mut reader, scope(&car, id), Operation::Status)
                .await
                .unwrap();
            assert!(matches!(
                state.availability,
                Availability::MissingClientId | Availability::AwaitingIntegration
            ));
            assert!(svc
                .handle(&mut db, &mut reader, scope(&car, id), submit())
                .await
                .is_err());
            assert!(db
                .active_partner_commands(&scope(&car, id))
                .unwrap()
                .is_empty());
        }
        for expected in [Disposition::Rejected, Disposition::Unknown] {
            let sent = Arc::new(AtomicUsize::new(0));
            let svc = Service::new(
                Some("fixture-client"),
                Some(Box::new(Fixture {
                    sent: sent.clone(),
                    disposition: expected,
                })),
            );
            let state = svc
                .handle(&mut db, &mut reader, scope(&car, id), submit())
                .await
                .unwrap();
            let last = state.commands.last().unwrap();
            assert_eq!(last.status, expected);
            assert_eq!(last.readback.is_some(), expected == Disposition::Unknown);
            assert_eq!(
                last.answered_at.is_some(),
                expected == Disposition::Rejected
            );
            assert_eq!(sent.load(Ordering::SeqCst), 1);
        }
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
