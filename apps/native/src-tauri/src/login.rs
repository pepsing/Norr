use norr_vehicle_core::{auth::PhoneLogin, credentials, Result};
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::ffi::{c_char, CStr};
use tauri::{Emitter, State};
use tokio::sync::Mutex;

#[cfg(target_os = "macos")]
use norr_vehicle_core::auth::Verification;

#[cfg(target_os = "macos")]
extern "C" {
    fn norr_china_verification() -> *mut c_char;
    fn norr_free_string(value: *mut c_char);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFailure {
    message: String,
    retry_at: u64,
}

#[cfg(target_os = "macos")]
fn verify_phone() -> Result<Option<Verification>> {
    let pointer = unsafe { norr_china_verification() };
    if pointer.is_null() {
        return Err("手机验证未完成，请重试".into());
    }
    let result = unsafe { CStr::from_ptr(pointer) }.to_bytes().to_vec();
    unsafe { norr_free_string(pointer) };
    let value: serde_json::Value =
        serde_json::from_slice(&result).map_err(|_| "验证结果格式无效")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.into());
    }
    serde_json::from_value(value).map_err(|_| "验证结果无效，请重新验证".into())
}

#[tauri::command]
pub async fn request_login_code(
    window: tauri::WebviewWindow,
    state: State<'_, Mutex<PhoneLogin>>,
    phone: String,
) -> std::result::Result<Option<u64>, SendFailure> {
    let mut flow = state.try_lock().map_err(|_| SendFailure {
        message: "登录操作正在进行，请完成或取消当前验证".into(),
        retry_at: 0,
    })?;
    let result: Result<Option<u64>> =
        async {
            if window.label() != "main" {
                return Err("请在 Norr 主窗口登录".into());
            }
            flow.ready_to_send(&phone)?;
            credentials::signing_key()?;
            #[cfg(target_os = "macos")]
            let verification = tauri::async_runtime::spawn_blocking(verify_phone)
                .await
                .map_err(|_| "手机验证未完成")??;
            #[cfg(target_os = "windows")]
            let verification = crate::verification_windows::verify(&window).await?;
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let verification = crate::mobile::call_async::<
                Option<norr_vehicle_core::auth::Verification>,
            >("verifyPhone", serde_json::json!({}))
            .await?;
            match verification {
                Some(verification) => flow.send_code(&phone, verification).await.map(Some),
                None => Ok(None),
            }
        }
        .await;
    result.map_err(|message| SendFailure {
        message,
        retry_at: flow.retry_at(),
    })
}

#[tauri::command]
pub async fn sign_in_phone(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Mutex<PhoneLogin>>,
    backend: State<'_, Mutex<crate::Backend>>,
    phone: String,
    code: String,
) -> Result<credentials::SessionStatus> {
    if window.label() != "main" {
        return Err("请在 Norr 主窗口登录".into());
    }
    let mut flow = state
        .try_lock()
        .map_err(|_| "登录操作正在进行，请稍后再试")?;
    let mut backend = backend.lock().await;
    let session = flow.sign_in(&phone, &code).await?;
    let client = norr_vehicle_core::china::ChinaClient::new()?;
    credentials::save_session(&session)?;
    backend.client = client;
    backend.history.settings.selected_vin = None;
    flow.finish();
    if let Err(error) = backend.save() {
        let _ = app.emit("desktop-failed", error);
    }
    Ok(credentials::SessionStatus {
        has_session: true,
        has_signing_key: true,
        expires_at: Some(session.expires_at()),
    })
}
