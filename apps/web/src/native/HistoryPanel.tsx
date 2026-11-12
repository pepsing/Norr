import { isMobile, isWindows } from "./platform";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight } from "lucide-react";
import { Modal } from "../components/Modal";
import { DataRows, EmptyState, SectionTabs } from "../components/WorkspaceUI";
import { HistoryTrend } from "./HistoryTrend";
import { actionLabels, native } from "./client";
import type { HistoryReport, ImportSummary } from "./client";

const categoryLabels: Record<string, string> = {
  snapshot: "Norr 采集",
  receipt: "Norr 指令",
  telemetry_logs: "旧车辆采样",
  remote_commands_log: "旧指令",
  charging_sessions: "充电会话",
  charging_samples: "充电采样",
  battery_health_history: "电池健康",
  air_quality_history: "空气质量",
  tyre_pressure_history: "胎压",
  vehicle_warning_events: "车辆告警",
  connectivity_history: "连接记录",
  cabin_climate_history: "座舱温度",
  fuel_entries: "燃油记录",
  trip_tags: "行程标签",
  vehicle_activity: "车辆活动",
};
const historyTabs: Record<string, string> = {
  overview: "总览",
  charging: "充电",
  trips: "行程",
  commands: "指令",
  samples: "采集",
};
const statusLabels: Record<string, string> = {
  acknowledged: "服务已接受",
  confirmed: "旧应用已确认",
  confirmation_timed_out: "状态确认超时",
  accepted: "服务已接受",
  delivered: "已送达",
  completed: "服务报告已完成",
  rejected: "已拒绝",
  unknown: "结果待核对",
  success: "成功",
  succeeded: "成功",
  failure: "失败",
  failed: "失败",
  active: "进行中",
  paused: "已暂停",
  pending_completion: "待结束确认",
  interrupted: "已中断",
  abandoned: "记录已中断",
};
const legacyActionLabels: Record<string, string> = {
  "start-climate": actionLabels.climateStart,
  "stop-climate": actionLabels.climateStop,
  "start-precleaning": actionLabels.cleanStart,
  "stop-precleaning": actionLabels.cleanStop,
  "lock-reduced-guard": "降低警戒并锁车",
  "unlock-trunk": actionLabels.unlockTrunk,
  "open-tailgate": actionLabels.tailgateOpen,
  "close-tailgate": actionLabels.tailgateClose,
  "open-windows": actionLabels.windowsOpen,
  "close-windows": actionLabels.windowsClose,
  "flash-lights": actionLabels.flash,
  "honk-flash": actionLabels.honkFlash,
  "honk-horn": "鸣笛",
  "set-charge-target": actionLabels.target,
  "set-amp-limit": actionLabels.amperage,
  "start-charge-override": actionLabels.chargeStart,
  "stop-charge-override": actionLabels.chargeStop,
  "set-charge-timer": actionLabels.chargeTimer,
  "set-climate-timer": actionLabels.climateTimer,
  "delete-climate-timer": actionLabels.deleteClimateTimer,
  "schedule-ota": actionLabels.otaSchedule,
  "install-ota": actionLabels.otaInstall,
  "cancel-ota": actionLabels.otaCancel,
  "create-charge-location": "添加充电地点",
  "rename-charge-location": "重命名充电地点",
  "set-location-amp-limit": "设置地点电流上限",
  "set-location-min-soc": "设置地点最低电量",
  "set-location-optimised-charging": "设置地点优化充电",
  "delete-charge-location": "删除充电地点",
  "start-engine": "启动发动机",
  "stop-engine": "停止发动机",
};
const sourceLabel = (source: string) =>
  source === "hisingen" ? "Hisingen" : "Norr";
const chargeStatusLabels: Record<string, string> = {
  active: "进行中",
  completed: "已结束",
  paused: "已暂停",
  interrupted: "记录中断",
  pending_completion: "待结束确认",
  abandoned: "记录中断",
};
const stamp = (time: number) =>
  new Date(time).toLocaleString("zh-CN", { hour12: false });
