use crate::{confirmation, now_ms, Backend, Command, Receipt, Result, Snapshot};
use norr_vehicle_core::china::PreparedCommand;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) type VehicleService = Arc<Mutex<Backend>>;

#[cfg(any(target_os = "ios", test))]
#[derive(Default)]
struct IosServiceSlot {
    service: std::sync::OnceLock<(std::path::PathBuf, VehicleService)>,
    initialization: std::sync::Mutex<()>,
}

#[cfg(any(target_os = "ios", test))]
impl IosServiceSlot {
    fn get(
        &self,
        root: std::path::PathBuf,
        initialize: impl FnOnce() -> Result<Backend>,
    ) -> Result<VehicleService> {
        let _guard = self
            .initialization
            .lock()
            .map_err(|_| "车辆服务初始化未完成")?;
        if let Some((initialized, service)) = self.service.get() {
            if initialized != &root {
                return Err("车辆服务数据目录不一致".into());
            }
            return Ok(service.clone());
        }
        let service = Arc::new(Mutex::new(initialize()?));
        self.service
            .set((root, service.clone()))
            .map_err(|_| "车辆服务重复初始化")?;
        Ok(service)
    }
}

#[cfg(target_os = "ios")]
pub(crate) fn ios_service(path: std::path::PathBuf) -> Result<VehicleService> {
    static SERVICE: IosServiceSlot = IosServiceSlot {
        service: std::sync::OnceLock::new(),
        initialization: std::sync::Mutex::new(()),
    };
    SERVICE.get(path.clone(), || {
        #[cfg(feature = "polestar4")]
        let path =
            crate::account_history_path(path, crate::credentials::load_session()?.as_ref(), true)?;
        crate::load_backend(path)
    })
}

impl Backend {
    pub(crate) fn record_reading(
        &mut self,
        car: &crate::Vehicle,
        endpoint: &str,
        reading: crate::Reading,
        fetched_at: u64,
    ) -> Result<Snapshot> {
        let mut snapshot = self
            .history
            .snapshots
            .iter()
            .rev()
            .find(|snapshot| snapshot.vehicle.vin == car.vin)
            .cloned()
            .unwrap_or_else(|| Snapshot {
                vehicle: car.clone(),
                fetched_at,
                readings: Default::default(),
            });
        let replace = snapshot.readings.get(endpoint).is_none_or(|old| {
            reading.observed_at >= old.observed_at
                && !(reading.status == "success" && old.status == "success"
                    && matches!((reading.reported_at, old.reported_at), (Some(new), Some(old)) if new < old))
        });
        if replace {
            snapshot.readings.insert(endpoint.into(), reading);
        }
        snapshot.vehicle = car.clone();
        snapshot.fetched_at = snapshot.fetched_at.max(fetched_at);
        self.record(snapshot)
    }

    pub(crate) fn apply_readback(&mut self, snapshot: &Snapshot) -> Result<()> {
        let account = self.client.account_scope();
        for receipt in &mut self.history.receipts {
            if receipt.account_scope.is_none() || receipt.account_scope == account {
                #[cfg(all(
                    any(target_os = "ios", target_os = "windows", target_os = "android"),
                    feature = "polestar4"
                ))]
                let before = (receipt.readback.clone(), receipt.readback_at);
                confirmation::update(receipt, snapshot);
                #[cfg(all(
                    any(target_os = "ios", target_os = "windows", target_os = "android"),
                    feature = "polestar4"
                ))]
                if snapshot.vehicle.uses_xchanger()
                    && receipt.command.vin == snapshot.vehicle.vin
                    && before != (receipt.readback.clone(), receipt.readback_at)
                {
                    if let Some(account) = &account {
                        self.archive
                            .xchanger_receipt(account, receipt, "readback")?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn submit(
        &mut self,
        command: Command,
        prepared: PreparedCommand,
    ) -> Result<Receipt> {
        let mut receipt = self.record_submission(command, &prepared)?;
        let result = self.client.execute(prepared).await;
        self.finish_submission(&mut receipt, result)?;
        Ok(receipt)
    }

    pub(crate) fn record_submission(
        &mut self,
        command: Command,
        prepared: &PreparedCommand,
    ) -> Result<Receipt> {
        let readback = if self.client.uses_xchanger(&command.vin)
            && confirmation::command_group(&command.action) == Some("find")
        {
            Some("鸣笛或闪灯结果请现场核对".into())
        } else {
            confirmation::endpoint(&command.action).map(|_| "等待车辆回读".into())
        };
        let receipt = Receipt {
            id: uuid::Uuid::new_v4().to_string(),
            command,
            time: now_ms(),
            status: "unknown".into(),
            message: "指令已开始发送，执行结果待核对".into(),
            readback_at: None,
            readback,
            baseline_timer_ids: prepared.baseline_timer_ids.clone(),
            account_scope: self.client.account_scope(),
        };
        #[cfg(all(
            any(target_os = "ios", target_os = "windows", target_os = "android"),
            feature = "polestar4"
        ))]
        if self.client.uses_xchanger(&receipt.command.vin) {
            if let Some(account) = self.client.account_scope() {
                self.archive
                    .xchanger_receipt(&account, &receipt, "submitted")?;
            }
        }
        self.history.receipts.push(receipt.clone());
        let evicted = (self.history.receipts.len() > 2000).then(|| self.history.receipts.remove(0));
        if let Err(error) = self.save() {
            self.history.receipts.pop();
            if let Some(evicted) = evicted {
                self.history.receipts.insert(0, evicted);
            }
            return Err(error);
        }
        Ok(receipt)
    }

    pub(crate) fn finish_submission(
        &mut self,
        receipt: &mut Receipt,
        result: Result<(String, String)>,
    ) -> Result<()> {
        match result {
            Ok((status, message)) => {
                receipt.status = status;
                receipt.message = message;
            }
            Err(error) => {
                let check = if self.client.uses_xchanger(&receipt.command.vin)
                    && confirmation::command_group(&receipt.command.action) == Some("find")
                {
                    "鸣笛或闪灯结果请现场核对，勿重复发送"
                } else {
                    "执行结果待回读核对"
                };
                receipt.message = format!("{error}。{check}");
            }
        }
        if receipt.status == "rejected" {
            receipt.readback = None;
        }
        self.replace_receipt(receipt)?;
        #[cfg(all(
            any(target_os = "ios", target_os = "windows", target_os = "android"),
            feature = "polestar4"
        ))]
        if self.client.uses_xchanger(&receipt.command.vin) {
            if let Some(account) = self.client.account_scope() {
                self.archive.xchanger_receipt(&account, receipt, "result")?;
            }
        }
        Ok(())
    }

    pub(crate) fn replace_receipt(&mut self, receipt: &Receipt) -> Result<()> {
        if let Some(saved) = self
            .history
            .receipts
            .iter_mut()
            .find(|item| item.id == receipt.id)
        {
            *saved = receipt.clone();
        }
        self.update_notifications();
        self.save()
    }
}

