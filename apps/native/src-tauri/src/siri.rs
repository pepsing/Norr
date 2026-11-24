use crate::{confirmation, Command, Receipt};

const READBACK_WINDOW_MS: u64 = 600_000;

#[cfg(target_os = "ios")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

#[cfg(target_os = "ios")]
pub(crate) fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

#[cfg(target_os = "ios")]
fn publish(snapshot: &crate::Snapshot, account: &str) {
    use tauri::Emitter;
    crate::widgets::publish_siri_snapshot(snapshot, account);
    if let Some(app) = APP.get() {
        let _ = app.emit("vehicle-updated", snapshot);
    }
}

fn control_action(action: &str, xchanger: bool) -> crate::Result<&str> {
    match (action, xchanger) {
        ("tailgateOpen", true) => Ok("unlockTrunk"),
        ("tailgateClose", true) => Err("此车辆仅支持解锁尾门，请手动关闭尾门".into()),
        _ => Ok(action),
    }
}

fn pending_command<'a>(
    receipts: &'a [Receipt],
    command: &Command,
    account: &str,
    now: u64,
    xchanger: bool,
) -> Option<&'a Receipt> {
    if xchanger {
        confirmation::unresolved_xchanger(receipts, command, account, now)
    } else {
        unresolved_command(receipts, command, account, now)
    }
}

pub(crate) fn unresolved_command<'a>(
    receipts: &'a [Receipt],
    command: &Command,
    account: &str,
    now: u64,
) -> Option<&'a Receipt> {
    let group: &[&str] = match command.action.as_str() {
        "lock" | "unlock" => &["lock", "unlock"],
        "windowsOpen" | "windowsClose" => &["windowsOpen", "windowsClose"],
        "tailgateOpen" | "tailgateClose" => &["tailgateOpen", "tailgateClose"],
        "climateStart" | "climateStop" => &["climateStart", "climateStop"],
        _ => return None,
    };
    receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.account_scope.as_deref() == Some(account)
                && receipt.command.vin == command.vin
                && group.contains(&receipt.command.action.as_str())
                && receipt.status != "rejected"
        })
        .filter(|receipt| {
            receipt.readback.as_deref() != Some(confirmation::CONFIRMED)
                && now.saturating_sub(receipt.time) < READBACK_WINDOW_MS
        })
}

