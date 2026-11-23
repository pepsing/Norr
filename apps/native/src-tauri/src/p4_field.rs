use super::{
    archive::p4_log::{OperationSource, Outcome, TestAction},
    exports, now_ms, Backend, Result, VehicleService,
};
use tauri::State;

pub(super) async fn log_scope(backend: &mut Backend, vin: &str) -> Result<String> {
    let owned = backend.client.vehicles().await?.iter().any(|car| {
        car.vin == vin
            && car
                .platform
                .as_deref()
                .is_some_and(|p| p.eq_ignore_ascii_case("HUANFU"))
    });
    if !owned {
        return Err("请在当前账号的车库中选择 Polestar 4".into());
    }
    let account = backend.client.account_scope().ok_or("请先登录")?;
    // macOS already opens a separate history database per account, with snapshots keyed by VIN.
    if cfg!(target_os = "macos") {
        Ok(vin.to_owned())
    } else {
        Ok(format!("{account}/{vin}"))
    }
}

#[tauri::command]
pub async fn open_field_log(state: State<'_, VehicleService>, vin: String) -> Result<()> {
    let mut backend = state.lock().await;
    let scope = log_scope(&mut backend, &vin).await?;
    #[cfg(target_os = "macos")]
    if backend.history.settings.selected_vin.as_deref() != Some(vin.as_str()) {
        let previous = backend.history.settings.selected_vin.replace(vin);
        if let Err(error) = backend.save() {
            backend.history.settings.selected_vin = previous;
            return Err(error);
        }
    }
    backend.archive.start_field_log(&scope, now_ms())
}

#[tauri::command]
pub async fn mark_field_log(
    state: State<'_, VehicleService>,
    vin: String,
    action: TestAction,
    outcome: Outcome,
    source: OperationSource,
) -> Result<()> {
    let mut backend = state.lock().await;
    let scope = log_scope(&mut backend, &vin).await?;
    backend
        .archive
        .field_observation(&scope, now_ms(), action, outcome, source)
}

#[tauri::command]
pub async fn export_field_log(state: State<'_, VehicleService>, vin: String) -> Result<bool> {
    let bytes = {
        let mut backend = state.lock().await;
        let scope = log_scope(&mut backend, &vin).await?;
        backend.archive.p4_log(&scope, now_ms())?
    };
    tauri::async_runtime::spawn_blocking(move || exports::save(bytes, "p4-log"))
        .await
        .map_err(|_| "导出未完成")?
}