#[cfg(test)]
mod ios_tests {
    use super::*;

    #[test]
    fn siri_partial_reading_persists_state_and_receipts_without_crossing_vehicle_or_clock() {
        use serde_json::json;
        let root = std::env::temp_dir().join(format!("norr-siri-state-{}", uuid::Uuid::new_v4()));
        let mut backend = crate::load_backend(root.join("account-a/history.json")).unwrap();
        let car: crate::Vehicle =
            serde_json::from_value(json!({"vin":"TEST0000000000001", "model":"Polestar 4",
            "platform":"HUANFU", "capabilities":{}, "limits":{}}))
            .unwrap();
        let reading = |value, reported, observed| {
            let mut r = crate::Reading::success(value, Some(reported));
            r.observed_at = observed;
            r
        };
        backend
            .record_reading(
                &car,
                "battery",
                reading(json!({"percent":42}), 1000, 1500),
                1500,
            )
            .unwrap();
        backend.history.receipts.push(Receipt {
            id: "fixture".into(),
            command: Command {
                vin: car.vin.clone(),
                action: "unlock".into(),
                ..Default::default()
            },
            time: 2000,
            status: "accepted".into(),
            message: "fixture".into(),
            readback: None,
            readback_at: None,
            baseline_timer_ids: None,
            account_scope: None,
        });
        let snapshot = backend
            .record_reading(
                &car,
                "exterior",
                reading(json!({"locked":false}), 2500, 3000),
                3000,
            )
            .unwrap();
        assert_eq!(
            snapshot.readings["battery"].value.as_ref().unwrap()["percent"],
            42
        );
        assert_eq!(
            backend.history.receipts[0].readback.as_deref(),
            Some(confirmation::CONFIRMED)
        );
        let stale = backend
            .record_reading(
                &car,
                "exterior",
                reading(json!({"locked":true}), 2300, 4000),
                4000,
            )
            .unwrap();
        assert_eq!(
            stale.readings["exterior"].value.as_ref().unwrap()["locked"],
            false
        );
        assert_eq!(stale.readings["exterior"].observed_at, 3000);
        let mut other = car.clone();
        other.vin = "TEST0000000000002".into();
        let other_snapshot = backend
            .record_reading(
                &other,
                "exterior",
                reading(json!({"locked":true}), 4500, 5000),
                5000,
            )
            .unwrap();
        assert!(!other_snapshot.readings.contains_key("battery"));
        let restored = crate::load_backend(root.join("account-a/history.json")).unwrap();
        assert_eq!(
            restored.history.receipts[0].readback.as_deref(),
            Some(confirmation::CONFIRMED)
        );
        assert_eq!(
            restored.history.snapshots.last().unwrap().vehicle.vin,
            other.vin
        );
        let mut switched = crate::load_backend(root.join("account-b/history.json")).unwrap();
        let isolated = switched
            .record_reading(
                &car,
                "exterior",
                reading(json!({"locked":true}), 5500, 6000),
                6000,
            )
            .unwrap();
        assert!(!isolated.readings.contains_key("battery"));
        drop((backend, restored, switched));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn siri_and_app_share_service_across_login_and_account_history_changes() {
        let root = std::env::temp_dir().join(format!("norr-ios-service-{}", uuid::Uuid::new_v4()));
        let path = root.join("vehicle-history.json");
        let slot = IosServiceSlot::default();
        let service = slot
            .get(path.clone(), || {
                crate::load_backend(root.join("signed-out/vehicle-history.json"))
            })
            .unwrap();
        for account in ["account-a", "account-b", "account-a"] {
            let history = root.join(account).join("vehicle-history.json");
            *service.blocking_lock() = crate::load_backend(history.clone()).unwrap();
            let from_siri = slot
                .get(path.clone(), || panic!("must reuse active account backend"))
                .unwrap();
            assert!(Arc::ptr_eq(&service, &from_siri));
            assert_eq!(from_siri.blocking_lock().path, history);
        }
        assert!(slot
            .get(root.join("another-app/vehicle-history.json"), || panic!(
                "must reject another root"
            ))
            .is_err());
        drop(service);
        drop(slot);
        std::fs::remove_dir_all(root).unwrap();
    }
}
