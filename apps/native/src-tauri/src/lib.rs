use norr_vehicle_core::{china::ChinaClient, confirmation, credentials, models::*, now_ms, Result};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf};
use tauri::{Emitter, Manager, State};
use tokio::sync::{Mutex, Notify};
mod archive;
#[cfg(target_os = "macos")]
mod desktop;
#[cfg(target_os = "windows")]
#[path = "desktop_windows.rs"]
mod desktop;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "desktop_mobile.rs"]
mod desktop;
mod exports;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
mod updates;

#[tauri::command]
async fn app_version(_app: tauri::AppHandle) -> Result<String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        #[derive(Deserialize)]
        struct Installed {
            version: String,
        }
        Ok(
            mobile::call_async::<Installed>("installedVersion", serde_json::json!({}))
                .await?
                .version,
        )
    }
    #[cfg(desktop)]
    Ok(_app.package_info().version.to_string())
}
mod insights;
mod login;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;
mod notifications;
#[cfg(any(
    all(
        any(target_os = "ios", target_os = "windows"),
        feature = "p4-field-test"
    ),
    all(
        any(
            target_os = "macos",
            target_os = "ios",
            target_os = "windows",
            target_os = "android"
        ),
        feature = "polestar4"
    )
))]
mod p4_field;
#[cfg(any(test, all(target_os = "ios", feature = "p4-field-test")))]
mod p4_partner;
#[cfg(any(
    all(target_os = "ios", feature = "p4-field-test"),
    all(
        any(target_os = "ios", target_os = "windows", target_os = "android"),
        feature = "polestar4"
    )
))]
mod p4_recorder;
mod platform;
#[cfg(any(target_os = "ios", test))]
mod siri;
mod vehicle_service;
use vehicle_service::VehicleService;
#[cfg(target_os = "windows")]
mod verification_windows;
#[cfg(all(target_os = "ios", not(feature = "polestar4-test")))]
mod watch;
#[cfg(any(target_os = "android", target_os = "ios", target_os = "macos"))]
mod widgets;

#[cfg(target_os = "ios")]
#[tauri::command]
async fn control_tap() -> Result<()> {
    mobile::call_async("controlTap", serde_json::json!({})).await
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn set_android_theme(dark: bool) -> Result<()> {
    mobile::call_async("setTheme", serde_json::json!({ "dark": dark })).await
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct History {
    snapshots: Vec<Snapshot>,
    receipts: Vec<Receipt>,
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    notifications: notifications::Tracker,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
struct Settings {
    refresh_seconds: u64,
    selected_vin: Option<String>,
    launch_at_login: bool,
    notify_charging: bool,
    notify_commands: bool,
    refresh_on_wake: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            refresh_seconds: 120,
            selected_vin: None,
            launch_at_login: false,
            notify_charging: false,
            notify_commands: false,
            refresh_on_wake: true,
        }
    }
}

struct Backend {
    client: ChinaClient,
    history: History,
    path: PathBuf,
    archive: archive::Archive,
    pending_import: Option<archive::PendingImport>,
}

impl Backend {
    fn save(&self) -> Result<()> {
        let temporary = self.path.with_extension("tmp");
        let bytes = serde_json::to_vec(&self.history).map_err(|_| "记录编码失败")?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        platform::private_file(&mut options);
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法保存本机车辆记录")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "车辆记录写入失败")?;
        drop(file);
        std::fs::rename(temporary, &self.path).map_err(|_| "车辆记录保存失败")?;
        self.archive.sync(&self.history)
    }

    fn record(&mut self, snapshot: Snapshot) -> Result<Snapshot> {
        self.apply_readback(&snapshot)?;
        #[cfg(all(
            any(target_os = "ios", target_os = "windows", target_os = "android"),
            feature = "polestar4"
        ))]
        if snapshot.vehicle.uses_xchanger() {
            if let Some(account) = self.client.account_scope() {
                self.archive.xchanger_event(&account, &snapshot.vehicle.vin, snapshot.fetched_at,
                    serde_json::json!({"operation":"readVehicle","phase":"completed","sample":norr_vehicle_core::p4_readback::recording_sample(&snapshot)}))?;
            }
        }
        if !snapshot.vehicle.uses_xchanger() {
            self.history.notifications.observe(
                &snapshot,
                self.history.settings.notify_charging,
                now_ms(),
            );
        }
        self.update_notifications();
        self.history.snapshots.push(snapshot.clone());
        if self.history.snapshots.len() > 5000 {
            self.history.snapshots.remove(0);
        }
        self.save()?;
        Ok(snapshot)
    }

    fn update_notifications(&mut self) {
        self.history.notifications.commands(
            &self.history.receipts,
            self.history.settings.notify_commands,
            now_ms(),
        );
        self.history.notifications.prune(
            self.history.settings.notify_charging,
            self.history.settings.notify_commands,
            now_ms(),
        );
    }

    async fn read_command_state(
        &mut self,
        command: &Command,
        request_latest: bool,
    ) -> Result<Snapshot> {
        let car = self
            .history
            .snapshots
            .iter()
            .rev()
            .find(|snapshot| snapshot.vehicle.vin == command.vin)
            .map(|snapshot| snapshot.vehicle.clone());
        let car = match car {
            Some(car) => car,
            None => {
                let snapshot = self.client.refresh(&command.vin).await?;
                return self.record(snapshot);
            }
        };
        let endpoint = confirmation::endpoint(&command.action).ok_or("指令没有对应的回读项目")?;
        let reading = self
            .client
            .refresh_reading(&command.vin, endpoint, request_latest)
            .await?;
        self.record_reading(&car, endpoint, reading, now_ms())
    }
}

