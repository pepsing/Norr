use crate::{archive::Record, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
pub struct Point {
    pub time: u64,
    pub value: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub vehicles: Vec<String>,
    pub counts: BTreeMap<String, usize>,
    pub battery: Vec<Point>,
    pub odometer: Vec<Point>,
    pub samples: Vec<Value>,
    pub commands: Vec<Value>,
    pub charging: Vec<Value>,
    pub trips: Vec<Trip>,
}

#[derive(Serialize)]
pub struct Trip {
    pub start: u64,
    pub end: u64,
    pub km: f64,
}

#[derive(Clone)]
struct ChargeObservation {
    time: u64,
    state: u64,
    percent: Option<f64>,
    power: Option<f64>,
}

fn charging_segments(observations: &BTreeMap<u64, ChargeObservation>) -> Vec<Value> {
    let mut result = Vec::new();
    let mut segment: Vec<&ChargeObservation> = Vec::new();
    for observation in observations.values() {
        if segment
            .last()
            .is_some_and(|last| observation.time.saturating_sub(last.time) > 600_000)
        {
            result.push(charging_segment(&segment, "interrupted"));
            segment.clear();
        }
        if observation.state == 1 {
            segment.push(observation);
        } else if !segment.is_empty() {
            segment.push(observation);
            result.push(charging_segment(
                &segment,
                if observation.state == 8 {
                    "completed"
                } else {
                    "paused"
                },
            ));
            segment.clear();
        }
    }
    if let Some(last) = segment.last() {
        let status = if norr_vehicle_core::now_ms().saturating_sub(last.time) > 600_000 {
            "interrupted"
        } else {
            "active"
        };
        result.push(charging_segment(&segment, status));
    }
    result
}

fn charging_segment(points: &[&ChargeObservation], status: &str) -> Value {
    let start = points[0];
    let end = points[points.len() - 1];
    let mut energy = 0.0;
    let mut covered = 0;
    for pair in points.windows(2) {
        if let (Some(previous), Some(next)) = (pair[0].power, pair[1].power) {
            let elapsed = pair[1].time.saturating_sub(pair[0].time);
            energy += (previous + next) / 2.0 * elapsed as f64 / 3_600_000.0;
            covered += elapsed;
        }
    }
    let peak = points
        .iter()
        .filter_map(|point| point.power)
        .reduce(f64::max);
    json!({"id":format!("norr-{}",start.time),"start":start.time,
        "end":if status == "active" { None } else { Some(end.time) },"source":"norr",
        "startPercent":start.percent,"endPercent":end.percent,
        "energyKwh":if covered > 0 { Some(energy) } else { None },"peakKw":peak,
        "cost":null,"currency":null,"status":status,"energySource":"observed_power_integration",
        "coverage":if end.time > start.time { Some(covered as f64/(end.time-start.time) as f64) } else { None },"location":null})
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value[key].as_f64().filter(|value| value.is_finite())
}

fn millis(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (value * 1000.0).round() as u64)
}

fn native_value<'a>(record: &'a Record, endpoint: &str) -> &'a Value {
    let reading = &record.value["readings"][endpoint];
    if reading["status"] == "success" {
        &reading["value"]
    } else {
        &Value::Null
    }
}

fn sample(record: &Record) -> Value {
    if record.category == "snapshot" {
        let battery = native_value(record, "battery");
        let odometer = native_value(record, "odometer");
        json!({"time":record.time,"source":record.source,"percent":number(battery,"percent"),
            "rangeKm":number(battery,"rangeKm"),"powerKw":number(battery,"powerKw"),
            "odometerKm":number(odometer,"km"),"temperature":number(native_value(record,"climate"),"interiorTemperature")})
    } else {
        json!({"time":record.time,"source":record.source,"percent":null,"rangeKm":null,"powerKw":null,
            "odometerKm":number(&record.value,"odometer_km"),"temperature":null,
            "ambientTemperature":number(&record.value,"ambient_temp_c")})
    }
}

