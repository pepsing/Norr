use crate::{
    models::{Schedule, Vehicle},
    wire::{self, Message},
    Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn minute(message: &Message, field: u32) -> Result<u32> {
    let time = message.nested(field)?.ok_or("日程缺少时间")?;
    let hour = time.int(1).unwrap_or(0);
    let minute = time.int(2).unwrap_or(0);
    if hour > 23 || minute > 59 {
        return Err("日程时间无效".into());
    }
    Ok((hour * 60 + minute) as u32)
}

pub fn climate_timers(message: &Message) -> Result<Value> {
    let deleted = message
        .messages(5)?
        .iter()
        .filter_map(|item| item.string(1))
        .collect::<Vec<_>>();
    let mut timers = BTreeMap::new();
    for item in message.messages(3)?.into_iter().chain(message.messages(4)?) {
        let id = item
            .string(1)
            .filter(|id| !id.is_empty())
            .ok_or("日程缺少身份信息")?;
        if deleted.contains(&id) {
            continue;
        }
        let weekdays = item.integers(6)?;
        if weekdays.iter().any(|day| !(1..=7).contains(day)) {
            return Err("日程星期无效".into());
        }
        timers.insert(
            id.clone(),
            Schedule {
                id: Some(id),
                index: Some(item.int(2).unwrap_or(0)),
                start: minute(&item, 3)?,
                end: None,
                weekdays,
                active: item.int(4).unwrap_or(0) == 1,
                repeats: item.int(5).map(|value| value != 0),
            },
        );
    }
    Ok(json!({"timers": timers.into_values().collect::<Vec<_>>()}))
}

pub fn global_timer(message: &Message) -> Result<Value> {
    let timer = message
        .nested(1)?
        .map(|item| -> Result<Schedule> {
            Ok(Schedule {
                id: None,
                index: None,
                start: minute(&item, 1)?,
                end: Some(minute(&item, 2)?),
                weekdays: vec![],
                active: item.int(3).unwrap_or(0) == 1,
                repeats: None,
            })
        })
        .transpose()?;
    Ok(json!({"timer":timer}))
}

pub fn charge_locations(message: &Message) -> Result<Value> {
    let mut locations = Vec::new();
    for item in message.messages(3)? {
        let id = item
            .string(2)
            .filter(|id| !id.is_empty())
            .ok_or("充电地点缺少身份信息")?;
        let mut timers = Vec::new();
        for (field, kind, time_field, days_field) in
            [(10, "charging", 3, 5), (11, "departure", 3, 4)]
        {
            for timer in item.messages(field)? {
                timers.push(json!({"kind":kind, "start":minute(&timer, time_field)?,
                    "end":if field == 10 { Some(minute(&timer, 4)?) } else { None },
                    "active":timer.int(2).unwrap_or(0) == 1, "weekdays":timer.integers(days_field)?}));
            }
        }
        locations.push(json!({"id":id, "name":item.string(3), "amps":item.int(5),
            "minimumPercent":item.int(6), "timers":timers}));
    }
    Ok(json!({"locations":locations}))
}

pub fn validate(schedule: &Schedule, climate: bool, vehicle: &Vehicle) -> Result<()> {
    if schedule.start >= 1440
        || schedule.end.is_some_and(|end| end >= 1440)
        || schedule.weekdays.iter().any(|day| !(1..=7).contains(day))
        || schedule
            .weekdays
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != schedule.weekdays.len()
        || schedule
            .id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256)
    {
        return Err("日程参数无效".into());
    }
    if !climate {
        if schedule.end.is_none()
            || schedule.end == Some(schedule.start)
            || !schedule.weekdays.is_empty()
        {
            return Err("充电窗口需要不同的开始和结束时间，每天生效".into());
        }
        return Ok(());
    }
    if schedule.end.is_some() {
        return Err("空调日程仅设置出发时间".into());
    }
    let repeats = schedule.repeats.ok_or("请选择日程重复方式")?;
    let flag = if repeats {
        "supportsParkingClimatizationRepeatedWeekdayTimers"
    } else if schedule.weekdays.is_empty() {
        "supportsParkingClimatization24hTimers"
    } else {
        "supportsParkingClimatizationUnrepeatedWeekdayTimers"
    };
    if vehicle.capabilities.get(flag).copied().flatten() != Some(true) {
        return Err("车辆尚未确认支持此重复方式".into());
    }
    if repeats && schedule.weekdays.is_empty() {
        return Err("请选择每周重复的星期".into());
    }
    Ok(())
}

fn daily_time(minutes: u32, offset: i32) -> Vec<u8> {
    [
        wire::integer(1, (minutes / 60) as u64),
        wire::integer(2, (minutes % 60) as u64),
        wire::bytes(3, &wire::integer(1, offset as i64 as u64)),
    ]
    .concat()
}

pub fn encode(schedule: &Schedule, climate: bool, offset: i32) -> Vec<u8> {
    if !climate {
        return [
            wire::bytes(1, &daily_time(schedule.start, offset)),
            wire::bytes(2, &daily_time(schedule.end.unwrap_or(0), offset)),
            wire::integer(3, u64::from(schedule.active)),
        ]
        .concat();
    }
    let mut body = Vec::new();
    if let Some(id) = &schedule.id {
        body.extend(wire::string(1, id));
    }
    body.extend(wire::integer(2, schedule.index.unwrap_or(0)));
    body.extend(wire::bytes(3, &daily_time(schedule.start, offset)));
    body.extend(wire::integer(4, u64::from(schedule.active)));
    body.extend(wire::integer(5, u64::from(schedule.repeats == Some(true))));
    if !schedule.weekdays.is_empty() {
        body.extend(wire::packed(6, &schedule.weekdays));
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timer_round_trip_preserves_id_index_minutes_and_explicit_false() {
        let timer = Schedule {
            id: Some("timer-7".into()),
            index: Some(7),
            start: 977,
            end: None,
            weekdays: vec![2, 5],
            active: true,
            repeats: Some(false),
        };
        let bytes = wire::bytes(3, &encode(&timer, true, -300));
        let result = climate_timers(&Message::parse(&bytes).unwrap()).unwrap();
        assert_eq!(
            serde_json::from_value::<Schedule>(result["timers"][0].clone()).unwrap(),
            timer
        );
        let encoded = Message::parse(&encode(&timer, true, -300)).unwrap();
        assert_eq!(
            encoded
                .nested(3)
                .unwrap()
                .unwrap()
                .nested(3)
                .unwrap()
                .unwrap()
                .int(1),
            Some(-300i64 as u64)
        );
    }
    #[test]
    fn deletion_and_empty_lists_are_authoritative_but_malformed_timers_fail() {
        assert_eq!(
            climate_timers(&Message(vec![])).unwrap()["timers"],
            json!([])
        );
        let body = [
            wire::bytes(3, &wire::string(1, "deleted")),
            wire::bytes(5, &wire::string(1, "deleted")),
        ]
        .concat();
        assert_eq!(
            climate_timers(&Message::parse(&body).unwrap()).unwrap()["timers"],
            json!([])
        );
        assert!(climate_timers(
            &Message::parse(&wire::bytes(3, &wire::string(1, "broken"))).unwrap()
        )
        .is_err());
        assert!(global_timer(&Message::parse(&wire::bytes(1, &[])).unwrap()).is_err());
    }
}
