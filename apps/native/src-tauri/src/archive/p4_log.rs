use super::{database_error, Archive, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const WEEK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TestAction {
    ClimateCreate,
    ClimateEdit,
    ClimateDelete,
    ChargeOnce,
    ChargeRepeat,
    ChargeOverride,
    ChargeResume,
    Lock,
    Unlock,
    UnlockTrunk,
    TailgateOpen,
    TailgateClose,
    WindowsOpen,
    WindowsClose,
    WindowsVent,
    ChargeLidOpen,
    ChargeLidClose,
    Flash,
    HonkFlash,
    Honk,
    ClimateStart,
    ClimateStop,
    ClimateTemperature,
    DriverSeatHeat,
    PassengerSeatHeat,
    DriverSeatVent,
    PassengerSeatVent,
    SteeringWheelHeat,
    CleanStart,
    CleanStop,
    Target,
    Amperage,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    AppAccepted,
    Before,
    Observed,
    Error,
    Missing,
    Unknown,
}

#[cfg(any(
    test,
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
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationSource {
    OfficialApp,
    Vehicle,
}

fn status(reading: &Value) -> &'static str {
    match reading["status"].as_str() {
        Some("success") => "success",
        Some("failed") => "failed",
        _ => "unavailable",
    }
}

fn clock_time(value: &Value) -> Option<&str> {
    let time = value.as_str()?;
    let (hours, minutes) = time.split_once(':')?;
    (hours.len() == 2
        && minutes.len() == 2
        && hours
            .bytes()
            .chain(minutes.bytes())
            .all(|byte| byte.is_ascii_digit())
        && hours.parse::<u8>().ok()? < 24
        && minutes.parse::<u8>().ok()? < 60)
        .then_some(time)
}

fn sample(time: i64, readings: &Value) -> Value {
    let reservations = &readings["p4Reservations"];
    let climate = &readings["climate"];
    let battery = &readings["battery"];
    let exterior = &readings["exterior"];
    let openings = &exterior["value"]["openings"];
    let parts: serde_json::Map<_, _> = [
        "tailgate",
        "frontLeftWindow",
        "frontRightWindow",
        "rearLeftWindow",
        "rearRightWindow",
    ]
    .into_iter()
    .map(|part| (part.to_owned(), json!(openings[part].as_u64())))
    .collect();
    let starts = (status(reservations) == "success")
        .then(|| {
            reservations["value"]["entries"].as_array().map(|entries| {
                entries
                    .iter()
                    .map(|entry| clock_time(&entry["start"]))
                    .collect::<Vec<_>>()
            })
        })
        .flatten();
    let activity = climate["value"]["activity"]
        .as_str()
        .filter(|value| matches!(*value, "active" | "starting" | "idle" | "unknown"));
    json!({
        "collectedAt": time,
        "chargingReservations": {"status": status(reservations), "startTimes": starts},
        "climateTimers": {"status": status(&readings["climateTimers"])},
        "exterior": {"status":status(exterior),"reportedAt":exterior["reportedAt"].as_u64(),
            "locked":exterior["value"]["locked"].as_bool(),"openings":parts},
        "chargeTarget": {"status":status(&readings["target"]), "percent":readings["target"]["value"]["percent"].as_f64(),
            "observedAt":readings["target"]["observedAt"].as_u64(), "reportedAt":readings["target"]["reportedAt"].as_u64()},
        "climate": {"status":status(climate),"observedAt":climate["observedAt"].as_u64(),"reportedAt":climate["reportedAt"].as_u64(),"activity":activity,
            "driverSeatHeatLevel":climate["value"]["driverSeatHeatLevel"].as_u64().filter(|n| *n <= 3),
            "passengerSeatHeatLevel":climate["value"]["passengerSeatHeatLevel"].as_u64().filter(|n| *n <= 3),
            "driverSeatVentLevel":climate["value"]["driverSeatVentLevel"].as_u64().filter(|n| *n <= 3),
            "passengerSeatVentLevel":climate["value"]["passengerSeatVentLevel"].as_u64().filter(|n| *n <= 3),
            "steeringWheelHeatActive":climate["value"]["steeringWheelHeatActive"].as_bool()},
        "charging": {"status":status(battery),"reportedAt":battery["reportedAt"].as_u64(),
            "state":battery["value"]["chargeState"].as_u64(),"plugged":battery["value"]["plugged"].as_bool()}
    })
}