pub fn trips(points: &[Point]) -> Vec<Trip> {
    let mut result = Vec::new();
    let mut current: Option<Trip> = None;
    for pair in points.windows(2) {
        let distance = pair[1].value - pair[0].value;
        let gap = pair[1].time.saturating_sub(pair[0].time);
        if !(0.05..2000.0).contains(&distance) || gap > 45 * 60 * 1000 {
            if let Some(trip) = current.take() {
                result.push(trip);
            }
            continue;
        }
        let trip = current.get_or_insert(Trip {
            start: pair[0].time,
            end: pair[1].time,
            km: 0.0,
        });
        trip.end = pair[1].time;
        trip.km += distance;
    }
    if let Some(trip) = current {
        result.push(trip);
    }
    result.reverse();
    result
}

pub fn report(records: Vec<Record>, vehicles: Vec<String>, start: u64, end: u64) -> Report {
    let mut report = Report {
        vehicles,
        counts: BTreeMap::new(),
        battery: vec![],
        odometer: vec![],
        samples: vec![],
        commands: vec![],
        charging: vec![],
        trips: vec![],
    };
    let mut battery = BTreeMap::new();
    let mut odometer = BTreeMap::new();
    let mut charging = BTreeMap::new();
    for record in records {
        *report.counts.entry(record.category.clone()).or_default() += 1;
        match record.category.as_str() {
            "snapshot" => {
                let reading = &record.value["readings"]["battery"];
                if let (Some(time),Some(state)) = (reading["reportedAt"].as_u64(),native_value(&record,"battery")["chargeState"].as_u64()) {
                    if time >= start && time < end && (1..=8).contains(&state) {
                        let value = native_value(&record,"battery");
                        charging.insert(time, ChargeObservation {time,state,percent:number(value,"percent"),power:number(value,"powerKw").filter(|value| *value >= 0.0)});
                    }
                }
                for (endpoint, field, points) in [("battery","percent",&mut battery),("odometer","km",&mut odometer)] {
                    let reading = &record.value["readings"][endpoint];
                    let time = reading["reportedAt"].as_u64().or_else(|| reading["observedAt"].as_u64()).unwrap_or(record.time);
                    if time >= start && time < end {
                        if let Some(value) = number(native_value(&record, endpoint), field) { points.insert(time, value); }
                    }
                }
                report.samples.push(sample(&record));
            }
            "telemetry_logs" => {
                if let Some(value) = number(&record.value,"odometer_km") { odometer.entry(record.time).or_insert(value); }
                report.samples.push(sample(&record));
            }
            "receipt" => report.commands.push(json!({"id":format!("norr-{}",record.key),"time":record.time,"source":record.source,
                "name":record.value["command"]["action"],"status":record.value["status"],"message":record.value["message"],"readback":record.value["readback"]})),
            "remote_commands_log" => report.commands.push(json!({"id":format!("hisingen-{}",record.key),"time":record.time,"source":record.source,
                "name":record.value["command_name"],"status":record.value["status"],"message":record.value["error_message"],"readback":null})),
            "charging_sessions" => report.charging.push(json!({"id":record.key,"start":record.time,"end":millis(&record.value["ended_at"]),
                "source":record.source,"startPercent":number(&record.value,"start_soc"),"endPercent":number(&record.value,"end_soc"),
                "energyKwh":number(&record.value,"energy_delivered_kwh"),"peakKw":number(&record.value,"peak_power_kw"),
                "cost":number(&record.value,"estimated_cost"),"currency":record.value["currency_symbol"],
                "status":record.value["lifecycle_state"],"energySource":record.value["energy_source"],"coverage":record.value["sample_coverage"],"location":record.value["location_name"]})),
            _ => {}
        }
    }
    report.battery = battery
        .into_iter()
        .map(|(time, value)| Point { time, value })
        .collect();
    report.odometer = odometer
        .into_iter()
        .map(|(time, value)| Point { time, value })
        .collect();
    report.trips = trips(&report.odometer);
    let native_charging = charging_segments(&charging)
        .into_iter()
        .filter(|segment| {
            !report.charging.iter().any(|existing| {
                let segment_start = segment["start"].as_u64().unwrap_or(0);
                let segment_end = segment["end"].as_u64().unwrap_or(end);
                let existing_start = existing["start"].as_u64().unwrap_or(0);
                let existing_end = existing["end"].as_u64().unwrap_or(end);
                segment_start <= existing_end && existing_start <= segment_end
            })
        })
        .collect::<Vec<_>>();
    report.charging.extend(native_charging);
    report
        .charging
        .sort_by_key(|session| session["start"].as_u64());
    report.samples.reverse();
    report.commands.reverse();
    report.charging.reverse();
    report
}

