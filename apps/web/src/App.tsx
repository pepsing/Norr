import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CarFront,
  Check,
  ChevronDown,
  History,
  LockKeyhole,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Sun,
  X,
  BatteryCharging,
} from "lucide-react";
import { Modal } from "./components/Modal";
import { Charging } from "./pages/Charging";
import { Controls } from "./pages/Controls";
import { Garage } from "./pages/Garage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VehicleDetails, VehiclePage } from "./pages/VehiclePage";
import { WorkspaceProvider, supports, useWorkspace } from "./workspace";

type Dialog = "climate" | "lock" | "limit" | null;
const pages = [
  { id: "vehicle", label: "车辆", icon: CarFront },
  { id: "controls", label: "控制", icon: SlidersHorizontal },
  { id: "charging", label: "充电", icon: BatteryCharging },
  { id: "history", label: "记录", icon: History },
  { id: "settings", label: "设置", icon: Settings2 },
];
const titles: Record<string, string> = {
  vehicle: "车辆概览",
  controls: "车辆控制",
  charging: "充电管理",
  history: "历史记录",
  settings: "设置",
  garage: "车库与账号",
  details: "车辆详情",
};
function initialTheme(): "light" | "dark" {
  try {
    return localStorage.getItem("hisingen-preview-theme") === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export default function App() {
  return (
    <WorkspaceProvider>
      <WorkspaceApp />
    </WorkspaceProvider>
  );
}

function WorkspaceApp() {
  const {
    data,
    setData,
    vehicle,
    scenario,
    setScenario,
    notice,
    busy,
    refresh,
    command,
    temperature,
  } = useWorkspace();
  const [page, setPage] = useState("vehicle");
  const [theme, setTheme] = useState(initialTheme);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [targetTemperature, setTargetTemperature] = useState(21);
  const [chargeLimit, setChargeLimit] = useState(90);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setLoading(false), 400);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#191b19" : "#f7f7f5");
    try {
      localStorage.setItem("hisingen-preview-theme", theme);
    } catch {
      /* Appearance still works without persistent browser storage. */
    }
  }, [theme]);
  useEffect(() => {
    document.title = `Norr 北行 · ${titles[page]}`;
  }, [page]);
  function navigate(destination: string) {
    setPage(destination);
    setDialog(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openDialog(next: Dialog) {
    setTargetTemperature(vehicle?.targetTemperature ?? 21);
    setChargeLimit(vehicle?.chargeLimit ?? 90);
    setDialog(next);
  }
  async function saveDialog() {
    if (!vehicle) return;
    if (dialog === "climate")
      await command("调节座舱温度", "climate", {
        climateOn: true,
        targetTemperature,
      });
    if (dialog === "lock")
      await command(vehicle.locked ? "解锁车辆" : "锁定车辆", "lock", {
        locked: !vehicle.locked,
      });
    if (dialog === "limit")
      await command("设置充电上限", "charge", {
        chargeLimit,
        charging: vehicle.charging && chargeLimit > vehicle.battery,
      });
    setDialog(null);
  }
  const activePage = page === "details" || page === "garage" ? "vehicle" : page;
  const blocked = busy || scenario !== "connected";
  return (
    <>
      <a className="skip-link" href="#main">
        跳到内容
      </a>
      <header className="app-header">
        <button
          className="wordmark"
          aria-label="Norr 北行 车辆首页"
          onClick={() => navigate("vehicle")}
        >
          Norr<span className="wordmark-dot">.</span>
        </button>
        <nav className="navigation" aria-label="主导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${activePage === id ? "selected" : ""}`}
              aria-current={activePage === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={21} strokeWidth={1.5} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <button
            className="garage-button"
            disabled={busy}
            onClick={() => navigate("garage")}
            aria-label="打开车库"
          >
            <span>{vehicle?.model ?? "添加车辆"}</span>
            <ChevronDown size={15} />
          </button>
          <button
            className="icon-button theme-button"
            aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>
      <main id="main" className="app-main">
        <div className="page-heading">
          <div className="heading-with-back">
            {["details", "garage"].includes(page) && (
              <button
                className="icon-button"
                aria-label="返回车辆"
                onClick={() => navigate("vehicle")}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <h1>{titles[page]}</h1>
          </div>
          {!["settings", "garage"].includes(page) && (
            <button
              className="refresh-button"
              disabled={busy || loading}
              onClick={refresh}
            >
              <span>
                {busy
                  ? "正在更新"
                  : vehicle
                    ? `更新于 ${new Date(vehicle.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`
                    : "刷新车辆"}
              </span>
              <RefreshCw size={15} className={busy ? "spinning" : ""} />
            </button>
          )}
        </div>
        <div className="preview-context">
          <span>
            演示数据 ·{" "}
            {vehicle
              ? `${vehicle.nickname} / ${vehicle.region}`
              : "本地交互预览"}
          </span>
          <button onClick={() => navigate("settings")}>预览设置</button>
        </div>
        {["offline", "error"].includes(scenario) &&
          !["settings", "garage"].includes(page) && (
            <div
              className="state-banner"
              role={scenario === "error" ? "alert" : "status"}
            >
              <span>
                {scenario === "error"
                  ? "车辆连接失败，正在显示上次快照。"
                  : "设备离线，车辆操作暂不可用。"}
              </span>
              <button disabled={busy} onClick={refresh}>
                {scenario === "error" ? "重新连接" : "恢复连接"}
              </button>
            </div>
          )}
        {page === "garage" ? (
          <Garage onSelect={() => navigate("vehicle")} />
        ) : page === "settings" ? (
          <SettingsPage
            theme={theme}
            onTheme={setTheme}
            onGarage={() => navigate("garage")}
          />
        ) : loading ? (
          <div className="loading-state" role="status">
            <RefreshCw className="spinning" />
            <p>正在载入车辆快照…</p>
          </div>
        ) : !vehicle || scenario === "empty" ? (
          <div className="empty-state">
            <CarFront size={50} strokeWidth={1} />
            <h2>尚未添加车辆</h2>
            <p>连接账号，查看你的车辆状态。</p>
            <button
              className="primary-button"
              onClick={() => navigate("garage")}
            >
              打开车库
            </button>
            {scenario === "empty" && vehicle && (
              <button
                className="text-button"
                onClick={() => setScenario("connected")}
              >
                恢复演示车辆
              </button>
            )}
          </div>
        ) : (
          <div key={vehicle.id}>
            {page === "vehicle" && (
              <VehiclePage onNavigate={navigate} onControl={openDialog} />
            )}
            {page === "details" && <VehicleDetails />}
            {page === "controls" && <Controls onControl={openDialog} />}
            {page === "charging" && (
              <Charging onLimit={() => openDialog("limit")} />
            )}
            {page === "history" && <HistoryPage />}
          </div>
        )}
        <footer className="page-footer">
          <span>Norr 北行 · 本地交互预览</span>
          <span>所有车辆读数与操作均为模拟</span>
        </footer>
      </main>
      <div className="toast-region" role="status" aria-live="polite">
        {notice && (
          <div className="toast">
            <Check size={18} />
            <span>{notice}</span>
          </div>
        )}
      </div>
      {data.settings.miniPanel && vehicle && (
        <aside className="mini-panel" aria-label="充电悬浮面板">
          <div>
            <span>{vehicle.model}</span>
            <button
              className="icon-button"
              aria-label="关闭充电悬浮面板"
              onClick={() =>
                setData((old) => ({
                  ...old,
                  settings: { ...old.settings, miniPanel: false },
                }))
              }
            >
              <X size={17} />
            </button>
          </div>
          <button
            className="mini-panel-value"
            onClick={() => navigate("charging")}
          >
            {vehicle.battery}%{" "}
            <span>{vehicle.charging ? "正在充电" : "充电已暂停"}</span>
          </button>
        </aside>
      )}
      {dialog && vehicle && (
        <Modal
          title={
            {
              climate: "座舱温度",
              lock: vehicle.locked ? "解锁车辆" : "锁定车辆",
              limit: "充电上限",
            }[dialog]
          }
          onClose={() => setDialog(null)}
        >
          {dialog === "climate" && (
            <>
              <p className="modal-description">
                车内 {temperature(vehicle.cabinTemperature)} ·{" "}
                {vehicle.climateOn ? "空调运行中" : "空调已关闭"}
              </p>
              <div className="temperature-control">
                <button
                  className="icon-button"
                  aria-label="降低温度"
                  disabled={targetTemperature <= 16 || busy}
                  onClick={() => setTargetTemperature(targetTemperature - 1)}
                >
                  <Minus />
                </button>
                <output aria-live="polite">
                  {temperature(targetTemperature)}
                </output>
                <button
                  className="icon-button"
                  aria-label="提高温度"
                  disabled={targetTemperature >= 28 || busy}
                  onClick={() => setTargetTemperature(targetTemperature + 1)}
                >
                  <Plus />
                </button>
              </div>
              <label className="range-label" htmlFor="temperature">
                目标温度
                <span>
                  {temperature(16)} 至 {temperature(28)}
                </span>
              </label>
              <input
                id="temperature"
                type="range"
                min={16}
                max={28}
                value={targetTemperature}
                disabled={busy}
                onChange={(e) => setTargetTemperature(Number(e.target.value))}
              />
              <button
                className="primary-button full-width"
                disabled={blocked || !supports(vehicle, "climate")}
                onClick={saveDialog}
              >
                {busy
                  ? "正在发送…"
                  : vehicle.climateOn
                    ? "应用温度"
                    : "开启空调"}
              </button>
              {vehicle.climateOn && (
                <button
                  className="secondary-button full-width"
                  disabled={blocked}
                  onClick={async () => {
                    await command("关闭空调", "climate", { climateOn: false });
                    setDialog(null);
                  }}
                >
                  关闭空调
                </button>
              )}
            </>
          )}
          {dialog === "lock" && (
            <>
              <LockKeyhole
                className="lock-dialog-icon"
                size={64}
                strokeWidth={1}
              />
              <p className="modal-description">
                确认{vehicle.locked ? "解锁" : "锁定"} {vehicle.nickname}？
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={blocked || !supports(vehicle, "lock")}
                  onClick={saveDialog}
                >
                  {busy ? "正在发送…" : "确认"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
              </div>
            </>
          )}
          {dialog === "limit" && (
            <>
              <div className="limit-readout">
                <output>
                  {chargeLimit}
                  <span>%</span>
                </output>
              </div>
              <label htmlFor="charge-limit" className="range-label">
                目标电量<span>50% 至 100%</span>
              </label>
              <input
                id="charge-limit"
                type="range"
                min={50}
                max={100}
                step={5}
                value={chargeLimit}
                disabled={busy}
                onChange={(e) => setChargeLimit(Number(e.target.value))}
              />
              <div className="limit-presets">
                {[80, 90, 100].map((value) => (
                  <button
                    key={value}
                    aria-pressed={chargeLimit === value}
                    disabled={busy}
                    onClick={() => setChargeLimit(value)}
                  >
                    {value}%
                  </button>
                ))}
              </div>
              <button
                className="primary-button full-width"
                disabled={blocked || !supports(vehicle, "charge")}
                onClick={saveDialog}
              >
                {busy ? "正在保存…" : "保存充电上限"}
              </button>
            </>
          )}
          <p className="modal-footnote">
            模拟操作 · 执行结果可在指令记录中查看
          </p>
        </Modal>
      )}
    </>
  );
}
