use crate::Result;
use norr_vehicle_core::{credentials, now_ms};

#[tauri::command]
pub async fn sync_watch(vin: String, clear: Option<bool>) -> Result<()> {
    synchronize(&vin, clear.unwrap_or(false), false).await
}

pub async fn synchronize(vin: &str, clear: bool, automatic: bool) -> Result<()> {
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
    if vin.len() != 17 || !vin.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("请选择有效车辆后同步".into());
    }
    let session = tauri::async_runtime::spawn_blocking(credentials::load_session)
        .await
        .map_err(|_| "读取登录态失败")??
        .ok_or("请先登录并恢复车辆连接")?;
    if session.needs_refresh() {
        return Err("请先恢复车辆连接以更新登录态，再同步手表".into());
    }
    let authorization = serde_json::json!({
        "version": now_ms(),
        "account": session.login.user_uid,
        "vin": vin,
        "accessToken": session.login.globle_token.access_token,
        "expiresAt": session.expires_at(),
    });
    crate::mobile::call_async(
        "syncWatch",
        serde_json::json!({"authorization": authorization.to_string(), "automatic": automatic}),
    )
    .await
}