fn pending_readback(
    history: &History,
    now: u64,
    account: Option<&str>,
    eligible: impl Fn(&Command) -> bool,
) -> Option<Receipt> {
    let mut latest = std::collections::BTreeSet::new();
    history
        .receipts
        .iter()
        .rev()
        .filter(|receipt| {
            if receipt.status == "rejected"
                || (receipt.account_scope.is_some() && receipt.account_scope.as_deref() != account)
            {
                return false;
            }
            let Some(endpoint) = confirmation::endpoint(&receipt.command.action) else {
                return false;
            };
            // A newer command for the same state replaces the earlier target.
            latest.insert((
                receipt.command.vin.as_str(),
                confirmation::command_group(&receipt.command.action).unwrap_or(endpoint),
            )) && eligible(&receipt.command)
                && receipt.readback.as_deref() != Some(confirmation::CONFIRMED)
                && now.saturating_sub(receipt.time)
                    < if history.snapshots.iter().any(|snapshot| {
                        snapshot.vehicle.vin == receipt.command.vin
                            && snapshot.vehicle.uses_xchanger()
                    }) {
                        600_000
                    } else {
                        120_000
                    }
        })
        .min_by_key(|receipt| {
            history
                .snapshots
                .iter()
                .rev()
                .find(|snapshot| snapshot.vehicle.vin == receipt.command.vin)
                .and_then(|snapshot| {
                    snapshot
                        .readings
                        .get(confirmation::endpoint(&receipt.command.action)?)
                })
                .map_or(0, |reading| reading.observed_at)
        })
        .cloned()
}

#[tauri::command]
async fn desktop_status(state: State<'_, VehicleService>) -> Result<serde_json::Value> {
    let status = tauri::async_runtime::spawn_blocking(desktop::status)
        .await
        .map_err(|_| "系统状态读取未完成")?;
    Ok(serde_json::json!({"status":status,"settings":state.lock().await.history.settings}))
}

#[tauri::command]
async fn set_desktop_option(
    state: State<'_, VehicleService>,
    option: String,
    enabled: bool,
) -> Result<()> {
    if ![
        "launchAtLogin",
        "notifyCharging",
        "notifyCommands",
        "refreshOnWake",
    ]
    .contains(&option.as_str())
    {
        return Err("设置项目无效".into());
    }
    if enabled && matches!(option.as_str(), "notifyCharging" | "notifyCommands") {
        tauri::async_runtime::spawn_blocking(desktop::request_notifications)
            .await
            .map_err(|_| "通知授权未完成")??;
    }
    let mut backend = state.lock().await;
    let previous = backend.history.settings.clone();
    match option.as_str() {
        "launchAtLogin" => backend.history.settings.launch_at_login = enabled,
        "notifyCharging" => backend.history.settings.notify_charging = enabled,
        "notifyCommands" => backend.history.settings.notify_commands = enabled,
        "refreshOnWake" => backend.history.settings.refresh_on_wake = enabled,
        _ => unreachable!(),
    }
    backend.update_notifications();
    if let Err(error) = backend.save() {
        backend.history.settings = previous;
        return Err(error);
    }
    drop(backend);
    if option == "launchAtLogin" {
        tauri::async_runtime::spawn_blocking(move || desktop::set_login(enabled))
            .await
            .map_err(|_| "登录启动设置未完成")??;
    }
    Ok(())
}

#[tauri::command]
async fn open_system_settings(section: String) -> Result<()> {
    desktop::open_settings(&section)
}

#[tauri::command]
async fn take_notification_target() -> Option<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(desktop::take_notification_target)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn test_notification(state: State<'_, VehicleService>) -> Result<()> {
    let backend = state.lock().await;
    let vin = backend
        .history
        .settings
        .selected_vin
        .clone()
        .unwrap_or_default();
    drop(backend);
    tauri::async_runtime::spawn_blocking(move || {
        desktop::request_notifications()?;
        desktop::notify(&notifications::Notice {
            id: "norr-test".into(),
            vin,
            title: "Norr 测试通知".into(),
            body: "通知已送达。点击可返回 Norr 设置。".into(),
            page: "settings".into(),
            time: now_ms(),
        })
    })
    .await
    .map_err(|_| "测试通知未完成")?
}

#[tauri::command]
async fn session_status() -> Result<credentials::SessionStatus> {
    tauri::async_runtime::spawn_blocking(credentials::status)
        .await
        .map_err(|_| "本机凭据状态读取未完成")?
}

#[cfg(all(debug_assertions, target_os = "macos"))]
#[tauri::command]
async fn import_hisingen(
    state: State<'_, VehicleService>,
    config_path: Option<String>,
) -> Result<credentials::SessionStatus> {
    let mut backend = state.lock().await;
    let status = credentials::import_hisingen(
        config_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(std::path::Path::new),
    )?;
    backend.client = ChinaClient::new()?;
    Ok(status)
}

#[tauri::command]
async fn connect(state: State<'_, VehicleService>) -> Result<Vec<Vehicle>> {
    let mut backend = state.lock().await;
    #[cfg(any(
        all(target_os = "ios", feature = "p4-field-test"),
        all(
            any(target_os = "ios", target_os = "windows", target_os = "android"),
            feature = "polestar4"
        )
    ))]
    return p4_recorder::read_garage(&mut backend).await;
    #[cfg(not(any(
        all(target_os = "ios", feature = "p4-field-test"),
        all(
            any(target_os = "ios", target_os = "windows", target_os = "android"),
            feature = "polestar4"
        )
    )))]
    backend.client.connect().await
}

