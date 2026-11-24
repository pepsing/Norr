use crate::Result;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Manager;
#[cfg(any(target_os = "ios", target_os = "macos"))]
use {std::sync::Mutex, tauri::Emitter};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetData {
    vin: String,
    model: String,
    battery_percent: Option<f64>,
    range_km: Option<f64>,
    locked: Option<bool>,
    climate: String,
    charging: Option<i32>,
    updated_at: Option<i64>,
    artwork: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Target {
    vin: String,
    action: String,
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
static TARGET: Mutex<Option<Target>> = Mutex::new(None);

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn target_from_url(url: &tauri::Url) -> Option<Target> {
    if url.scheme() != "norr" || url.host_str() != Some("widget") {
        return None;
    }
    let action = url.path().trim_start_matches('/');
    if !["vehicle", "lock", "climate", "refresh"].contains(&action) {
        return None;
    }
    let vin = url
        .query_pairs()
        .find(|(name, _)| name == "vin")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    Some(Target {
        vin,
        action: action.into(),
    })
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn open_url(app: &tauri::AppHandle, url: &tauri::Url) {
    if let Some(target) = target_from_url(url) {
        *TARGET.lock().unwrap() = Some(target);
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app.emit("widget-open", ());
    }
}

#[cfg(target_os = "ios")]
#[no_mangle]
unsafe extern "C" fn norr_widget_launch_url(value: *const std::ffi::c_char) {
    if value.is_null() {
        return;
    }
    // UIKit owns this UTF-8 string for the duration of its launch notification.
    if let Ok(value) = unsafe { std::ffi::CStr::from_ptr(value) }.to_str() {
        if let Ok(url) = tauri::Url::parse(value) {
            if let Some(target) = target_from_url(&url) {
                *TARGET.lock().unwrap() = Some(target);
            }
        }
    }
}

#[tauri::command]
pub async fn take_widget_target() -> Result<Option<Target>> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    return Ok(TARGET.lock().unwrap().take());
    #[cfg(target_os = "android")]
    crate::mobile::call_async("takeWidgetTarget", serde_json::json!({})).await
}

#[tauri::command]
pub async fn update_widgets(app: tauri::AppHandle, data: Option<WidgetData>) -> Result<()> {
    let Some(data) = data else {
        #[cfg(target_os = "android")]
        return crate::mobile::call_async("clearWidgets", serde_json::json!({})).await;
        #[cfg(not(target_os = "android"))]
        return Err("此平台尚不支持清除小组件数据".into());
    };
    if cfg!(all(target_os = "macos", feature = "polestar4-test")) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let _update = UPDATE.lock().map_err(|_| "小组件同步锁不可用")?;
    let path = &data.artwork;
    if !path.starts_with("images/vehicles/") || path.contains("..") || !path.ends_with("-side.jpg")
    {
        return Err("小组件车辆图片地址无效".into());
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let directory = crate::mobile::data_directory()?;
    #[cfg(target_os = "macos")]
    let directory = crate::platform::data_directory()?.join("widgets");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    crate::platform::private_directory(&directory)?;
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let image_path = directory.join("widget-vehicle.jpg");
    #[cfg(target_os = "macos")]
    let image_path = directory.join(format!("vehicle-{}", path.replace('/', "-")));
    let dark_artwork = path.replace("-side.jpg", "-side-cutout.webp");
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let dark_image_path = directory.join("widget-vehicle-dark.webp");
    #[cfg(target_os = "macos")]
    let dark_image_path = directory.join(format!("vehicle-{}", dark_artwork.replace('/', "-")));
    for (source, destination) in [(path, &image_path), (&dark_artwork, &dark_image_path)] {
        let asset = app
            .asset_resolver()
            .get(source.clone())
            .ok_or("小组件车辆图片不可用")?;
        let temporary = destination.with_extension("tmp");
        std::fs::write(&temporary, asset.bytes).map_err(|error| error.to_string())?;
        crate::platform::private_path(&temporary, 0o600)?;
        std::fs::rename(temporary, destination).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let record = serde_json::json!({
            "data": data,
            "imageName": image_path.file_name().unwrap().to_string_lossy(),
            "darkImageName": dark_image_path.file_name().unwrap().to_string_lossy(),
        });
        let temporary = directory.join("vehicle.json.tmp");
        let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
        std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        crate::platform::private_path(&temporary, 0o600)?;
        std::fs::rename(temporary, directory.join("vehicle.json"))
            .map_err(|error| error.to_string())?;
        unsafe { norr_widgets_reload() };
        Ok(())
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let payload = serde_json::json!({
            "data": data, "imagePath": image_path, "darkImagePath": dark_image_path,
        });
        crate::mobile::call_async("updateWidgets", payload).await
    }
}

#[cfg(target_os = "macos")]
static UPDATE: Mutex<()> = Mutex::new(());

#[cfg(target_os = "macos")]
extern "C" {
    fn norr_widgets_reload();
}

#[cfg(all(test, any(target_os = "ios", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn widget_links_accept_only_supported_actions() {
        for action in ["vehicle", "lock", "climate", "refresh"] {
            let url = format!("norr://widget/{action}?vin=TEST123")
                .parse()
                .unwrap();
            let target = target_from_url(&url).unwrap();
            assert_eq!(target.action, action);
            assert_eq!(target.vin, "TEST123");
        }
        for url in [
            "https://widget/lock",
            "norr://other/lock",
            "norr://widget/unlock",
        ] {
            assert!(target_from_url(&url.parse().unwrap()).is_none());
        }
        let target = target_from_url(&"norr://widget/vehicle".parse().unwrap()).unwrap();
        assert!(target.vin.is_empty());
    }
}
