use super::{History, Result};
use norr_vehicle_core::models::{Receipt, Snapshot};
use rusqlite::{params, Connection};
#[cfg(any(all(debug_assertions, target_os = "macos"), test))]
use rusqlite::{types::ValueRef, OpenFlags};
use serde::{Deserialize, Serialize};
#[cfg(any(all(debug_assertions, target_os = "macos"), test))]
use serde_json::Map;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

const LEGACY_TABLES: &[(&str, &str, &str)] = &[
    ("charging_sessions", "started_at", "id"),
    ("charging_samples", "timestamp", "id"),
    ("telemetry_logs", "timestamp", "id"),
    ("remote_commands_log", "executed_at", "id"),
    ("battery_health_history", "timestamp", "id"),
    ("air_quality_history", "timestamp", "id"),
    ("tyre_pressure_history", "timestamp", "id"),
    ("vehicle_warning_events", "first_seen", "id"),
    ("connectivity_history", "timestamp", "id"),
    ("cabin_climate_history", "timestamp", "id"),
    ("fuel_entries", "date", "id"),
    ("trip_tags", "updated_at", "trip_id"),
    ("vehicle_activity", "timestamp", "id"),
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub source: String,
    pub category: String,
    pub key: String,
    pub vin: String,
    pub time: u64,
    pub value: Value,
}

impl Record {
    fn snapshot(snapshot: &Snapshot) -> Result<Self> {
        Ok(Self {
            source: "norr".into(),
            category: "snapshot".into(),
            key: snapshot.fetched_at.to_string(),
            vin: snapshot.vehicle.vin.clone(),
            time: snapshot.fetched_at,
            value: serde_json::to_value(snapshot).map_err(|_| "采集记录编码失败")?,
        })
    }

    fn receipt(receipt: &Receipt) -> Result<Self> {
        Ok(Self {
            source: "norr".into(),
            category: "receipt".into(),
            key: receipt.id.clone(),
            vin: receipt.command.vin.clone(),
            time: receipt.time,
            value: serde_json::to_value(receipt).map_err(|_| "指令记录编码失败")?,
        })
    }

