use crate::Result;
#[cfg(target_os = "android")]
use norr_vehicle_core::credentials::android::SecureStorage;
use serde::de::DeserializeOwned;
#[cfg(target_os = "android")]
use serde::Deserialize;
#[cfg(target_os = "android")]
use serde_json::json;
use serde_json::Value;
use std::{path::PathBuf, sync::OnceLock};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Wry,
};

static PLUGIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();
static DATA_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub fn call<T: DeserializeOwned>(command: &str, args: Value) -> Result<T> {
    PLUGIN
        .get()
        .ok_or("移动系统接口尚未就绪")?
        .run_mobile_plugin(command, args)
        .map_err(|error| format!("{error}"))
}

pub async fn call_async<T: DeserializeOwned>(command: &str, args: Value) -> Result<T> {
    PLUGIN
        .get()
        .ok_or("移动系统接口尚未就绪")?
        .run_mobile_plugin_async(command, args)
        .await
        .map_err(|error| format!("{error}"))
}

pub fn data_directory() -> Result<PathBuf> {
    DATA_DIRECTORY
        .get()
        .cloned()
        .ok_or_else(|| "移动应用数据目录尚未就绪".into())
}

#[cfg(target_os = "android")]
struct Storage;
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct StoredValue {
    value: Option<String>,
}
#[cfg(target_os = "android")]
impl SecureStorage for Storage {
    fn read(&self, account: &str) -> Result<Option<String>> {
        call::<StoredValue>("readCredential", json!({"account":account})).map(|result| result.value)
    }
    fn write(&self, account: &str, value: &str) -> Result<()> {
        call("writeCredential", json!({"account":account,"value":value}))
    }
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_norr);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("norr-mobile")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("app.norr.mobile", "NorrPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_norr)?;
            PLUGIN.set(handle).map_err(|_| "移动系统接口重复初始化")?;
            DATA_DIRECTORY
                .set(app.path().app_data_dir()?.join("files"))
                .map_err(|_| "移动应用数据目录重复初始化")?;
            #[cfg(target_os = "android")]
            norr_vehicle_core::credentials::android::initialize(Box::new(Storage))?;
            Ok(())
        })
        .build()
}
