use super::archive::p4_log::{OperationSource, Outcome, TestAction};
use super::{
    archive::p4_recordings::Recording, credentials, exports, now_ms, Backend, Result, Vehicle,
    VehicleService,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;

fn signed_in_account() -> Result<String> {
    credentials::load_session()?
        .map(|session| session.account_scope())
        .ok_or("请先登录中国区账号".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    List,
    Start,
    Finish,
}

#[tauri::command]
pub async fn field_recordings(
    state: State<'_, VehicleService>,
    operation: Operation,
    id: Option<i64>,
) -> Result<Vec<Recording>> {
    let backend = state.lock().await;
    let account = signed_in_account()?;
    match operation {
        Operation::List => (),
        Operation::Start => backend.archive.begin_recording(&account, now_ms() as i64)?,
        Operation::Finish => backend.archive.finish_recording(
            &account,
            id.ok_or("缺少记录编号")?,
            now_ms() as i64,
        )?,
    }
    backend.archive.recordings(&account)
}

#[tauri::command]
pub async fn record_session_observation(
    state: State<'_, VehicleService>,
    id: i64,
    vin: String,
    action: TestAction,
    outcome: Outcome,
    source: OperationSource,
) -> Result<()> {
    let mut backend = state.lock().await;
    let account = signed_in_account()?;
    let scope = super::p4_field::log_scope(&mut backend, &vin).await?;
    if backend.client.account_scope().as_ref() != Some(&account) {
        return Err("账号已变更，请重新选择车辆".into());
    }
    let vehicle_ref = vehicle_reference(id, &scope);
    backend.archive.recording_observation(&account, id, now_ms() as i64, &json!({
        "operation":"manualObservation", "vehicleRef":vehicle_ref, "action":action, "outcome":outcome, "operationSource":source
    }))
}

fn vehicle_reference(id: i64, scope: &str) -> String {
    let digest = Sha256::digest(format!("{id}/{scope}"));
    format!("{:x}", digest)[..12].to_owned()
}

#[tauri::command]
pub async fn read_recording_vehicle(
    state: State<'_, VehicleService>,
    id: i64,
    vin: String,
) -> Result<Value> {
    let mut backend = state.lock().await;
    let account = signed_in_account()?;
    if !backend
        .archive
        .recordings(&account)?
        .iter()
        .any(|r| r.id == id && r.finished_at.is_none())
    {
        return Err("请先开始本轮记录".into());
    }
    let scope = match super::p4_field::log_scope(&mut backend, &vin).await {
        Ok(scope) => scope,
        Err(error) => {
            backend.archive.recording_observation(&account, id, now_ms() as i64, &json!({
                "operation":"readVehicle", "source":"c3", "phase":"failed", "step":"vehicleSelection"
            }))?;
            return Err(error);
        }
    };
    if backend.client.account_scope().as_ref() != Some(&account) {
        return Err("账号已变更，请重新选择车辆".into());
    }
    let result = backend.client.refresh(&vin).await;
    let time = now_ms() as i64;
    let mut event =
        json!({"operation":"readVehicle","source":"c3","vehicleRef":vehicle_reference(id, &scope)});
    match &result {
        Ok(snapshot) => {
            event["sample"] = norr_vehicle_core::p4_readback::recording_sample(snapshot);
            event["phase"] = json!("completed");
        }
        Err(_) => event["phase"] = json!("failed"),
    }
    backend
        .archive
        .recording_observation(&account, id, time, &event)?;
    result.map(|_| event["sample"].take())
}

#[tauri::command]
pub async fn share_recording(state: State<'_, VehicleService>, id: i64) -> Result<bool> {
    let bytes = {
        let backend = state.lock().await;
        backend
            .archive
            .export_recording(&signed_in_account()?, id)?
    };
    tauri::async_runtime::spawn_blocking(move || exports::save(bytes, "p4-log"))
        .await
        .map_err(|_| "日志导出未完成")?
}

pub async fn read_garage(backend: &mut Backend) -> Result<Vec<Vehicle>> {
    let account = signed_in_account()?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let mut event = json!({"operation":"readGarage","operationId":operation_id,"phase":"started"});
    backend
        .archive
        .garage_event(&account, now_ms() as i64, &event)?;
    let result = backend.client.connect().await;
    match &result {
        Ok(cars) => {
            event["phase"] = json!("completed");
            event["p4Count"] = json!(cars
                .iter()
                .filter(|car| car
                    .platform
                    .as_deref()
                    .is_some_and(|p| p.eq_ignore_ascii_case("HUANFU")))
                .count());
        }
        Err(error) => {
            event["phase"] = json!("failed");
            if let Some(status) = error
                .split("HTTP ")
                .nth(1)
                .and_then(|s| s.get(..3))
                .and_then(|s| s.parse::<u16>().ok())
                .filter(|s| (400..600).contains(s))
            {
                event["httpStatus"] = json!(status);
            }
        }
    }
    backend
        .archive
        .garage_event(&account, now_ms() as i64, &event)?;
    result
}
