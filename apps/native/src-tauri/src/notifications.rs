use norr_vehicle_core::{
    confirmation,
    models::{Receipt, Snapshot},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_AGE: u64 = 20 * 60 * 1000;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct Notice {
    pub id: String,
    pub vin: String,
    pub title: String,
    pub body: String,
    pub page: String,
    pub time: u64,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct Baseline {
    time: u64,
    state: u64,
    charging: bool,
    interruptions: u8,
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct Tracker {
    vehicles: BTreeMap<String, Baseline>,
    commands: BTreeMap<String, String>,
    pub outbox: Vec<Notice>,
}

impl Tracker {
    pub fn observe(&mut self, snapshot: &Snapshot, enabled: bool, now: u64) {
        let Some(reading) = snapshot
            .readings
            .get("battery")
            .filter(|r| r.status == "success")
        else {
            return;
        };
        let Some(time) = reading.reported_at.filter(|time| *time <= now + 60_000) else {
            return;
        };
        let Some(state) = reading
            .value
            .as_ref()
            .and_then(|value| value["chargeState"].as_u64())
            .filter(|state| (1..=8).contains(state))
        else {
            return;
        };
        let vin = &snapshot.vehicle.vin;
        let previous = self.vehicles.get(vin);
        if previous.is_some_and(|old| time <= old.time) {
            return;
        }
        let mut next = Baseline {
            time,
            state,
            charging: state == 1,
            interruptions: 0,
        };
        let mut event = None;
        if let Some(old) = previous.filter(|old| time.saturating_sub(old.time) <= MAX_AGE) {
            next.charging = old.charging;
            match state {
                1 => {
                    if !old.charging {
                        event = Some(("started", "充电已开始", "车辆上报正在充电。"));
                    }
                    next.charging = true;
                }
                5 => {
                    if old.state != 5 {
                        event = Some((
                            "fault",
                            "充电异常",
                            "车辆上报充电异常，请查看车辆与充电设备。",
                        ));
                    }
                    next.charging = false;
                }
                8 => {
                    if old.charging {
                        event = Some(("completed", "充电已完成", "车辆已上报充电完成。"));
                    }
                    next.charging = false;
                }
                3 | 6 | 7 => {}
                _ if old.charging => {
                    next.interruptions = old.interruptions.saturating_add(1);
                    if next.interruptions >= 2 {
                        event = Some((
                            "interrupted",
                            "充电已中断",
                            "连续两次新上报显示充电已停止，请查看车辆状态。",
                        ));
                        next.charging = false;
                    }
                }
                _ => {}
            }
        }
        self.vehicles.insert(vin.clone(), next);
        if enabled && now.saturating_sub(time) <= MAX_AGE {
            if let Some((kind, title, body)) = event {
                self.outbox.push(Notice {
                    id: format!("charging-{vin}-{time}-{kind}"),
                    vin: vin.clone(),
                    title: title.into(),
                    body: format!("{} · {body}", snapshot.vehicle.model),
                    page: "charging".into(),
                    time: now,
                });
            }
        }
    }

    pub fn commands(&mut self, receipts: &[Receipt], enabled: bool, now: u64) {
        self.commands
            .retain(|id, _| receipts.iter().any(|r| &r.id == id));
        for receipt in receipts {
            let outcome = if receipt.readback.as_deref() == Some(confirmation::CONFIRMED) {
                Some((
                    "confirmed",
                    "车辆状态已核对",
                    "指令后的独立回读与请求一致。",
                ))
            } else if receipt.status == "rejected" {
                Some(("rejected", "车辆指令被拒绝", receipt.message.as_str()))
            } else if confirmation::endpoint(&receipt.command.action).is_none() {
                match receipt.status.as_str() {
                    "accepted" => {
                        Some(("accepted", "服务已接受车辆指令", receipt.message.as_str()))
                    }
                    "delivered" => Some(("delivered", "车辆指令已送达", receipt.message.as_str())),
                    "completed" => {
                        Some(("completed", "服务报告指令已完成", receipt.message.as_str()))
                    }
                    _ => Some(("unknown", "车辆指令结果待核对", receipt.message.as_str())),
                }
            } else if now.saturating_sub(receipt.time) >= 120_000 {
                Some((
                    "unconfirmed",
                    "车辆指令尚未核对一致",
                    "自动回读已结束，可在记录页查看服务结果和回读说明。",
                ))
            } else {
                None
            };
            let Some((key, title, body)) = outcome else {
                continue;
            };
            if self.commands.get(&receipt.id).is_some_and(|old| old == key) {
                continue;
            }
            self.commands.insert(receipt.id.clone(), key.into());
            if enabled && now.saturating_sub(receipt.time) <= MAX_AGE {
                self.outbox.push(Notice {
                    id: format!("command-{}-{key}", receipt.id),
                    vin: receipt.command.vin.clone(),
                    title: title.into(),
                    body: body.into(),
                    page: "history".into(),
                    time: now,
                });
            }
        }
    }

    pub fn prune(&mut self, charging: bool, commands: bool, now: u64) {
        self.outbox.retain(|notice| {
            now.saturating_sub(notice.time) <= MAX_AGE
                && if notice.page == "charging" {
                    charging
                } else {
                    commands
                }
        });
        if self.outbox.len() > 100 {
            self.outbox.drain(..self.outbox.len() - 100);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use norr_vehicle_core::models::{Command, Reading, Vehicle};
    fn sample(state: u64, time: u64) -> Snapshot {
        Snapshot {
            vehicle: Vehicle {
                vin: "TEST0000000000001".into(),
                model: "Polestar 2".into(),
                model_year: None,
                owner: Some(true),
                platform: None,
                capabilities: BTreeMap::new(),
                limits: BTreeMap::new(),
                installed_version: None,
            },
            fetched_at: time,
            readings: BTreeMap::from([(
                "battery".into(),
                Reading::success(serde_json::json!({"chargeState":state}), Some(time)),
            )]),
        }
    }
    #[test]
    fn charging_uses_new_fresh_samples_and_survives_restart() {
        let mut tracker = Tracker::default();
        tracker.observe(&sample(1, 1000), true, 1000);
        assert!(tracker.outbox.is_empty());
        tracker.observe(&sample(8, 2000), true, 2000);
        assert_eq!(tracker.outbox.len(), 1);
        let mut restored: Tracker =
            serde_json::from_value(serde_json::to_value(&tracker).unwrap()).unwrap();
        restored.observe(&sample(8, 2000), true, 3000);
        restored.observe(&sample(1, 1500), true, 3000);
        assert_eq!(restored.outbox.len(), 1);
        restored.observe(&sample(1, 3000), true, MAX_AGE + 4000);
        assert_eq!(restored.outbox.len(), 1);
    }
    #[test]
    fn interruption_needs_two_samples_and_scheduled_pause_is_expected() {
        let mut tracker = Tracker::default();
        for (state, time) in [(1, 1000), (7, 2000), (3, 3000), (2, 4000)] {
            tracker.observe(&sample(state, time), true, time);
        }
        assert!(tracker.outbox.is_empty());
        tracker.observe(&sample(2, 5000), true, 5000);
        assert_eq!(tracker.outbox[0].title, "充电已中断");
        tracker.observe(&sample(5, 6000), false, 6000);
        assert_eq!(tracker.outbox.len(), 1);
    }
    #[test]
    fn command_notifications_preserve_acceptance_and_readback_semantics() {
        let mut tracker = Tracker::default();
        let mut receipt = Receipt {
            id: "test".into(),
            command: Command {
                vin: "TEST0000000000001".into(),
                action: "target".into(),
                ..Default::default()
            },
            time: 1000,
            status: "accepted".into(),
            message: "服务已接受".into(),
            readback: None,
            readback_at: None,
            baseline_timer_ids: None,
        };
        tracker.commands(&[receipt.clone()], true, 2000);
        assert!(tracker.outbox.is_empty());
        receipt.readback = Some(confirmation::CONFIRMED.into());
        tracker.commands(&[receipt.clone()], true, 3000);
        tracker.commands(&[receipt], true, 4000);
        assert_eq!(tracker.outbox.len(), 1);
        assert_eq!(tracker.outbox[0].title, "车辆状态已核对");
        tracker.prune(false, false, 5000);
        assert!(tracker.outbox.is_empty());
    }
}