const valueText = (value: number | null | undefined, unit = "") =>
  value == null
    ? "未返回"
    : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit}`;

function dayText(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function HistoryPanel({
  vin,
  revision,
}: {
  vin: string;
  revision: number;
}) {
  const [selectedVin, setSelectedVin] = useState(vin);
  const [period, setPeriod] = useState("30");
  const [startDay, setStartDay] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 29);
    return dayText(date);
  });
  const [endDay, setEndDay] = useState(() => dayText(new Date()));
  const [report, setReport] = useState<HistoryReport>();
  const [tab, setTab] = useState("overview");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [selectedCharge, setSelectedCharge] = useState<
    HistoryReport["charging"][number] | null
  >(null);
  const [selectedTrip, setSelectedTrip] = useState<
    HistoryReport["trips"][number] | null
  >(null);
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const start = startDay ? new Date(`${startDay}T00:00:00`).getTime() : 0;
  const endDate = new Date(`${endDay}T00:00:00`);
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.getTime();
  const validRange =
    Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < end;

  useEffect(() => {
    setSelectedVin(vin);
  }, [vin]);
  useEffect(() => {
    setPage(0);
  }, [tab, selectedVin, startDay, endDay]);
  useEffect(() => {
    const id = ++request.current;
    if (!validRange) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setReport(undefined);
    setError("");
    void native
      .historyReport(selectedVin, start, end)
      .then((next) => {
        if (request.current !== id) return;
        setReport(next);
        if (!selectedVin && next.vehicles.length)
          setSelectedVin(next.vehicles[0]);
      })
      .catch((problem: unknown) => {
        if (request.current === id) setError(String(problem));
      })
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
    return () => {
      if (request.current === id) request.current++;
    };
  }, [selectedVin, start, end, validRange, revision, reload]);

  async function prepare(source: "hisingen" | "backup") {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const next = await native.previewHistoryImport(source);
      if (next) {
        setManagementOpen(false);
        setPreview(next);
      }
    } catch (problem) {
      setError(String(problem));
    } finally {
      setWorking(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setWorking(true);
    setError("");
    try {
      const result = await native.commitHistoryImport(preview.token);
      setPreview(null);
      setNotice(
        `导入完成，新增 ${result.added} 条，合并重复 ${result.duplicates} 条。`,
      );
      setReload((value) => value + 1);
    } catch (problem) {
      setError(String(problem));
    } finally {
      setWorking(false);
    }
  }

  function cancel() {
    if (working || !preview) return;
    const token = preview.token;
    setPreview(null);
    void native
      .cancelHistoryImport(token)
      .catch((problem: unknown) => setError(String(problem)));
  }

  async function exportFile(format: "csv" | "json") {
    setWorking(true);
    setError("");
    try {
      if (await native.exportHistory(selectedVin, format))
        setNotice(format === "csv" ? "采集 CSV 已保存" : "历史备份已保存");
    } catch (problem) {
      setError(String(problem));
    } finally {
      setWorking(false);
    }
  }

  const total = Object.values(report?.counts ?? {}).reduce(
    (sum, count) => sum + count,
    0,
  );
  const list =
    tab === "charging"
      ? report?.charging
      : tab === "trips"
        ? report?.trips
        : tab === "commands"
          ? report?.commands
          : report?.samples;
  const rows = list?.length ?? 0;
  const vehicles = Array.from(
    new Set([selectedVin, ...(report?.vehicles ?? [])]),
  ).filter(Boolean);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows / 50) - 1));
  const from = currentPage * 50;
  const costs = new Map<string, { total: number; count: number }>();
  const energyValues = (report?.charging ?? []).flatMap((session) =>
    session.energyKwh === null ? [] : [session.energyKwh],
  );
  for (const session of report?.charging ?? []) {
    if (session.cost === null) continue;
    const currency = session.currency || "未标注币种";
    const previous = costs.get(currency) ?? { total: 0, count: 0 };
    costs.set(currency, {
      total: previous.total + session.cost,
      count: previous.count + 1,
    });
  }
  const energy = energyValues.length
    ? energyValues.reduce((sum, value) => sum + value, 0)
    : null;
  const distance = report?.trips.length
    ? report.trips.reduce((sum, trip) => sum + trip.km, 0)
    : null;

  return (
    <div className="native-history">
      <SectionTabs
        items={Object.values(historyTabs)}
        value={historyTabs[tab]}
        onChange={(label) =>
          setTab(
            Object.keys(historyTabs).find(
              (key) => historyTabs[key] === label,
            ) ?? "overview",
          )
        }
        label="历史分类"
      />
      <div className="native-history-toolbar">
        <div className="native-history-filters">
          <label>
            时间范围
            <select
              value={period}
              onChange={(event) => {
                const value = event.target.value;
                setPeriod(value);
                if (value === "custom") return;
                const date = new Date();
                setEndDay(dayText(date));
                if (value !== "all")
                  date.setDate(date.getDate() - Number(value) + 1);
                setStartDay(value === "all" ? "" : dayText(date));
              }}
            >
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="90">最近 90 天</option>
              <option value="all">全部日期</option>
              <option value="custom">自定义日期</option>
            </select>
          </label>
          {vehicles.length > 1 && (
            <label>
              历史车辆
              <select
                value={selectedVin}
                onChange={(event) => setSelectedVin(event.target.value)}
              >
                {!selectedVin && <option value="">请选择车辆</option>}
                {vehicles.map((vehicleVin) => (
                  <option key={vehicleVin} value={vehicleVin}>
                    VIN ···· {vehicleVin.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {period === "custom" && (
            <>
              <label>
                开始日期
                <input
                  type="date"
                  value={startDay}
                  max={endDay}
                  onChange={(event) => setStartDay(event.target.value)}
                />
              </label>
              <label>
                结束日期
                <input
                  type="date"
                  value={endDay}
                  min={startDay}
                  onChange={(event) => setEndDay(event.target.value)}
                />
              </label>
            </>
          )}
        </div>
        <button
          className="text-button native-history-manage"
          onClick={() => {
            setNotice("");
            setManagementOpen(true);
          }}
        >
          <ArrowDownToLine size={16} aria-hidden="true" /> 数据管理
        </button>
      </div>
      {!validRange && (
        <p role="alert">请选择有效日期，结束日期应晚于或等于开始日期。</p>
      )}
      {error && !preview && !managementOpen && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && !report && !loading && (
        <button
          className="text-button"
          onClick={() => setReload((value) => value + 1)}
        >
          重试读取
        </button>
      )}
      {loading ? (
        <p role="status">正在读取历史记录</p>
      ) : (
        validRange &&
        report && (
          <>
            {total === 0 ? (
              <EmptyState title="这段时间暂无记录">
                <p>选择更长的时间范围，或等待车辆上报。</p>
              </EmptyState>
            ) : (
              <>
                {tab === "overview" && (
                  <>
                    <div className="metric-strip">
                      <div>
                        <span>已记录行驶</span>
                        <strong>
                          {distance === null ? "暂无" : valueText(distance)}
                          {distance !== null && <small>km</small>}
                        </strong>
                      </div>
                      <div>
                        <span>已记录充入</span>
                        <strong>
                          {energy === null ? "暂无" : valueText(energy)}
                          {energy !== null && <small>kWh</small>}
                        </strong>
                      </div>
                      <div>
                        <span>车辆采集</span>
                        <strong>
                          {report.samples.length.toLocaleString("zh-CN")}
                          <small>次</small>
                        </strong>
                      </div>
                    </div>
                    <div className="native-history-trends">
                      <HistoryTrend
                        title="电量趋势"
                        points={report.battery}
                        unit="%"
                      />
                      <HistoryTrend
                        title="里程趋势"
                        points={report.odometer}
                        unit="km"
                      />
                    </div>
                    <details className="native-history-method">
                      <summary>所选日期内共 {total} 条历史记录</summary>
                      <dl className="native-details">
                        {Object.entries(report.counts).map(
                          ([category, count]) => (
                            <div key={category}>
                              <dt>{categoryLabels[category] ?? category}</dt>
                              <dd>{count} 条</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </details>
                  </>
                )}
                {tab === "charging" && (
                  <section>
                    {report.charging.length === 0 ? (
                      <EmptyState title="暂无充电记录">
                        <p>充电期间保持 Norr 运行，上报数据将汇成充电记录。</p>
                      </EmptyState>
                    ) : (
                      <>
                        <div className="metric-strip">
                          <div>
                            <span>已记录充入</span>
                            <strong>
                              {energy === null ? "未知" : valueText(energy)}
                              {energy !== null && <small>kWh</small>}
                            </strong>
                          </div>
                          <div>
                            <span>充电记录</span>
                            <strong>
                              {report.charging.length}
                              <small>次</small>
                            </strong>
                          </div>
                          <div>
                            <span>有电量读数</span>
                            <strong>
                              {energyValues.length}
                              <small>次</small>
                            </strong>
                          </div>
                        </div>
                        <div className="record-list">
                          {report.charging
                            .slice(from, from + 50)
                            .map((session) => (
                              <button
                                className="record-button native-history-record"
                                key={`${session.source}-${session.id}`}
                                onClick={() => setSelectedCharge(session)}
                              >
                                <div>
                                  <h3>{session.location || "充电记录"}</h3>
                                  <p>
                                    {stamp(session.start)} ·{" "}
                                    {session.status
                                      ? (chargeStatusLabels[session.status] ??
                                        session.status)
                                      : "状态未知"}
                                  </p>
                                </div>
                                <span>
                                  {valueText(session.startPercent, "%")} →{" "}
                                  {valueText(session.endPercent, "%")}
                                </span>
                                <strong>
                                  {valueText(session.energyKwh)}
                                  {session.energyKwh !== null && (
                                    <small> kWh</small>
                                  )}{" "}
                                  <ArrowUpRight size={16} aria-hidden="true" />
                                </strong>
                              </button>
                            ))}
                        </div>
                      </>
                    )}
                    <details className="native-history-method">
                      <summary>记录说明</summary>
                      <p>
                        Norr 按车辆上报推算充电片段，采样间隔超过 10
                        分钟时另起一段。详情中的电量包含估算方法和采样覆盖率。
                      </p>
                      {Array.from(costs, ([currency, cost]) => (
                        <p key={currency}>
                          已有估算费用 {valueText(cost.total)} {currency} ·{" "}
                          {cost.count} 条会话
                        </p>
                      ))}
                    </details>
                  </section>
                )}
                {tab === "trips" && (
                  <section>
                    {report.trips.length === 0 ? (
                      <EmptyState title="暂无行程记录">
                        <p>采样尚不足以形成行程，后续里程变化将汇成记录。</p>
                      </EmptyState>
                    ) : (
                      <>
                        <div className="metric-strip">
                          <div>
                            <span>已记录行驶</span>
                            <strong>
                              {valueText(distance)}
                              <small>km</small>
                            </strong>
                          </div>
                          <div>
                            <span>行程片段</span>
                            <strong>
                              {report.trips.length}
                              <small>段</small>
                            </strong>
                          </div>
                          <div>
                            <span>采样时长合计</span>
                            <strong>
                              {valueText(
                                report.trips.reduce(
                                  (sum, trip) => sum + trip.end - trip.start,
                                  0,
                                ) / 60000,
                              )}
                              <small>分钟</small>
                            </strong>
                          </div>
                        </div>
                        {report.trips.slice(from, from + 50).map((trip) => (
                          <button
                            className="record-button native-history-record"
                            key={`${trip.start}-${trip.end}`}
                            onClick={() => setSelectedTrip(trip)}
                          >
                            <div>
                              <h3>
                                {new Date(trip.start).toLocaleDateString(
                                  "zh-CN",
                                )}
                              </h3>
                              <p>
                                {new Date(trip.start).toLocaleTimeString(
                                  "zh-CN",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    hour12: false,
                                  },
                                )}{" "}
                                出发
                              </p>
                            </div>
                            <span>
                              {valueText(
                                (trip.end - trip.start) / 60000,
                                " 分钟",
                              )}
                            </span>
                            <strong>
                              {valueText(trip.km)}
                              <small> km</small>{" "}
                              <ArrowUpRight size={16} aria-hidden="true" />
                            </strong>
                          </button>
                        ))}
                      </>
                    )}
                    <details className="native-history-method">
                      <summary>记录说明</summary>
                      <p>
                        根据里程采样推算，超过 45
                        分钟的采样间隔另起一段。显示时长为首尾采样间隔。
                      </p>
                    </details>
                  </section>
                )}
                {tab === "commands" && (
                  <section className="native-history-commands">
                    <p className="native-history-note">
                      {report.commands.length} 条指令 · 服务结果与独立回读
                    </p>
                    {report.commands.length === 0 && (
                      <EmptyState title="暂无指令记录">
                        <p>执行车辆控制后，可以在这里查看服务结果。</p>
                      </EmptyState>
                    )}
                    {report.commands.slice(from, from + 50).map((command) => (
                      <article className="native-history-row" key={command.id}>
                        <div>
                          <h3>
                            {actionLabels[command.name] ??
                              legacyActionLabels[command.name] ??
                              command.name}
                          </h3>
                          <small>
                            {stamp(command.time)} ·{" "}
                            {sourceLabel(command.source)}
                          </small>
                        </div>
                        <div>
                          <p>
                            {command.message ||
                              statusLabels[command.status] ||
                              command.status}
                          </p>
                          <small>{command.readback ?? "独立回读未记录"}</small>
                        </div>
                      </article>
                    ))}
                  </section>
                )}
                {tab === "samples" && (
                  <section>
                    <p className="native-history-note">
                      {report.samples.length} 次采集 · 时间按本机时区显示
                    </p>
                    {report.samples.length === 0 ? (
                      <EmptyState title="暂无采集记录">
                        <p>车辆上报后将显示采集数据。</p>
                      </EmptyState>
                    ) : (
                      <div
                        className="native-table-wrap"
                        tabIndex={0}
                        role="region"
                        aria-label="车辆采集记录"
                      >
                        <table className="native-table">
                          <thead>
                            <tr>
                              <th>采集时间</th>
                              <th>电量</th>
                              <th>续航</th>
                              <th>里程</th>
                              <th>来源</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.samples
                              .slice(from, from + 50)
                              .map((sample, index) => (
                                <tr
                                  key={`${sample.source}-${sample.time}-${index}`}
                                >
                                  <td>{stamp(sample.time)}</td>
                                  <td>{valueText(sample.percent, "%")}</td>
                                  <td>{valueText(sample.rangeKm, " km")}</td>
                                  <td>{valueText(sample.odometerKm, " km")}</td>
                                  <td>{sourceLabel(sample.source)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}
                {tab !== "overview" && rows > 50 && (
                  <div className="native-pagination">
                    <button
                      className="secondary-button"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      上一页
                    </button>
                    <span>
                      {from + 1}–{Math.min(from + 50, rows)} / {rows}
                    </span>
                    <button
                      className="secondary-button"
                      disabled={from + 50 >= rows}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )
      )}
      {managementOpen && (
        <Modal title="历史数据管理" onClose={() => setManagementOpen(false)}>
          <p className="modal-description">导出包含所选车辆的全部保留历史。</p>
          <div className="native-history-data-actions">
            <button
              className="secondary-button"
              disabled={working || !selectedVin}
              onClick={() => void exportFile("csv")}
            >
              导出采集 CSV
            </button>
            <button
              className="secondary-button"
              disabled={working || !selectedVin}
              onClick={() => void exportFile("json")}
            >
              导出历史备份
            </button>
            <button
              className="secondary-button"
              disabled={working}
              onClick={() => void prepare("backup")}
            >
              恢复 Norr 备份
            </button>
            {import.meta.env.DEV && !isWindows && !isMobile && (
              <button
                className="secondary-button"
                disabled={working}
                onClick={() => void prepare("hisingen")}
              >
                导入 Hisingen 历史
              </button>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </Modal>
      )}
      {selectedCharge && (
        <Modal
          title={selectedCharge.location || "充电记录"}
          onClose={() => setSelectedCharge(null)}
        >
          <DataRows
            rows={[
              ["开始时间", stamp(selectedCharge.start)],
              [
                "结束时间",
                selectedCharge.end ? stamp(selectedCharge.end) : "待结束",
              ],
              [
                "电量变化",
                `${valueText(selectedCharge.startPercent, "%")} → ${valueText(selectedCharge.endPercent, "%")}`,
              ],
              ["充入电量", valueText(selectedCharge.energyKwh, " kWh")],
              ["峰值功率", valueText(selectedCharge.peakKw, " kW")],
              [
                "电量估算",
                selectedCharge.energySource === "observed_power_integration"
                  ? "按上报功率估算"
                  : "原记录估算",
              ],
              [
                "采样覆盖率",
                selectedCharge.coverage == null
                  ? "未记录"
                  : `${Math.round(selectedCharge.coverage * 100)}%`,
              ],
              [
                "估算费用",
                `${valueText(selectedCharge.cost)} ${selectedCharge.currency ?? ""}`,
              ],
              [
                "状态",
                selectedCharge.status
                  ? (chargeStatusLabels[selectedCharge.status] ??
                    selectedCharge.status)
                  : "未知",
              ],
              ["来源", sourceLabel(selectedCharge.source)],
            ]}
          />
        </Modal>
      )}
      {selectedTrip && (
        <Modal title="行程详情" onClose={() => setSelectedTrip(null)}>
          <DataRows
            rows={[
              ["开始时间", stamp(selectedTrip.start)],
              ["结束时间", stamp(selectedTrip.end)],
              ["行驶里程", valueText(selectedTrip.km, " km")],
              [
                "采样时长",
                valueText(
                  (selectedTrip.end - selectedTrip.start) / 60000,
                  " 分钟",
                ),
              ],
            ]}
          />
        </Modal>
      )}
      {preview && (
        <Modal
          title={
            import.meta.env.DEV &&
            !isWindows &&
            !isMobile &&
            preview.source === "hisingen"
              ? "导入 Hisingen 历史"
              : "恢复历史备份"
          }
          onClose={cancel}
        >
          <p className="modal-description">
            共 {preview.total} 条记录，预计新增 {preview.added} 条，合并重复{" "}
            {preview.duplicates} 条。同一记录采用本机已有版本。
          </p>
          <dl className="native-details">
            {Object.entries(preview.vehicles).map(([vehicleVin, count]) => (
              <div key={vehicleVin}>
                <dt>VIN ···· {vehicleVin.slice(-6)}</dt>
                <dd>{count} 条</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>查看记录类型</summary>
            <dl className="native-details">
              {Object.entries(preview.categories).map(([category, count]) => (
                <div key={category}>
                  <dt>{categoryLabels[category] ?? category}</dt>
                  <dd>{count} 条</dd>
                </div>
              ))}
            </dl>
          </details>
          {error && <p role="alert">{error}</p>}
          <div className="button-row">
            <button
              className="primary-button"
              disabled={working || preview.added === 0}
              onClick={() => void commit()}
            >
              {working ? "正在导入" : "确认导入"}
            </button>
            <button
              className="secondary-button"
              disabled={working}
              onClick={cancel}
            >
              {preview.added === 0 ? "完成" : "取消"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