#[cfg(target_os = "ios")]
mod ios {
    use super::*;
    use crate::{now_ms, vehicle_service, Backend, Reading, Result, Vehicle};
    use serde::{Deserialize, Serialize};
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        future::Future,
        time::Duration,
    };
    use tokio::{sync::watch, time::Instant};

    type Cancellation = watch::Sender<bool>;
    type Completion = extern "C" fn(*mut c_void, *const c_char);

    #[derive(Clone, Copy, Deserialize)]
    #[serde(rename_all = "camelCase")]
    enum Action {
        Vehicles,
        Energy,
        LockState,
        Lock,
        Unlock,
        WindowsOpen,
        WindowsClose,
        TailgateOpen,
        TailgateClose,
        ClimateStart,
        ClimateStop,
    }

    #[derive(Deserialize)]
    struct Request {
        action: Action,
        vehicle: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Entity {
        id: String,
        name: String,
        trunk_unlock_only: bool,
    }

    #[derive(Serialize)]
    #[serde(tag = "status", rename_all = "camelCase")]
    enum Response {
        Vehicles {
            vehicles: Vec<Entity>,
            preferred: Option<String>,
        },
        Reading {
            reading: Reading,
        },
        Confirmed,
        Accepted,
        Pending,
        PendingConflict,
        Rejected,
        Error {
            message: String,
        },
    }

    fn entity_id(account: &str, vin: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut id = Sha256::new();
        id.update(account);
        id.update(vin);
        format!("{:x}", id.finalize())
    }

    fn entity(account: &str, car: &Vehicle) -> Entity {
        let suffix: String = car
            .vin
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        Entity {
            id: entity_id(account, &car.vin),
            name: format!("{}（尾号 {}）", car.model, suffix),
            trunk_unlock_only: car.uses_xchanger(),
        }
    }

    async fn bounded<T>(
        deadline: Instant,
        cancel: &mut watch::Receiver<bool>,
        future: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::select! {
            biased;
            _ = cancel.wait_for(|value| *value) => Err("操作已取消".into()),
            result = tokio::time::timeout_at(deadline, future) => {
                result.map_err(|_| "车辆服务响应超时".to_owned())?
            }
        }
    }

    async fn run(request: Request, mut cancel: watch::Receiver<bool>) -> Result<Response> {
        let directory = dirs::data_dir().ok_or("无法读取 Norr 数据目录")?;
        let path = directory
            .join("app.norr.ios")
            .join("files")
            .join("vehicle-history.json");
        let service = tokio::task::spawn_blocking(move || vehicle_service::ios_service(path))
            .await
            .map_err(|_| "车辆服务初始化未完成")??;
        let deadline = Instant::now() + Duration::from_secs(17);
        let mut backend =
            bounded(deadline, &mut cancel, async { Ok(service.lock().await) }).await?;
        let fleet = bounded(deadline, &mut cancel, async {
            Ok(backend.client.vehicles().await?.to_vec())
        })
        .await?;
        let account = backend.client.account_scope().ok_or("请先在 Norr 登录")?;
        if matches!(request.action, Action::Vehicles) {
            let selected = backend.history.settings.selected_vin.as_deref();
            let preferred = fleet
                .iter()
                .find(|car| Some(car.vin.as_str()) == selected)
                .or_else(|| (fleet.len() == 1).then(|| &fleet[0]))
                .map(|car| entity_id(&account, &car.vin));
            return Ok(Response::Vehicles {
                vehicles: fleet.iter().map(|car| entity(&account, car)).collect(),
                preferred,
            });
        }

        let id = request.vehicle.ok_or("请选择车辆")?;
        let car = fleet
            .into_iter()
            .find(|car| entity_id(&account, &car.vin) == id)
            .ok_or("车辆已不属于当前账号，请重新选择")?;

        let action = match request.action {
            Action::Energy | Action::LockState => {
                let kind = if matches!(request.action, Action::Energy) {
                    "battery"
                } else {
                    "exterior"
                };
                let reading = bounded(
                    deadline,
                    &mut cancel,
                    backend.client.refresh_reading(&car.vin, kind),
                )
                .await?;
                let snapshot = backend.record_reading(&car, kind, reading.clone(), now_ms())?;
                publish(&snapshot, &account);
                return if reading.status == "success" {
                    Ok(Response::Reading { reading })
                } else {
                    Err(reading.error.unwrap_or_else(|| "无法读取车辆数据".into()))
                };
            }
            Action::Lock => "lock",
            Action::Unlock => "unlock",
            Action::WindowsOpen => "windowsOpen",
            Action::WindowsClose => "windowsClose",
            Action::TailgateOpen => "tailgateOpen",
            Action::TailgateClose => "tailgateClose",
            Action::ClimateStart => "climateStart",
            Action::ClimateStop => "climateStop",
            Action::Vehicles => unreachable!(),
        };
        let xchanger = car.uses_xchanger();
        let action = control_action(action, xchanger)?;
        let command = Command {
            vin: car.vin.clone(),
            action: action.into(),
            ..Default::default()
        };
        let endpoint = confirmation::endpoint(action).ok_or("此操作不支持回读")?;
        if let Some(mut receipt) = pending_command(
            &backend.history.receipts,
            &command,
            &account,
            now_ms(),
            xchanger,
        )
        .cloned()
        {
            readback(
                &mut backend,
                &car,
                endpoint,
                &mut receipt,
                deadline,
                &mut cancel,
            )
            .await;
            if receipt.command.action == action && receipt.command.value == command.value {
                return Ok(command_result(&receipt));
            }
            if pending_command(
                &backend.history.receipts,
                &command,
                &account,
                now_ms(),
                xchanger,
            )
            .is_some()
            {
                return Ok(Response::PendingConflict);
            }
        }

        let prepared = bounded(deadline, &mut cancel, backend.client.prepare(&command)).await?;
        if *cancel.borrow() || Instant::now() >= deadline {
            return Err("操作未发送".into());
        }
        let mut receipt = backend.record_submission(command, &prepared)?;
        let result = bounded(deadline, &mut cancel, backend.client.execute(prepared)).await;
        if backend.finish_submission(&mut receipt, result).is_err() {
            return Ok(Response::Pending);
        }
        if receipt.status != "rejected" && !*cancel.borrow() && Instant::now() < deadline {
            readback(
                &mut backend,
                &car,
                endpoint,
                &mut receipt,
                deadline,
                &mut cancel,
            )
            .await;
        }
        Ok(command_result(&receipt))
    }

    async fn readback(
        backend: &mut Backend,
        car: &Vehicle,
        endpoint: &str,
        receipt: &mut Receipt,
        deadline: Instant,
        cancel: &mut watch::Receiver<bool>,
    ) {
        let Ok(reading) = bounded(
            deadline,
            cancel,
            backend.client.refresh_reading(&car.vin, endpoint),
        )
        .await
        else {
            return;
        };
        if let Ok(snapshot) = backend.record_reading(car, endpoint, reading, now_ms()) {
            if let Some(account) = backend.client.account_scope() {
                publish(&snapshot, &account);
            }
            if let Some(updated) = backend.history.receipts.iter().find(|r| r.id == receipt.id) {
                *receipt = updated.clone();
            }
        }
    }

    fn command_result(receipt: &Receipt) -> Response {
        if receipt.readback.as_deref() == Some(confirmation::CONFIRMED) {
            return Response::Confirmed;
        }
        match receipt.status.as_str() {
            "accepted" | "delivered" | "completed" => Response::Accepted,
            "rejected" => Response::Rejected,
            _ => Response::Pending,
        }
    }

    #[no_mangle]
    extern "C" fn norr_siri_cancellation_new() -> *mut Cancellation {
        Box::into_raw(Box::new(watch::channel(false).0))
    }

    #[no_mangle]
    unsafe extern "C" fn norr_siri_cancel(cancellation: *const Cancellation) {
        unsafe { &*cancellation }.send_replace(true);
    }

    #[no_mangle]
    unsafe extern "C" fn norr_siri_cancellation_free(cancellation: *mut Cancellation) {
        drop(unsafe { Box::from_raw(cancellation) });
    }

    #[no_mangle]
    unsafe extern "C" fn norr_siri_run(
        request: *const c_char,
        cancellation: *const Cancellation,
        context: *mut c_void,
        complete: Completion,
    ) {
        // Swift owns the request bytes until this function returns and the callback context until completion.
        let request =
            serde_json::from_slice::<Request>(unsafe { CStr::from_ptr(request) }.to_bytes());
        let cancel = unsafe { &*cancellation }.subscribe();
        let context = context as usize;
        tauri::async_runtime::spawn(async move {
            let response = match request {
                Ok(request) => {
                    run(request, cancel)
                        .await
                        .unwrap_or_else(|message| Response::Error {
                            message: if message.contains("iOS 钥匙串读取失败") {
                                "请解锁设备后重试。如仍无法读取登录信息，请打开 Norr。".into()
                            } else {
                                message
                            },
                        })
                }
                Err(_) => Response::Error {
                    message: "Norr 无法识别此操作".into(),
                },
            };
            let payload = serde_json::to_vec(&response)
                .ok()
                .and_then(|bytes| CString::new(bytes).ok());
            complete(
                context as *mut c_void,
                payload
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailgate_actions_match_each_vehicle_service() {
        assert_eq!(control_action("tailgateOpen", true).unwrap(), "unlockTrunk");
        assert!(control_action("tailgateClose", true).is_err());
        for action in ["tailgateOpen", "tailgateClose", "lock", "climateStart"] {
            assert_eq!(control_action(action, false).unwrap(), action);
        }
    }

    #[test]
    fn p4_pending_rules_match_the_app_without_relaxing_unknown_commands() {
        for (action, opposite, observed) in [
            ("climateStart", "climateStop", confirmation::CLIMATE_ACTIVE),
            ("windowsVent", "windowsClose", confirmation::WINDOWS_AJAR),
        ] {
            let mut previous = receipt("account", "car", action);
            let command = receipt("account", "car", opposite).command;
            assert!(
                pending_command(&[previous.clone()], &command, "account", 2000, true).is_some()
            );
            previous.readback = Some(observed.into());
            assert!(
                pending_command(&[previous.clone()], &command, "account", 2000, true).is_none()
            );
            assert!(pending_command(
                &[previous.clone()],
                &previous.command,
                "account",
                2000,
                true
            )
            .is_some());
        }
        let mut previous = receipt("account", "car", "climateStart");
        previous.readback = Some(confirmation::CLIMATE_ACTIVE.into());
        let stop = receipt("account", "car", "climateStop").command;
        assert!(pending_command(&[previous], &stop, "account", 2000, false).is_some());
        let previous = receipt("account", "car", "unlock");
        let lock = receipt("account", "car", "lock").command;
        assert!(pending_command(&[previous], &lock, "account", 2000, true).is_some());
    }

    fn receipt(account: &str, vin: &str, action: &str) -> Receipt {
        Receipt {
            id: "fixture".into(),
            command: Command {
                vin: vin.into(),
                action: action.into(),
                ..Default::default()
            },
            time: 1_000,
            status: "unknown".into(),
            message: String::new(),
            readback_at: None,
            readback: None,
            baseline_timer_ids: None,
            account_scope: Some(account.into()),
        }
    }

    #[test]
    fn pending_climate_command_blocks_same_account_and_vehicle_only() {
        let start = receipt("first", "car", "climateStart");
        let stop = receipt("first", "car", "climateStop").command;
        let receipts = [receipt("second", "car", "climateStop"), start];
        assert_eq!(
            unresolved_command(&receipts, &stop, "first", 2_000)
                .unwrap()
                .command
                .action,
            "climateStart"
        );
        assert!(unresolved_command(&receipts, &stop, "third", 2_000).is_none());
        assert!(unresolved_command(&receipts, &stop, "first", 601_000).is_none());
        assert!(unresolved_command(
            &receipts,
            &Command {
                vin: "other".into(),
                ..stop
            },
            "first",
            2_000
        )
        .is_none());
    }

    #[test]
    fn rejected_command_does_not_hide_previous_unknown_command() {
        let pending = receipt("account", "car", "lock");
        let command = pending.command.clone();
        let mut rejected = pending.clone();
        rejected.status = "rejected".into();
        assert!(unresolved_command(&[pending, rejected], &command, "account", 2_000).is_some());
    }

    #[test]
    fn pending_opening_commands_block_repeats_and_opposite_actions() {
        for (first, opposite) in [
            ("lock", "unlock"),
            ("windowsOpen", "windowsClose"),
            ("tailgateOpen", "tailgateClose"),
        ] {
            for (pending_action, opposing_action) in [(first, opposite), (opposite, first)] {
                let receipts = [
                    receipt("account", "car", pending_action),
                    receipt("other", "car", opposing_action),
                ];
                for action in [pending_action, opposing_action] {
                    let command = receipt("account", "car", action).command;
                    let previous =
                        unresolved_command(&receipts, &command, "account", 2_000).unwrap();
                    assert_eq!(previous.command.action, pending_action);
                }
            }
        }
        let window = receipt("account", "car", "windowsClose");
        let tailgate = receipt("account", "car", "tailgateOpen");
        assert!(unresolved_command(&[window], &tailgate.command, "account", 2_000).is_none());
    }
}
