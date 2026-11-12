use crate::{mobile, notifications::Notice, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    launch_at_login: i32,
    notifications: i32,
}

pub fn initialize(_app: tauri::AppHandle) {}
pub fn wake_generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

pub fn sleeping() -> bool {
    #[derive(Deserialize)]
    struct Lifecycle {
        active: bool,
        generation: u64,
    }
    match mobile::call::<Lifecycle>("lifecycle", json!({})) {
        Ok(state) => {
            GENERATION.store(state.generation, Ordering::SeqCst);
            !state.active
        }
        Err(_) => true,
    }
}

pub fn status() -> Status {
    mobile::call("systemStatus", json!({})).unwrap_or(Status {
        launch_at_login: -1,
        notifications: -1,
    })
}

pub fn set_login(_enabled: bool) -> Result<()> {
    Err("移动端自动采集在应用前台运行时进行".into())
}

pub fn request_notifications() -> Result<()> {
    mobile::call("requestNotifications", json!({}))
}

pub fn notify(notice: &Notice) -> Result<()> {
    mobile::call(
        "postNotification",
        serde_json::to_value(notice).map_err(|_| "通知内容无效")?,
    )
}

pub fn open_settings(section: &str) -> Result<()> {
    mobile::call("openSettings", json!({"section":section}))
}

pub fn take_notification_target() -> Option<Value> {
    mobile::call("takeNotificationTarget", json!({}))
        .ok()
        .flatten()
}
