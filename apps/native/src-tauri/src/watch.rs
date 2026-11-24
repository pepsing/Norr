use crate::Result;
use norr_vehicle_core::{china::ChinaClient, now_ms};

#[cfg(not(feature = "p4-field-test"))]
#[tauri::command]
pub async fn sync_watch(
    state: tauri::State<'_, crate::vehicle_service::VehicleService>,
    vin: String,
    clear: Option<bool>,
) -> Result<()> {
    let mut backend = state.lock().await;
    synchronize(&mut backend.client, &vin, clear.unwrap_or(false), false).await
}

pub async fn synchronize(
    client: &mut ChinaClient,
    vin: &str,
    clear: bool,
    automatic: bool,
) -> Result<()> {
    if clear {
        let authorization = serde_json::json!({
            "version": now_ms(), "account": "", "vin": "", "accessToken": "", "expiresAt": 0,
        });
        return crate::mobile::call_async(
            "syncWatch",
            serde_json::json!({"authorization": authorization.to_string(), "automatic": automatic}),
        )
        .await;
    }
    if automatic {
        #[derive(serde::Deserialize)]
        struct Status {
            enabled: bool,
        }
        let status: Status =
            crate::mobile::call_async("watchSyncStatus", serde_json::json!({})).await?;
        if !status.enabled {
            return Ok(());
        }
    }
    if vin.len() != 17 || !vin.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("请选择有效车辆后同步".into());
    }
    let authorization = client.watch_authorization(vin).await?;
    crate::mobile::call_async(
        "syncWatch",
        serde_json::json!({"authorization": authorization.to_string(), "automatic": automatic}),
    )
    .await
}
