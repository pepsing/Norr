import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { EnergyPanel } from "../components/EnergyPanel";
import { Modal } from "../components/Modal";
import {
  Bars,
  DataRows,
  EmptyState,
  ScheduleList,
  SectionTabs,
} from "../components/WorkspaceUI";
import { capabilityReason, supports, useWorkspace } from "../workspace";
import type { ChargeLocation } from "../workspace";

export function Charging({ onLimit }: { onLimit: () => void }) {
  const { vehicle, data, setData, busy, scenario, command, setNotice } =
    useWorkspace();
  const [tab, setTab] = useState("充电状态");
  const [editing, setEditing] = useState<ChargeLocation | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [departure, setDeparture] = useState("07:00");
  const [target, setTarget] = useState(90);
  if (!vehicle) return null;
  const allowed =
    supports(vehicle, "charge") && !busy && scenario === "connected";
  const locationsAllowed =
    supports(vehicle, "chargeLocation") && !busy && scenario === "connected";
  const locations = data.locations.filter((l) => l.vehicleId === vehicle.id);
  const needed = (Math.max(0, target - vehicle.battery) / 100) * 100;
  const prices = [0.82, 0.74, 0.52, 0.38, 0.36, 0.42, 0.56, 0.78];
  const durationHours = Math.max(1, Math.ceil(needed / 7.2));
  const departureHour = Number(departure.split(":")[0]);
  const availableHours =
    departureHour < 20 ? departureHour + 4 : departureHour - 20;
  const windowCount = Math.min(prices.length, availableHours);
  let cheapestStart = 0;
  let cheapestCost = Infinity;
  for (let start = 0; start + durationHours <= windowCount; start++) {
    const average =
      prices
        .slice(start, start + durationHours)
        .reduce((sum, price) => sum + price, 0) / durationHours;
    if (average < cheapestCost) {
      cheapestCost = average;
      cheapestStart = start;
    }
  }
  const startTime = `${String((20 + cheapestStart) % 24).padStart(2, "0")}:00`;
  const finishTime = `${String((20 + cheapestStart + durationHours) % 24).padStart(2, "0")}:00`;
  const canPlan = needed > 0 && Number.isFinite(cheapestCost);
  return (
    <>
      <SectionTabs
        items={["充电状态", "计划与地点", "费用与优化"]}
        value={tab}
        onChange={setTab}
        label="充电分类"
      />
      {tab === "充电状态" && (
        <div className="charging-layout">
          <EnergyPanel
            vehicle={vehicle}
            busy={busy}
            unavailable={!allowed}
            onSettings={onLimit}
            onToggleCharge={() =>
              command(vehicle.charging ? "暂停充电" : "继续充电", "charge", {
                charging: !vehicle.charging,
              })
            }
          />
          <section className="charge-details">
            <h2>本次充电</h2>
            <DataRows
              rows={[
                ["连接状态", "充电线已连接"],
                ["充电方式", "交流充电"],
                ["当前功率", vehicle.charging ? "7.2 kW" : "0.0 kW"],
                [
                  "电压 / 电流",
                  vehicle.charging
                    ? "230 V / 31.3 A · 演示"
                    : "230 V / 0 A · 演示",
                ],
                ["本次充入", "18.4 kWh"],
                ["费用估算", `¥${(18.4 * data.settings.rate).toFixed(2)}`],
                ["充电上限", `${vehicle.chargeLimit}%`],
              ]}
            />
            <div className="list-row">
              <div>
                <h3>电流限制</h3>
                <p>设备上报的充电电流限制 · 示例</p>
              </div>
              <button
                className="text-button"
                disabled={!allowed}
                onClick={() => setCurrent(vehicle.currentLimit)}
              >
                {vehicle.currentLimit} A · 调整
              </button>
            </div>
            <Bars
              title="本次充电功率"
              unit="kW"
              values={[3.2, 6.4, 7.2, 7.1, 7.2, vehicle.charging ? 7.2 : 0]}
              labels={["开始", "+10分", "+20分", "+30分", "+40分", "当前"]}
            />
            <p className="muted">
              曲线与读数为演示数据，费用按设置中的电价估算。
            </p>
          </section>
        </div>
      )}
      {tab === "计划与地点" && (
        <>
          <ScheduleList kind="充电" />
          <section className="content-section">
            <div className="section-heading">
              <h2>保存的充电地点</h2>
              <button
                className="text-button"
                disabled={!locationsAllowed}
                onClick={() =>
                  setEditing({
                    id: crypto.randomUUID(),
                    vehicleId: vehicle.id,
                    name: "",
                    current: 16,
                    minimum: 50,
                    optimized: false,
                  })
                }
              >
                <Plus size={17} />
                添加地点
              </button>
            </div>
            {!supports(vehicle, "chargeLocation") && (
              <p className="muted">
                {capabilityReason(vehicle, "chargeLocation")}
              </p>
            )}
            {!locations.length && (
              <EmptyState title="还没有充电地点">
                <p>保存地点名称、电流限制与最低电量。</p>
              </EmptyState>
            )}
            {locations.map((location) => (
              <div className="list-row" key={location.id}>
                <div>
                  <h3>{location.name}</h3>
                  <p>
                    {location.current} A · 最低电量 {location.minimum}% ·{" "}
                    {location.optimized ? "优化充电" : "立即充电"}
                  </p>
                </div>
                <button
                  className="text-button"
                  disabled={!locationsAllowed}
                  onClick={() => setEditing({ ...location })}
                >
                  编辑地点
                </button>
              </div>
            ))}
          </section>
        </>
      )}
      {tab === "费用与优化" && (
        <div className="split-content">
          <section>
            <h2>充电费用</h2>
            <DataRows
              rows={[
                ["电价", `¥${data.settings.rate.toFixed(2)} / kWh`],
                ["本次费用估算", `¥${(18.4 * data.settings.rate).toFixed(2)}`],
                ["计算依据", "18.4 kWh × 电价"],
              ]}
            />
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                setNotice("电价已更新，费用估算已重算");
              }}
            >
              <label>
                固定电价（元 / kWh）
                <input
                  required
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={data.settings.rate}
                  onChange={(e) => {
                    const rate = Number(e.target.value);
                    if (Number.isFinite(rate) && rate >= 0 && rate <= 100)
                      setData((old) => ({
                        ...old,
                        settings: { ...old.settings, rate },
                      }));
                  }}
                />
              </label>
              <button className="secondary-button">保存电价</button>
            </form>
          </section>
          <section>
            <h2>低价时段规划</h2>
            <p className="muted">
              以今晚 20:00 为起点，按示例电价、100 kWh 容量和 7.2 kW 功率估算。
            </p>
            <Bars
              title="每小时示例电价"
              unit="元"
              values={prices}
              labels={[
                "20时",
                "21时",
                "22时",
                "23时",
                "00时",
                "01时",
                "02时",
                "03时",
              ]}
            />
            <div className="form-grid">
              <label>
                出发时间
                <input
                  type="time"
                  value={departure}
                  onInput={(e) => setDeparture(e.currentTarget.value)}
                />
              </label>
              <label>
                目标电量
                <select
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                >
                  {[80, 90, 100].map((value) => (
                    <option key={value} value={value}>
                      {value}%
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="planner-result">
              <h3>
                {canPlan
                  ? `${startTime} 至 ${finishTime}`
                  : needed === 0
                    ? "当前电量已达到目标"
                    : "可用电价时段内无法完成"}
              </h3>
              <p>
                {canPlan
                  ? `预计充入 ${needed.toFixed(1)} kWh · 约 ¥${(needed * cheapestCost).toFixed(2)}`
                  : "可调整出发时间或目标电量。"}
              </p>
            </div>
            <p className="muted">保存后将停用当前车辆的其他充电计划。</p>
            <button
              className="primary-button"
              disabled={
                !allowed || !supports(vehicle, "chargeSchedule") || !canPlan
              }
              onClick={() => {
                setData((old) => ({
                  ...old,
                  schedules: [
                    ...old.schedules
                      .filter((s) => s.id !== `optimized-${vehicle.id}`)
                      .map((s) =>
                        s.vehicleId === vehicle.id && s.kind === "充电"
                          ? { ...s, enabled: false }
                          : s,
                      ),
                    {
                      id: `optimized-${vehicle.id}`,
                      vehicleId: vehicle.id,
                      kind: "充电",
                      time: startTime,
                      end: finishTime,
                      days: ["一", "二", "三", "四", "五", "六", "日"],
                      enabled: true,
                      target,
                      confirmation: "accepted",
                    },
                  ],
                }));
                setNotice("模拟服务已接受充电窗口，目标字段等待回读确认");
                setTab("计划与地点");
              }}
            >
              保存为每日计划
            </button>
          </section>
        </div>
      )}
      {!supports(vehicle, "charge") && (
        <p className="capability-note">{capabilityReason(vehicle, "charge")}</p>
      )}
      {current !== null && (
        <Modal title="充电电流限制" onClose={() => setCurrent(null)}>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              await command("设置充电电流", "charge", {
                currentLimit: current,
              });
              setCurrent(null);
            }}
          >
            <div className="limit-readout">
              <output>
                {current}
                <span>A</span>
              </output>
            </div>
            <label>
              最大电流
              <input
                type="range"
                min={6}
                max={16}
                value={current}
                onChange={(e) => setCurrent(Number(e.target.value))}
              />
            </label>
            <div className="limit-presets">
              {[6, 8, 10, 13, 16].map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={current === value}
                  onClick={() => setCurrent(value)}
                >
                  {value} A
                </button>
              ))}
            </div>
            <button className="primary-button" disabled={!allowed}>
              保存电流限制
            </button>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title="充电地点" onClose={() => setEditing(null)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!locationsAllowed || !editing.name.trim()) return;
              setData((old) => ({
                ...old,
                locations: [
                  ...old.locations.filter((l) => l.id !== editing.id),
                  { ...editing, name: editing.name.trim() },
                ],
              }));
              setEditing(null);
              setNotice("充电地点已保存");
            }}
          >
            <label>
              地点名称
              <input
                required
                maxLength={40}
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label>
              电流限制（A）
              <input
                type="number"
                required
                min={6}
                max={16}
                value={editing.current}
                onChange={(e) =>
                  setEditing({ ...editing, current: Number(e.target.value) })
                }
              />
            </label>
            <label>
              最低充电量（%）
              <input
                type="number"
                required
                min={20}
                max={100}
                step={5}
                value={editing.minimum}
                onChange={(e) =>
                  setEditing({ ...editing, minimum: Number(e.target.value) })
                }
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editing.optimized}
                onChange={(e) =>
                  setEditing({ ...editing, optimized: e.target.checked })
                }
              />
              启用优化充电
            </label>
            <button className="primary-button" disabled={!locationsAllowed}>
              保存地点
            </button>
            {locations.some((l) => l.id === editing.id) && (
              <button
                type="button"
                className="text-button danger-text"
                disabled={!locationsAllowed}
                onClick={() => {
                  setData((old) => ({
                    ...old,
                    locations: old.locations.filter((l) => l.id !== editing.id),
                  }));
                  setEditing(null);
                  setNotice("充电地点已删除");
                }}
              >
                <Trash2 size={16} />
                删除地点
              </button>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}
