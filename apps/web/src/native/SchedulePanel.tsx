import { useState } from "react";
import { Modal } from "../components/Modal";
import {
  readingText,
  scheduleText,
  timeText,
  unavailableReason,
  weekdayLabels,
} from "./client";
import type { Command, NativeVehicle, Schedule, Snapshot } from "./client";

interface Props {
  kind: "climate" | "charging";
  vehicle: NativeVehicle;
  snapshot?: Snapshot;
  disabled: boolean;
  onCommand: (command: Command) => void;
}

export function SchedulePanel({
  kind,
  vehicle,
  snapshot,
  disabled,
  onCommand,
}: Props) {
  const climate = kind === "climate";
  const endpoint = climate ? "climateTimers" : "chargeTimer";
  const action = climate ? "climateTimer" : "chargeTimer";
  const reading = snapshot?.readings[endpoint];
  const timers = (
    climate
      ? (reading?.value?.timers ?? [])
      : reading?.value?.timer
        ? [reading.value.timer]
        : []
  ) as Schedule[];
  const reason = unavailableReason(vehicle, action);
  const maximum = vehicle.limits.parkingClimatizationMaxNumberOfTimers;
  const full = climate && maximum !== undefined && timers.length >= maximum;
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const repeatSupported =
    vehicle.capabilities.supportsParkingClimatizationRepeatedWeekdayTimers ===
    true;
  const singleWeekdaySupported =
    vehicle.capabilities.supportsParkingClimatizationUnrepeatedWeekdayTimers ===
    true;
  const single24hSupported =
    vehicle.capabilities.supportsParkingClimatization24hTimers === true;
  const editable = !disabled && !reason && reading?.status === "success";
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function edit(schedule?: Schedule) {
    const next = schedule ?? {
      id: null,
      index: null,
      start: climate ? 480 : 1320,
      end: climate ? null : 420,
      weekdays: [],
      active: true,
      repeats: climate ? (repeatSupported ? true : false) : null,
    };
    setEditing(next);
    setStartText(timeText(next.start));
    setEndText(next.end === null ? "" : timeText(next.end));
  }

  function minutes(text: string): number | null {
    if (!/^\d{2}:\d{2}$/.test(text)) return null;
    const [hour, minute] = text.split(":").map(Number);
    return hour < 24 && minute < 60 ? hour * 60 + minute : null;
  }

  const start = minutes(startText);
  const end = minutes(endText);
  const validDays =
    editing &&
    (editing.repeats === true
      ? repeatSupported && editing.weekdays.length > 0
      : editing.repeats === false &&
        (editing.weekdays.length > 0
          ? singleWeekdaySupported
          : single24hSupported));
  const valid =
    start !== null && (climate ? validDays : end !== null && end !== start);

  return (
    <section className="native-section">
      <div className="section-heading">
        <h2>{climate ? "空调日程" : "充电窗口"}</h2>
        <button
          className="secondary-button"
          disabled={!editable || full}
          onClick={() => edit(climate ? undefined : timers[0])}
        >
          {climate
            ? "添加日程"
            : timers.length
              ? "编辑充电窗口"
              : "设置充电窗口"}
        </button>
      </div>
      <p className="muted">{readingText(snapshot, endpoint)}</p>
      {reason && <p className="muted">{reason}</p>}
      {full && (
        <p className="muted">
          已达到车辆返回的 {maximum} 条上限，仍可编辑已有日程。
        </p>
      )}
      {reading?.status === "success" && timers.length === 0 && (
        <p className="muted">
          {climate ? "车辆当前没有空调日程。" : "车辆当前没有全局充电窗口。"}
        </p>
      )}
      {timers.map((timer, index) => (
        <div className="native-setting-row" key={timer.id ?? index}>
          <p>{scheduleText(timer)}</p>
          {climate && (
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={!editable}
                onClick={() => edit(timer)}
              >
                编辑日程
              </button>
              <button
                className="text-button"
                disabled={!editable || !timer.id}
                onClick={() =>
                  onCommand({
                    vin: vehicle.vin,
                    action: "deleteClimateTimer",
                    timerId: timer.id ?? undefined,
                  })
                }
              >
                删除
              </button>
            </div>
          )}
        </div>
      ))}
      {editing && (
        <Modal
          title={
            climate
              ? editing.id
                ? "编辑空调日程"
                : "添加空调日程"
              : "设置充电窗口"
          }
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || start === null) return;
              onCommand({
                vin: vehicle.vin,
                action,
                schedule: { ...editing, start, end: climate ? null : end },
                timezoneOffset: -new Date().getTimezoneOffset(),
              });
              setEditing(null);
            }}
          >
            <p className="modal-description">按本机时区 {zone} 保存。</p>
            <label className="native-field">
              {climate ? "出发时间" : "开始充电"}
              <input
                type="time"
                required
                value={startText}
                onChange={(event) => setStartText(event.target.value)}
              />
            </label>
            {!climate && (
              <label className="native-field">
                结束充电
                <input
                  type="time"
                  required
                  value={endText}
                  onChange={(event) => setEndText(event.target.value)}
                />
              </label>
            )}
            {climate && (
              <>
                <label className="native-field">
                  重复方式
                  <select
                    value={
                      editing.repeats === null ? "" : String(editing.repeats)
                    }
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        repeats: event.target.value === "true",
                        weekdays:
                          event.target.value === "false" &&
                          !singleWeekdaySupported
                            ? []
                            : editing.weekdays,
                      })
                    }
                  >
                    <option value="" disabled>
                      请选择
                    </option>
                    {repeatSupported && <option value="true">每周重复</option>}
                    {(singleWeekdaySupported || single24hSupported) && (
                      <option value="false">一次性</option>
                    )}
                  </select>
                </label>
                {(editing.repeats || singleWeekdaySupported) && (
                  <fieldset className="native-weekdays">
                    <legend>生效星期</legend>
                    {weekdayLabels.map((day, index) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={editing.weekdays.includes(index + 1)}
                          onChange={(event) =>
                            setEditing({
                              ...editing,
                              weekdays: event.target.checked
                                ? [...editing.weekdays, index + 1].sort()
                                : editing.weekdays.filter(
                                    (value) => value !== index + 1,
                                  ),
                            })
                          }
                        />
                        {day}
                      </label>
                    ))}
                  </fieldset>
                )}
                {editing.repeats === false &&
                  single24hSupported &&
                  editing.weekdays.length === 0 && (
                    <p className="muted">在未来 24 小时内执行一次。</p>
                  )}
              </>
            )}
            <label className="native-checkbox">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) =>
                  setEditing({ ...editing, active: event.target.checked })
                }
              />
              启用此日程
            </label>
            {!valid && (
              <p role="status">
                {climate
                  ? "请填写时间，并选择车辆支持的重复方式与星期。"
                  : "开始和结束时间应不同，允许跨越午夜。"}
              </p>
            )}
            <div className="button-row">
              <button className="primary-button" disabled={!valid || !editable}>
                核对并保存
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
