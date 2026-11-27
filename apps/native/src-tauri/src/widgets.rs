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
    #[cfg(target_os = "ios")]
    #[serde(default)]
    carplay_front: bool,
    #[serde(default)]
    freshness_pending: bool,
    #[serde(default, skip_deserializing)]
    account_scope: Option<String>,
    #[serde(default)]
    observed_at: Option<u64>,
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
pub async fn update_widgets(
    app: tauri::AppHandle,
    service: tauri::State<'_, crate::vehicle_service::VehicleService>,
    data: Option<WidgetData>,
) -> Result<()> {
    let Some(mut data) = data else {
        #[cfg(target_os = "android")]
        return crate::mobile::call_async("clearWidgets", serde_json::json!({})).await;
        #[cfg(target_os = "ios")]
        return crate::mobile::call_async("updateWidgets", serde_json::json!({"clear": true}))
            .await;
        #[cfg(target_os = "macos")]
        {
            let _update = UPDATE.lock().map_err(|_| "小组件同步锁不可用")?;
            if cfg!(feature = "polestar4-test") {
                return Ok(());
            }
            clear_record(&crate::platform::data_directory()?.join("widgets"))?;
            unsafe { norr_widgets_reload() };
            return Ok(());
        }
    };
    data.account_scope = service.lock().await.client.account_scope();
    #[cfg(target_os = "macos")]
    let _update = UPDATE.lock().map_err(|_| "小组件同步锁不可用")?;
    if cfg!(all(target_os = "macos", feature = "polestar4-test")) {
        return Ok(());
    }
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
    let write_image = |source: &str, destination: &std::path::Path| -> Result<()> {
        let asset = app
            .asset_resolver()
            .get(source.to_owned())
            .ok_or("小组件车辆图片不可用")?;
        let temporary = destination.with_extension("tmp");
        std::fs::write(&temporary, asset.bytes).map_err(|error| error.to_string())?;
        crate::platform::private_path(&temporary, 0o600)?;
        std::fs::rename(temporary, destination).map_err(|error| error.to_string())?;
        Ok(())
    };
    write_image(path, &image_path)?;
    write_image(&dark_artwork, &dark_image_path)?;
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
        #[cfg(target_os = "ios")]
        let portrait_path = if data.carplay_front {
            let front = path.replace("-side.jpg", "-front-portrait.webp");
            let destination = directory.join("widget-front.webp");
            write_image(&front, &destination)?;
            Some(destination)
        } else {
            None
        };
        #[cfg(target_os = "android")]
        let portrait_path: Option<std::path::PathBuf> = None;
        let payload = serde_json::json!({
            "data": data, "imagePath": image_path, "darkImagePath": dark_image_path,
            "portraitPath": portrait_path,
        });
        crate::mobile::call_async("updateWidgets", payload).await
    }
}

