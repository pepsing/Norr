import { useState } from "react";
import { ArrowDownToLine, Plus, Search } from "lucide-react";
import { Modal } from "../components/Modal";
import {
  Bars,
  DataRows,
  EmptyState,
  SectionTabs,
} from "../components/WorkspaceUI";
import { downloadFile, useWorkspace } from "../workspace";
import { CommandHistory } from "./Controls";

function dayAgo(days: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const sessions = [
  {
    id: "charge-1",
    days: 1,
    location: "家庭充电",
    energy: 32.6,
    start: 42,
    end: 90,
    cost: 18.91,
    duration: "8 小时 24 分",
    peak: 7.2,
  },
  {
    id: "charge-2",
    days: 4,
    location: "直流快充",
    energy: 46.2,
    start: 24,
    end: 80,
    cost: 64.68,
    duration: "32 分钟",
    peak: 142,
  },
  {
    id: "charge-3",
    days: 7,
    location: "家庭充电",
    energy: 28.4,
    start: 51,
    end: 90,
    cost: 16.47,
    duration: "7 小时 13 分",
    peak: 7.1,
  },
  {
    id: "charge-4",
    days: 18,
    location: "目的地充电",
    energy: 19.8,
    start: 62,
    end: 85,
    cost: 23.76,
    duration: "3 小时 6 分",
    peak: 11,
  },
];
const trips = [
  {
    id: "trip-1",
    days: 1,
    name: "日常通勤",
    distance: 28.4,
    energy: 4.8,
    duration: 38,
  },
  {
    id: "trip-2",
    days: 3,
    name: "周末出行",
    distance: 126.8,
    energy: 22.1,
    duration: 104,
  },
  {
    id: "trip-3",
    days: 6,
    name: "市区行程",
    distance: 16.2,
    energy: 3.1,
    duration: 31,
  },
  {
    id: "trip-4",
    days: 12,
    name: "城际行程",
    distance: 215.6,
    energy: 38.2,
    duration: 162,
  },
];

export function HistoryPage() {
  const { data, setData, vehicle, distance, setNotice } = useWorkspace();
  const [tab, setTab] = useState("总览");
  const [period, setPeriod] = useState("30");
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(dayAgo(30));
  const [end, setEnd] = useState(dayAgo(0));
  const [sort, setSort] = useState("最新优先");
  const [hidden, setHidden] = useState(false);
  const [selectedCharge, setSelectedCharge] = useState<
    (typeof sessions)[number] | null
  >(null);
  const [selectedTrip, setSelectedTrip] = useState<
    (typeof trips)[number] | null
  >(null);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [liters, setLiters] = useState("");
  const [cost, setCost] = useState("");
  const [odometer, setOdometer] = useState("");
  if (!vehicle) return null;
  const cleared = data.clearedHistory.includes(vehicle.id);
  function inPeriod(days: number) {
    return period === "custom"
      ? dayAgo(days) >= start && dayAgo(days) <= end
      : days < Number(period);
  }
  const charges = cleared
    ? []
    : sessions.filter(
        (s) =>
          inPeriod(s.days) && `${s.location} ${dayAgo(s.days)}`.includes(query),
      );
  const journeys = (
    cleared
      ? []
      : trips.filter(
          (t) =>
            inPeriod(t.days) &&
            t.name.includes(query) &&
            (hidden || !data.hiddenTrips.includes(`${vehicle.id}/${t.id}`)),
        )
  ).sort((a, b) =>
    sort === "里程最多" ? b.distance - a.distance : a.days - b.days,
  );
  const energy = charges.reduce((sum, s) => sum + s.energy, 0);
  const chargeCost = charges.reduce((sum, s) => sum + s.cost, 0);
  const mileage = journeys.reduce((sum, t) => sum + t.distance, 0);
  const consumption = journeys.reduce((sum, t) => sum + t.energy, 0);
  const distanceFactor = data.settings.distance === "mi" ? 1.609344 : 1;
  const efficiencyUnit = `kWh/100 ${data.settings.distance}`;
  const fuel = data.fuel.filter((f) => f.vehicleId === vehicle.id);
  function exportCSV() {
    const rows =
      tab === "行程"
        ? [
            ["日期", "行程", "里程(km)", "电耗(kWh)", "时长(分钟)"],
            ...journeys.map((t) => [
              dayAgo(t.days),
              t.name,
              t.distance,
              t.energy,
              t.duration,
            ]),
          ]
        : [
            ["日期", "充电方式", "充入电量(kWh)", "费用(元)"],
            ...charges.map((s) => [
              dayAgo(s.days),
              s.location,
              s.energy,
              s.cost,
            ]),
          ];
    downloadFile(
      `norr-demo-${tab === "行程" ? "trips" : "charging"}.csv`,
      "\uFEFF" + rows.map((row) => row.join(",")).join("\n"),
      "text/csv;charset=utf-8",
    );
    setNotice("已导出当前筛选范围的示例记录");
  }
  return (
    <>
      <SectionTabs
        items={["总览", "充电", "行程", "费用与加油", "指令"]}
        value={tab}
        onChange={(value) => {
          setTab(value);
          setQuery("");
        }}
        label="历史分类"
      />
      {tab !== "指令" && (
        <div className="history-toolbar">
          <label>
            时间范围
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="90">最近 90 天</option>
              <option value="365">最近一年</option>
              <option value="custom">自定义日期</option>
            </select>
          </label>
          {period === "custom" && (
            <>
              <label>
                开始日期
                <input
                  type="date"
                  value={start}
                  max={end}
                  onInput={(e) => setStart(e.currentTarget.value)}
                />
              </label>
              <label>
                结束日期
                <input
                  type="date"
                  value={end}
                  min={start}
                  max={dayAgo(0)}
                  onInput={(e) => setEnd(e.currentTarget.value)}
                />
              </label>
            </>
          )}
          {["充电", "行程"].includes(tab) && (
            <>
              <label className="search-field">
                <span>
                  <Search size={14} />
                  搜索记录
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tab === "充电" ? "充电方式或日期" : "行程名称"}
                />
              </label>
              <button className="text-button" onClick={exportCSV}>
                <ArrowDownToLine size={17} />
                导出 CSV
              </button>
            </>
          )}
        </div>
      )}
      {tab === "总览" && (
        <>
          <div className="metric-strip">
            <div>
              <span>行驶里程</span>
              <strong>{distance(mileage)}</strong>
            </div>
            <div>
              <span>平均电耗</span>
              <strong>
                {mileage
                  ? ((consumption / mileage) * 100 * distanceFactor).toFixed(1)
                  : "0"}
                <small>{efficiencyUnit}</small>
              </strong>
            </div>
            <div>
              <span>充入电量</span>
              <strong>
                {energy.toFixed(1)}
                <small>kWh</small>
              </strong>
            </div>
          </div>
          {journeys.length ? (
            <div className="split-content">
              <Bars
                title="各次行程里程"
                unit={data.settings.distance}
                values={journeys.map((t) =>
                  Number((t.distance / distanceFactor).toFixed(1)),
                )}
                labels={journeys.map((t) => dayAgo(t.days).slice(5))}
              />
              <Bars
                title="各次行程电耗"
                unit={efficiencyUnit}
                values={journeys.map((t) =>
                  Number(
                    ((t.energy / t.distance) * 100 * distanceFactor).toFixed(1),
                  ),
                )}
                labels={journeys.map((t) => dayAgo(t.days).slice(5))}
              />
            </div>
          ) : (
            <EmptyState title="所选时间内没有行程">
              <p>选择更长的时间范围，或等待设备采集。</p>
            </EmptyState>
          )}
          <div className="sampling-note">
            <h3>采样完整性</h3>
            <p>
              演示记录包含一次离线间断，昨日 02:10 至
              06:30。该时段的状态变化与能耗分配无法确认。
            </p>
          </div>
        </>
      )}
      {tab === "充电" && (
        <>
          <div className="metric-strip">
            <div>
              <span>累计充入</span>
              <strong>
                {energy.toFixed(1)}
                <small>kWh</small>
              </strong>
            </div>
            <div>
              <span>充电次数</span>
              <strong>
                {charges.length}
                <small>次</small>
              </strong>
            </div>
            <div>
              <span>费用合计</span>
              <strong>¥{chargeCost.toFixed(2)}</strong>
            </div>
          </div>
          <div className="record-list">
            {charges.map((session) => (
              <button
                className="record-button"
                key={session.id}
                onClick={() => setSelectedCharge(session)}
              >
                <div>
                  <h3>{session.location}</h3>
                  <p>
                    {dayAgo(session.days)} · {session.duration}
                  </p>
                </div>
                <span>
                  {session.start}% → {session.end}%
                </span>
                <strong>
                  {session.energy}
                  <small> kWh</small>
                </strong>
              </button>
            ))}
          </div>
          {!charges.length && (
            <EmptyState title="没有匹配的充电记录">
              <p>调整日期或搜索词后重试。</p>
            </EmptyState>
          )}
        </>
      )}
      {tab === "行程" && (
        <>
          <div className="history-toolbar">
            <label>
              排列方式
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option>最新优先</option>
                <option>里程最多</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={hidden}
                onChange={(e) => setHidden(e.target.checked)}
              />
              显示已隐藏行程
            </label>
            <button
              className="text-button"
              onClick={() => {
                downloadFile(
                  "norr-demo-mileage-report.csv",
                  "\uFEFF范围,里程(km),行程数\n" +
                    `${period === "custom" ? `${start} 至 ${end}` : `最近${period}天`},${mileage.toFixed(1)},${journeys.length}`,
                  "text/csv;charset=utf-8",
                );
                setNotice("里程报告已导出");
              }}
            >
              导出里程报告
            </button>
          </div>
          {journeys.map((trip) => (
            <div className="trip-row" key={trip.id}>
              <button onClick={() => setSelectedTrip(trip)}>
                <div>
                  <h3>{trip.name}</h3>
                  <p>
                    {dayAgo(trip.days)} · {trip.duration} 分钟
                  </p>
                </div>
                <strong>{distance(trip.distance)}</strong>
              </button>
              <button
                className="text-button"
                onClick={() => {
                  const id = `${vehicle.id}/${trip.id}`;
                  setData((old) => ({
                    ...old,
                    hiddenTrips: old.hiddenTrips.includes(id)
                      ? old.hiddenTrips.filter((t) => t !== id)
                      : [...old.hiddenTrips, id],
                  }));
                }}
              >
                {data.hiddenTrips.includes(`${vehicle.id}/${trip.id}`)
                  ? "恢复"
                  : "隐藏"}
              </button>
            </div>
          ))}
          {!journeys.length && (
            <EmptyState title="没有匹配的行程">
              <p>调整筛选，或开启显示已隐藏行程。</p>
            </EmptyState>
          )}
        </>
      )}
      {tab === "费用与加油" && (
        <>
          <div className="metric-strip">
            <div>
              <span>所选期间充电费用</span>
              <strong>¥{chargeCost.toFixed(2)}</strong>
            </div>
            <div>
              <span>全部手动加油费用</span>
              <strong>
                ¥{fuel.reduce((sum, f) => sum + f.cost, 0).toFixed(2)}
              </strong>
            </div>
          </div>
          <p className="muted">
            充电费用来自示例记录。手动加油记录按全部记录列出。
          </p>
          <div className="section-heading">
            <h2>加油记录</h2>
            <button
              className="text-button"
              disabled={vehicle.brand !== "Volvo"}
              onClick={() => {
                setFuelOpen(true);
                setLiters("");
                setCost("");
                setOdometer(String(vehicle.odometer));
              }}
            >
              <Plus size={17} />
              添加加油
            </button>
          </div>
          {vehicle.brand !== "Volvo" ? (
            <EmptyState title="当前车辆为纯电车型">
              <p>加油记录适用于混动与燃油车辆，可在车库添加 Volvo 示例。</p>
            </EmptyState>
          ) : fuel.length === 0 ? (
            <EmptyState title="还没有加油记录">
              <p>记录加油量、费用与里程。</p>
            </EmptyState>
          ) : (
            fuel.map((entry) => (
              <div className="list-row" key={entry.id}>
                <div>
                  <h3>
                    {entry.liters} L · ¥{entry.cost.toFixed(2)}
                  </h3>
                  <p>里程 {distance(entry.odometer)}</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setData((old) => ({
                      ...old,
                      fuel: old.fuel.filter((f) => f.id !== entry.id),
                    }));
                    setNotice("演示加油记录已删除");
                  }}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </>
      )}
      {tab === "指令" && <CommandHistory />}
      {selectedCharge && (
        <Modal
          title={`${selectedCharge.location}详情`}
          onClose={() => setSelectedCharge(null)}
        >
          <DataRows
            rows={[
              ["日期", dayAgo(selectedCharge.days)],
              ["充入电量", `${selectedCharge.energy} kWh`],
              ["峰值功率", `${selectedCharge.peak} kW`],
              ["充电时长", selectedCharge.duration],
              ["电量变化", `${selectedCharge.start}% → ${selectedCharge.end}%`],
              ["费用", `¥${selectedCharge.cost.toFixed(2)}`],
              ["估算质量", "示例 · 按采样计算"],
            ]}
          />
          <Bars
            title="功率变化示例"
            unit="kW"
            values={[0.4, 0.8, 1, 0.9, 0.5].map((n) =>
              Number((n * selectedCharge.peak).toFixed(1)),
            )}
            labels={["开始", "25%", "50%", "75%", "结束"]}
          />
        </Modal>
      )}
      {selectedTrip && (
        <Modal title={selectedTrip.name} onClose={() => setSelectedTrip(null)}>
          <DataRows
            rows={[
              ["日期", dayAgo(selectedTrip.days)],
              ["里程", distance(selectedTrip.distance)],
              ["时长", `${selectedTrip.duration} 分钟`],
              ["电耗", `${selectedTrip.energy} kWh`],
              [
                "平均电耗",
                `${((selectedTrip.energy / selectedTrip.distance) * 100 * distanceFactor).toFixed(1)} ${efficiencyUnit}`,
              ],
              [
                "位置",
                data.settings.privacy ? "隐私模式已隐藏" : "示例未提供轨迹",
              ],
            ]}
          />
          <Bars
            title="能耗分配示例"
            unit="kWh"
            values={[0.8, 0.12, 0.08].map((n) =>
              Number((n * selectedTrip.energy).toFixed(1)),
            )}
            labels={["行驶", "空调", "其他"]}
          />
        </Modal>
      )}
      {fuelOpen && (
        <Modal title="添加加油记录" onClose={() => setFuelOpen(false)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              setData((old) => ({
                ...old,
                fuel: [
                  ...old.fuel,
                  {
                    id: crypto.randomUUID(),
                    vehicleId: vehicle.id,
                    liters: Number(liters),
                    cost: Number(cost),
                    odometer: Number(odometer),
                  },
                ],
              }));
              setFuelOpen(false);
              setNotice("演示加油记录已保存");
            }}
          >
            <label>
              加油量（L）
              <input
                required
                type="number"
                min="0.1"
                max="150"
                step="0.1"
                value={liters}
                onChange={(e) => setLiters(e.target.value)}
              />
            </label>
            <label>
              费用（元）
              <input
                required
                type="number"
                min="0"
                max="10000"
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </label>
            <label>
              里程表（km）
              <input
                required
                type="number"
                min="0"
                step="1"
                value={odometer}
                onChange={(e) => setOdometer(e.target.value)}
              />
            </label>
            <button className="primary-button">保存加油记录</button>
          </form>
        </Modal>
      )}
      <p className="page-note">
        所有记录均为本地演示数据。各设备的实际历史取决于采样时间。
      </p>
    </>
  );
}
