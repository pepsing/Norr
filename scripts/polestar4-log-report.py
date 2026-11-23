"""Read an exported Norr P4 log locally and summarize door-lock and climate evidence."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


ACTIONS = {
    "lock": ("锁车", "exterior", "已锁定"),
    "unlock": ("解锁", "exterior", "已解锁"),
    "climateStart": ("启动空调", "climate", "运行中"),
    "climateStop": ("停止空调", "climate", "已停止"),
}
SOURCES = {"officialApp": "官方 App", "vehicle": "车机或车辆"}
OUTCOMES = {
    "before": "准备操作", "observed": "观察到预期变化", "appAccepted": "官方 App 提示受理",
    "missing": "未看到入口", "error": "操作报错", "unknown": "结果未明",
}
WINDOW_MS = 10 * 60 * 1000


def valid_time(value):
    return type(value) is int and 0 < value <= 253402300799999


def timestamp(ms):
    dt = datetime.fromtimestamp(ms // 1000, timezone.utc)
    return f"{dt:%Y-%m-%d %H:%M:%S}.{ms % 1000:03} UTC"


def rows(log, name):
    result = log.get(name)
    if not isinstance(result, list) or not all(isinstance(row, dict) for row in result):
        raise ValueError(f"日志缺少有效的 {name} 列表")
    return result


def vehicle_reports(samples, field):
    reports = []
    for sample in samples:
        reading = sample.get(field)
        if not isinstance(reading, dict) or reading.get("status") != "success":
            continue
        collected, reported = sample.get("collectedAt"), reading.get("reportedAt")
        if not valid_time(reported) or not valid_time(collected) or reported > collected:
            continue
        if field == "exterior":
            locked = reading.get("locked")
            if type(locked) is not bool:
                continue
            value = "已锁定" if locked else "已解锁"
        else:
            value = {"active": "运行中", "starting": "正在启动", "idle": "已停止"}.get(reading.get("activity"))
            if value is None:
                continue
        reports.append((reported, collected, value))
    return reports


def last_state(states):
    last = max(states)
    values = states[last]
    label = next(iter(values)) if len(values) == 1 else "同一上报时间的读数冲突"
    return f"{label}（{timestamp(last)}）"


def readback(reports, start, end, target):
    before, after = {}, {}
    for reported, collected, value in reports:
        if collected < start:
            before.setdefault(reported, set()).add(value)
        elif start < reported <= collected < end:
            after.setdefault(reported, set()).add(value)
    baseline = "准备前最近上报为" + last_state(before) if before else "准备前无可用上报"
    if not after:
        return f"{baseline}。该时段没有可核对的新上报"
    match = "新上报中出现目标状态" if {target} in after.values() else "未见明确匹配的上报"
    return f"{baseline}。新上报 {len(after)} 条，末次为{last_state(after)}。{match}"


def ios_samples(events, vehicles, result):
    samples = {}
    failures = 0
    for event in events:
        ref = event.get("vehicleRef")
        if event.get("operation") != "readVehicle" or event.get("source") != "c3":
            continue
        if event.get("phase") == "failed":
            failures += 1
            continue
        if not isinstance(ref, str) or not ref:
            continue
        sample = event.get("sample")
        if event.get("phase") != "completed" or not isinstance(sample, dict) or not valid_time(sample.get("collectedAt")):
            continue
        samples.setdefault(ref, []).append(sample)
    if failures:
        result.append(f"整次车况读取失败 {failures} 次。")
    for ref, group in samples.items():
        vehicle = vehicles.setdefault(ref, len(vehicles) + 1)
        latest = max(group, key=lambda row: row["collectedAt"])
        levels = []
        for kind, field, label in (("battery", "percent", "当前电量"), ("target", "referencePercent", "充电上限（C3 参考值）")):
            reading = latest.get(kind)
            value = reading.get(field) if isinstance(reading, dict) and reading.get("status") == "success" else None
            level = f"{value:g}%" if type(value) in (float, int) and 0 <= value <= 100 else "未返回"
            levels.append(label + " " + level)
        result.append(f"车辆 {vehicle} 共采样 {len(group)} 次。末次采集于 {timestamp(latest['collectedAt'])}，" + "，".join(levels) + "。")
    return {ref: {field: vehicle_reports(group, field) for field in ("exterior", "climate")} for ref, group in samples.items()}


def partner_results(log, vehicles):
    result = []
    states = {"accepted": "服务已受理", "rejected": "服务已拒绝", "unknown": "受理结果未知"}
    for row in rows(log, "vehicleCommands"):
        ref, when, action = row.get("vehicleRef"), row.get("requestedAt"), row.get("action")
        if not isinstance(ref, str) or not ref or not valid_time(when) or not isinstance(action, dict):
            continue
        kind = action.get("kind")
        if kind == "target" and type(action.get("percent")) is int and 1 <= action["percent"] <= 100:
            label = f"设置充电上限 {action['percent']}%"
        elif kind in ACTIONS:
            label = ACTIONS[kind][0]
        else:
            continue
        car = vehicles.setdefault(ref, len(vehicles) + 1)
        status = states.get(row.get("status"), "受理结果未知")
        evidence = ""
        if row.get("status") != "rejected":
            observed, reported = row.get("readbackAt"), row.get("reportedAt")
            fresh = valid_time(reported) and valid_time(observed) and when < reported <= observed <= when + WINDOW_MS
            evidence = "，车辆回读一致" if fresh and row.get("readback") == "回读一致" else "，等待车辆确认"
        result.append(f"{timestamp(when)}  车辆 {car} · Norr {label} · {status}{evidence}")
    return result


def report(log):
    if not isinstance(log, dict) or type(log.get("version")) is not int or log["version"] != 1:
        raise ValueError("不支持的日志版本")
    partner_log = log.get("format") == "norr-ios-session-log" and log.get("vehicleControlTransport") == "norrPartner"
    result = [] if partner_log else ["车控服务回执：未采集（含服务受理和操作结果）"]
    reports = {}
    vehicle_scoped = {}
    vehicles = {}
    if log.get("format") == "norr-ios-session-log" and log.get("vehicleControlTransport") in (None, "norrPartner"):
        events = rows(log, "events")
        notes = [row for row in events if row.get("operation") == "manualObservation"]
        count = sum(row.get("operation") == "readGarage" and row.get("phase") == "completed" for row in events)
        result.append(f"读取车库成功 {count} 次。")
        vehicle_scoped = ios_samples(events, vehicles, result)
        if partner_log:
            result.extend(partner_results(log, vehicles))
        if not vehicle_scoped:
            result.append("本轮未采集可用的车辆门锁或空调读数。")
        clock = "time"
    elif log.get("format") == "norr-p4-test-log":
        notes = rows(log, "testerObservations")
        samples = rows(log, "readings")
        reports = {key: vehicle_reports(samples, key) for key in ("exterior", "climate")}
        result.append(f"共 {len(samples)} 次采样。按车辆上报时间去重后的有效读数："
                      f"门锁 {len({r[0] for r in reports['exterior']})} 条，"
                      f"空调 {len({r[0] for r in reports['climate']})} 条。")
        clock = "recordedAt"
    else:
        raise ValueError("不支持的日志格式或车控通道")

    notes = sorted((row for row in notes if row.get("action") in ACTIONS and valid_time(row.get(clock))),
                   key=lambda row: row[clock])
    if not notes:
        return result if partner_log else result + ["没有门锁或空调启停的人工标记，无法对照单次操作。"]

    for i, row in enumerate(notes):
        label, field, target = ACTIONS[row["action"]]
        time = row[clock]
        source = SOURCES.get(row.get("operationSource"), "操作位置未记录")
        outcome = OUTCOMES.get(row.get("outcome"), "观察结果未识别")
        vehicle = ""
        if clock == "time":
            ref = row.get("vehicleRef")
            vehicle = (f"车辆 {vehicles.setdefault(ref, len(vehicles) + 1)}"
                       if isinstance(ref, str) and ref else "车辆未注明") + " · "
        result.append(f"{timestamp(time)}  {vehicle}{label} · 人工记录（{source}）：{outcome}")
        comparison = vehicle_scoped.get(ref, {}) if clock == "time" and isinstance(ref, str) else reports
        if comparison and row.get("outcome") == "before":
            end = time + WINDOW_MS + 1
            for other in notes[i + 1:]:
                if clock == "time" and other.get("vehicleRef") != ref:
                    continue
                if other.get("outcome") == "before" and ACTIONS[other["action"]][1] == field:
                    end = min(end, other[clock])
                    break
            result.append("  车况：" + readback(comparison[field], time, end, target))
    if reports or vehicle_scoped:
        result.append("车况以准备操作后的十分钟为限，遇到同类下一次准备操作提前截止。状态吻合只说明车辆曾上报该状态。")
    return result


def main():
    parser = argparse.ArgumentParser(description="在本机核对 P4 日志里的门锁和驻车空调证据")
    parser.add_argument("log", type=Path, help="Norr 导出的 JSON 文件")
    args = parser.parse_args()
    try:
        lines = report(json.loads(args.log.read_text(encoding="utf-8-sig")))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"无法读取日志：{exc}\n")
    except TypeError:
        parser.exit(1, "日志字段类型无效\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