#[cfg(any(target_os = "macos", test))]
fn clear_record(directory: &std::path::Path) -> Result<()> {
    match std::fs::remove_file(directory.join("vehicle.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("小组件数据清除失败，请重试".into()),
    }
}

#[cfg(any(target_os = "ios", test))]
fn snapshot_values(snapshot: &crate::Snapshot, account: &str) -> serde_json::Value {
    use serde_json::{json, Value};
    let reading = |kind: &str| {
        snapshot
            .readings
            .get(kind)
            .filter(|r| r.status == "success")
    };
    let value = |kind: &str, field: &str| {
        reading(kind)
            .and_then(|r| r.value.as_ref())
            .and_then(|v| v.get(field))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let number = |kind: &str, field: &str| {
        let value = value(kind, field);
        if value.as_f64().is_some_and(f64::is_finite) {
            value
        } else {
            Value::Null
        }
    };
    let p4 = snapshot
        .vehicle
        .platform
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case("HUANFU"));
    let entries: Vec<_> = ["battery", "exterior", "climate"]
        .into_iter()
        .filter_map(reading)
        .collect();
    let times: Vec<_> = entries
        .iter()
        .filter_map(|r| {
            if p4 {
                r.reported_at
            } else {
                r.reported_at.or(Some(r.observed_at))
            }
        })
        .filter(|t| *t > 0)
        .collect();
    let updated = if p4 && times.len() != entries.len() {
        None
    } else {
        times.iter().min().copied()
    };
    json!({"vin": snapshot.vehicle.vin, "model": snapshot.vehicle.model, "accountScope": account,
        "batteryPercent": number("battery", "percent"), "rangeKm": number("battery", "rangeKm"),
        "locked": value("exterior", "locked").as_bool(), "climate": value("climate", "activity").as_str().unwrap_or("unknown"),
        "charging": number("battery", "chargeState"), "updatedAt": updated,
        "freshnessPending": p4 && entries.iter().any(|r| r.reported_at.is_none_or(|t| t == 0)
            || r.value.as_ref().is_some_and(|v| v["freshnessPending"] == true)),
        "observedAt": snapshot.fetched_at})
}

#[cfg(target_os = "ios")]
pub(crate) fn publish_siri_snapshot(snapshot: &crate::Snapshot, account: &str) -> bool {
    extern "C" {
        fn norr_widget_readback(json: *const std::ffi::c_char) -> bool;
    }
    std::ffi::CString::new(snapshot_values(snapshot, account).to_string())
        .is_ok_and(|json| unsafe { norr_widget_readback(json.as_ptr()) })
}

#[cfg(any(target_os = "ios", test))]
pub(crate) fn merge_widget_refresh(
    mut snapshot: crate::Snapshot,
    previous: Option<&crate::Snapshot>,
) -> Result<crate::Snapshot> {
    let mut received = false;
    for kind in ["battery", "exterior", "climate"] {
        let old = previous
            .and_then(|s| s.readings.get(kind))
            .filter(|r| r.status == "success");
        let current = snapshot
            .readings
            .get(kind)
            .filter(|r| r.status == "success");
        if current.is_some_and(|new| {
            old.is_none_or(|old| {
                new.observed_at >= old.observed_at
                    && !matches!((new.reported_at, old.reported_at), (Some(n), Some(o)) if n < o)
            })
        }) {
            received = true;
        } else if let Some(old) = old {
            snapshot.readings.insert(kind.into(), old.clone());
        }
    }
    if !received {
        return Err("未收到可更新的小组件车况，已保留上次读数".into());
    }
    Ok(snapshot)
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
    fn clearing_widget_record_preserves_artwork_and_accepts_an_empty_cache() {
        let root = std::env::temp_dir().join(format!("norr-widget-clear-{}", uuid::Uuid::new_v4()));
        clear_record(&root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("vehicle.json"), b"fixture").unwrap();
        std::fs::write(root.join("image.jpg"), b"fixture").unwrap();
        clear_record(&root).unwrap();
        clear_record(&root).unwrap();
        assert!(!root.join("vehicle.json").exists());
        assert!(root.join("image.jpg").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn siri_widget_projection_preserves_zero_unknown_and_source_time() {
        use serde_json::json;
        let mut snapshot: crate::Snapshot = serde_json::from_value(json!({
            "vehicle":{"vin":"fixture", "model":"Polestar 4", "platform":"HUANFU", "capabilities":{}, "limits":{}},
            "fetchedAt":9000, "readings":{
                "battery":{"status":"success", "value":{"percent":0, "rangeKm":0, "chargeState":9}, "observedAt":9000, "reportedAt":3000},
                "exterior":{"status":"success", "value":{"locked":false}, "observedAt":8000, "reportedAt":2000}
            }})).unwrap();
        let data = snapshot_values(&snapshot, "fixture-account");
        assert_eq!(data["batteryPercent"], 0);
        assert_eq!(data["locked"], false);
        assert_eq!(data["climate"], "unknown");
        assert_eq!(data["updatedAt"], 2000);
        assert_eq!(data["accountScope"], "fixture-account");
        snapshot.readings.get_mut("battery").unwrap().reported_at = None;
        let data = snapshot_values(&snapshot, "fixture-account");
        assert!(data["updatedAt"].is_null());
        assert_eq!(data["freshnessPending"], true);
        snapshot.vehicle.platform = Some("ICUP".into());
        assert_eq!(
            snapshot_values(&snapshot, "fixture-account")["updatedAt"],
            2000
        );
    }

    #[test]
    fn widget_refresh_keeps_previous_readings_on_partial_or_stale_results() {
        use serde_json::json;
        let previous: crate::Snapshot = serde_json::from_value(json!({
            "vehicle":{"vin":"fixture","model":"Polestar 4","capabilities":{},"limits":{}},
            "fetchedAt":100, "readings":{
                "battery":{"status":"success","value":{"percent":50},"observedAt":100,"reportedAt":90},
                "exterior":{"status":"success","value":{"locked":false},"observedAt":100,"reportedAt":90}
            }
        })).unwrap();
        let mut next = previous.clone();
        next.readings.remove("battery");
        next.readings.get_mut("exterior").unwrap().reported_at = Some(80);
        assert!(merge_widget_refresh(next.clone(), Some(&previous)).is_err());
        next.readings.insert(
            "climate".into(),
            crate::Reading::success(json!({"activity":"idle"}), Some(120)),
        );
        let merged = merge_widget_refresh(next, Some(&previous)).unwrap();
        assert_eq!(merged.readings["exterior"].reported_at, Some(90));
        assert_eq!(merged.readings["battery"].observed_at, 100);
        assert_eq!(merged.readings["climate"].reported_at, Some(120));
    }

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