    fn legacy(category: &str, value: Value) -> Result<Self> {
        let (_, time_field, key_field) = LEGACY_TABLES
            .iter()
            .find(|(table, _, _)| *table == category)
            .ok_or("不支持的旧记录类型")?;
        let vin = value["vin"]
            .as_str()
            .ok_or("旧记录缺少车辆身份")?
            .to_owned();
        let seconds = value[*time_field]
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0 && *value < 253402300800.0)
            .ok_or("旧记录时间无效")?;
        let key = match &value[*key_field] {
            Value::String(key) => key.clone(),
            Value::Number(key) => key.to_string(),
            _ => return Err("旧记录缺少记录身份".into()),
        };
        Ok(Self {
            source: "hisingen".into(),
            category: category.into(),
            key,
            vin,
            time: (seconds * 1000.0).round() as u64,
            value,
        })
    }

    fn validate(&self) -> Result<()> {
        if self.vin.len() != 17
            || !self.vin.bytes().all(|byte| byte.is_ascii_alphanumeric())
            || self.key.is_empty()
            || self.key.len() > 512
            || self.time > 253402300800000
        {
            return Err("历史记录的车辆、身份或时间无效".into());
        }
        let canonical = match (self.source.as_str(), self.category.as_str()) {
            ("norr", "snapshot") => {
                let snapshot: Snapshot = serde_json::from_value(self.value.clone())
                    .map_err(|_| "备份采集记录格式无效")?;
                for reading in snapshot.readings.values() {
                    if !matches!(reading.status.as_str(), "success" | "failed") {
                        return Err("备份读取状态无效".into());
                    }
                }
                Self::snapshot(&snapshot)?
            }
            ("norr", "receipt") => {
                let receipt: Receipt = serde_json::from_value(self.value.clone())
                    .map_err(|_| "备份指令记录格式无效")?;
                if !matches!(
                    receipt.status.as_str(),
                    "unknown" | "accepted" | "delivered" | "completed" | "rejected"
                ) {
                    return Err("备份指令状态无效".into());
                }
                Self::receipt(&receipt)?
            }
            ("hisingen", category) => Self::legacy(category, self.value.clone())?,
            _ => return Err("备份包含不支持的记录来源或类型".into()),
        };
        if canonical.vin != self.vin || canonical.key != self.key || canonical.time != self.time {
            return Err("备份记录的车辆、身份或时间不一致".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub token: String,
    pub source: String,
    pub total: usize,
    pub added: usize,
    pub duplicates: usize,
    pub categories: BTreeMap<String, usize>,
    pub vehicles: BTreeMap<String, usize>,
}

pub struct PendingImport {
    pub token: String,
    pub source: String,
    pub records: Vec<Record>,
}

pub struct Archive {
    connection: Connection,
}

fn database_error(error: rusqlite::Error) -> String {
    format!("历史数据库操作失败（{error}）")
}

impl Archive {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(database_error)?;
        crate::platform::private_path(path, 0o600)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(database_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS records (
                source TEXT NOT NULL, category TEXT NOT NULL, record_key TEXT NOT NULL,
                vin TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(source, category, vin, record_key));
            CREATE INDEX IF NOT EXISTS records_vehicle_time ON records(vin, recorded_at);",
            )
            .map_err(database_error)?;
        Ok(Self { connection })
    }

    pub fn sync(&self, history: &History) -> Result<()> {
        let records = history
            .snapshots
            .iter()
            .map(Record::snapshot)
            .chain(history.receipts.iter().map(Record::receipt))
            .collect::<Result<Vec<_>>>()?;
        self.merge(&records, true).map(|_| ())
    }

    pub fn merge(&self, records: &[Record], update: bool) -> Result<usize> {
        for record in records {
            record.validate()?;
        }
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let mut added = 0;
        {
            let sql = if update {
                "INSERT INTO records VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(source,category,vin,record_key) DO UPDATE SET payload=excluded.payload WHERE records.payload != excluded.payload"
            } else {
                "INSERT OR IGNORE INTO records VALUES (?1,?2,?3,?4,?5,?6)"
            };
            let mut statement = transaction.prepare(sql).map_err(database_error)?;
            for record in records {
                added += statement
                    .execute(params![
                        record.source,
                        record.category,
                        record.key,
                        record.vin,
                        record.time as i64,
                        record.value.to_string()
                    ])
                    .map_err(database_error)?;
            }
        }
        transaction.commit().map_err(database_error)?;
        Ok(added)
    }

    pub fn preview(&self, pending: &PendingImport) -> Result<ImportSummary> {
        let mut summary = ImportSummary {
            token: pending.token.clone(),
            source: pending.source.clone(),
            total: pending.records.len(),
            added: 0,
            duplicates: 0,
            categories: BTreeMap::new(),
            vehicles: BTreeMap::new(),
        };
        let mut seen = std::collections::BTreeSet::new();
        let mut statement = self.connection.prepare("SELECT EXISTS(SELECT 1 FROM records WHERE source=?1 AND category=?2 AND vin=?3 AND record_key=?4)").map_err(database_error)?;
        for record in &pending.records {
            record.validate()?;
            *summary
                .categories
                .entry(record.category.clone())
                .or_default() += 1;
            *summary.vehicles.entry(record.vin.clone()).or_default() += 1;
            let identity = (&record.source, &record.category, &record.vin, &record.key);
            let exists: bool = statement
                .query_row(
                    params![record.source, record.category, record.vin, record.key],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if exists || !seen.insert(identity) {
                summary.duplicates += 1;
            } else {
                summary.added += 1;
            }
        }
        Ok(summary)
    }

    pub fn vehicles(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT vin FROM records ORDER BY vin")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(database_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(database_error)
    }

    pub fn records(&self, vin: &str, start: u64, end: u64) -> Result<Vec<Record>> {
        let mut statement = self.connection.prepare("SELECT source,category,record_key,vin,recorded_at,payload FROM records WHERE vin=?1 AND recorded_at>=?2 AND recorded_at<?3 ORDER BY recorded_at,source,category,record_key").map_err(database_error)?;
        let rows = statement
            .query_map(params![vin, start as i64, end as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let (source, category, key, vin, time, payload) = row.map_err(database_error)?;
            let value = serde_json::from_str(&payload).map_err(|_| "历史记录内容损坏")?;
            let time = u64::try_from(time).map_err(|_| "历史记录时间损坏")?;
            Ok(Record {
                source,
                category,
                key,
                vin,
                time,
                value,
            })
        })
        .collect()
    }

    pub fn backup(&self, vin: &str) -> Result<Vec<u8>> {
        let records = self.records(vin, 0, 253402300800001)?;
        if records.is_empty() {
            return Err("该车辆没有可导出的历史记录".into());
        }
        serde_json::to_vec_pretty(&json!({"format":"norr-history", "version":2,
            "exportedAt":norr_vehicle_core::now_ms(), "records":records}))
        .map_err(|_| "历史备份编码失败".into())
    }
}

pub fn read_backup(path: &Path) -> Result<Vec<Record>> {
    let size = std::fs::metadata(path)
        .map_err(|_| "无法读取备份文件")?
        .len();
    if size > 256 * 1024 * 1024 {
        return Err("备份超过 256 MB，请按车辆拆分后导入".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "无法读取备份文件")?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "备份 JSON 格式无效")?;
    if value["format"] != "norr-history" {
        return Err("请选择 Norr 历史备份 JSON 文件".into());
    }
    let records = match value["version"].as_u64() {
        Some(1) => {
            let snapshots: Vec<Snapshot> = serde_json::from_value(value["snapshots"].clone())
                .map_err(|_| "备份采集列表无效")?;
            let receipts: Vec<Receipt> = serde_json::from_value(value["receipts"].clone())
                .map_err(|_| "备份指令列表无效")?;
            snapshots
                .iter()
                .map(Record::snapshot)
                .chain(receipts.iter().map(Record::receipt))
                .collect::<Result<Vec<_>>>()?
        }
        Some(2) => serde_json::from_value::<Vec<Record>>(value["records"].clone())
            .map_err(|_| "备份历史列表无效")?,
        _ => return Err("不支持此备份版本".into()),
    };
    for record in &records {
        record.validate()?;
    }
    Ok(records)
}

#[cfg(any(all(debug_assertions, target_os = "macos"), test))]
pub fn read_hisingen(path: &Path) -> Result<Vec<Record>> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法打开 Hisingen 历史数据库")?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(database_error)?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;")
        .map_err(database_error)?;
    let mut records = Vec::new();
    let mut found = 0;
    for (table, _, _) in LEGACY_TABLES {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if !exists {
            continue;
        }
        found += 1;
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table}"))
            .map_err(database_error)?;
        let columns = statement
            .column_names()
            .map(String::from)
            .collect::<Vec<_>>();
        let mut rows = statement.query([]).map_err(database_error)?;
        while let Some(row) = rows.next().map_err(database_error)? {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                let value = match row.get_ref(index).map_err(database_error)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => json!(value),
                    ValueRef::Real(value) if value.is_finite() => json!(value),
                    ValueRef::Text(value) => Value::String(
                        std::str::from_utf8(value)
                            .map_err(|_| "旧记录文本编码无效")?
                            .into(),
                    ),
                    ValueRef::Blob(value) => {
                        serde_json::from_slice(value).map_err(|_| "旧记录内容格式无效")?
                    }
                    _ => return Err("旧记录包含无效数字".into()),
                };
                object.insert(column.clone(), value);
            }
            let record = Record::legacy(table, Value::Object(object))?;
            record.validate()?;
            records.push(record);
        }
    }
    if found == 0 {
        return Err("文件中没有可识别的 Hisingen 历史表".into());
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive() -> Archive {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE records(source TEXT,category TEXT,record_key TEXT,vin TEXT,recorded_at INTEGER,payload TEXT,PRIMARY KEY(source,category,vin,record_key));").unwrap();
        Archive { connection }
    }

    fn record(id: i64) -> Record {
        Record::legacy("telemetry_logs", json!({"id":id,"vin":"TEST0000000000001","timestamp":1794470000.0,"odometer_km":12345.0})).unwrap()
    }

    #[test]
    fn imports_are_idempotent_and_preserve_existing_rows() {
        let archive = archive();
        let original = record(1);
        assert_eq!(
            archive
                .merge(std::slice::from_ref(&original), false)
                .unwrap(),
            1
        );
        let mut edited = original.clone();
        edited.value["odometer_km"] = json!(20000);
        let pending = PendingImport {
            token: "test".into(),
            source: "backup".into(),
            records: vec![edited, original.clone()],
        };
        let preview = archive.preview(&pending).unwrap();
        assert_eq!((preview.added, preview.duplicates), (0, 2));
        assert_eq!(archive.merge(&pending.records, false).unwrap(), 0);
        let rows = archive.records(&original.vin, 0, 253402300800001).unwrap();
        assert_eq!(rows[0].value["odometer_km"], 12345.0);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn failed_batch_rolls_back_and_wrong_vehicle_is_rejected() {
        let archive = archive();
        archive.connection.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON records WHEN NEW.record_key='2' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(archive.merge(&[record(1), record(2)], false).is_err());
        assert!(archive.vehicles().unwrap().is_empty());
        let mut invalid = record(3);
        invalid.vin = "TEST0000000000002".into();
        assert!(archive.merge(&[record(1), invalid], false).is_err());
        assert!(archive.vehicles().unwrap().is_empty());
    }

    #[test]
    fn backup_round_trip_supports_both_versions_and_rejects_unknown_versions() {
        let archive = archive();
        archive.merge(&[record(1)], false).unwrap();
        let path =
            std::env::temp_dir().join(format!("norr-backup-test-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, archive.backup("TEST0000000000001").unwrap()).unwrap();
        assert_eq!(read_backup(&path).unwrap()[0].value, record(1).value);
        let receipt = Receipt {
            id: "command".into(),
            command: norr_vehicle_core::models::Command {
                vin: "TEST0000000000001".into(),
                action: "lock".into(),
                ..Default::default()
            },
            time: 1794470000000,
            status: "accepted".into(),
            message: "已接受".into(),
            readback_at: None,
            readback: None,
            baseline_timer_ids: None,
        };
        std::fs::write(
            &path,
            json!({"format":"norr-history","version":1,"snapshots":[],"receipts":[receipt]})
                .to_string(),
        )
        .unwrap();
        let restored = read_backup(&path).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].category, "receipt");
        std::fs::write(
            &path,
            json!({"format":"norr-history","version":999,"records":[]}).to_string(),
        )
        .unwrap();
        assert!(read_backup(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_sqlite_import_preserves_nulls_dates_and_activity_payloads() {
        let path =
            std::env::temp_dir().join(format!("norr-legacy-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let source = Connection::open(&path).unwrap();
        source.execute_batch("CREATE TABLE telemetry_logs(id INTEGER,vin TEXT,timestamp REAL,odometer_km REAL,latitude REAL);
            INSERT INTO telemetry_logs VALUES(1,'TEST0000000000001',1794470000.125,12345,NULL);
            CREATE TABLE vehicle_activity(id TEXT,vin TEXT,timestamp REAL,payload BLOB);
            INSERT INTO vehicle_activity VALUES('activity','TEST0000000000001',1794470001,CAST('{\"kind\":\"charging\"}' AS BLOB));").unwrap();
        let records = read_hisingen(&path).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].time, 1794470000125);
        assert!(records[0].value["latitude"].is_null());
        assert_eq!(records[1].value["payload"]["kind"], "charging");
        assert_eq!(
            source
                .query_row("SELECT count(*) FROM telemetry_logs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(source);
        std::fs::remove_file(path).unwrap();
    }
}
