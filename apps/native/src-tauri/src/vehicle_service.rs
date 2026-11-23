use crate::{confirmation, now_ms, Backend, Command, Receipt, Result, Snapshot};
use norr_vehicle_core::china::PreparedCommand;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) type VehicleService = Arc<Mutex<Backend>>;

#[cfg(target_os = "ios")]
pub(crate) fn ios_service(path: std::path::PathBuf) -> Result<VehicleService> {
    use std::sync::{Mutex as InitLock, OnceLock};

    static SERVICE: OnceLock<(std::path::PathBuf, VehicleService)> = OnceLock::new();
    static INIT: InitLock<()> = InitLock::new(());

    let _guard = INIT.lock().map_err(|_| "车辆服务初始化未完成")?;
    if let Some((initialized, service)) = SERVICE.get() {
        if initialized != &path {
            return Err("车辆服务数据目录不一致".into());
        }
        return Ok(service.clone());
    }

    let service = Arc::new(Mutex::new(crate::load_backend(path.clone())?));
    SERVICE
        .set((path, service.clone()))
        .map_err(|_| "车辆服务重复初始化")?;
    Ok(service)
}

impl Backend {
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
