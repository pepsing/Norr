#![cfg(target_env = "ohos")]

use norr_vehicle_core::{
    auth::PhoneLogin, china::ChinaClient, confirmation, credentials, models::*, now_ms, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{c_char, CStr, CString},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tokio::{runtime::Runtime, sync::Mutex};

#[path = "../../../native/src-tauri/src/archive.rs"]
mod archive;
#[path = "../../../native/src-tauri/src/insights.rs"]
mod insights;
mod storage;

mod platform {
    pub fn private_path(path: &std::path::Path, mode: u32) -> norr_vehicle_core::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|_| "无法设置本机文件权限".into())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
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

#[derive(Clone, Default, Deserialize, Serialize)]
struct History {
    snapshots: Vec<Snapshot>,
    receipts: Vec<Receipt>,
    #[serde(default)]
    settings: Settings,
}

struct Backend {
    client: ChinaClient,
    login: PhoneLogin,
    history: History,
    directory: PathBuf,
    archive: archive::Archive,
    pending_import: Option<archive::PendingImport>,
    last_attempt: u64,
}

impl Backend {
    fn new(directory: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&directory).map_err(|_| "无法建立本机数据目录")?;
        platform::private_path(&directory, 0o700)?;
        let history = match std::fs::read(directory.join("history.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "本机记录格式异常，请保留文件后恢复备份")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => History::default(),
            Err(_) => return Err("无法读取本机记录".into()),
        };
        let archive = archive::Archive::open(&directory.join("history.sqlite3"))?;
        archive.sync(&history)?;
        Ok(Self {
            client: ChinaClient::new()?,
            login: PhoneLogin::new()?,
            history,
            directory,
            archive,
            pending_import: None,
            last_attempt: now_ms(),
        })
    }

    fn save(&self) -> Result<()> {
        write_private(
            &self.directory.join("history.json"),
            &serde_json::to_vec(&self.history).map_err(|_| "记录编码失败")?,
        )?;
        self.archive.sync(&self.history)
    }

    fn record(&mut self, snapshot: Snapshot) -> Result<Snapshot> {
        for receipt in &mut self.history.receipts {
            confirmation::update(receipt, &snapshot);
        }
        self.history.settings.selected_vin = Some(snapshot.vehicle.vin.clone());
        self.history.snapshots.push(snapshot.clone());
        if self.history.snapshots.len() > 5000 {
            self.history.snapshots.remove(0);
        }
        self.save()?;
        Ok(snapshot)
    }

    fn commit_session(&mut self, session: credentials::Session) -> Result<Value> {
        let client = ChinaClient::new()?;
        credentials::save_session(&session)?;
        self.client = client;
        self.login.finish();
        self.history.settings.selected_vin = None;
        self.save()?;
        value(credentials::status()?)
    }

    async fn command(&mut self, command: Command, authorized: bool) -> Result<Value> {
        self.client.validate_command(&command)?;
        if matches!(
            command.action.as_str(),
            "unlock"
                | "unlockTrunk"
                | "tailgateOpen"
                | "windowsOpen"
                | "honkFlash"
                | "otaInstall"
                | "otaSchedule"
                | "deleteClimateTimer"
        ) && !authorized
        {
            return Err("系统身份验证已取消或未通过，指令尚未发送".into());
        }
        let prepared = self.client.prepare(&command).await?;
        let mut receipt = Receipt {
            id: uuid::Uuid::new_v4().to_string(),
            command,
            time: now_ms(),
            status: "unknown".into(),
            message: "指令已开始发送，执行结果待核对".into(),
            readback_at: None,
            readback: None,
            baseline_timer_ids: prepared.baseline_timer_ids.clone(),
            account_scope: self.client.account_scope(),
        };
        self.history.receipts.push(receipt.clone());
        if self.history.receipts.len() > 2000 {
            self.history.receipts.remove(0);
        }
        self.save()?;
        match self.client.execute(prepared).await {
            Ok((status, message)) => {
                receipt.status = status;
                receipt.message = message;
            }
            Err(error) => receipt.message = format!("{error}。执行结果待回读核对"),
        }
        if receipt.status != "rejected" && confirmation::endpoint(&receipt.command.action).is_some()
        {
            receipt.readback = Some("等待车辆回读".into());
        }
        if let Some(saved) = self
            .history
            .receipts
            .iter_mut()
            .find(|item| item.id == receipt.id)
        {
            *saved = receipt.clone();
        }
        self.save()?;
        value(receipt)
    }

    async fn invoke(&mut self, command: &str, args: Value) -> Result<Value> {
        match command {
            "poll" => self.poll(args["waking"].as_bool().unwrap_or(false)).await,
            "session_status" => value(credentials::status()?),
            "prepare_login_code" => {
                self.login.ready_to_send(string(&args, "phone")?)?;
                credentials::signing_key()?;
                Ok(Value::Null)
            }
            "request_login_code" => {
                let verification = serde_json::from_value(args["verification"].clone())
                    .map_err(|_| "手机验证结果无效")?;
                value(
                    self.login
                        .send_code(string(&args, "phone")?, verification)
                        .await?,
                )
            }
            "sign_in_phone" => {
                let session = self
                    .login
                    .sign_in(string(&args, "phone")?, string(&args, "code")?)
                    .await?;
                self.commit_session(session)
            }
            "sign_in_password" => {
                let session = self
                    .login
                    .sign_in_password(string(&args, "phone")?, string(&args, "password")?.into())
                    .await?;
                self.commit_session(session)
            }
            "connect" => value(self.client.connect().await?),
            "refresh" => {
                let snapshot = self.client.refresh(string(&args, "vin")?).await?;
                value(self.record(snapshot)?)
            }
            "history" => value(&self.history),
            "history_report" => {
                let start = args["start"].as_u64().ok_or("历史开始时间无效")?;
                let end = args["end"].as_u64().ok_or("历史结束时间无效")?;
                if start >= end || end > 253402300800001 {
                    return Err("历史日期范围无效".into());
                }
                value(insights::report(
                    self.archive.records(string(&args, "vin")?, start, end)?,
                    self.archive.vehicles()?,
                    start,
                    end,
                ))
            }
            "set_refresh_interval" => {
                let seconds = args["seconds"].as_u64().ok_or("刷新间隔无效")?;
                if ![0, 60, 120, 300, 600].contains(&seconds) {
                    return Err("刷新间隔无效".into());
                }
                let previous = self.history.settings.clone();
                self.history.settings.refresh_seconds = seconds;
                if let Err(error) = self.save() {
                    self.history.settings = previous;
                    return Err(error);
                }
                value(&self.history.settings)
            }
            "desktop_status" => Ok(
                json!({"status":{"launchAtLogin":-1,"notifications":-1},"settings":self.history.settings}),
            ),
            "set_desktop_option" => {
                if string(&args, "option")? != "refreshOnWake" {
                    return Err("此鸿蒙版本尚未接入系统通知".into());
                }
                let previous = self.history.settings.clone();
                self.history.settings.refresh_on_wake =
                    args["enabled"].as_bool().ok_or("设置值无效")?;
                if let Err(error) = self.save() {
                    self.history.settings = previous;
                    return Err(error);
                }
                Ok(Value::Null)
            }
            "take_notification_target" | "take_widget_target" => Ok(Value::Null),
            "send_command" => {
                self.command(
                    serde_json::from_value(args["command"].clone())
                        .map_err(|_| "车辆指令格式无效")?,
                    args["authorized"].as_bool().unwrap_or(false),
                )
                .await
            }
            "preview_history_import" => {
                self.pending_import = None;
                let path = self.directory.join("import.json");
                let records = archive::read_backup(&path);
                let _ = std::fs::remove_file(path);
                let pending = archive::PendingImport {
                    token: uuid::Uuid::new_v4().to_string(),
                    source: "backup".into(),
                    records: records?,
                };
                let summary = self.archive.preview(&pending)?;
                self.pending_import = Some(pending);
                value(summary)
            }
            "commit_history_import" => {
                let pending = self
                    .pending_import
                    .as_ref()
                    .filter(|pending| Some(pending.token.as_str()) == args["token"].as_str())
                    .ok_or("导入预览已失效，请重新选择文件")?;
                let mut summary = self.archive.preview(pending)?;
                summary.added = self.archive.merge(&pending.records, false)?;
                summary.duplicates = summary.total - summary.added;
                self.pending_import = None;
                value(summary)
            }
            "cancel_history_import" => {
                if self
                    .pending_import
                    .as_ref()
                    .is_some_and(|pending| Some(pending.token.as_str()) == args["token"].as_str())
                {
                    self.pending_import = None;
                }
                Ok(Value::Null)
            }
            "export_history" => {
                let vin = string(&args, "vin")?;
                let format = string(&args, "format")?;
                let bytes = match format {
                    "json" => self.archive.backup(vin)?,
                    "csv" => insights::csv(self.archive.records(vin, 0, 253402300800001)?)?,
                    _ => return Err("导出格式无效".into()),
                };
                let name = format!("Norr-history.{format}");
                let path = self.directory.join(&name);
                write_private(&path, &bytes)?;
                Ok(json!({"path":path,"name":name}))
            }
            "health_check" => {
                let id = credentials::device_id()?;
                let persisted = credentials::device_id()? == id;
                Ok(
                    json!({"secureStorage":persisted,"hasSigningKey":credentials::status()?.has_signing_key}),
                )
            }
            _ => Err("此鸿蒙版本尚未提供该系统功能".into()),
        }
    }

    async fn poll(&mut self, waking: bool) -> Result<Value> {
        let now = now_ms();
        let mut latest = std::collections::BTreeSet::new();
        let pending = self
            .history
            .receipts
            .iter()
            .rev()
            .filter(|receipt| {
                if receipt.status == "rejected" {
                    return false;
                }
                let Some(endpoint) = confirmation::endpoint(&receipt.command.action) else {
                    return false;
                };
                latest.insert((receipt.command.vin.as_str(), endpoint))
                    && receipt.readback.as_deref() != Some(confirmation::CONFIRMED)
                    && now.saturating_sub(receipt.time) < 120_000
            })
            .min_by_key(|receipt| {
                self.history
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
            .map(|receipt| receipt.command.clone());
        let result = if let Some(command) = pending {
            let previous = self
                .history
                .snapshots
                .iter()
                .rev()
                .find(|snapshot| snapshot.vehicle.vin == command.vin)
                .cloned();
            if let Some(mut snapshot) = previous {
                let endpoint = confirmation::endpoint(&command.action).ok_or("指令回读项目无效")?;
                match self.client.refresh_reading(&command.vin, endpoint).await {
                    Ok(reading) => {
                        snapshot.readings.insert(endpoint.into(), reading);
                        snapshot.fetched_at = now_ms();
                        Ok(snapshot)
                    }
                    Err(error) => Err(error),
                }
            } else {
                self.client.refresh(&command.vin).await
            }
        } else {
            let seconds = if waking && self.history.settings.refresh_on_wake {
                2
            } else {
                self.history.settings.refresh_seconds
            };
            if seconds == 0 || now.saturating_sub(self.last_attempt) < seconds * 1000 {
                return Ok(Value::Null);
            }
            let Some(vin) = self.history.settings.selected_vin.clone() else {
                return Ok(Value::Null);
            };
            self.last_attempt = now;
            self.client.refresh(&vin).await
        };
        match result.and_then(|snapshot| self.record(snapshot)) {
            Ok(snapshot) => {
                let woke = snapshot
                    .readings
                    .values()
                    .any(|reading| reading.status == "success");
                Ok(json!({"snapshot":snapshot,"woke":woke}))
            }
            Err(error) => Ok(json!({"error":error})),
        }
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "无法保存本机记录")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "本机记录写入失败")?;
    drop(file);
    std::fs::rename(temporary, path).map_err(|_| "本机记录保存失败".into())
}

fn value(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| "结果编码失败".into())
}

fn string<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    args[name]
        .as_str()
        .ok_or_else(|| format!("参数 {name} 无效"))
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static BACKEND: OnceLock<Mutex<Backend>> = OnceLock::new();

async fn dispatch(request: Value) -> Value {
    let result: Result<Value> = async {
        let command = string(&request, "command")?;
        let args = request["args"].clone();
        if command == "initialize" {
            if BACKEND.get().is_some() {
                return Ok(Value::Null);
            }
            let directory = PathBuf::from(string(&args, "directory")?);
            let backend = Backend::new(directory.clone())?;
            credentials::harmonyos::initialize(Box::new(storage::Storage::new(
                directory.join("credentials"),
            )?))?;
            BACKEND
                .set(Mutex::new(backend))
                .map_err(|_| "车辆服务已初始化")?;
            return Ok(Value::Null);
        }
        let state = BACKEND.get().ok_or("车辆服务尚未就绪")?;
        if command == "poll" && state.try_lock().is_err() {
            return Ok(Value::Null);
        }
        let mut backend = state.lock().await;
        match backend.invoke(command, args).await {
            Ok(result) => Ok(result),
            Err(message) if command == "request_login_code" || command == "prepare_login_code" => {
                return Ok(
                    json!({"loginError":{"message":message,"retryAt":backend.login.retry_at()}}),
                );
            }
            Err(message) => Err(message),
        }
    }
    .await;
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}

#[no_mangle]
pub unsafe extern "C" fn norr_invoke(request: *const c_char) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if request.is_null() {
            return json!({"ok":false,"error":"请求为空"});
        }
        let request = zeroize::Zeroizing::new(CStr::from_ptr(request).to_bytes().to_vec());
        let parsed = match serde_json::from_slice(&request) {
            Ok(value) => value,
            Err(_) => return json!({"ok":false,"error":"请求格式无效"}),
        };
        RUNTIME
            .get_or_init(|| Runtime::new().expect("native runtime"))
            .block_on(dispatch(parsed))
    })
    .unwrap_or_else(|_| json!({"ok":false,"error":"车辆服务发生内部错误，请重试"}));
    CString::new(result.to_string())
        .expect("JSON string")
        .into_raw()
}

#[no_mangle]
pub unsafe extern "C" fn norr_free_result(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}
