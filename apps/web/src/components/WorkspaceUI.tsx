import { useState } from "react";
import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { capabilityReason, supports, useWorkspace } from "../workspace";
import type { Schedule } from "../workspace";

export function SectionTabs({
  items,
  value,
  onChange,
  label,
}: {
  items: string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="section-tabs" role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item}
          aria-pressed={value === item}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export function DataRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="inline-empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Confirmation({
  title,
  children,
  confirm,
  onClose,
  onConfirm,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-description">{children}</div>
      <div className="button-row">
        <button className="primary-button" disabled={busy} onClick={onConfirm}>
          {busy ? "处理中…" : confirm}
        </button>
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}

export function ScheduleList({ kind }: { kind: Schedule["kind"] }) {
  const {
    data,
    vehicle,
    busy,
    scenario,
    saveSchedule,
    deleteSchedule,
    readSchedules,
  } = useWorkspace();
  const [editing, setEditing] = useState<Schedule | null>(null);
  if (!vehicle) return null;
  const capability = kind === "充电" ? "chargeSchedule" : "climateSchedule";
  const allowed =
    supports(vehicle, capability) && scenario === "connected" && !busy;
  const schedules = data.schedules.filter(
    (s) => s.vehicleId === vehicle.id && s.kind === kind,
  );
  const read = vehicle.scheduleReads?.[kind] ?? {
    status: schedules.length ? "cached" : "unrequested",
    observedAt: 0,
  };
  const complete = read.status === "success" && scenario === "connected";
  const readLabels = {
    unrequested: "尚未读取定时列表",
    failed: "读取失败，保留上次记录",
    cached: "正在显示缓存记录",
    partial:
      kind === "充电"
        ? "全局窗口已读取，地点日程读取失败，完整列表待核对"
        : "仅读取到部分记录，完整列表待核对",
    success:
      kind === "充电" ? "全局与地点日程已完整读取" : "空调定时列表已读取",
  };
  function save() {
    if (!editing || !allowed) return;
    saveSchedule(editing);
    setEditing(null);
  }
  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>{kind === "空调" ? "出发前预调节" : "充电计划"}</h2>
        <button
          className="text-button"
          disabled={!allowed}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              vehicleId: vehicle.id,
              kind,
              time: kind === "充电" ? "23:00" : "07:30",
              end: "07:00",
              days: ["一", "二", "三", "四", "五"],
              enabled: true,
            })
          }
        >
          <Plus size={17} />
          添加计划
        </button>
      </div>
      <div className="list-row">
        <div>
          <p>
            {scenario === "connected"
              ? readLabels[read.status]
              : "连接不可用，显示本地缓存"}{" "}
            · 演示
          </p>
          {read.observedAt > 0 && (
            <p className="muted">
              上次完整读取{" "}
              {new Date(read.observedAt).toLocaleTimeString("zh-CN")}
            </p>
          )}
        </div>
        <button
          className="text-button"
          disabled={
            busy || scenario !== "connected" || !supports(vehicle, capability)
          }
          onClick={() => readSchedules(kind)}
        >
          读取定时列表
        </button>
      </div>
      {!supports(vehicle, capability) && (
        <p className="muted">{capabilityReason(vehicle, capability)}</p>
      )}
      {schedules.length === 0 && (
        <EmptyState title={complete ? "已确认没有计划" : "尚无可显示的计划"}>
          <p>
            {complete
              ? "本次完整读取返回空列表。可添加新的重复计划。"
              : "取得完整列表后，可确认是否设置过计划。"}
          </p>
        </EmptyState>
      )}
      {schedules.map((schedule) => (
        <div className="list-row" key={schedule.id}>
          <div>
            <h3>
              {schedule.time}
              {kind === "充电" && ` 至 ${schedule.end}`}
            </h3>
            <p>
              每周{schedule.days.join("、")}
              {schedule.target !== undefined && ` · 目标 ${schedule.target}%`}
              {kind === "空调" && " · 出发时间"}
            </p>
            {schedule.confirmation && (
              <p className="muted">
                {schedule.confirmation === "deleting"
                  ? "删除已提交 · 等待完整列表回读"
                  : "服务已接受 · 目标字段待回读确认"}
              </p>
            )}
          </div>
          <div className="row-actions">
            <button
              className="switch"
              role="switch"
              aria-label={`${schedule.time} ${kind}计划`}
              aria-checked={schedule.enabled}
              disabled={!allowed || schedule.confirmation === "deleting"}
              onClick={() =>
                saveSchedule({ ...schedule, enabled: !schedule.enabled })
              }
            >
              <span />
            </button>
            <button
              className="text-button"
              disabled={!allowed || schedule.confirmation === "deleting"}
              onClick={() => setEditing({ ...schedule })}
            >
              编辑
            </button>
          </div>
        </div>
      ))}
      {editing && (
        <Modal title={`编辑${kind}计划`} onClose={() => setEditing(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
            className="form-stack"
          >
            <label>
              {kind === "充电" ? "开始时间" : "出发时间"}
              <input
                required
                type="time"
                value={editing.time}
                onInput={(e) =>
                  setEditing({ ...editing, time: e.currentTarget.value })
                }
              />
            </label>
            {kind === "充电" && (
              <label>
                结束时间
                <input
                  required
                  type="time"
                  value={editing.end}
                  onInput={(e) =>
                    setEditing({ ...editing, end: e.currentTarget.value })
                  }
                />
              </label>
            )}
            <fieldset>
              <legend>重复日期</legend>
              <div className="day-picker">
                {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                  <button
                    type="button"
                    key={day}
                    aria-pressed={editing.days.includes(day)}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        days: editing.days.includes(day)
                          ? editing.days.filter((d) => d !== day)
                          : [...editing.days, day],
                      })
                    }
                  >
                    {day}
                  </button>
                ))}
              </div>
            </fieldset>
            {editing.days.length === 0 && <p role="alert">至少选择一天。</p>}
            <p className="muted">
              时间按设备本地时区解释
              {kind === "充电" && "，结束时间早于开始时间时跨至次日"}
              。演示计划保存在此浏览器中。
            </p>
            <button
              className="primary-button"
              disabled={!allowed || !editing.days.length}
            >
              保存计划
            </button>
            {schedules.some((s) => s.id === editing.id) && (
              <button
                className="text-button danger-text"
                type="button"
                disabled={!allowed}
                onClick={async () => {
                  await deleteSchedule(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={16} />
                删除计划
              </button>
            )}
          </form>
        </Modal>
      )}
    </section>
  );
}

export function Bars({
  title,
  unit,
  values,
  labels,
}: {
  title: string;
  unit: string;
  values: number[];
  labels: string[];
}) {
  const [selected, setSelected] = useState(0);
  const maximum = Math.max(...values, 1);
  const index = Math.min(selected, values.length - 1);
  return (
    <figure className="chart-figure">
      <figcaption>
        <span>{title}</span>
        <strong>
          {labels[index]} · {values[index]} {unit}
        </strong>
      </figcaption>
      <div className="chart-axis">
        <span>{maximum}</span>
        <span>0</span>
      </div>
      <div className="bar-chart">
        {values.map((value, i) => (
          <button
            key={i}
            aria-label={`${labels[i]}，${value} ${unit}`}
            aria-pressed={index === i}
            onClick={() => setSelected(i)}
          >
            <span
              className="bar-column"
              style={{ height: `${Math.max((value / maximum) * 100, 2)}%` }}
            />
            <span className="bar-label">{labels[i]}</span>
          </button>
        ))}
      </div>
    </figure>
  );
}
