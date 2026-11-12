use crate::{
    schedules,
    wire::{self, Message, Value as WireValue},
    Result,
};
use serde_json::{json, Value};

pub fn parse(kind: &str, bytes: &[u8], vin: &str) -> Result<(Value, Option<u64>)> {
    let outer = Message::parse(bytes)?;
    match kind {
        "climateTimers" => return Ok((schedules::climate_timers(&outer)?, None)),
        "chargeTimer" => return Ok((schedules::global_timer(&outer)?, None)),
        "chargeLocations" => return Ok((schedules::charge_locations(&outer)?, None)),
        "location" => return location(&outer),
        "software" => return software(&outer),
        "softwareSchedule" => {
            let schedule = outer.nested(1)?;
            return Ok((
                match schedule {
                    Some(item) => json!({"status":item.int(1), "scheduledAt":item.timestamp(3),
                    "softwareId":item.string(4), "minutes":item.int(2).filter(|value| *value <= 10080)}),
                    None => json!({"status":null, "scheduledAt":null, "softwareId":null}),
                },
                None,
            ));
        }
        _ => {}
    }
    let message = wire::payload(bytes, vin)?;
    let timestamp = message.timestamp(1);
    let value = match kind {
        "health" => {
            let tyres = ["frontLeft", "frontRight", "rearLeft", "rearRight"].iter().enumerate().map(|(index, wheel)| {
                json!({"wheel":wheel, "kpa":message.number(39 + index as u32).filter(|n| *n > 0.0),
                    "warning":message.int(9 + index as u32),
                    "referenceKpa":message.number(if index < 2 {43} else {44}).filter(|n| *n > 0.0)})
            }).collect::<Vec<_>>();
            let warnings = [
                (5, "service"),
                (6, "brakeFluid"),
                (7, "coolant"),
                (8, "oil"),
                (13, "washerFluid"),
                (38, "lowVoltageBattery"),
            ]
            .iter()
            .map(|(field, name)| ((*name).to_owned(), json!(message.int(*field))))
            .collect::<serde_json::Map<_, _>>();
            json!({"daysToService":message.int(3).filter(|n| *n < i32::MAX as u64),
                "kmToService":message.int(4).filter(|n| *n < i32::MAX as u64), "tyres":tyres, "warnings":warnings})
        }
        "airQuality" => {
            json!({"state":message.int(6), "aqi":message.int(9), "pm25":message.int(10),
            "pm10":message.int(14), "externalPm25":message.int(15), "filterPercent":message.int(16).filter(|n| *n <= 100),
            "remainingMinutes":message.int(11), "error":message.int(13), "measuredAt":message.timestamp(2)})
        }
        _ => return Err("未知扩展读取项目".into()),
    };
    Ok((value, timestamp))
}

fn software(outer: &Message) -> Result<(Value, Option<u64>)> {
    let Some(item) = outer.nested(1)? else {
        return Ok((json!({"noUpdate":true}), None));
    };
    let description = item.nested(2)?;
    let duration = item.nested(5)?.and_then(|value| value.int(1));
    let schedule = item.nested(8)?.and_then(|value| value.timestamp(2));
    Ok((
        json!({"id":item.string(1), "version":item.string(6), "state":item.int(4),
        "title":description.as_ref().and_then(|value| value.string(1)),
        "description":description.as_ref().and_then(|value| value.string(3)),
        "durationSeconds":duration, "scheduledAt":schedule, "noUpdate":false}),
        item.timestamp(10),
    ))
}

fn coordinate(message: &Message, field: u32) -> Option<f64> {
    match message.value(field)? {
        WireValue::Fixed32(_) | WireValue::Fixed64(_) => message.number(field),
        _ => None,
    }
}

fn coordinates(
    message: &Message,
    lon_field: u32,
    lat_field: u32,
    time_field: u32,
) -> Result<Option<(Value, Option<u64>)>> {
    let Some((lon, lat)) = coordinate(message, lon_field).zip(coordinate(message, lat_field))
    else {
        return Ok(None);
    };
    if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
        return Err("车辆位置范围无效".into());
    }
    let time = message
        .timestamp(time_field)
        .or_else(|| message.int(time_field)?.checked_mul(1000));
    Ok(Some((json!({"latitude":lat, "longitude":lon}), time)))
}

fn location(message: &Message) -> Result<(Value, Option<u64>)> {
    let compact = coordinates(message, 1, 2, 3)?;
    let shifted = coordinates(message, 2, 3, 4)?;
    let mut wrapped = Vec::new();
    for field in [2, 5] {
        if let Some(nested) = message.nested(field)? {
            if let Some(value) = coordinates(&nested, 1, 2, 3)? {
                wrapped.push((field, value));
            }
        }
    }
    if wrapped.len() > 1 {
        return Err("车辆位置格式存在歧义".into());
    }
    if let (Some((5, nested)), Some(shifted)) = (wrapped.first(), shifted.as_ref()) {
        if compact.is_none() && nested.0 == shifted.0 {
            return Ok(nested.clone());
        }
    }
    let candidates = [
        compact,
        shifted,
        wrapped.into_iter().next().map(|(_, value)| value),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return Err("车辆未返回明确位置".into());
    }
    Ok(candidates.into_iter().next().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_keeps_absent_values_unknown_and_reference_pressures_separate() {
        let bytes = wire::bytes(
            3,
            &[
                wire::integer(43, 290),
                wire::integer(9, 3),
                wire::integer(3, 0),
            ]
            .concat(),
        );
        let (value, _) = parse("health", &bytes, "fixture").unwrap();
        assert!(value["tyres"][0]["kpa"].is_null());
        assert_eq!(value["tyres"][0]["referenceKpa"], 290.0);
        assert_eq!(value["tyres"][0]["warning"], 3);
        assert_eq!(value["daysToService"], 0);
        assert!(value["warnings"]["brakeFluid"].is_null());
    }
    #[test]
    fn ota_version_and_duration_follow_their_wire_fields() {
        let bytes = wire::bytes(
            1,
            &[
                wire::string(1, "update-id"),
                wire::integer(4, 15),
                wire::bytes(5, &wire::integer(1, 5400)),
                wire::string(6, "test-version"),
            ]
            .concat(),
        );
        let (value, _) = parse("software", &bytes, "fixture").unwrap();
        assert_eq!(value["state"], 15);
        assert_eq!(value["durationSeconds"], 5400);
        assert_eq!(value["version"], "test-version");
        assert!(value.get("installedVersion").is_none());
    }
    #[test]
    fn coordinates_require_floating_point_fields_and_reject_ambiguity() {
        let compact = [wire::float(1, 12.0), wire::float(2, 55.0)].concat();
        assert!(location(&Message::parse(&compact).unwrap()).is_ok());
        assert!(location(
            &Message::parse(&[wire::integer(1, 12), wire::integer(2, 55)].concat()).unwrap()
        )
        .is_err());
        let ambiguous = [wire::bytes(2, &compact), wire::bytes(5, &compact)].concat();
        assert!(location(&Message::parse(&ambiguous).unwrap()).is_err());
    }
}
