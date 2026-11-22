use super::{database_error, Archive, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

impl Archive {
    fn recording_tables(&self) -> Result<()> {
        self.connection.execute_batch("
            CREATE TABLE IF NOT EXISTS p4_recordings (
                id INTEGER PRIMARY KEY, account TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS p4_active_recording ON p4_recordings(account) WHERE finished_at IS NULL;
            CREATE TABLE IF NOT EXISTS p4_recording_events (
                id INTEGER PRIMARY KEY, recording INTEGER NOT NULL, time INTEGER NOT NULL, event TEXT NOT NULL
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

    pub fn recording_observation(&self, account: &str, id: i64, now: i64, event: &Value) -> Result<()> {
        let inserted = self.connection.execute(
            "INSERT INTO p4_recording_events(recording,time,event)
             SELECT id,?3,?4 FROM p4_recordings WHERE account=?1 AND id=?2 AND finished_at IS NULL",
            params![account, id, now, event.to_string()],
        ).map_err(database_error)?;
        if inserted == 0 {
            return Err("本轮记录已结束或账号已更换".into());
        }
        Ok(())
    }

    pub fn export_recording(&self, account: &str, id: i64) -> Result<Vec<u8>> {
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
        serde_json::to_vec_pretty(&json!({"format":"norr-ios-session-log","version":1,
            "appVersion":env!("CARGO_PKG_VERSION"),"startedAt":start,"finishedAt":end,
            "vehicleControlTransport":null,"events":events}))
        .map_err(|_| "日志编码失败".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(data["events"], json!([
            {"time":3,"operation":"manualObservation","action":"driverSeatHeat","operationSource":"vehicle"},
            {"time":4,"phase":"requested"}
        ]));
        assert_eq!(data["finishedAt"], 6);
        db.begin_recording("a", 8).unwrap();
        assert_eq!(db.recordings("a").unwrap().len(), 2);
    }
}