impl Archive {
    fn ensure_observations(&self) -> Result<()> {
        self.connection.execute_batch("CREATE TABLE IF NOT EXISTS p4_observations (
            id INTEGER PRIMARY KEY, vin TEXT NOT NULL, recorded_at INTEGER NOT NULL, observation TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS p4_observations_vehicle_time ON p4_observations(vin, recorded_at);").map_err(database_error)
    }

    #[cfg(any(
        test,
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
    pub fn start_field_log(&self, scope: &str, time: u64) -> Result<()> {
        self.append_mark(
            scope,
            time,
            json!({"recordedAt":time, "event":"accountVehicleSelected"}),
        )
    }

    pub fn record_observation(
        &self,
        vin: &str,
        time: u64,
        action: TestAction,
        outcome: Outcome,
    ) -> Result<()> {
        self.append_mark(
            vin,
            time,
            json!({"recordedAt":time, "action":action, "outcome":outcome}),
        )
    }

    #[cfg(any(
        test,
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
    pub fn field_observation(
        &self,
        scope: &str,
        time: u64,
        action: TestAction,
        outcome: Outcome,
        source: OperationSource,
    ) -> Result<()> {
        self.append_mark(scope, time, json!({"recordedAt":time, "action":action, "outcome":outcome, "operationSource":source}))
    }

    fn append_mark(&self, scope: &str, time: u64, mark: Value) -> Result<()> {
        self.ensure_observations()?;
        self.connection
            .execute(
                "INSERT INTO p4_observations(vin, recorded_at, observation) VALUES (?1, ?2, ?3)",
                params![scope, time as i64, mark.to_string()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn p4_log(&self, vin: &str, end: u64) -> Result<Vec<u8>> {
        self.ensure_observations()?;
        let start = end.saturating_sub(WEEK_MS);
        let mut notes = self.connection.prepare(
            "SELECT observation FROM p4_observations WHERE vin=?1 AND recorded_at BETWEEN ?2 AND ?3 ORDER BY recorded_at,id"
        ).map_err(database_error)?;
        let mut observations = Vec::<Value>::new();
        for entry in notes
            .query_map(params![vin, start as i64, end as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(database_error)?
        {
            observations.push(
                serde_json::from_str(&entry.map_err(database_error)?)
                    .map_err(|_| "实测标记损坏")?,
            );
        }
        let (session_events, observations): (Vec<_>, Vec<_>) = observations
            .into_iter()
            .partition(|entry| entry.get("event").is_some());
        let mut query = self.connection.prepare(
            "SELECT recorded_at, payload FROM records WHERE source='norr' AND category='snapshot' AND vin=?1
            AND recorded_at BETWEEN ?2 AND ?3 ORDER BY recorded_at"
        ).map_err(database_error)?;
        let mut rows = query
            .query(params![vin, start as i64, end as i64])
            .map_err(database_error)?;
        let mut samples = Vec::new();
        while let Some(row) = rows.next().map_err(database_error)? {
            let data: String = row.get(1).map_err(database_error)?;
            let record: Value = serde_json::from_str(&data).map_err(|_| "采集记录损坏")?;
            if record["vehicle"]["capabilities"]["norrGeelyReadOnly"] == true
                || record["vehicle"]["capabilities"]["norrXchanger"] == true
            {
                samples.push(sample(
                    row.get(0).map_err(database_error)?,
                    &record["readings"],
                ));
            }
        }
        if samples.is_empty() && observations.is_empty() && session_events.is_empty() {
            return Err("最近 7 天没有该车辆的 P4 测试记录".into());
        }
        serde_json::to_vec_pretty(
            &json!({"format":"norr-p4-test-log","version":1,"appVersion":env!("CARGO_PKG_VERSION"),
            "sessionEvents":session_events,"from":start,"exportedAt":end,"testerObservations":observations,"readings":samples}),
        )
        .map_err(|_| "测试日志编码失败".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_keeps_setting_report_time_separate_from_collection_and_battery() {
        let readings = json!({
            "target":{"status":"success","value":{"percent":90},"observedAt":4000,"reportedAt":2100},
            "battery":{"status":"success","value":{"percent":55},"reportedAt":3500},
            "climate":{"status":"success","value":{"activity":"idle"},"observedAt":4500,"reportedAt":2000}
        });
        let log = sample(5000, &readings);
        assert_eq!(
            log["chargeTarget"],
            json!({"status":"success","percent":90.0,
            "observedAt":4000,"reportedAt":2100})
        );
        assert_eq!(log["climate"]["reportedAt"], 2000);
        assert_eq!(log["climate"]["observedAt"], 4500);
        let legacy = sample(
            5000,
            &json!({"target":{"status":"success","value":{"percent":80}}}),
        );
        assert!(legacy["chargeTarget"]["reportedAt"].is_null());
        assert!(legacy["chargeTarget"]["observedAt"].is_null());
    }
    #[test]
    fn field_log_separates_account_events_from_owner_observations() {
        let path = std::env::temp_dir().join(format!("field-log-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Archive::open(&path).unwrap();
        db.start_field_log("owner/car", 123).unwrap();
        db.field_observation(
            "other/car",
            124,
            TestAction::Lock,
            Outcome::AppAccepted,
            OperationSource::Vehicle,
        )
        .unwrap();
        let initial: Value = serde_json::from_slice(&db.p4_log("owner/car", 125).unwrap()).unwrap();
        assert_eq!(
            initial["sessionEvents"][0]["event"],
            "accountVehicleSelected"
        );
        assert_eq!(initial["testerObservations"], json!([]));
        db.field_observation(
            "owner/car",
            126,
            TestAction::Unlock,
            Outcome::Observed,
            OperationSource::OfficialApp,
        )
        .unwrap();
        drop(db);
        let db = Archive::open(&path).unwrap();
        let report: Value = serde_json::from_slice(&db.p4_log("owner/car", 127).unwrap()).unwrap();
        assert_eq!(
            report["testerObservations"],
            json!([{"action":"unlock","outcome":"observed","operationSource":"officialApp","recordedAt":126}])
        );
        assert_eq!(report["readings"], json!([]));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn export_scopes_notes_and_samples_and_excludes_private_fields() {
        let path = std::env::temp_dir().join(format!("p4-log-{}.sqlite", uuid::Uuid::new_v4()));
        let end = WEEK_MS + 100;
        {
            let db = Archive::open(&path).unwrap();
            for (vin, time) in [("car1", end), ("car2", end), ("car1", 1)] {
                db.record_observation(vin, time, TestAction::ClimateCreate, Outcome::Observed)
                    .unwrap();
            }
            let payload = json!({"vehicle":{"capabilities":{"norrGeelyReadOnly":true}},"readings":{
                "location":{"value":{"latitude":33.5}}, "climate":{"status":"failed","error":"private-example"},
                "p4Reservations":{"status":"success","value":{"entries":[{"start":"08:30","id":"private-example"},{"start":"private-example"}]}}
            }});
            for (vin, at) in [("car1", end), ("car2", end), ("car1", 1)] {
                db.connection
                    .execute(
                        "INSERT INTO records VALUES ('norr','snapshot',?1,?2,?1,?3)",
                        params![at as i64, vin, payload.to_string()],
                    )
                    .unwrap();
            }
        }
        let db = Archive::open(&path).unwrap();
        let bytes = db.p4_log("car1", end).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            !text.contains("private-example")
                && !text.contains("latitude")
                && !text.contains("car1")
        );
        let log: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(log["testerObservations"].as_array().unwrap().len(), 1);
        assert_eq!(log["testerObservations"][0]["outcome"], "observed");
        assert_eq!(log["readings"].as_array().unwrap().len(), 1);
        let row = &log["readings"][0];
        assert_eq!(
            row["chargingReservations"]["startTimes"],
            json!(["08:30", null])
        );
        assert_eq!(row["climateTimers"]["status"], "unavailable");
        assert_eq!(row["climate"]["status"], "failed");
        assert!(db.p4_log("absent", end).is_err());
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
