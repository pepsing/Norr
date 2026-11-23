use super::{database_error, Archive, Result};
#[cfg(any(test, feature = "p4-field-test"))]
use crate::p4_partner::{CommandRecord, Scope};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(any(test, feature = "polestar4"))]
use sha2::{Digest, Sha256};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

impl Archive {
    #[cfg(any(test, feature = "polestar4"))]
    pub(crate) fn xchanger_event(
        &self,
        account: &str,
        vin: &str,
        now: u64,
        mut event: Value,
    ) -> Result<()> {
        self.recording_tables()?;
        let recording: Option<i64> = self.connection.query_row(
            "SELECT id FROM p4_recordings WHERE account=?1 AND finished_at IS NULL AND started_at<=?2",
            params![account, now as i64], |row| row.get(0),
        ).optional().map_err(database_error)?;
        if let Some(id) = recording {
            let digest = Sha256::digest(format!("{id}/{account}/{vin}"));
            event["vehicleRef"] = json!(format!("{digest:x}")[..12]);
            event["source"] = json!("xchanger");
            self.recording_observation(account, id, now as i64, &event)?;
        }
        Ok(())
    }

    #[cfg(any(test, feature = "polestar4"))]
    pub(crate) fn xchanger_receipt(
        &self,
        account: &str,
        receipt: &crate::Receipt,
        phase: &str,
    ) -> Result<()> {
        if receipt.account_scope.as_deref() != Some(account) {
            return Ok(());
        }
        self.xchanger_event(account, &receipt.command.vin, crate::now_ms(), json!({
            "operation":"vehicleCommand", "phase":phase,"commandRef":receipt.id,
            "action":receipt.command.action,"value":receipt.command.value,"status":receipt.status,
            "submittedAt":receipt.time,"readback":receipt.readback,"readbackAt":receipt.readback_at
        }))
    }
    fn recording_tables(&self) -> Result<()> {
        self.connection.execute_batch("
            CREATE TABLE IF NOT EXISTS p4_recordings (
                id INTEGER PRIMARY KEY, account TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS p4_active_recording ON p4_recordings(account) WHERE finished_at IS NULL;
            CREATE TABLE IF NOT EXISTS p4_recording_events (
                id INTEGER PRIMARY KEY, recording INTEGER NOT NULL, time INTEGER NOT NULL, event TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS p4_partner_commands (
                recording INTEGER NOT NULL, request_id TEXT NOT NULL, vehicle_ref TEXT NOT NULL,
                payload TEXT NOT NULL, UNIQUE(recording, request_id)
            );
            CREATE INDEX IF NOT EXISTS p4_recording_event_order ON p4_recording_events(recording, id);
        ").map_err(database_error)
    }

    pub fn recordings(&self, account: &str) -> Result<Vec<Recording>> {
        self.recording_tables()?;
        let mut query = self.connection.prepare(
            "SELECT id, started_at, finished_at FROM p4_recordings WHERE account=?1 ORDER BY id DESC"
        ).map_err(database_error)?;
        let rows = query
            .query_map([account], |r| {
                Ok(Recording {
                    id: r.get(0)?,
                    started_at: r.get(1)?,
                    finished_at: r.get(2)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(database_error)
    }

    pub fn begin_recording(&self, account: &str, now: i64) -> Result<()> {
        self.recording_tables()?;
        self.connection
            .execute(
                "INSERT INTO p4_recordings(account,started_at) VALUES (?1,?2)
            ON CONFLICT(account) WHERE finished_at IS NULL DO NOTHING",
                params![account, now],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn finish_recording(&self, account: &str, id: i64, now: i64) -> Result<()> {
        let updated = self.connection.execute("UPDATE p4_recordings SET finished_at=COALESCE(finished_at,?3) WHERE account=?1 AND id=?2",
            params![account,id,now]).map_err(database_error)?;
        if updated == 0 {
            return Err("未找到本账号的记录".into());
        }
        Ok(())
    }

    pub fn garage_event(&self, account: &str, now: i64, event: &Value) -> Result<()> {
        self.recording_tables()?;
        self.connection
            .execute(
                "INSERT INTO p4_recording_events(recording,time,event)
            SELECT id,?2,?3 FROM p4_recordings WHERE account=?1 AND finished_at IS NULL",
                params![account, now, event.to_string()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn recording_observation(
        &self,
        account: &str,
        id: i64,
        now: i64,
        event: &Value,
    ) -> Result<()> {
        let inserted = self
            .connection
            .execute(
                "INSERT INTO p4_recording_events(recording,time,event)
             SELECT id,?3,?4 FROM p4_recordings WHERE account=?1 AND id=?2 AND finished_at IS NULL",
                params![account, id, now, event.to_string()],
            )
            .map_err(database_error)?;
        if inserted == 0 {
            return Err("本轮记录已结束或账号已更换".into());
        }
        Ok(())
    }

    #[cfg(any(test, feature = "p4-field-test"))]
    pub(crate) fn active_partner_commands(&self, scope: &Scope<'_>) -> Result<Vec<CommandRecord>> {
        self.recording_tables()?;
        let active: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM p4_recordings WHERE account=?1 AND id=?2 AND finished_at IS NULL)",
            params![scope.account,scope.recording], |row| row.get(0)).map_err(database_error)?;
        if !active {
            return Err("请选择当前账号进行中的记录".into());
        }
        self.partner_commands(scope.account, scope.recording, Some(scope.vehicle_ref))
    }

    #[cfg(any(test, feature = "p4-field-test"))]
    fn partner_commands(
        &self,
        account: &str,
        id: i64,
        vehicle: Option<&str>,
    ) -> Result<Vec<CommandRecord>> {
        let mut stmt = self.connection.prepare("SELECT c.payload FROM p4_partner_commands c JOIN p4_recordings r ON r.id=c.recording
            WHERE r.account=?1 AND r.id=?2 AND (?3 IS NULL OR c.vehicle_ref=?3) ORDER BY c.rowid").map_err(database_error)?;
        let mut rows = stmt
            .query(params![account, id, vehicle])
            .map_err(database_error)?;
        let mut commands = Vec::new();
        while let Some(row) = rows.next().map_err(database_error)? {
            let data: String = row.get(0).map_err(database_error)?;
            commands.push(serde_json::from_str(&data).map_err(|_| "指令记录已损坏")?);
        }
        Ok(commands)
    }

    #[cfg(any(test, feature = "p4-field-test"))]
    pub(crate) fn insert_partner_command(
        &self,
        scope: &Scope<'_>,
        record: &CommandRecord,
    ) -> Result<()> {
        let data = serde_json::to_string(record).map_err(|_| "指令记录编码失败")?;
        let changed = self
            .connection
            .execute(
                "INSERT INTO p4_partner_commands(recording,request_id,vehicle_ref,payload)
            SELECT id,?3,?4,?5 FROM p4_recordings WHERE account=?1 AND id=?2 AND finished_at IS NULL
            ON CONFLICT(recording,request_id) DO NOTHING",
                params![
                    scope.account,
                    scope.recording,
                    record.request_id,
                    scope.vehicle_ref,
                    data
                ],
            )
            .map_err(database_error)?;
        if changed != 1 {
            return Err("记录已结束或请求编号已使用".into());
        }
        Ok(())
    }

    #[cfg(any(test, feature = "p4-field-test"))]
    pub(crate) fn update_partner_command(
        &self,
        scope: &Scope<'_>,
        record: &CommandRecord,
    ) -> Result<()> {
        let data = serde_json::to_string(record).map_err(|_| "指令记录编码失败")?;
        let changed = self.connection.execute("UPDATE p4_partner_commands SET payload=?5 WHERE recording=?2 AND request_id=?3 AND vehicle_ref=?4
            AND EXISTS(SELECT 1 FROM p4_recordings WHERE id=?2 AND account=?1 AND finished_at IS NULL)",
            params![scope.account, scope.recording, record.request_id, scope.vehicle_ref, data]).map_err(database_error)?;
        if changed != 1 {
            return Err("指令记录已变更，请重新读取".into());
        }
        Ok(())
    }

    pub fn export_recording(&self, account: &str, id: i64) -> Result<Vec<u8>> {
        self.recording_tables()?;
        let (start,end): (i64,i64) = self.connection.query_row(
            "SELECT started_at,finished_at FROM p4_recordings WHERE account=?1 AND id=?2 AND finished_at IS NOT NULL",
            params![account,id],|r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(database_error)?
            .ok_or("请选择本账号已完成的记录")?;
        let mut query = self
            .connection
            .prepare("SELECT time,event FROM p4_recording_events WHERE recording=?1 ORDER BY id")
            .map_err(database_error)?;
        let mut rows = query.query([id]).map_err(database_error)?;
        let mut events = Vec::new();
        while let Some(row) = rows.next().map_err(database_error)? {
            let time: i64 = row.get(0).map_err(database_error)?;
            let text: String = row.get(1).map_err(database_error)?;
            let mut event: Value = serde_json::from_str(&text).map_err(|_| "记录已损坏")?;
            event["time"] = json!(time);
            events.push(event);
        }
        let log = json!({"format":"norr-ios-session-log","version":1,
            "appVersion":env!("CARGO_PKG_VERSION"),"startedAt":start,"finishedAt":end,
            "vehicleControlTransport":if events.iter().any(|event| event["source"] == "xchanger") { Some("xchanger") } else { None },"events":events});
        #[cfg(any(test, feature = "p4-field-test"))]
        let log = {
            let commands = self.partner_commands(account, id, None)?;
            let mut log = log;
            if !commands.is_empty() {
                log["vehicleControlTransport"] = json!("norrPartner");
                log["vehicleCommands"] = json!(commands);
            }
            log
        };
        serde_json::to_vec_pretty(&log).map_err(|_| "日志编码失败".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xchanger_logs_are_opt_in_account_scoped_and_export_only_selected_command_fields() {
        let db = Archive {
            connection: rusqlite::Connection::open_in_memory().unwrap(),
        };
        let now = crate::now_ms();
        db.xchanger_event(
            "account-a",
            "PRIVATE-VIN",
            now,
            json!({"operation":"notRecording"}),
        )
        .unwrap();
        assert!(db.recordings("account-a").unwrap().is_empty());
        db.begin_recording("account-a", (now - 10) as i64).unwrap();
        let id = db.recordings("account-a").unwrap()[0].id;
        let mut receipt: crate::Receipt = serde_json::from_value(json!({
            "id":"fixture-command","command":{"vin":"PRIVATE-VIN","action":"driverSeatHeat","value":3},
            "time":now,"status":"accepted","message":"PRIVATE-ERROR","accountScope":"account-a",
            "readback":"等待车辆回读","readbackAt":null
        })).unwrap();
        db.xchanger_receipt("account-b", &receipt, "result")
            .unwrap();
        db.xchanger_receipt("account-a", &receipt, "result")
            .unwrap();
        receipt.readback = Some(crate::confirmation::CONFIRMED.into());
        receipt.readback_at = Some(crate::now_ms());
        db.xchanger_receipt("account-a", &receipt, "readback")
            .unwrap();
        assert!(db.export_recording("account-a", id).is_err());
        db.finish_recording("account-a", id, crate::now_ms() as i64)
            .unwrap();
        db.xchanger_event(
            "account-a",
            "PRIVATE-VIN",
            crate::now_ms(),
            json!({"operation":"afterFinish"}),
        )
        .unwrap();
        let bytes = db.export_recording("account-a", id).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("PRIVATE"));
        assert!(!text.contains("account-a"));
        let log: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(log["vehicleControlTransport"], "xchanger");
        assert_eq!(log["events"].as_array().unwrap().len(), 2);
        assert_eq!(log["events"][0]["action"], "driverSeatHeat");
        assert_eq!(log["events"][0]["value"], 3.0);
        assert_eq!(log["events"][1]["readback"], crate::confirmation::CONFIRMED);
        assert_eq!(
            log["events"][0]["vehicleRef"],
            log["events"][1]["vehicleRef"]
        );
        assert!(db.export_recording("account-b", id).is_err());
    }
    #[test]
    fn recording_boundaries_and_account_isolation() {
        let db = Archive {
            connection: rusqlite::Connection::open_in_memory().unwrap(),
        };
        db.begin_recording("a", 1).unwrap();
        db.begin_recording("a", 2).unwrap();
        db.begin_recording("b", 3).unwrap();
        let rows = db.recordings("a").unwrap();
        assert_eq!(rows.len(), 1);
        let id = rows[0].id;
        assert!(db.export_recording("a", id).is_err());
        let note = json!({"operation":"manualObservation","action":"driverSeatHeat","operationSource":"vehicle"});
        assert!(db.recording_observation("b", id, 3, &note).is_err());
        db.recording_observation("a", id, 3, &note).unwrap();
        db.garage_event("a", 4, &json!({"phase":"requested"}))
            .unwrap();
        assert!(db.finish_recording("b", id, 5).is_err());
        db.finish_recording("a", id, 6).unwrap();
        db.finish_recording("a", id, 7).unwrap();
        assert!(db.recording_observation("a", id, 7, &note).is_err());
        db.garage_event("a", 7, &json!({"phase":"late"})).unwrap();
        assert!(db.export_recording("b", id).is_err());
        let data: Value = serde_json::from_slice(&db.export_recording("a", id).unwrap()).unwrap();
        assert_eq!(
            data["events"],
            json!([
                {"time":3,"operation":"manualObservation","action":"driverSeatHeat","operationSource":"vehicle"},
                {"time":4,"phase":"requested"}
            ])
        );
        assert_eq!(data["finishedAt"], 6);
        db.begin_recording("a", 8).unwrap();
        assert_eq!(db.recordings("a").unwrap().len(), 2);
    }
}
