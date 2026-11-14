use crate::Result;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "ios")]
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

#[cfg(target_os = "ios")]
static TARGET: Mutex<Option<Target>> = Mutex::new(None);

#[cfg(target_os = "ios")]
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

#[cfg(target_os = "ios")]
pub fn open_url(app: &tauri::AppHandle, url: &tauri::Url) {
    if let Some(target) = target_from_url(url) {
        *TARGET.lock().unwrap() = Some(target);
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
    #[cfg(target_os = "ios")]
    return Ok(TARGET.lock().unwrap().take());
    #[cfg(target_os = "android")]
    crate::mobile::call_async("takeWidgetTarget", serde_json::json!({})).await
}

#[tauri::command]
pub async fn update_widgets(app: tauri::AppHandle, data: WidgetData) -> Result<()> {
    let path = &data.artwork;
    if !path.starts_with("images/vehicles/") || path.contains("..") || !path.ends_with("-side.jpg")
    {
        return Err("小组件车辆图片地址无效".into());
    }
    let directory = crate::mobile::data_directory()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let image_path = directory.join("widget-vehicle.jpg");
    #[cfg(target_os = "ios")]
    let dark_image_path = directory.join("widget-vehicle-dark.webp");
    #[cfg(target_os = "ios")]
    let dark_artwork = path.replace("-side.jpg", "-side-cutout.webp");
    for (source, destination) in [
        (path, &image_path),
        #[cfg(target_os = "ios")]
        (&dark_artwork, &dark_image_path),
    ] {
        let asset = app
            .asset_resolver()
            .get(source.clone())
            .ok_or("小组件车辆图片不可用")?;
        let temporary = destination.with_extension("tmp");
        std::fs::write(&temporary, asset.bytes).map_err(|error| error.to_string())?;
        std::fs::rename(temporary, destination).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::json!({"data": data, "imagePath": image_path});
    #[cfg(target_os = "ios")]
    let payload = {
        let mut payload = payload;
        payload["darkImagePath"] = serde_json::json!(dark_image_path);
        payload
    };
    crate::mobile::call_async("updateWidgets", payload).await
}