pub fn csv(records: Vec<Record>) -> Result<Vec<u8>> {
    let mut csv = String::from("fetched_at_ms,battery_reported_at_ms,odometer_reported_at_ms,battery_percent,range_km,power_kw,odometer_km,interior_temperature_c,source,ambient_temperature_c\r\n");
    let mut count = 0;
    for record in records
        .iter()
        .filter(|record| matches!(record.category.as_str(), "snapshot" | "telemetry_logs"))
    {
        let value = sample(record);
        let reported = |endpoint: &str| {
            record.value["readings"][endpoint]["reportedAt"]
                .as_u64()
                .map(|value| value.to_string())
                .unwrap_or_default()
        };
        let odometer_time = if record.source == "hisingen" {
            record.time.to_string()
        } else {
            reported("odometer")
        };
        let mut row = vec![record.time.to_string(), reported("battery"), odometer_time];
        for key in ["percent", "rangeKm", "powerKw", "odometerKm", "temperature"] {
            row.push(
                number(&value, key)
                    .map(|number| number.to_string())
                    .unwrap_or_default(),
            );
        }
        row.push(record.source.clone());
        row.push(
            number(&value, "ambientTemperature")
                .map(|number| number.to_string())
                .unwrap_or_default(),
        );
        csv.push_str(&row.join(","));
        csv.push_str("\r\n");
        count += 1;
    }
    if count == 0 {
        return Err("该车辆没有可导出的采集记录".into());
    }
    Ok(csv.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_csv_keeps_ambient_temperature_in_its_own_column() {
        let record = Record {
            source: "hisingen".into(),
            category: "telemetry_logs".into(),
            key: "1".into(),
            vin: "TEST0000000000001".into(),
            time: 1000,
            value: json!({"odometer_km":12345.0,"ambient_temp_c":12.5}),
        };
        let output = String::from_utf8(csv(vec![record]).unwrap()).unwrap();
        let rows = output.lines().collect::<Vec<_>>();
        let fields = rows[1].split(',').collect::<Vec<_>>();
        assert_eq!(fields[7], "");
        assert_eq!(fields[8], "hisingen");
        assert_eq!(fields[9], "12.5");
        assert_eq!(rows[0].split(',').nth(7), Some("interior_temperature_c"));
    }

    #[test]
    fn trip_derivation_rejects_gaps_resets_and_duplicate_readings() {
        let points = [
            (0, 100.0),
            (60_000, 100.0),
            (120_000, 102.0),
            (180_000, 103.0),
            (240_000, 103.0),
            (300_000, 10.0),
            (3_060_000, 20.0),
        ]
        .map(|(time, value)| Point { time, value });
        let trips = trips(&points);
        assert_eq!(trips.len(), 1);
        assert_eq!(trips[0].km, 3.0);
        assert_eq!(trips[0].start, 60_000);
        assert_eq!(trips[0].end, 180_000);
    }

    #[test]
    fn charging_estimates_use_reported_intervals_and_split_sampling_gaps() {
        let observations = [
            (0, 1, Some(6.0)),
            (300_000, 1, Some(6.0)),
            (600_000, 8, Some(0.0)),
            (1_800_000, 1, None),
            (2_500_000, 1, None),
        ]
        .map(|(time, state, power)| {
            (
                time,
                ChargeObservation {
                    time,
                    state,
                    power,
                    percent: Some(60.0),
                },
            )
        })
        .into_iter()
        .collect();
        let segments = charging_segments(&observations);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0]["energyKwh"], 0.75);
        assert_eq!(segments[0]["coverage"], 1.0);
        assert_eq!(segments[0]["status"], "completed");
        assert!(segments[1]["energyKwh"].is_null());
        assert_eq!(segments[1]["status"], "interrupted");
    }
}