#[tauri::command]
async fn refresh(
    _app: tauri::AppHandle,
    state: State<'_, VehicleService>,
    vin: String,
    receipt_id: Option<String>,
) -> Result<Snapshot> {
    let mut backend = state.lock().await;
    if let Some(id) = receipt_id {
        let account = backend.client.account_scope().ok_or("请先登录并连接车辆")?;
        let command = backend
            .history
            .receipts
            .iter()
            .find(|receipt| {
                receipt.id == id
                    && receipt.command.vin == vin
                    && receipt.account_scope.as_deref() == Some(account.as_str())
                    && receipt.status != "rejected"
                    && confirmation::endpoint(&receipt.command.action).is_some()
            })
            .ok_or("当前车辆没有这条可核对的操作")?
            .command
            .clone();
        return backend.read_command_state(&command, true).await;
    }
    let snapshot = backend.client.refresh(&vin).await?;
    backend.history.settings.selected_vin = Some(vin.clone());
    #[cfg(all(target_os = "ios", not(feature = "polestar4-test")))]
    let _ = watch::synchronize(&mut backend.client, &vin, false, true).await;
    let snapshot = backend.record(snapshot)?;
    #[cfg(desktop)]
    update_tray(&_app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn set_refresh_interval(state: State<'_, VehicleService>, seconds: u64) -> Result<Settings> {
    if ![0, 60, 120, 300, 600].contains(&seconds) {
        return Err("刷新间隔无效".into());
    }
    let mut backend = state.lock().await;
    let previous = backend.history.settings.clone();
    backend.history.settings.refresh_seconds = seconds;
    if let Err(error) = backend.save() {
        backend.history.settings = previous;
        return Err(error);
    }
    Ok(backend.history.settings.clone())
}

#[tauri::command]
async fn history(state: State<'_, VehicleService>) -> Result<History> {
    Ok(state.lock().await.history.clone())
}

#[tauri::command]
async fn history_report(
    state: State<'_, VehicleService>,
    vin: String,
    start: u64,
    end: u64,
) -> Result<insights::Report> {
    if start >= end || end > 253402300800001 {
        return Err("历史日期范围无效".into());
    }
    let backend = state.lock().await;
    let records = backend.archive.records(&vin, start, end)?;
    Ok(insights::report(
        records,
        backend.archive.vehicles()?,
        start,
        end,
    ))
}

#[tauri::command]
async fn preview_history_import(
    state: State<'_, VehicleService>,
    source: String,
) -> Result<Option<archive::ImportSummary>> {
    let pending =
        tauri::async_runtime::spawn_blocking(move || -> Result<Option<archive::PendingImport>> {
            let records = match source.as_str() {
                #[cfg(all(debug_assertions, target_os = "macos"))]
                "hisingen" => {
                    let directory = std::env::var_os("HOME").ok_or("无法定位旧历史目录")?;
                    archive::read_hisingen(
                        &PathBuf::from(directory)
                            .join("Library/Application Support/Hisingen/hisingen.sqlite3"),
                    )?
                }
                "backup" => {
                    let Some(path) = exports::open_path()? else {
                        return Ok(None);
                    };
                    let records = archive::read_backup(&path);
                    #[cfg(any(target_os = "android", target_os = "ios"))]
                    let _ = std::fs::remove_file(&path);
                    records?
                }
                _ => return Err("导入来源无效".into()),
            };
            Ok(Some(archive::PendingImport {
                token: uuid::Uuid::new_v4().to_string(),
                source,
                records,
            }))
        })
        .await
        .map_err(|_| "读取导入文件未完成")??;
    let mut backend = state.lock().await;
    backend.pending_import = None;
    let Some(pending) = pending else {
        return Ok(None);
    };
    let summary = backend.archive.preview(&pending)?;
    backend.pending_import = Some(pending);
    Ok(Some(summary))
}

#[tauri::command]
async fn commit_history_import(
    state: State<'_, VehicleService>,
    token: String,
) -> Result<archive::ImportSummary> {
    let mut backend = state.lock().await;
    let pending = backend
        .pending_import
        .as_ref()
        .filter(|pending| pending.token == token)
        .ok_or("导入预览已失效，请重新选择文件")?;
    let mut summary = backend.archive.preview(pending)?;
    summary.added = backend.archive.merge(&pending.records, false)?;
    summary.duplicates = summary.total - summary.added;
    backend.pending_import = None;
    Ok(summary)
}

#[tauri::command]
async fn cancel_history_import(state: State<'_, VehicleService>, token: String) -> Result<()> {
    let mut backend = state.lock().await;
    if backend
        .pending_import
        .as_ref()
        .is_some_and(|pending| pending.token == token)
    {
        backend.pending_import = None;
    }
    Ok(())
}

#[tauri::command]
async fn open_location(state: State<'_, VehicleService>, vin: String) -> Result<()> {
    let backend = state.lock().await;
    let snapshot = backend
        .history
        .snapshots
        .iter()
        .rev()
        .find(|snapshot| snapshot.vehicle.vin == vin)
        .ok_or("没有车辆位置记录")?;
    let value = snapshot
        .readings
        .get("location")
        .filter(|reading| reading.status == "success")
        .and_then(|reading| reading.value.as_ref())
        .ok_or("车辆未返回有效位置")?;
    let lat = value["latitude"]
        .as_f64()
        .filter(|value| value.is_finite() && (-90.0..=90.0).contains(value))
        .ok_or("纬度无效")?;
    let lon = value["longitude"]
        .as_f64()
        .filter(|value| value.is_finite() && (-180.0..=180.0).contains(value))
        .ok_or("经度无效")?;
    platform::open_url(&format!(
        "https://www.google.com/maps/search/?api=1&query={lat},{lon}"
    ))
}

fn validate_map_url(url: &str) -> Result<tauri::Url> {
    let parsed = tauri::Url::parse(url).map_err(|_| "地图地址无效")?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || !matches!(
            (parsed.host_str(), parsed.path()),
            (Some("uri.amap.com"), "/marker")
                | (Some("www.google.com"), "/maps/search/")
                | (Some("maps.apple.com"), "/")
        )
    {
        return Err("地图地址不受支持".into());
    }
    Ok(parsed)
}

#[tauri::command]
async fn open_map_link(url: String) -> Result<()> {
    let url = validate_map_url(&url)?;
    platform::open_url(url.as_str())
}

#[tauri::command]
async fn record_p4_observation(
    state: State<'_, VehicleService>,
    vin: String,
    action: archive::p4_log::TestAction,
    outcome: archive::p4_log::Outcome,
) -> Result<()> {
    let backend = state.lock().await;
    if !backend
        .history
        .snapshots
        .iter()
        .any(|s| s.vehicle.vin == vin && s.vehicle.uses_xchanger())
    {
        return Err("未找到所选 P4 的采集记录".into());
    }
    backend
        .archive
        .record_observation(&vin, now_ms(), action, outcome)
}

#[tauri::command]
async fn export_history(
    state: State<'_, VehicleService>,
    vin: String,
    format: String,
) -> Result<bool> {
    let bytes = {
        let backend = state.lock().await;
        match format.as_str() {
            "p4-log" => backend.archive.p4_log(&vin, now_ms())?,
            "json" => backend.archive.backup(&vin)?,
            "csv" => insights::csv(backend.archive.records(&vin, 0, 253402300800001)?)?,
            _ => return Err("导出格式无效".into()),
        }
    };
    tauri::async_runtime::spawn_blocking(move || exports::save(bytes, &format))
        .await
        .map_err(|_| "导出未完成")?
}

#[tauri::command]
async fn send_command(
    app: tauri::AppHandle,
    _window: tauri::WebviewWindow,
    state: State<'_, VehicleService>,
    command: Command,
) -> Result<Receipt> {
    let mut backend = state
        .try_lock()
        .map_err(|_| "正在处理车辆请求，请等待完成")?;
    backend.client.validate_command(&command)?;
    if backend.client.uses_xchanger(&command.vin) {
        let account = backend.client.account_scope().ok_or("会话尚未恢复")?;
        if let Some(pending) = confirmation::unresolved_xchanger(
            &backend.history.receipts,
            &command,
            &account,
            now_ms(),
        )
        .cloned()
        {
            if confirmation::endpoint(&pending.command.action).is_some() {
                let snapshot = backend.read_command_state(&pending.command, true).await?;
                let _ = app.emit("vehicle-updated", snapshot);
            }
            if pending.command.action == command.action && pending.command.value == command.value {
                return backend
                    .history
                    .receipts
                    .iter()
                    .find(|r| r.id == pending.id)
                    .cloned()
                    .ok_or_else(|| "指令记录不可用".into());
            }
            if confirmation::unresolved_xchanger(
                &backend.history.receipts,
                &command,
                &account,
                now_ms(),
            )
            .is_some()
            {
                app.state::<Notify>().notify_one();
                return Err(if confirmation::endpoint(&command.action).is_some() {
                    "上一条 P4 操作仍待车辆回读，本次指令尚未发送"
                } else {
                    "上一条寻车操作请先现场核对，暂不重复发送"
                }
                .into());
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    if matches!(
        command.action.as_str(),
        "unlock"
            | "unlockTrunk"
            | "tailgateOpen"
            | "windowsOpen"
            | "windowsVent"
            | "chargeLidOpen"
            | "honk"
            | "honkFlash"
            | "otaInstall"
            | "otaSchedule"
            | "deleteClimateTimer"
    ) {
        let authorized =
            tauri::async_runtime::spawn_blocking(move || platform::authenticate(&_window))
                .await
                .map_err(|_| "系统身份验证未完成")??;
        if !authorized {
            return Err("系统身份验证已取消或未通过，指令尚未发送".into());
        }
    }
    let prepared = backend.client.prepare(&command).await?;
    #[cfg(target_os = "ios")]
    if let Some(pending) = backend
        .client
        .account_scope()
        .filter(|_| !backend.client.uses_xchanger(&command.vin))
        .and_then(|account| {
            siri::unresolved_command(&backend.history.receipts, &command, &account, now_ms())
        })
    {
        app.state::<Notify>().notify_one();
        return if pending.command.action == command.action && pending.command.value == command.value
        {
            Ok(pending.clone())
        } else {
            Err("这辆车有一条操作待核对，本次指令尚未发送".into())
        };
    }
    let receipt = backend.submit(command, prepared).await?;
    drop(backend);
    if receipt.readback.is_some() {
        app.state::<Notify>().notify_one();
    }
    Ok(receipt)
}

async fn collect_in_background(app: tauri::AppHandle) {
    let mut last_attempt = now_ms();
    let mut handled_wake = desktop::wake_generation();
    let command_wake = app.state::<Notify>();
    let mut readback_cooldowns = std::collections::BTreeMap::new();
    loop {
        tokio::select! {
            _ = command_wake.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {},
        }
        if tauri::async_runtime::spawn_blocking(desktop::sleeping)
            .await
            .unwrap_or(true)
        {
            continue;
        }
        deliver_notifications(&app).await;
        let state = app.state::<VehicleService>();
        let Ok(mut backend) = state.try_lock() else {
            continue;
        };
        let settings = &backend.history.settings;
        let generation = desktop::wake_generation();
        let waking = settings.refresh_on_wake && generation != handled_wake;
        let account = backend.client.account_scope();
        let now = now_ms();
        readback_cooldowns.retain(|_, until| *until > now);
        let pending = pending_readback(&backend.history, now, account.as_deref(), |cmd| {
            !readback_cooldowns
                .contains_key(&(cmd.vin.clone(), confirmation::endpoint(&cmd.action)))
        });
        #[cfg(all(target_os = "ios", not(feature = "polestar4-test")))]
        let checking_command = pending.is_some();
        let result = if let Some(receipt) = pending {
            let command = receipt.command;
            let result = backend
                .read_command_state(&command, receipt.readback_at.is_none())
                .await;
            let usable = result
                .as_ref()
                .ok()
                .and_then(|snapshot| {
                    snapshot
                        .readings
                        .get(confirmation::endpoint(&command.action)?)
                })
                .is_some_and(|reading| reading.status == "success");
            readback_cooldowns.insert(
                (command.vin, confirmation::endpoint(&command.action)),
                now_ms() + if usable { 5_000 } else { 15_000 },
            );
            result
        } else {
            let interval = if waking { 2 } else { settings.refresh_seconds };
            if interval == 0 || now_ms().saturating_sub(last_attempt) < interval * 1000 {
                continue;
            }
            let Some(vin) = settings.selected_vin.clone() else {
                continue;
            };
            last_attempt = now_ms();
            backend
                .client
                .refresh(&vin)
                .await
                .and_then(|snapshot| backend.record(snapshot))
        };
        match result {
            Ok(snapshot) => {
                if snapshot
                    .readings
                    .values()
                    .any(|reading| reading.status == "success")
                {
                    handled_wake = generation;
                }
                #[cfg(desktop)]
                update_tray(&app, &snapshot);
                #[cfg(all(target_os = "ios", not(feature = "polestar4-test")))]
                if let Some(vin) = backend
                    .history
                    .settings
                    .selected_vin
                    .clone()
                    .filter(|_| !checking_command)
                {
                    let _ = watch::synchronize(&mut backend.client, &vin, false, true).await;
                }
                let _ = app.emit("vehicle-updated", snapshot);
            }
            Err(error) => {
                let _ = app.emit("refresh-failed", error);
            }
        }
    }
}

async fn deliver_notifications(app: &tauri::AppHandle) {
    let state = app.state::<VehicleService>();
    let notice = {
        let Ok(mut backend) = state.try_lock() else {
            return;
        };
        let previous = backend.history.notifications.clone();
        backend.update_notifications();
        if previous != backend.history.notifications {
            if let Err(error) = backend.save() {
                let _ = app.emit("desktop-failed", error);
                return;
            }
        }
        backend.history.notifications.outbox.first().cloned()
    };
    let Some(notice) = notice else {
        return;
    };
    let id = notice.id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || desktop::notify(&notice)).await;
    match result {
        Ok(Ok(())) => {
            let mut backend = state.lock().await;
            backend
                .history
                .notifications
                .outbox
                .retain(|notice| notice.id != id);
            if let Err(error) = backend.save() {
                let _ = app.emit("desktop-failed", error);
            }
        }
        Ok(Err(error)) => {
            let _ = app.emit("desktop-failed", error);
        }
        Err(_) => {
            let _ = app.emit("desktop-failed", "通知发送任务未完成");
        }
    }
}

#[cfg(desktop)]
fn update_tray(app: &tauri::AppHandle, snapshot: &Snapshot) {
    if let Some(tray) = app.tray_by_id("norr-status") {
        let percent = snapshot
            .readings
            .get("battery")
            .and_then(|reading| reading.value.as_ref())
            .and_then(|value| value["percent"].as_f64());
        let title = percent
            .map(|value| format!("Norr {value:.0}%"))
            .unwrap_or_else(|| "Norr".into());
        let _ = tray.set_tooltip(Some(&title));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(title));
    }
}

#[cfg(all(
    feature = "polestar4",
    any(
        target_os = "macos",
        target_os = "ios",
        target_os = "windows",
        target_os = "android"
    )
))]
fn account_history_path(
    path: PathBuf,
    session: Option<&credentials::Session>,
    claim_legacy: bool,
) -> Result<PathBuf> {
    let root = path.parent().ok_or("本机数据目录无效")?;
    let Some(session) = session else {
        return Ok(root.join("signed-out/vehicle-history.json"));
    };
    let scope = session.account_scope();
    let marker = root.join("history-owner");
    match std::fs::read_to_string(&marker) {
        Ok(owner) if owner == scope => return Ok(path),
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if claim_legacy && path.exists() {
                std::fs::write(&marker, &scope).map_err(|_| "无法保存已有记录的账号归属")?;
                return Ok(path);
            }
        }
        Err(_) => return Err("无法核对本机记录的账号归属".into()),
    }
    Ok(root
        .join("accounts")
        .join(scope)
        .join("vehicle-history.json"))
}

