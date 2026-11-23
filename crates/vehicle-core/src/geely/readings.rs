use crate::{models::*, now_ms, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) fn num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
fn code(v: &Value) -> Option<i32> {
    num(v)
        .filter(|n| n.fract() == 0. && (-1e4..1e4).contains(n))
        .map(|n| n as i32)
}
fn bounded(v: &Value, min: f64, max: f64) -> Option<f64> {
    num(v).filter(|n| (min..=max).contains(n))
}
fn seat_heat(detail: &Value, level: &Value) -> Option<i32> {
    if code(detail) == Some(0) {
        return Some(0);
    }
    if !detail.is_null() && code(detail).is_none() {
        return None;
    }
    code(level).filter(|n| (0..=3).contains(n))
}

fn cabin_climate(climate: &Value) -> Value {
    let steering = match code(&climate["steerWhlHeatingSts"]) {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None,
    };
    json!({
        "interiorTemperature": bounded(&climate["interiorTemp"], -55., 90.),
        "exteriorTemperature": bounded(&climate["exteriorTemp"], -55., 90.),
        "activity": match status_flag(climate, "preClimateActive") {
            Some(true) => "active", Some(false) => "idle", None => "unknown",
        },
        "driverSeatHeatLevel": seat_heat(&climate["drvHeatDetail"], &climate["drvHeatSts"]),
        "passengerSeatHeatLevel": seat_heat(&climate["passHeatingDetail"], &climate["passHeatingSts"]),
        "driverSeatVentLevel": seat_vent(&climate["drvVentSts"], &climate["drvVentDetail"]),
        "passengerSeatVentLevel": seat_vent(&climate["passVentSts"], &climate["passVentDetail"]),
        "driverSeatVentSupported": match code(&climate["drvVentSts"]) { Some(0) => Some(false), Some(1|2) => Some(true), _ => None },
        "passengerSeatVentSupported": match code(&climate["passVentSts"]) { Some(0) => Some(false), Some(1|2) => Some(true), _ => None },
        "steeringWheelHeatActive": steering,
    })
}
fn seat_vent(status: &Value, detail: &Value) -> Option<i32> {
    match code(status) {
        Some(1) => code(detail).filter(|n| (0..=3).contains(n)),
        Some(2) => Some(0),
        _ => None,
    }
}
fn charge_state(ev: &Value) -> Option<i32> {
    match code(&ev["chargerState"]) {
        Some(2 | 15 | 24) => return Some(1),
        Some(3) => return Some(7),
        Some(5) => return Some(9),
        Some(14 | 18 | 20..=23 | 27) => return Some(5),
        _ => {}
    }
    let minutes = bounded(&ev["timeToFullyCharged"], 0., 10080.);
    match code(&ev["statusOfChargerConnection"]) {
        Some(9) => Some(5),
        Some(3) => minutes.map(|n| if n == 0. { 8 } else { 1 }),
        Some(5) => match code(&ev["chargeSts"]) {
            Some(0 | 3) => Some(7),
            Some(1) => Some(3),
            Some(2) => minutes.map(|n| if n == 0. { 8 } else { 3 }),
            Some(4) => Some(1),
            _ => None,
        },
        _ => None,
    }
}

fn plugged(status: &Value) -> Option<bool> {
    match code(&status["statusOfChargerConnection"]) {
        Some(0) => Some(false),
        Some(1 | 2 | 3 | 5) => Some(true),
        _ => None,
    }
}

fn openings(safety: &Value, climate: &Value, electric: &Value) -> Value {
    let mut parts = serde_json::Map::new();
    for (part, source) in [
        ("frontLeft", "Driver"),
        ("frontRight", "Passenger"),
        ("rearLeft", "DriverRear"),
        ("rearRight", "PassengerRear"),
    ] {
        parts.insert(
            format!("{part}Door"),
            json!(open_code(&safety[format!("doorOpenStatus{source}")])),
        );
        let window = match code(&climate[format!("winStatus{source}")]) {
            Some(0) => Some(3),
            Some(1) => Some(1),
            Some(2) => Some(2),
            _ => None,
        };
        parts.insert(format!("{part}Window"), json!(window));
    }
    parts.insert(
        "hood".into(),
        json!(open_code(&safety["engineHoodOpenStatus"])),
    );
    parts.insert(
        "tailgate".into(),
        json!(open_code(&safety["trunkOpenStatus"])),
    );
    parts.insert(
        "chargeLid".into(),
        json!(code(&electric["chargeLidDcAcStatus"]).filter(|n| matches!(n, 1 | 2))),
    );
    Value::Object(parts)
}
fn open_code(v: &Value) -> Option<i32> {
    match code(v) {
        Some(1) => Some(1),
        Some(0) => Some(2),
        _ => None,
    }
}

