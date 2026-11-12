import { useState } from "react";
import type { ChangeEvent } from "react";
import { ArrowRight, Download, Upload } from "lucide-react";
import { Confirmation, DataRows, SectionTabs } from "../components/WorkspaceUI";
import {
  demoCapabilityProfile,
  capabilityLabels,
  downloadFile,
  parseBackup,
  useWorkspace,
} from "../workspace";
import type {
  Capability,
  ScheduleRead,
  Settings,
  WorkspaceData,
} from "../workspace";

export function SettingsPage({
  theme,
  onTheme,
  onGarage,
}: {
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onGarage: () => void;
}) {
  const {
    data,
    setData,
    vehicle,
    scenario,
    setScenario,
    outcome,
    setOutcome,
    readbackOutcome,
    setReadbackOutcome,
    setScheduleRead,
    setNotice,
    busy,
  } = useWorkspace();
  const [tab, setTab] = useState("偏好");
  const [confirm, setConfirm] = useState<"clear" | "restore" | null>(null);
  const [backup, setBackup] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState("");
  function setting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setData((old) => ({ ...old, settings: { ...old.settings, [key]: value } }));
  }
  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("请选择小于 2 MB 的演示备份");
      const parsed = parseBackup(await file.text());
      setBackup(parsed);
      setError("");
      setConfirm("restore");
    } catch (error) {
      setError(
        error instanceof Error ? `导入失败，${error.message}` : "备份无法读取",
      );
    }
  }
  return (
    <>
      <SectionTabs
        items={["偏好", "账号", "通知与系统", "隐私与数据", "演示状态", "关于"]}
        value={tab}
        onChange={setTab}
        label="设置分类"
      />
      {tab === "偏好" && (
        <section className="settings-page">
          <div className="setting-row">
            <div>
              <h3>显示模式</h3>
              <p>保存在当前浏览器</p>
            </div>
            <div className="segmented-control">
              {(["light", "dark"] as const).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={theme === mode}
                  onClick={() => onTheme(mode)}
                >
                  {mode === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <label htmlFor="distance-unit">距离单位</label>
            <select
              id="distance-unit"
              value={data.settings.distance}
              onChange={(e) =>
                setting("distance", e.target.value as "km" | "mi")
              }
            >
              <option value="km">公里 km</option>
              <option value="mi">英里 mi</option>
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="temperature-unit">温度单位</label>
            <select
              id="temperature-unit"
              value={data.settings.temperature}
              onChange={(e) =>
                setting("temperature", e.target.value as "C" | "F")
              }
            >
              <option value="C">摄氏度 °C</option>
              <option value="F">华氏度 °F</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="refresh-interval">刷新间隔</label>
              <p>预览保存偏好，持续采集由原生宿主调度</p>
            </div>
            <select
              id="refresh-interval"
              value={data.settings.refresh}
              onChange={(e) => setting("refresh", e.target.value)}
            >
              <option value="1">1 分钟</option>
              <option value="5">5 分钟</option>
              <option value="15">15 分钟</option>
              <option value="manual">手动刷新</option>
            </select>
          </div>
          <DataRows rows={[["界面语言", "简体中文 · 本轮设计语言"]]} />
        </section>
      )}
      {tab === "账号" && (
        <section className="reading-width">
          <h2>已连接的演示账号</h2>
          {data.vehicles.map((car) => (
            <div className="list-row" key={car.id}>
              <div>
                <h3>
                  {car.brand} · {car.region}
                </h3>
                <p>{car.nickname} · 本地演示会话</p>
              </div>
              <span>已连接</span>
            </div>
          ))}
          {!data.vehicles.length && (
            <p className="inline-empty">尚未添加账号，可从车库连接车辆。</p>
          )}
          <div className="button-row">
            <button className="primary-button" onClick={onGarage}>
              管理车库与账号
              <ArrowRight size={17} />
            </button>
          </div>
          <p className="muted">
            应用会先尝试恢复会话；车辆服务要求重新验证时，再进入登录流程。车库提供连接账号与移除车辆的入口。
          </p>
        </section>
      )}
      {tab === "通知与系统" && (
        <section className="settings-page">
          <div className="setting-row">
            <div>
              <h3>充电与车辆通知</h3>
              <p>预览中通过应用内提示演示</p>
            </div>
            <button
              className="switch"
              role="switch"
              aria-label="充电与车辆通知"
              aria-checked={data.settings.notifications}
              onClick={() =>
                setting("notifications", !data.settings.notifications)
              }
            >
              <span />
            </button>
          </div>
          <div className="button-row">
            <button
              className="secondary-button"
              disabled={!data.settings.notifications}
              onClick={() => setNotice("充电已达到目标电量 · 演示通知")}
            >
              预览充电完成通知
            </button>
          </div>
          <div className="setting-row">
            <div>
              <h3>登录时启动</h3>
              <p>保存桌面端偏好，原生宿主接入后生效</p>
            </div>
            <button
              className="switch"
              role="switch"
              aria-label="登录时启动"
              aria-checked={data.settings.startAtLogin}
              onClick={() =>
                setting("startAtLogin", !data.settings.startAtLogin)
              }
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <h3>充电悬浮面板</h3>
              <p>在当前页面预览紧凑的充电信息</p>
            </div>
            <button
              className="switch"
              role="switch"
              aria-label="充电悬浮面板"
              aria-checked={data.settings.miniPanel}
              onClick={() => setting("miniPanel", !data.settings.miniPanel)}
            >
              <span />
            </button>
          </div>
          <details className="disclosure">
            <summary>系统集成与快捷方式</summary>
            <p>
              菜单栏与系统托盘、系统通知、快捷指令和日历预调节将在各平台宿主中接入。手机后台采样受系统调度影响。
            </p>
          </details>
        </section>
      )}
      {tab === "隐私与数据" && (
        <section className="settings-page">
          <div className="setting-row">
            <div>
              <h3>截图隐私模式</h3>
              <p>隐藏位置与车辆识别码</p>
            </div>
            <button
              className="switch"
              role="switch"
              aria-label="截图隐私模式"
              aria-checked={data.settings.privacy}
              onClick={() => setting("privacy", !data.settings.privacy)}
            >
              <span />
            </button>
          </div>
          <div className="data-actions">
            <div>
              <h2>备份与恢复</h2>
              <p className="muted">
                备份包含演示车库、设置、计划、地点及手动记录。
              </p>
            </div>
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  downloadFile(
                    "norr-design-backup.json",
                    JSON.stringify(data, null, 2),
                  );
                  setNotice("演示备份已导出");
                }}
              >
                <Download size={17} />
                导出备份
              </button>
              <label className="secondary-button file-button">
                <Upload size={17} />
                导入备份
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={importBackup}
                />
              </label>
            </div>
            {error && (
              <p role="alert" className="danger-text">
                {error}
              </p>
            )}
          </div>
          <div className="setting-row">
            <div>
              <h3>清空当前车辆记录</h3>
              <p>清空历史示例、手动记录与指令结果</p>
            </div>
            <button
              className="text-button danger-text"
              disabled={!vehicle || busy}
              onClick={() => setConfirm("clear")}
            >
              清空记录
            </button>
          </div>
          <details className="disclosure">
            <summary>本地数据与凭据</summary>
            <p>
              预览数据保存在此浏览器。各设备直连方案会将长期凭据存入系统安全存储，并将实际历史保存在本机数据库。浏览器预览使用模拟会话。
            </p>
          </details>
        </section>
      )}
      {tab === "演示状态" && (
        <section className="settings-page">
          <div className="setting-row">
            <div>
              <label htmlFor="scenario">连接场景</label>
              <p>切回业务页查看对应状态</p>
            </div>
            <select
              id="scenario"
              value={scenario}
              disabled={busy}
              onChange={(e) => setScenario(e.target.value as typeof scenario)}
            >
              <option value="connected">已连接</option>
              <option value="offline">离线快照</option>
              <option value="error">连接失败</option>
              <option value="empty">空车辆状态</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="outcome">下一次指令结果</label>
              <p>服务处理进度与车辆回读分别显示</p>
            </div>
            <select
              id="outcome"
              value={outcome}
              disabled={busy}
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            >
              <option value="success">完成后核对回读</option>
              <option value="accepted">服务已接受</option>
              <option value="delivered">已送达车辆</option>
              <option value="completed">服务报告完成</option>
              <option value="failed">请求未发出</option>
              <option value="unknown">结果未确认</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="readback-outcome">下一次指令的车辆回读</label>
              <p>用于预览核对成功、状态不符和读取不可用</p>
            </div>
            <select
              id="readback-outcome"
              value={readbackOutcome}
              disabled={busy}
              onChange={(event) =>
                setReadbackOutcome(event.target.value as typeof readbackOutcome)
              }
            >
              <option value="match">与目标一致</option>
              <option value="mismatch">与目标不一致</option>
              <option value="unavailable">无法读取</option>
            </select>
          </div>
          {vehicle && (
            <>
              <div className="setting-row">
                <div>
                  <label htmlFor="capability-scenario">
                    当前车辆的能力场景
                  </label>
                  <p>预览缺失字段、明确不支持和账号权限受限</p>
                </div>
                <select
                  id="capability-scenario"
                  disabled={busy}
                  value={
                    vehicle.controlAccess === "denied"
                      ? "denied"
                      : !Object.keys(vehicle.capabilities ?? {}).length
                        ? "unchecked"
                        : Object.values(vehicle.capabilities ?? {}).every(
                              (flag) => flag === false,
                            )
                          ? "unsupported"
                          : "profile"
                  }
                  onChange={(event) => {
                    const choice = event.target.value;
                    const profile = demoCapabilityProfile(
                      vehicle.brand,
                      vehicle.region,
                      vehicle.model,
                    );
                    setData((old) => ({
                      ...old,
                      vehicles: old.vehicles.map((car) =>
                        car.id === vehicle.id
                          ? {
                              ...car,
                              ...profile,
                              ...(choice === "unchecked"
                                ? { capabilities: {} }
                                : {}),
                              ...(choice === "unsupported"
                                ? {
                                    capabilities: Object.fromEntries(
                                      (
                                        Object.keys(
                                          capabilityLabels,
                                        ) as Capability[]
                                      ).map((key) => [key, false]),
                                    ),
                                  }
                                : {}),
                              ...(choice === "denied"
                                ? { controlAccess: "denied" as const }
                                : {}),
                            }
                          : car,
                      ),
                    }));
                  }}
                >
                  <option value="profile">车型演示能力</option>
                  <option value="unchecked">能力尚未检查</option>
                  <option value="unsupported">能力明确不支持</option>
                  <option value="denied">账号无操作权限</option>
                </select>
              </div>
              {(["空调", "充电"] as const).map((kind) => (
                <div className="setting-row" key={kind}>
                  <div>
                    <label htmlFor={`schedule-read-${kind}`}>
                      {kind}定时读取
                    </label>
                    <p>
                      仅作用于 {vehicle.nickname} 的{kind}计划
                    </p>
                  </div>
                  <select
                    id={`schedule-read-${kind}`}
                    disabled={busy}
                    value={
                      vehicle.scheduleReads?.[kind]?.status ?? "unrequested"
                    }
                    onChange={(event) =>
                      setScheduleRead(
                        kind,
                        event.target.value as ScheduleRead["status"] | "empty",
                      )
                    }
                  >
                    <option value="unrequested">尚未请求</option>
                    <option value="failed">读取失败</option>
                    <option value="cached">缓存记录</option>
                    {kind === "充电" && (
                      <option value="partial">仅全局窗口读取成功</option>
                    )}
                    <option value="success">完整读取成功</option>
                    <option value="empty">完整空列表，清除本地计划</option>
                  </select>
                </div>
              ))}
            </>
          )}
          <p className="muted">
            选择的结果持续应用，直到再次修改。所有车辆指令均在本地模拟。
          </p>
        </section>
      )}
      {tab === "关于" && (
        <section className="reading-width">
          <h2>Norr 北行</h2>
          <p className="about-description">车辆状态、远程控制与本地历史。</p>
          <DataRows
            rows={[
              ["版本", "界面设计预览 0.2"],
              ["数据模式", "本地模拟"],
              ["视觉方向", "极星参考 · Archivo 字体"],
              ["设备连接", "各端独立直连 · 集成阶段接入"],
            ]}
          />
          <details className="disclosure">
            <summary>厂商接入进展</summary>
            <p>
              本界面使用本地模拟。macOS 原生版本的中国区 Polestar 2
              已有真实登录、车辆读取和空调控制成功记录，其他写操作仍需逐项实车验证。中国区
              Polestar 4 及跨端登录与控制仍待验证。
            </p>
          </details>
          <details className="disclosure">
            <summary>字体与车辆素材</summary>
            <p>
              Archivo 使用随包字体许可。Polestar
              车辆图片来自官网，当前用于设计参考，发布授权待确认。
            </p>
          </details>
        </section>
      )}
      {confirm && (
        <Confirmation
          title={confirm === "clear" ? "清空当前车辆记录" : "恢复演示备份"}
          confirm={confirm === "clear" ? "确认清空" : "确认恢复"}
          busy={busy}
          onClose={() => {
            setConfirm(null);
            setBackup(null);
          }}
          onConfirm={() => {
            if (confirm === "restore" && backup) {
              setData(backup);
              setScenario("connected");
              setNotice("演示备份已恢复");
            } else if (vehicle) {
              setData((old) => ({
                ...old,
                clearedHistory: [
                  ...new Set([...old.clearedHistory, vehicle.id]),
                ],
                receipts: old.receipts.filter(
                  (r) => r.vehicleId !== vehicle.id,
                ),
                fuel: old.fuel.filter((f) => f.vehicleId !== vehicle.id),
              }));
              setNotice("当前车辆记录已清空");
            }
            setConfirm(null);
            setBackup(null);
          }}
        >
          <p>
            {confirm === "clear"
              ? `将清空 ${vehicle?.nickname} 的演示历史、加油记录与指令结果。`
              : `备份包含 ${backup?.vehicles.length ?? 0} 辆车辆，恢复后将替换此浏览器的当前演示数据。`}
          </p>
        </Confirmation>
      )}
    </>
  );
}