fn load_backend(path: PathBuf) -> Result<Backend> {
    let parent = path.parent().ok_or("本机数据目录无效")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法建立本机数据目录")?;
    platform::private_directory(parent)?;
    let mut history: History = match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "本机记录格式异常，请保留文件后恢复备份")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => History::default(),
        Err(_) => return Err("无法读取本机记录".into()),
    };
    history
        .notifications
        .commands(&history.receipts, false, now_ms());
    let archive = archive::Archive::open(&parent.join("history.sqlite3"))?;
    archive.sync(&history)?;
    Ok(Backend {
        client: ChinaClient::new()?,
        history,
        path,
        archive,
        pending_import: None,
    })
}

#[cfg(any(desktop, test))]
async fn run_cli(arguments: &[String]) -> Result<()> {
    match arguments.first().map(String::as_str) {
        Some("--session-status") => {
            let status = credentials::status()?;
            println!(
                "storageNamespace={} hasSession={} signingKeyPresent={}",
                credentials::storage_namespace(),
                status.has_session,
                status.has_signing_key
            );
        }
        #[cfg(all(debug_assertions, target_os = "macos"))]
        Some("--import-hisingen") => {
            let config = arguments
                .iter()
                .position(|arg| arg == "--config")
                .and_then(|i| arguments.get(i + 1));
            let status = credentials::import_hisingen(config.map(std::path::Path::new))?;
            println!(
                "sessionImported={} signingKeyPresent={}",
                status.has_session, status.has_signing_key
            );
        }
        Some("--verify-session") => {
            let mut client = ChinaClient::new()?;
            let fleet = client.connect().await?;
            println!("sessionRestored=true vehicleCount={}", fleet.len());
            for car in fleet {
                println!(
                    "model={} platform={}",
                    car.model,
                    car.platform.as_deref().unwrap_or("unknown")
                );
                let snapshot = client.refresh(&car.vin).await?;
                for (kind, reading) in snapshot.readings {
                    let fields = reading
                        .value
                        .as_ref()
                        .and_then(|v| v.as_object())
                        .map(|v| v.values().filter(|v| !v.is_null()).count())
                        .unwrap_or(0);
                    println!(
                        "reading={kind} status={} populatedFields={fields} timestampPresent={}",
                        reading.status,
                        reading.reported_at.is_some()
                    );
                    if let Some(error) = reading.error {
                        println!("readingError={error}");
                    }
                }
            }
        }
        _ => return Err("不支持的命令行参数".into()),
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    let _instance = {
        let directory = match platform::data_directory() {
            Ok(directory) => directory,
            Err(error) => {
                eprintln!("{error}");
                return;
            }
        };
        let instance = (|| -> Result<std::fs::File> {
            std::fs::create_dir_all(&directory).map_err(|_| "无法创建应用数据目录")?;
            platform::private_directory(&directory)?;
            let mut options = std::fs::OpenOptions::new();
            options.create(true).truncate(false).read(true).write(true);
            platform::private_file(&mut options);
            let file = options
                .open(directory.join("session.lock"))
                .map_err(|_| "无法建立会话锁")?;
            file.try_lock()
                .map_err(|_| "Norr 已在运行，请在现有窗口继续操作")?;
            Ok(file)
        })();
        let _instance = match instance {
            Ok(file) => file,
            Err(error) => {
                if platform::show_running_window() {
                    return;
                }
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
        let arguments = std::env::args().skip(1).collect::<Vec<_>>();
        if arguments.first().is_some_and(|arg| arg.starts_with("--")) {
            let result = tokio::runtime::Runtime::new()
                .expect("runtime")
                .block_on(run_cli(&arguments));
            if let Err(error) = result {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
        _instance
    };
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(mobile::init());
    builder
        .append_invoke_initialization_script(format!(
            "window.__NORR_PLATFORM__ = {:?};",
            std::env::consts::OS
        ))
        .setup(|app| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if app.config().identifier != credentials::storage_namespace() {
                return Err("应用标识与凭据存储不匹配，请重新构建安装包".into());
            }
            let path = platform::data_directory()
                .map_err(std::io::Error::other)?
                .join("vehicle-history.json");
            #[cfg(all(
                feature = "polestar4",
                any(target_os = "macos", target_os = "windows", target_os = "android")
            ))]
            let path = account_history_path(
                path,
                credentials::load_session()
                    .map_err(std::io::Error::other)?
                    .as_ref(),
                true,
            )
            .map_err(std::io::Error::other)?;
            #[cfg(target_os = "ios")]
            let service = vehicle_service::ios_service(path).map_err(std::io::Error::other)?;
            #[cfg(not(target_os = "ios"))]
            let backend = load_backend(path).map_err(std::io::Error::other)?;
            #[cfg(desktop)]
            let launch_at_login = backend.history.settings.launch_at_login;
            #[cfg(not(target_os = "ios"))]
            let service = std::sync::Arc::new(Mutex::new(backend));
            app.manage(service);
            #[cfg(target_os = "ios")]
            siri::initialize(app.handle().clone());
            #[cfg(all(target_os = "ios", feature = "p4-field-test"))]
            app.manage(p4_partner::Service::new(
                option_env!("NORR_P4_PARTNER_CLIENT_ID"),
                None,
            ));
            app.manage(Notify::new());
            app.manage(Mutex::new(
                norr_vehicle_core::auth::PhoneLogin::new().map_err(std::io::Error::other)?,
            ));
            desktop::initialize(app.handle().clone());
            #[cfg(target_os = "windows")]
            app.manage(verification_windows::Pending::default());
            #[cfg(desktop)]
            if launch_at_login {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = desktop::set_login(true) {
                        let _ = handle.emit("desktop-failed", error);
                    }
                });
            }
            #[cfg(desktop)]
            {
                let show =
                    tauri::menu::MenuItem::with_id(app, "show", "打开 Norr", true, None::<&str>)?;
                let quit =
                    tauri::menu::MenuItem::with_id(app, "quit", "退出 Norr", true, None::<&str>)?;
                let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])?;
                tauri::tray::TrayIconBuilder::with_id("norr-status")
                    .icon(app.default_window_icon().expect("application icon").clone())
                    .title("Norr")
                    .tooltip("Norr 北行")
                    .menu(&menu)
                    .on_tray_icon_event(|tray, event| {
                        if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            }
            tauri::async_runtime::spawn(collect_in_background(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(desktop)]
            if _window.label() != "main" {
                return;
            }
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                api.prevent_close();
                let _ = _window.hide();
            }
        })
        .invoke_handler(|invoke| {
            #[cfg(all(
                target_os = "ios",
                not(any(feature = "p4-field-test", feature = "polestar4-test"))
            ))]
            if invoke.message.command() == "sync_watch"
                && invoke.message.webview_ref().label() == "main"
            {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![watch::sync_watch];
                return handler(invoke);
            }
            #[cfg(target_os = "windows")]
            if invoke.message.command() == "submit_verification" {
                let verification_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![verification_windows::submit_verification];
                return verification_handler(invoke);
            }
            if invoke.message.webview_ref().label() != "main" {
                invoke.resolver.reject("请在 Norr 主窗口操作");
                return true;
            }
            #[cfg(any(
                all(target_os = "ios", feature = "p4-field-test"),
                all(
                    any(target_os = "ios", target_os = "windows", target_os = "android"),
                    feature = "polestar4"
                )
            ))]
            if matches!(
                invoke.message.command(),
                "field_recordings"
                    | "share_recording"
                    | "record_session_observation"
                    | "read_recording_vehicle"
            ) {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                    p4_recorder::field_recordings,
                    p4_recorder::share_recording,
                    p4_recorder::record_session_observation,
                    p4_recorder::read_recording_vehicle
                ];
                return handler(invoke);
            }
            #[cfg(all(target_os = "ios", feature = "p4-field-test"))]
            if invoke.message.command() == "p4_partner_control" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![p4_recorder::p4_partner_control];
                return handler(invoke);
            }
            #[cfg(any(
                all(
                    any(target_os = "ios", target_os = "windows"),
                    feature = "p4-field-test"
                ),
                all(
                    any(
                        target_os = "macos",
                        target_os = "ios",
                        target_os = "windows",
                        target_os = "android"
                    ),
                    feature = "polestar4"
                )
            ))]
            if matches!(
                invoke.message.command(),
                "open_field_log" | "mark_field_log" | "export_field_log"
            ) {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                    p4_field::open_field_log,
                    p4_field::mark_field_log,
                    p4_field::export_field_log
                ];
                return handler(invoke);
            }
            #[cfg(all(
                any(target_os = "ios", target_os = "windows"),
                feature = "p4-field-test"
            ))]
            {
                match invoke.message.command() {
                    "session_status" | "request_login_code" | "sign_in_phone"
                    | "sign_in_password" | "connect" => {}
                    _ => {
                        invoke.resolver.reject("此测试包仅提供账号登录和实测日志");
                        return true;
                    }
                }
            }
            #[cfg(any(target_os = "android", target_os = "ios", target_os = "macos"))]
            if ["update_widgets", "take_widget_target"].contains(&invoke.message.command()) {
                let widget_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![widgets::update_widgets, widgets::take_widget_target];
                return widget_handler(invoke);
            }
            #[cfg(target_os = "ios")]
            if invoke.message.command() == "control_tap" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![control_tap];
                return handler(invoke);
            }
            #[cfg(target_os = "android")]
            if invoke.message.command() == "set_android_theme" {
                let theme_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![set_android_theme];
                return theme_handler(invoke);
            }
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
            if matches!(invoke.message.command(), "check_update" | "install_update") {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![updates::check_update, updates::install_update];
                return handler(invoke);
            }
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if invoke.message.command() == "import_hisingen" {
                let development_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![import_hisingen];
                return development_handler(invoke);
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                app_version,
                session_status,
                login::request_login_code,
                login::sign_in_phone,
                login::sign_in_password,
                connect,
                refresh,
                history,
                history_report,
                preview_history_import,
                commit_history_import,
                cancel_history_import,
                set_refresh_interval,
                desktop_status,
                set_desktop_option,
                open_system_settings,
                test_notification,
                take_notification_target,
                open_location,
                open_map_link,
                export_history,
                record_p4_observation,
                send_command
            ];
            handler(invoke)
        })
        .build(app_context())
        .expect("Norr could not start")
        .run(|_app, _event| {
            #[cfg(any(target_os = "ios", target_os = "macos"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                for url in urls {
                    widgets::open_url(_app, url);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}

fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn authorization_commands_are_allowed_only_from_the_local_main_window() {
        use tauri::utils::{acl::resolved::Resolved, platform::Target};

        let remote = tauri::ipc::Origin::Remote {
            url: "https://h5.app.polestar-auto.com/account-components/auth-slider/index.html"
                .parse()
                .unwrap(),
        };
        let local = tauri::ipc::Origin::Local;
        for target in [Target::MacOS, Target::Ios] {
            let manifests = serde_json::from_str(include_str!(concat!(
                env!("OUT_DIR"),
                "/acl-manifests.json"
            )))
            .unwrap();
            let capabilities =
                serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json")))
                    .unwrap();
            let resolved = Resolved::resolve(&manifests, capabilities, target).unwrap();
            let authority = tauri::ipc::RuntimeAuthority::new(manifests, resolved);
            for command in [
                "request_login_code",
                "sign_in_phone",
                "sign_in_password",
                "sync_watch",
            ] {
                assert_eq!(
                    authority
                        .resolve_access(command, "main", "main", &local)
                        .is_some(),
                    command != "sync_watch" || target == Target::Ios,
                    "unexpected access for {command} from the local main window on {target:?}"
                );
                assert!(authority
                    .resolve_access(
                        command,
                        "phone-verification-1",
                        "phone-verification-1",
                        &remote
                    )
                    .is_none());
                assert!(authority
                    .resolve_access(command, "main", "main", &remote)
                    .is_none());
                assert!(authority
                    .resolve_access(command, "other", "other", &local)
                    .is_none());
            }
            if target == Target::Ios {
                for command in ["plugin:event|listen", "plugin:event|unlisten"] {
                    assert!(authority
                        .resolve_access(command, "main", "main", &local)
                        .is_some());
                }
                for command in ["plugin:event|emit", "set_android_theme", "import_hisingen"] {
                    assert!(authority
                        .resolve_access(command, "main", "main", &local)
                        .is_none());
                }
            }
        }
    }

    #[test]
    fn verification_callback_is_allowed_only_from_its_official_window() {
        let manifests = serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/acl-manifests.json"
        )))
        .unwrap();
        let capabilities =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json")))
                .unwrap();
        let resolved = tauri::utils::acl::resolved::Resolved::resolve(
            &manifests,
            capabilities,
            tauri::utils::platform::Target::Windows,
        )
        .unwrap();
        let authority = tauri::ipc::RuntimeAuthority::new(manifests, resolved);
        for url in [
            "https://h5.app.polestar-auto.com/",
            "https://h5.app.polestar-auto.com/account-components/auth-slider/index.html?from=webview",
        ] {
            let remote = tauri::ipc::Origin::Remote {
                url: url.parse().unwrap(),
            };
            assert!(authority
                .resolve_access(
                    "submit_verification",
                    "phone-verification-1",
                    "phone-verification-1",
                    &remote
                )
                .is_some(), "verification callback must accept IPC source {url}");
            assert!(authority
                .resolve_access("submit_verification", "main", "main", &remote)
                .is_none());
        }
        assert!(authority
            .resolve_access(
                "submit_verification",
                "phone-verification-1",
                "phone-verification-1",
                &tauri::ipc::Origin::Local
            )
            .is_none());
        let other_origin = tauri::ipc::Origin::Remote {
            url: "https://example.org/".parse().unwrap(),
        };
        assert!(authority
            .resolve_access(
                "submit_verification",
                "phone-verification-1",
                "phone-verification-1",
                &other_origin
            )
            .is_none());
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_rejects_hisingen_session_import() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(run_cli(&["--import-hisingen".into()]));
        assert_eq!(result.unwrap_err(), "不支持的命令行参数");
    }

    #[test]
    fn desktop_settings_migrate_and_map_links_are_restricted() {
        let settings: Settings =
            serde_json::from_value(serde_json::json!({"refreshSeconds":300,"selectedVin":null}))
                .unwrap();
        assert_eq!(settings.refresh_seconds, 300);
        assert!(settings.refresh_on_wake);
        assert!(
            !settings.launch_at_login && !settings.notify_charging && !settings.notify_commands
        );
        assert!(validate_map_url("https://www.google.com/maps/search/?api=1&query=39,116").is_ok());
        assert!(validate_map_url("https://uri.amap.com/marker?position=116,39").is_ok());
        for url in [
            "file:///tmp/map",
            "https://www.google.com.evil.test/maps/search/",
            "https://www.google.com/redirect",
            "https://user@maps.apple.com/",
        ] {
            assert!(validate_map_url(url).is_err());
        }
    }

    #[test]
    fn command_readback_targets_local_state_with_collection_disabled() {
        let receipt = |id: &str, action: &str, time| Receipt {
            id: id.into(),
            command: Command {
                vin: "TEST0000000000001".into(),
                action: action.into(),
                ..Default::default()
            },
            time,
            status: "completed".into(),
            message: "fixture".into(),
            readback_at: None,
            readback: Some("等待车辆回读".into()),
            baseline_timer_ids: None,
            account_scope: None,
        };
        let mut history = History {
            receipts: vec![receipt("unlock", "unlock", 1000)],
            settings: Settings {
                refresh_seconds: 0,
                selected_vin: Some("TEST0000000000002".into()),
                ..Settings::default()
            },
            ..History::default()
        };
        assert!(pending_readback(&history, 2000, None, |_| false).is_none());
        let pending = pending_readback(&history, 2000, None, |_| true).unwrap();
        assert_eq!(pending.command.vin, "TEST0000000000001");
        assert_eq!(
            confirmation::endpoint(&pending.command.action),
            Some("exterior")
        );

        history.receipts.push(receipt("lock", "lock", 2000));
        assert_eq!(
            pending_readback(&history, 3000, None, |_| true)
                .unwrap()
                .command
                .action,
            "lock"
        );
        history.receipts[1].status = "rejected".into();
        assert_eq!(
            pending_readback(&history, 3000, None, |_| true)
                .unwrap()
                .command
                .action,
            "unlock"
        );
        history.receipts[1].status = "completed".into();
        history.receipts[1].readback = Some(confirmation::CONFIRMED.into());
        assert!(pending_readback(&history, 3000, None, |_| true).is_none());

        history
            .receipts
            .push(receipt("climate", "climateStart", 3000));
        assert_eq!(
            confirmation::endpoint(
                &pending_readback(&history, 4000, None, |_| true)
                    .unwrap()
                    .command
                    .action
            ),
            Some("climate")
        );
        assert!(pending_readback(&history, 123_000, None, |_| true).is_none());
        history.receipts.push(receipt("flash", "flash", 123_000));
        assert!(pending_readback(&history, 124_000, None, |_| true).is_none());

        history.receipts = vec![
            receipt("climate", "climateStart", 1000),
            receipt("unlock", "unlock", 2000),
        ];
        history.snapshots.push(
            serde_json::from_value(serde_json::json!({
                "vehicle": {"vin":"TEST0000000000001", "model":"fixture", "modelYear":null,
                    "owner":false, "platform":"ICUP", "capabilities":{}, "limits":{}},
                "fetchedAt":3000,
                "readings": {
                    "climate":{"status":"success", "value":{}, "observedAt":3000,
                        "reportedAt":500, "error":null},
                    "exterior":{"status":"success", "value":{}, "observedAt":2000,
                        "reportedAt":500, "error":null}
                }
            }))
            .unwrap(),
        );
        assert_eq!(
            pending_readback(&history, 4000, None, |_| true)
                .unwrap()
                .command
                .action,
            "unlock"
        );
        history.snapshots[0]
            .readings
            .get_mut("exterior")
            .unwrap()
            .observed_at = 4000;
        assert_eq!(
            pending_readback(&history, 5000, None, |_| true)
                .unwrap()
                .command
                .action,
            "climateStart"
        );
    }

    #[test]
    fn cached_vehicle_state_cannot_confirm_a_later_command() {
        let path = std::env::temp_dir().join(format!("norr-test-{}.json", uuid::Uuid::new_v4()));
        let receipt = Receipt {
            id: "fixture".into(),
            command: Command {
                vin: "TEST0000000000001".into(),
                action: "lock".into(),
                value: None,
                ..Default::default()
            },
            time: 2000,
            status: "accepted".into(),
            message: "fixture".into(),
            readback: None,
            readback_at: None,
            baseline_timer_ids: None,
            account_scope: None,
        };
        let mut backend = Backend {
            client: ChinaClient::new().unwrap(),
            path: path.clone(),
            archive: archive::Archive::open(&path.with_extension("sqlite3")).unwrap(),
            pending_import: None,
            history: History {
                snapshots: vec![],
                receipts: vec![receipt],
                settings: Settings::default(),
                notifications: notifications::Tracker::default(),
            },
        };
        let mut reading = Reading::success(serde_json::json!({"locked":true}), Some(1000));
        reading.observed_at = 3000;
        let mut snapshot = Snapshot {
            vehicle: Vehicle {
                vin: "TEST0000000000001".into(),
                model: "fixture".into(),
                model_year: None,
                owner: None,
                platform: None,
                capabilities: BTreeMap::new(),
                limits: BTreeMap::new(),
                installed_version: None,
            },
            fetched_at: 3000,
            readings: BTreeMap::from([("exterior".into(), reading)]),
        };
        backend.record(snapshot.clone()).unwrap();
        assert_eq!(
            backend.history.receipts[0].readback.as_deref(),
            Some("车辆数据早于指令，等待新状态")
        );
        snapshot.readings.get_mut("exterior").unwrap().reported_at = Some(2500);
        snapshot.vehicle.vin = "TEST0000000000002".into();
        backend.record(snapshot.clone()).unwrap();
        assert_eq!(
            backend.history.receipts[0].readback.as_deref(),
            Some("车辆数据早于指令，等待新状态")
        );
        snapshot.vehicle.vin = "TEST0000000000001".into();
        backend.record(snapshot).unwrap();
        assert_eq!(
            backend.history.receipts[0].readback.as_deref(),
            Some("回读一致")
        );
        assert_eq!(backend.history.receipts[0].status, "accepted");
        let restored: History = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored.snapshots.len(), 3);
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(&path).unwrap();
        drop(backend);
        std::fs::remove_file(path.with_extension("sqlite3")).unwrap();
    }
}