fn status_flag(group: &Value, key: &str) -> Option<bool> {
    match &group[key] {
        Value::Bool(value) => Some(*value),
        Value::String(value) if value.eq_ignore_ascii_case("true") => Some(true),
        Value::String(value) if value.eq_ignore_ascii_case("false") => Some(false),
        value => match code(value) {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
    }
}

fn degrees(raw: &Value, limit: f64) -> Option<f64> {
    let n = num(raw)?;
    (n.fract() == 0.0 && n != 0.0 && n.abs() <= limit * 3_600_000.0).then_some(n / 3_600_000.0)
}

fn location_reading(position: &Value, reported_at: Option<u64>, pending: bool) -> Reading {
    if status_flag(position, "carLocatorStatUploadEn") != Some(true) {
        return Reading::failure("车辆未确认允许位置上报".into());
    }
    if status_flag(position, "posCanBeTrusted") != Some(true) {
        return Reading::failure("车辆未确认定位可信".into());
    }
    if status_flag(position, "marsCoordinates") != Some(false) {
        return Reading::failure("车辆坐标系待核实".into());
    }
    match (
        degrees(&position["latitude"], 90.0),
        degrees(&position["longitude"], 180.0),
    ) {
        (Some(latitude), Some(longitude)) => Reading::success(
            json!({
                "latitude": latitude, "longitude": longitude, "coordinateSystem": "wgs84",
                "freshnessPending": pending
            }),
            reported_at,
        ),
        _ => Reading::failure("车辆尚未返回有效坐标".into()),
    }
}

// Read-only installation checks report coordinate validity without exposing the position.
fn field_evidence(status: &Value) -> Value {
    let position = &status["basicVehicleStatus"]["position"];
    let maintenance = &status["additionalVehicleStatus"]["maintenanceStatus"];
    let wheels: Vec<_> = ["Driver", "Passenger", "DriverRear", "PassengerRear"]
        .into_iter()
        .map(|wheel| {
            json!({
                "wheel": wheel,
                "tyreStatus": bounded(&maintenance[format!("tyreStatus{wheel}")], 0.0, 10000.0),
                "tyrePreWarning": code(&maintenance[format!("tyrePreWarning{wheel}")])
            })
        })
        .collect();
    json!({
        "positionFlags": {
            "posCanBeTrusted": status_flag(position, "posCanBeTrusted"),
            "marsCoordinates": status_flag(position, "marsCoordinates"),
            "carLocatorStatUploadEn": status_flag(position, "carLocatorStatUploadEn"),
            "latitudeValid": num(&position["latitude"]).map(|_| degrees(&position["latitude"], 90.0).is_some()),
            "longitudeValid": num(&position["longitude"]).map(|_| degrees(&position["longitude"], 180.0).is_some())
        },
        "wheels": wheels
    })
}

pub(super) fn snapshot(
    car: &Vehicle,
    status: Result<Value>,
    charge: Result<Value>,
) -> Result<Snapshot> {
    let mut readings = BTreeMap::new();
    let status = status.and_then(|v| {
        let vehicle = &v["vehicleStatus"];
        if vehicle["configuration"]["vin"]
            .as_str()
            .is_some_and(|vin| vin != car.vin)
        {
            return Err("P4 返回的车辆不匹配".into());
        }
        let result = &v["result"]["serviceResult"];
        if !vehicle.is_object()
            || !result["error"].is_null()
            || !matches!(code(&result["operationResult"]), Some(0 | 1))
        {
            return Err("P4 车况读取未完成".into());
        }
        Ok(v)
    });
    if let Ok(v) = &status {
        let s = &v["vehicleStatus"];
        if std::env::args().nth(1).as_deref() == Some("--verify-session") {
            println!("p4FieldEvidence={}", field_evidence(s));
        }
        let a = &s["additionalVehicleStatus"];
        let ts = num(&s["updateTime"])
            .map(|n| if n < 1e12 { n * 1000. } else { n })
            .filter(|n| (1e12..=(now_ms() + 60000) as f64).contains(n))
            .map(|n| n as u64);
        let pending = code(&v["result"]["serviceResult"]["operationResult"]) == Some(1);
        let mut add = |key: &str, source: &Value, mut value: Value| {
            let reading = if source.is_object() {
                value["freshnessPending"] = json!(pending);
                Reading::success(value, ts)
            } else {
                Reading::failure("本次车况缺少该分组".into())
            };
            readings.insert(key.to_owned(), reading);
        };
        let ev = &a["electricVehicleStatus"];
        let maintenance = &a["maintenanceStatus"];
        let cl = &a["climateStatus"];
        let safe = &a["drivingSafetyStatus"];
        let run = &a["runningStatus"];
        add(
            "battery",
            ev,
            json!({"percent":bounded(&ev["chargeLevel"],0.,100.),"rangeKm":bounded(&ev["distanceToEmptyOnBatteryOnly"],0.,3000.),"chargeState":charge_state(ev),"minutesToFull":bounded(&ev["timeToFullyCharged"],0.,10080.),"plugged":plugged(ev),
                "averageConsumptionKwhPer100Km":bounded(&ev["averPowerConsumption"],0.,200.)}),
        );
        add(
            "exterior",
            safe,
            json!({"locked":match code(&safe["centralLockingStatus"]){Some(1|2)=>Some(true),Some(0)=>Some(false),_=>None},
                "trunkLocked":match code(&safe["trunkLockStatus"]){Some(1)=>Some(true),Some(0)=>Some(false),_=>None},
                "openings":openings(safe,cl,ev)}),
        );
        add("climate", cl, cabin_climate(cl));
        add(
            "odometer",
            if maintenance.is_object() {
                maintenance
            } else {
                run
            },
            json!({"km":bounded(&maintenance["odometer"],0.,1e7),"tripKm":bounded(&run["tripMeter2"],0.,1e6),"manualAverageSpeed":bounded(&run["avgSpeed"],0.,300.)}),
        );
        let tyres = [
            ("frontLeft", "Driver"),
            ("frontRight", "Passenger"),
            ("rearLeft", "DriverRear"),
            ("rearRight", "PassengerRear"),
        ]
        .into_iter()
        .filter_map(|(wheel, k)| {
            let kpa = bounded(&maintenance[format!("tyreStatus{k}")], 0.0, 10000.0);
            let warning = code(&maintenance[format!("tyrePreWarning{k}")]);
            let temperature = bounded(&maintenance[format!("tyreTemp{k}")], -60., 150.);
            (kpa.is_some() || warning.is_some() || temperature.is_some()).then(|| {
                json!({
                    "wheel": wheel, "kpa": kpa, "sourceWarning": warning, "temperatureC": temperature
                })
            })
        })
        .collect::<Vec<_>>();
        add(
            "health",
            maintenance,
            json!({"daysToService":bounded(&maintenance["daysToService"],-3650.,3650.),"kmToService":bounded(&maintenance["distanceToService"],-1e6,1e6),"tyres":tyres}),
        );
        let air = &a["pollutionStatus"];
        let cleaning = status_flag(cl, "airBlowerActive");
        add(
            "airQuality",
            if cleaning.is_some() { cl } else { air },
            json!({"pm25":bounded(&air["interiorPM25"],0.,2000.),"state":cleaning.map(|active| if active {1} else {2})}),
        );
        readings.insert(
            "location".into(),
            location_reading(&s["basicVehicleStatus"]["position"], ts, pending),
        );
    } else if let Err(err) = &status {
        for k in [
            "battery",
            "exterior",
            "climate",
            "odometer",
            "location",
            "health",
            "airQuality",
        ] {
            readings.insert(k.into(), Reading::failure(err.clone()));
        }
    }
    if let Ok(c) = charge {
        let percent = bounded(&c["soc"], 0., 100.);
        let connection = plugged(&c);
        if (percent.is_some() || connection.is_some())
            && readings
                .get("battery")
                .and_then(|reading| reading.value.as_ref())
                .is_none()
        {
            readings.insert(
                "battery".into(),
                Reading::success(
                    json!({
                        "percent": percent, "plugged": connection
                    }),
                    None,
                ),
            );
        }
    }
    Ok(Snapshot {
        vehicle: car.clone(),
        fetched_at: now_ms(),
        readings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn climate_activity_preserves_explicit_off_and_unknown_states() {
        for (raw, expected) in [
            (json!("false"), "idle"),
            (json!(0), "idle"),
            (json!("1"), "active"),
            (json!(true), "active"),
            (Value::Null, "unknown"),
            (json!(7), "unknown"),
        ] {
            assert_eq!(
                cabin_climate(&json!({"preClimateActive":raw}))["activity"],
                expected
            );
        }
    }

    #[test]
    fn cabin_heating_preserves_reported_off_levels_and_missing_values() {
        let state = cabin_climate(&json!({
            "interiorTemp": "22", "drvHeatDetail": "0", "drvHeatSts": "3",
            "passHeatingDetail": "1", "passHeatingSts": "2", "steerWhlHeatingSts": "1"
        }));
        assert_eq!(state["driverSeatHeatLevel"], 0);
        assert_eq!(state["passengerSeatHeatLevel"], 2);
        assert_eq!(state["steeringWheelHeatActive"], true);
        assert!(state.get("targetTemperature").is_none());
        let partial =
            cabin_climate(&json!({"drvHeatSts":1,"passHeatingSts":"7","steerWhlHeatingSts":0}));
        assert_eq!(partial["driverSeatHeatLevel"], 1);
        assert!(partial["passengerSeatHeatLevel"].is_null());
        assert_eq!(partial["steeringWheelHeatActive"], false);
        assert!(
            cabin_climate(&json!({"steerWhlHeatingSts":7}))["steeringWheelHeatActive"].is_null()
        );
        assert!(cabin_climate(&json!({}))["driverSeatHeatLevel"].is_null());
    }
    #[test]
    fn ventilation_uses_the_active_seats_detail_and_preserves_unknowns() {
        let climate = cabin_climate(
            &json!({"drvVentSts":"1","drvVentDetail":"3","passVentSts":2,"passVentDetail":3}),
        );
        assert_eq!(climate["driverSeatVentLevel"], 3);
        assert_eq!(climate["passengerSeatVentLevel"], 0);
        for (status, detail) in [(0, 2), (7, 2), (1, 255)] {
            assert_eq!(seat_vent(&json!(status), &json!(detail)), None);
        }
        assert!(cabin_climate(&json!({}))["passengerSeatVentLevel"].is_null());
    }
    #[test]
    fn only_publish_trusted_permitted_gps_with_the_car_timestamp() {
        let position = json!({"carLocatorStatUploadEn":"1","posCanBeTrusted":"true","marsCoordinates":"0","latitude":"108000000","longitude":-36000000});
        let reading = location_reading(&position, Some(1700000000000), true);
        let value = reading.value.unwrap();
        assert_eq!(value["latitude"], 30.0);
        assert_eq!(value["longitude"], -10.0);
        assert_eq!(value["coordinateSystem"], "wgs84");
        assert_eq!(value["freshnessPending"], true);
        assert_eq!(reading.reported_at, Some(1700000000000));
        for (field, invalid) in [
            ("marsCoordinates", json!(true)),
            ("marsCoordinates", Value::Null),
            ("carLocatorStatUploadEn", json!("false")),
            ("posCanBeTrusted", json!("unknown")),
            ("latitude", json!(0)),
            ("longitude", json!(648000001)),
            ("latitude", json!(1.5)),
        ] {
            let mut sample = position.clone();
            sample[field] = invalid;
            assert!(location_reading(&sample, None, false).value.is_none());
        }
    }

    #[test]
    fn field_evidence_reports_only_bounded_values_and_distinguishes_missing_flags() {
        let data = json!({
            "configuration":{"vin":"private-identifier"},
            "basicVehicleStatus":{"position":{
                "latitude":"12345678", "longitude":0, "marsCoordinates":"false",
                "posCanBeTrusted":"1", "carLocatorStatUploadEn":"unexpected"
            }},
            "additionalVehicleStatus":{"maintenanceStatus":{
                "tyreStatusDriver":"2.5", "tyrePreWarningDriver":0
            }}
        });
        let evidence = field_evidence(&data);
        assert_eq!(
            evidence["positionFlags"],
            json!({
                "latitudeValid":true, "longitudeValid":false, "marsCoordinates":false,
                "posCanBeTrusted":true, "carLocatorStatUploadEn":null
            })
        );
        assert_eq!(evidence["wheels"][0]["tyreStatus"], 2.5);
        assert_eq!(evidence["wheels"][0]["tyrePreWarning"], 0);
        assert!(evidence["wheels"][1]["tyreStatus"].is_null());
        assert!(!evidence.to_string().contains("12345678"));
        assert!(!evidence.to_string().contains("private-identifier"));
    }

    #[test]
    fn independent_soc_never_changes_timestamp_or_discards_other_battery_fields() {
        let car: Vehicle = serde_json::from_value(json!({
            "vin":"12345678901234567", "model":"Polestar 4", "capabilities":{}, "limits":{}
        }))
        .unwrap();
        let timestamp = 1_700_000_000_000u64;
        let status = json!({
            "result":{"serviceResult":{"operationResult":1}},
            "vehicleStatus":{"updateTime":timestamp, "additionalVehicleStatus":{
                "electricVehicleStatus":{"distanceToEmptyOnBatteryOnly":"0","averPowerConsumption":"20.3"},
                "climateStatus":{"interiorTemp":"255","exteriorTemp":"-4.5","airBlowerActive":"false"},
                "maintenanceStatus":{"tyreTempDriver":"0","tyreTempDriverRear":"19","tyreTempPassenger":255}
            }}
        });
        let charge = json!({"soc":0});
        let report = snapshot(&car, Ok(status), Ok(charge.clone())).unwrap();
        let climate = report.readings["climate"].value.as_ref().unwrap();
        assert_eq!(climate["exteriorTemperature"], -4.5);
        assert!(climate["interiorTemperature"].is_null());
        assert_eq!(
            report.readings["airQuality"].value.as_ref().unwrap()["state"],
            2
        );
        let tyres = &report.readings["health"].value.as_ref().unwrap()["tyres"];
        assert_eq!(tyres.as_array().unwrap().len(), 2);
        assert_eq!(tyres[0]["temperatureC"], 0.);
        assert_eq!(tyres[1]["wheel"], "rearLeft");
        assert_eq!(tyres[1]["temperatureC"], 19.);
        let reading = &report.readings["battery"];
        let value = reading.value.as_ref().unwrap();
        assert_eq!(reading.reported_at, Some(timestamp));
        assert_eq!(value["rangeKm"], 0.0);
        assert_eq!(value["averageConsumptionKwhPer100Km"], 20.3);
        assert!(value["percent"].is_null());
        assert_eq!(value["freshnessPending"], true);
        let fallback = snapshot(&car, Err("timeout".into()), Ok(charge)).unwrap();
        let reading = &fallback.readings["battery"];
        assert_eq!(reading.reported_at, None);
        assert_eq!(reading.value.as_ref().unwrap()["percent"], 0.0);
        assert_eq!(fallback.readings["exterior"].status, "failed");
        let fallback = snapshot(
            &car,
            Err("timeout".into()),
            Ok(json!({"statusOfChargerConnection":"1"})),
        )
        .unwrap();
        assert_eq!(
            fallback.readings["battery"].value.as_ref().unwrap()["plugged"],
            true
        );
    }
    #[test]
    fn codes_preserve_unknown_and_distinguish_ajar_from_closed() {
        let parts = openings(
            &json!({"doorOpenStatusDriver":"7"}),
            &json!({"winStatusDriver":"0","winStatusPassenger":"2"}),
            &Value::Null,
        );
        assert!(parts["frontLeftDoor"].is_null());
        assert_eq!(parts["frontLeftWindow"], 3);
        assert_eq!(parts["frontRightWindow"], 2);
        assert_eq!(
            charge_state(&json!({"chargerState":"3","statusOfChargerConnection":"3"})),
            Some(7)
        );
        assert_eq!(
            charge_state(&json!({"statusOfChargerConnection":"3"})),
            None
        );
    }
}
