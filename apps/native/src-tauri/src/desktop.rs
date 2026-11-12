use crate::{notifications::Notice, Result};
use serde::Serialize;
use std::{
    ffi::{c_char, CStr, CString},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        OnceLock,
    },
};
use tauri::{Emitter, Manager};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static WAKE_GENERATION: AtomicU64 = AtomicU64::new(0);
static SLEEPING: AtomicBool = AtomicBool::new(false);
static NOTIFICATION_TARGET: std::sync::Mutex<Option<serde_json::Value>> =
    std::sync::Mutex::new(None);

extern "C" {
    fn norr_desktop_initialize(callback: extern "C" fn(i32, *const c_char));
    fn norr_login_status() -> i32;
    fn norr_set_login(enabled: bool) -> *mut c_char;
    fn norr_notification_status(request: bool) -> i32;
    fn norr_post_notification(payload: *const c_char) -> *mut c_char;
    fn norr_free_string(value: *mut c_char);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    launch_at_login: i32,
    notifications: i32,
}

extern "C" fn event(kind: i32, payload: *const c_char) {
    match kind {
        1 => SLEEPING.store(true, Ordering::SeqCst),
        2 => {
            SLEEPING.store(false, Ordering::SeqCst);
            WAKE_GENERATION.fetch_add(1, Ordering::SeqCst);
        }
        3 => {
            if let Some(app) = APP.get() {
                let value = if payload.is_null() {
                    "{}"
                } else {
                    unsafe { CStr::from_ptr(payload) }.to_str().unwrap_or("{}")
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(value) {
                    if let Ok(mut target) = NOTIFICATION_TARGET.lock() {
                        *target = Some(value.clone());
                    }
                    let _ = app.emit("notification-open", value);
                }
            }
        }
        _ => {}
    }
}

pub fn take_notification_target() -> Option<serde_json::Value> {
    NOTIFICATION_TARGET.lock().ok()?.take()
}

pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
    unsafe { norr_desktop_initialize(event) };
}

pub fn wake_generation() -> u64 {
    WAKE_GENERATION.load(Ordering::SeqCst)
}
pub fn sleeping() -> bool {
    SLEEPING.load(Ordering::SeqCst)
}

pub fn status() -> Status {
    Status {
        launch_at_login: unsafe { norr_login_status() },
        notifications: unsafe { norr_notification_status(false) },
    }
}

fn system_result(error: *mut c_char) -> Result<()> {
    if error.is_null() {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { norr_free_string(error) };
    Err(message)
}

pub fn set_login(enabled: bool) -> Result<()> {
    system_result(unsafe { norr_set_login(enabled) })
}

pub fn request_notifications() -> Result<()> {
    match unsafe { norr_notification_status(true) } {
        2 | 3 => Ok(()),
        1 => Err("通知权限已关闭，请在系统设置中允许 Norr 通知".into()),
        _ => Err("通知授权尚未完成，可稍后重试".into()),
    }
}

pub fn notify(notice: &Notice) -> Result<()> {
    let json = serde_json::to_string(notice).map_err(|_| "通知内容编码失败")?;
    let payload = CString::new(json).map_err(|_| "通知内容无效")?;
    system_result(unsafe { norr_post_notification(payload.as_ptr()) })
}

pub fn open_settings(section: &str) -> Result<()> {
    let url = match section {
        "login" => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        "notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        _ => return Err("系统设置项目无效".into()),
    };
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|_| "无法打开系统设置")?;
    if status.success() {
        Ok(())
    } else {
        Err("无法打开系统设置".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sleep_and_wake_events_advance_the_collection_generation() {
        let previous = wake_generation();
        event(1, std::ptr::null());
        assert!(sleeping());
        event(2, std::ptr::null());
        assert!(!sleeping());
        assert_eq!(wake_generation(), previous + 1);
    }
}
