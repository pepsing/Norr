use crate::{notifications::Notice, Result};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, OnceLock,
};
use tauri::{Emitter, Manager};
use windows::{
    core::{HRESULT, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::{
        Foundation::{HANDLE, RPC_E_CHANGED_MODE},
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
            Power::{PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS},
        },
        UI::{
            Shell::SetCurrentProcessExplicitAppUserModelID,
            WindowsAndMessaging::{
                DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
                PBT_APMSUSPEND,
            },
        },
    },
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
    RegKey,
};

const APP_ID: &str = "app.norr.windows";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static SLEEPING: AtomicBool = AtomicBool::new(false);
static WAKE_GENERATION: AtomicU64 = AtomicU64::new(0);
static TARGET: Mutex<Option<serde_json::Value>> = Mutex::new(None);
static TOASTS: Mutex<Vec<ToastNotification>> = Mutex::new(Vec::new());

pub(crate) struct Apartment(bool);
impl Apartment {
    pub fn new() -> windows::core::Result<Self> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self(false));
        }
        result.ok()?;
        Ok(Self(true))
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    launch_at_login: i32,
    notifications: i32,
}

unsafe extern "system" fn power_event(
    _: *const std::ffi::c_void,
    kind: u32,
    _: *const std::ffi::c_void,
) -> u32 {
    match kind {
        PBT_APMSUSPEND => SLEEPING.store(true, Ordering::SeqCst),
        PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => {
            SLEEPING.store(false, Ordering::SeqCst);
            WAKE_GENERATION.fetch_add(1, Ordering::SeqCst);
        }
        _ => {}
    }
    0
}

pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app.clone());
    if let Err(error) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) } {
        let _ = app.emit(
            "desktop-failed",
            format!("Windows 通知标识设置失败（{}）", error.code()),
        );
    }
    let parameters = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(power_event),
        Context: std::ptr::null_mut(),
    });
    let pointer = Box::into_raw(parameters);
    let mut registration = std::ptr::null_mut();
    let result = unsafe {
        PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            HANDLE(pointer.cast()),
            &mut registration,
        )
    };
    if result.0 != 0 {
        unsafe {
            drop(Box::from_raw(pointer));
        }
        let _ = app.emit("desktop-failed", "Windows 唤醒事件注册失败");
    }
}

pub fn wake_generation() -> u64 {
    WAKE_GENERATION.load(Ordering::SeqCst)
}
pub fn sleeping() -> bool {
    SLEEPING.load(Ordering::SeqCst)
}
pub fn take_notification_target() -> Option<serde_json::Value> {
    TARGET.lock().ok()?.take()
}

fn startup_command() -> Result<String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位 Norr 安装位置")?;
    Ok(format!("\"{}\"", executable.display()))
}

fn login_status() -> i32 {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let configured = current_user
        .open_subkey(RUN_KEY)
        .and_then(|key| key.get_value::<String, _>("Norr"));
    let Ok(command) = configured else {
        return 0;
    };
    if startup_command().as_deref() != Ok(command.as_str()) {
        return 3;
    }
    if let Ok(key) = current_user
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run")
    {
        if let Ok(value) = key.get_raw_value("Norr") {
            if value
                .bytes
                .first()
                .is_some_and(|state| *state == 3 || *state == 7)
            {
                return 2;
            }
        }
    }
    1
}

pub fn set_login(enabled: bool) -> Result<()> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    if enabled {
        let (key, _) = current_user
            .create_subkey(RUN_KEY)
            .map_err(|_| "无法打开 Windows 启动项")?;
        key.set_value("Norr", &startup_command()?)
            .map_err(|_| "无法保存 Windows 启动项")?;
    } else if let Ok(key) = current_user.open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE) {
        match key.delete_value("Norr") {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法移除 Windows 启动项".into()),
        }
    }
    Ok(())
}

fn notification_status() -> windows::core::Result<i32> {
    let _apartment = Apartment::new()?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?;
    Ok(if notifier.Setting()? == NotificationSetting::Enabled {
        2
    } else {
        1
    })
}

pub fn status() -> Status {
    Status {
        launch_at_login: login_status(),
        notifications: notification_status().unwrap_or(-1),
    }
}

pub fn request_notifications() -> Result<()> {
    match notification_status() {
        Ok(2) => Ok(()),
        Ok(_) => Err("通知已关闭，请在 Windows 系统通知设置中允许 Norr 通知".into()),
        Err(_) => Err("Windows 通知不可用，请通过安装包安装 Norr 后重试".into()),
    }
}

pub fn notify(notice: &Notice) -> Result<()> {
    post_notification(notice).map_err(|error| format!("Windows 通知发送失败（{}）", error.code()))
}

fn post_notification(notice: &Notice) -> windows::core::Result<()> {
    let _apartment = Apartment::new()?;
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from("<toast><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual></toast>"))?;
    let texts = document.GetElementsByTagName(&HSTRING::from("text"))?;
    texts
        .Item(0)?
        .AppendChild(&document.CreateTextNode(&HSTRING::from(&notice.title))?)?;
    texts
        .Item(1)?
        .AppendChild(&document.CreateTextNode(&HSTRING::from(&notice.body))?)?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    let target = serde_json::json!({"vin": notice.vin, "page": notice.page});
    toast.Activated(&TypedEventHandler::new(move |_, _| {
        if let Ok(mut pending) = TARGET.lock() {
            *pending = Some(target.clone());
        }
        if let Some(app) = APP.get() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("notification-open", target.clone());
        }
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?.Show(&toast)?;
    let mut toasts = TOASTS
        .lock()
        .map_err(|_| windows::core::Error::from_hresult(HRESULT(0x80004005u32 as i32)))?;
    if toasts.len() >= 64 {
        toasts.remove(0);
    }
    toasts.push(toast);
    Ok(())
}

pub fn open_settings(section: &str) -> Result<()> {
    crate::platform::open_url(match section {
        "login" => "ms-settings:startupapps",
        "notifications" => "ms-settings:notifications",
        _ => return Err("系统设置项目无效".into()),
    })
}
