import {
  credentialStorage,
  desktopName,
  isAndroid,
  isIOS,
  isMobile,
  isWindows,
  supportsWidgets,
} from "./platform";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BatteryCharging,
  CarFront,
  ChevronRight,
  Fan,
  History as HistoryIcon,
  KeyRound,
  LockKeyhole,
  MapPin,
  Moon,
  RefreshCw,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { Modal } from "../components/Modal";
import { VehicleArtwork } from "../components/VehicleArtwork";
import { VehicleAppearancePicker } from "../components/VehicleAppearancePicker";
import { EnergyPanelView } from "../components/EnergyPanel";
import { DataRows, SectionTabs } from "../components/WorkspaceUI";
import { NativeControls } from "./NativeControls";
import { SchedulePanel } from "./SchedulePanel";
import { HistoryPanel } from "./HistoryPanel";
import { DesktopSettings } from "./DesktopSettings";
import { PhoneSignIn } from "./PhoneSignIn";
import { ChargeLocations, VehicleDetails } from "./VehicleDetails";
import { VehicleMap } from "./VehicleMap";
import type { VehiclePosition } from "./VehicleMap";
import { defaultAppearance, validAppearance } from "../vehicle-catalog";
import type { VehicleAppearance } from "../vehicle-catalog";
import {
  actionLabels,
  activeControls,
  commandLimits,
  chargingOptions,
  native,
  numeric,
  readingText,
  scheduleText,
  unavailableReason,
  mergeXchangerSnapshot,
  xchangerCoordinate,
  xchangerTruthy,
} from "./client";
import type {
  Command,
  History,
  NativeVehicle,
  ProbeReport,
  Receipt,
  XchangerStatus,
  SessionStatus,
  Snapshot,
} from "./client";
import "./native.css";
import { widgetData } from "./widgets";
import type { WidgetTarget } from "./widgets";

const pages = [
  { id: "vehicle", label: "车辆", title: "车辆概览", icon: CarFront },
  { id: "controls", label: "控制", title: "车辆控制", icon: SlidersHorizontal },
  { id: "charging", label: "充电", title: "充电管理", icon: BatteryCharging },
  { id: "history", label: "记录", title: "历史记录", icon: HistoryIcon },
  { id: "settings", label: "设置", title: "设置", icon: Settings2 },
];
const endpointLabels: Record<string, string> = {
  battery: "电池与续航",
  exterior: "车身",
  climate: "空调",
  odometer: "里程",
  target: "目标电量",
  amperage: "电流上限",
  health: "健康与保养",
  airQuality: "空气质量",
  location: "车辆位置",
  software: "车辆软件",
  softwareSchedule: "软件安装计划",
  climateTimers: "空调日程",
  chargeTimer: "全局充电窗口",
  chargeLocations: "充电地点",
};
const chargeStates: Record<number, string> = {
  1: "正在充电",
  2: "空闲",
  3: "等待预约",
  4: "放电中",
  5: "充电异常",
  6: "智能充电",
  7: "已暂停",
  8: "充电完成",
};
const climateStates: Record<string, string> = {
  active: "运行中",
  starting: "启动中",
  idle: "已关闭",
  unknown: "状态未知",
};

function storedAppearance(vin: string, model: string): VehicleAppearance {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`norr-appearance-${vin}`) ?? "null",
    );
    if (validAppearance(value)) return value;
  } catch {
    /* A missing appearance can be selected again in Settings. */
  }
  return defaultAppearance(model.includes("4") ? "polestar-4" : "polestar-2");
}

function valueText(value: number | null, unit = "", digits = 0): string {
  return value === null
    ? "未知"
    : `${value.toLocaleString("zh-CN", { maximumFractionDigits: digits })}${unit}`;
}

export default function NativeApp() {
  const [page, setPage] = useState("vehicle");
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  const [chargingTab, setChargingTab] = useState("充电状态");
  const [settingsTab, setSettingsTab] = useState("偏好");
  const [fleet, setFleet] = useState<NativeVehicle[]>([]);
  const [vin, setVin] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [history, setHistory] = useState<History>({
    snapshots: [],
    receipts: [],
  });
  const [session, setSession] = useState<SessionStatus>();
  const [busy, setBusy] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [widgetError, setWidgetError] = useState("");
  const [notice, setNotice] = useState<string | Receipt>("");
  const [backgroundError, setBackgroundError] = useState("");
  const [desktopError, setDesktopError] = useState("");
  const [notificationTarget, setNotificationTarget] = useState<{
    vin: string;
    page: string;
  } | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [dialog, setDialog] = useState<Command | null>(null);
  const [vehicleSheet, setVehicleSheet] = useState<
    "details" | "location" | null
  >(null);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const [appearance, setAppearance] = useState(defaultAppearance());
  const [widgetTarget, setWidgetTarget] = useState<WidgetTarget | null>(null);
  const widgetSync = useRef(Promise.resolve());
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("norr-native-theme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  const started = useRef(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  const vehicle =
    snapshot?.vehicle.vin === vin
      ? snapshot.vehicle
      : fleet.find((car) => car.vin === vin);
  const experimental = history.settings?.experimentalP4 ?? false;
  const unverifiedPlatform = Boolean(
    vehicle && !["ICUP", "AccountLinking"].includes(vehicle.platform ?? ""),
  );
  const [probe, setProbe] = useState<ProbeReport>();
  const [xchanger, setXchanger] = useState<XchangerStatus>();
  const [xchangerError, setXchangerError] = useState("");
  const [xchangerTarget, setXchangerTarget] = useState<number>();
  const xchangerPosition = xchanger?.basicVehicleStatus?.position;
  const displaySnapshot = mergeXchangerSnapshot(
    snapshot,
    xchanger,
    xchangerTarget,
  );
  const xchangerPoint: VehiclePosition | undefined = (() => {
    const latitude = xchangerCoordinate(xchangerPosition?.latitude);
    const longitude = xchangerCoordinate(xchangerPosition?.longitude);
    if (latitude === null || longitude === null) return undefined;
    const observedAt = Number(xchanger?.updateTime);
    return {
      latitude,
      longitude,
      observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
      source: "xchanger",
      coordinateSystem:
        xchangerPosition?.marsCoordinates === "true" ? "gcj02" : "wgs84",
    };
  })();
  const supportsTemperature =
    vehicle?.capabilities
      .supportsParkingClimatizationCompartmentTemperatureSettings === true;
  const active = activeControls(displaySnapshot);
  const needsValue =
    dialog?.action === "target" ||
    dialog?.action === "amperage" ||
    dialog?.action === "otaSchedule" ||
    (dialog?.action === "climateStart" && supportsTemperature);
  const limits = commandLimits(vehicle, dialog?.action ?? "");
  const chargeAction =
    dialog?.action === "target" || dialog?.action === "amperage"
      ? dialog.action
      : null;
  const chargeOptions = chargeAction
    ? chargingOptions(
        vehicle,
        chargeAction,
        numeric(
          snapshot,
          chargeAction,
          chargeAction === "target" ? "percent" : "amps",
        ),
      )
    : null;
  const chargeUnit = chargeAction === "target" ? "%" : "A";
  const validValue =
    !needsValue ||
    (dialog?.value !== undefined &&
      Number.isFinite(dialog.value) &&
      dialog.value >= limits.min &&
      dialog.value <= limits.max &&
      Number.isInteger(dialog.value / limits.step) &&
      (!chargeOptions || chargeOptions.values.includes(dialog.value)));

  useEffect(() => {
    document.title = `Norr 北行 · ${pages.find((item) => item.id === page)?.label}`;
  }, [page]);

  useEffect(() => {
    if (vehicle?.platform !== "HUANFU" || !vin) {
      setXchanger(undefined);
      setXchangerError("");
      return;
    }
    void loadXchanger(vin);
  }, [vin, vehicle?.platform]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (isAndroid) {
      void native.setAndroidTheme(theme === "dark").catch((error) => {
        console.error("Android 系统栏主题同步失败", error);
      });
    }
    try {
      localStorage.setItem("norr-native-theme", theme);
    } catch {
      /* Theme still applies to the current window. */
    }
  }, [theme]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void restore();
  }, []);

  useEffect(() => {
    let disposed = false;
    const receive = () => {
      void native
        .takeNotificationTarget()
        .then((target) => {
          if (!disposed && target) setNotificationTarget(target);
        })
        .catch((problem: unknown) => {
          if (!disposed) setDesktopError(String(problem));
        });
    };
    window.addEventListener("focus", receive);
    const subscriptions = [
      native.onNotificationOpen(receive),
      native.onDesktopError((message) => {
        if (!disposed) setDesktopError(message);
      }),
    ];
    void Promise.all(subscriptions)
      .then(receive)
      .catch((problem: unknown) => {
        if (!disposed) setDesktopError(String(problem));
      });
    return () => {
      disposed = true;
      window.removeEventListener("focus", receive);
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!notificationTarget || busy) return;
    setNotificationTarget(null);
    if (
      ["vehicle", "charging", "history", "settings"].includes(
        notificationTarget.page,
      )
    )
      setPage(notificationTarget.page);
    if (notificationTarget.page === "settings") setSettingsTab("通知与系统");
    if (notificationTarget.vin && notificationTarget.vin !== vin)
      void selectVehicle(notificationTarget.vin);
  }, [notificationTarget, busy, vin]);

  useEffect(() => {
    if (vehicle) setAppearance(storedAppearance(vehicle.vin, vehicle.model));
  }, [vehicle?.vin, vehicle?.model]);

  useEffect(() => {
    if (!supportsWidgets || !snapshot || snapshot.vehicle.vin !== vin) {
      setWidgetError("");
      return;
    }
    let disposed = false;
    const data = widgetData(snapshot, storedAppearance(vin, snapshot.vehicle.model));
    widgetSync.current = widgetSync.current
      .then(() => native.updateWidgets(data))
      .then(() => { if (!disposed) setWidgetError(""); })
      .catch((problem) => {
        console.error("小组件数据同步失败", problem);
        if (!disposed) setWidgetError(String(problem));
      });
    return () => { disposed = true; };
  }, [snapshot, vin, appearance]);

  useEffect(() => {
    if (!supportsWidgets) return;
    let disposed = false;
    const receive = () => {
      if (disposed) return;
      void native.takeWidgetTarget().then((target) => {
        if (!disposed && target) setWidgetTarget(target);
      }).catch((problem) => console.error("小组件入口读取失败", problem));
    };
    const subscription = native.onWidgetOpen(receive);
    void subscription.then(receive).catch((problem) => console.error("小组件入口监听失败", problem));
    window.addEventListener("focus", receive);
    return () => {
      disposed = true;
      window.removeEventListener("focus", receive);
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!widgetTarget || busy || !connected) return;
    if (widgetTarget.vin && widgetTarget.vin !== vin) {
      if (fleet.some((car) => car.vin === widgetTarget.vin)) {
        void selectVehicle(widgetTarget.vin);
      } else {
        setWidgetTarget(null);
        setError("小组件中的车辆已不在当前账号中，请重新选择车辆。");
      }
      return;
    }
    setWidgetTarget(null);
    setPage("vehicle");
    if (widgetTarget.action === "refresh") {
      void refresh();
    } else if (widgetTarget.action === "lock" || widgetTarget.action === "climate") {
      const action = widgetTarget.action === "lock"
        ? (snapshot?.readings.exterior?.value?.locked === true ? "unlock" : "lock")
        : (snapshot?.readings.climate?.value?.activity === "active" ? "climateStop" : "climateStart");
      const reason = unavailableReason(vehicle, action, experimental);
      if (reason) setError(reason);
      else openCommand(action);
    }
  }, [widgetTarget, busy, connected, vin, fleet]);

  useEffect(() => {
    let disposed = false;
    const subscriptions = [
      native.onSnapshot((next) => {
        if (disposed) return;
        if (next.vehicle.vin === vin) {
          setSnapshot(next);
          setConnected(true);
          setBackgroundError("");
        }
        void reloadHistory().catch((problem: unknown) =>
          setBackgroundError(String(problem)),
        );
      }),
      native.onRefreshError((problem) => {
        if (!disposed) setBackgroundError(problem);
      }),
    ];
    for (const subscription of subscriptions)
      void subscription.catch((problem: unknown) => {
        if (!disposed) setBackgroundError(String(problem));
      });
    return () => {
      disposed = true;
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [vin]);

  async function reloadHistory() {
    const data = await native.history();
    setHistory(data);
    return data;
  }

  async function restore() {
    setBusy(true);
    setError("");
    try {
      const data = await reloadHistory();
      const cached = data.snapshots.at(-1);
      if (cached) {
        setSnapshot(cached);
        setVin(cached.vehicle.vin);
      }
      const status = await native.status();
      setSession(status);
      if (status.hasSession && status.hasSigningKey)
        await connect(cached?.vehicle.vin);
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function connect(preferred?: string) {
    setConnected(false);
    const cars = await native.connect();
    setFleet(cars);
    setConnected(true);
    const selected = cars.find((car) => car.vin === preferred) ?? cars[0];
    if (selected) {
      setVin(selected.vin);
      if (selected.vin !== preferred) setSnapshot(undefined);
      setSnapshot(await native.refresh(selected.vin));
      await reloadHistory();
    } else {
      setVin("");
      setSnapshot(undefined);
    }
    setSession(await native.status());
  }

  async function loadXchanger(target: string) {
    if (!target) return;
    try {
      const status = await native.xchangerStatus(target);
      setXchanger(status);
      setXchangerError("");
      try {
        setXchangerTarget(await native.xchangerTargetSoc(target));
      } catch {
        setXchangerTarget(undefined);
      }
    } catch (problem) {
      setXchanger(undefined);
      setXchangerError(String(problem));
    }
  }

  async function refreshXchanger() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await native.refreshXchanger();
      await loadXchanger(vin);
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function controlXchangerClimate(
    command: "start" | "stop",
    temperature?: number,
  ) {
    if (busy || !vin) return;
    setBusy(true);
    setError("");
    const target = command === "start";
    try {
      await native.xchangerClimate(vin, command, temperature);
      setNotice(target ? "空调指令已提交，等待车辆确认…" : "关闭指令已提交，等待车辆确认…");
      // The car takes roughly 5–15 s to report the new pre-climate state.
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const status = await native.xchangerStatus(vin);
        setXchanger(status);
        const active = xchangerTruthy(
          status.additionalVehicleStatus?.climateStatus?.preClimateActive,
        );
        if (active === target) {
          setNotice(target ? "空调已开启" : "空调已关闭");
          return;
        }
      }
      setError("指令已提交，但车辆尚未回读目标状态；请稍后在官方 App 或车内确认。");
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function runProbe() {
    if (!vin || busy) return;
    setBusy(true);
    setError("");
    try {
      setProbe(await native.probeVehicle(vin));
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      if (!connected || !vin) await connect(vin);
      else {
        setSnapshot(await native.refresh(vin));
        await reloadHistory();
      }
      setSession(await native.status());
      setBackgroundError("");
    } catch (problem) {
      setError(String(problem));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  async function selectVehicle(selected: string) {
    setVin(selected);
    setSnapshot(
      history.snapshots.filter((item) => item.vehicle.vin === selected).at(-1),
    );
    setBusy(true);
    setError("");
    try {
      setSnapshot(await native.refresh(selected));
      await reloadHistory();
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function importSession() {
    if (!native.import) return;
    setBusy(true);
    setError("");
    try {
      const status = await native.import(configPath.trim() || undefined);
      setSession(status);
      if (status.hasSigningKey) await connect(vin);
      else setNotice("会话已复制，请指定现有程序的签名配置文件。");
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function syncWatch(clear = false) {
    setBusy(true);
    setError("");
    try {
      await native.syncWatch(clear ? "" : vin, clear);
      setNotice(
        clear
          ? "清除请求已交给系统，手表连接后生效。自动同步已暂停，点击同步按钮可恢复。"
          : "登录态与当前车辆已交给系统，手表连接后同步。后续车辆切换和授权更新将自动同步。",
      );
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function signedIn(status: SessionStatus) {
    setSession(status);
    setFleet([]);
    setVin("");
    setSnapshot(undefined);
    setConnected(false);
    setError("");
    setBackgroundError("");
    setNotice("登录成功，正在读取车辆。");
    try {
      await connect();
      setNotice("登录成功。");
      setPage("vehicle");
    } catch (problem) {
      setNotice("登录成功，会话已保存。");
      setError(`车辆读取未完成，可点击刷新车辆重试。${String(problem)}`);
    }
  }

  function openCommand(action: string) {
    if (action === "otaSchedule") {
      setDialog({ vin, action, value: 60 });
      return;
    }
    if (!["climateStart", "target", "amperage"].includes(action)) {
      setDialog({ vin, action });
      return;
    }
    if (action === "climateStart" && !supportsTemperature) {
      setDialog({ vin, action });
      return;
    }
    const current =
      action === "target"
        ? numeric(displaySnapshot, "target", "percent")
        : action === "amperage"
          ? numeric(snapshot, "amperage", "amps")
          : numeric(snapshot, "climate", "targetTemperature");
    const fallback = action === "target" ? 80 : action === "amperage" ? 16 : 22;
    const bounds = commandLimits(vehicle, action);
    setDialog({
      vin,
      action,
      value: current ?? Math.min(bounds.max, Math.max(bounds.min, fallback)),
    });
  }

  async function setP4Target(percent: number) {
    if (busy || !vin) return;
    setBusy(true);
    setError("");
    try {
      await native.xchangerSetTargetSoc(vin, percent);
      setNotice(`目标电量已提交 ${percent}%，等待车辆确认…`);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const soc = await native.xchangerTargetSoc(vin);
        setXchangerTarget(soc);
        if (Math.round(soc) === Math.round(percent)) {
          setNotice(`目标电量已设为 ${percent}%`);
          return;
        }
      }
      setError("目标电量指令已提交，但车辆尚未回读目标值；请稍后在官方 App 或车内确认。");
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function sendCommand() {
    if (!dialog || busy || !validValue) return;
    if (vehicle?.platform === "HUANFU" && dialog.action === "target") {
      const percent = dialog.value;
      setDialog(null);
      if (percent !== undefined) await setP4Target(percent);
      return;
    }
    if (
      vehicle?.platform === "HUANFU" &&
      (dialog.action === "climateStart" || dialog.action === "climateStop")
    ) {
      const action = dialog.action;
      const temperature = dialog.value;
      setDialog(null);
      await controlXchangerClimate(
        action === "climateStart" ? "start" : "stop",
        temperature,
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const receipt = await native.command(dialog);
      setNotice(receipt);
      setDialog(null);
      await reloadHistory();
      if (!receipt.readback && receipt.status !== "rejected") {
        setSnapshot(await native.refresh(dialog.vin));
        await reloadHistory();
      }
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  function control(action: string, onSelect?: () => void) {
    let reason = unavailableReason(vehicle, action, experimental);
    if (
      !reason &&
      ["otaInstall", "otaSchedule"].includes(action) &&
      ![3, 10, 12].includes(numeric(snapshot, "software", "state") ?? -1)
    )
      reason = "软件须已下载，或已有可调整的安装计划";
    if (
      !reason &&
      action === "otaCancel" &&
      numeric(snapshot, "softwareSchedule", "status") !== 2
    )
      reason = "当前没有可取消的安装计划";
    return (
      <div className="native-control" key={action}>
        <button
          className="secondary-button"
          data-active={
            (action === "climateStop" && active.climate) ||
            (action === "lock" && active.unlocked) ||
            (action === "cleanStop" && active.cleaning)
          }
          disabled={busy || !connected || !!reason}
          onClick={() => {
            onSelect?.();
            openCommand(action);
          }}
        >
          {actionLabels[action]}
        </button>
        {reason && <small>{reason}</small>}
      </div>
    );
  }

  const percent = numeric(snapshot, "battery", "percent");
  const locked = snapshot?.readings.exterior?.value?.locked;
  const lockLabel =
    locked === true ? "已锁车" : locked === false ? "已解锁" : "门锁状态未知";
  const climate = String(
    snapshot?.readings.climate?.value?.activity ?? "unknown",
  );
  const target = numeric(displaySnapshot, "target", "percent");
  const lockAction = locked === true ? "unlock" : "lock";
  const climateAction = climate === "active" ? "climateStop" : "climateStart";
  const openingActions = ["windowsOpen", "windowsClose"].includes(
    dialog?.action ?? "",
  )
    ? ["windowsOpen", "windowsClose"]
    : ["unlockTrunk", "tailgateOpen", "tailgateClose"].includes(
          dialog?.action ?? "",
        )
      ? ["unlockTrunk", "tailgateOpen", "tailgateClose"]
      : [];
  const noticeReceipt =
    typeof notice === "string"
      ? null
      : (history.receipts.find((receipt) => receipt.id === notice.id) ??
        notice);
  const noticeText = noticeReceipt
    ? [
        actionLabels[noticeReceipt.command.action],
        noticeReceipt.message,
        noticeReceipt.readback,
      ]
        .filter(Boolean)
        .join(" · ")
    : String(notice);

  return (
    <>
      <a className="skip-link" href="#main">
        跳到内容
      </a>
      <header className="app-header native-header">
        <button
          className="wordmark"
          aria-label="Norr 北行 车辆首页"
          onClick={() => setPage("vehicle")}
        >
          Norr<span className="wordmark-dot">.</span>
        </button>
        <nav className="navigation" aria-label="主导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "selected" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={21} strokeWidth={1.5} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="header-actions">
          {fleet.length > 0 && (
            <select
              className="native-vehicle-select"
              aria-label="当前车辆"
              value={vin}
              disabled={busy}
              onChange={(event) => void selectVehicle(event.target.value)}
            >
              {fleet.map((car) => (
                <option key={car.vin} value={car.vin}>
                  {car.model} · {car.vin.slice(-4)}
                </option>
              ))}
            </select>
          )}
          <button
            className="icon-button theme-button"
            aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>
      <main id="main" className={`app-main native-main native-page-${page}`}>
        <div className="page-heading">
          <h1>{pages.find((item) => item.id === page)?.title}</h1>
          <button
            className="refresh-button"
            disabled={busy || !session?.hasSession}
            onClick={() => void refresh()}
          >
            <span>{busy ? "正在连接车辆" : "刷新车辆"}</span>
            <RefreshCw size={16} className={busy ? "spinning" : ""} />
          </button>
        </div>
        {error && (
          <div className="state-banner" role="alert">
            <span>{error}</span>
            <button disabled={busy} onClick={() => void refresh()}>
              重新连接
            </button>
          </div>
        )}
        {notice && (
          <div className="native-notice" role="status">
            <span>{noticeText}</span>
            <button className="text-button" onClick={() => setNotice("")}>
              收起
            </button>
          </div>
        )}
        {widgetError && (
          <p className="native-cache-note" role="status">
            小组件同步失败 · {widgetError}
          </p>
        )}
        {backgroundError && (
          <p className="native-cache-note" role="status">
            自动采集未完成 · {backgroundError}
          </p>
        )}
        {desktopError && (
          <div className="native-notice" role="status">
            <span>{desktopError}</span>
            <button className="text-button" onClick={() => setDesktopError("")}>
              收起
            </button>
          </div>
        )}
        {!connected && snapshot && (
          <p className="native-cache-note">
            本机缓存 · 最近读取于{" "}
            {new Date(snapshot.fetchedAt).toLocaleString("zh-CN")}
          </p>
        )}

        {page === "settings" ? (
          <>
            <SectionTabs
              items={["偏好", "账号", "通知与系统", "隐私与数据"]}
              value={settingsTab}
              onChange={setSettingsTab}
              label="设置分类"
            />
            <div className="settings-page">
              {settingsTab === "通知与系统" && (
                <>
                  <DesktopSettings />
                  <section className="native-section">
                    <h2>{isMobile ? "前台采集" : "后台采集"}</h2>
                    <label className="native-field">
                      自动刷新间隔
                      <select
                        value={history.settings?.refreshSeconds ?? 120}
                        disabled={busy}
                        onChange={(event) => {
                          setBusy(true);
                          void native
                            .setRefreshInterval(Number(event.target.value))
                            .then((settings) =>
                              setHistory((data) => ({ ...data, settings })),
                            )
                            .catch((problem: unknown) =>
                              setError(String(problem)),
                            )
                            .finally(() => setBusy(false));
                        }}
                      >
                        <option value={0}>关闭自动采集</option>
                        <option value={60}>每分钟</option>
                        <option value={120}>每 2 分钟</option>
                        <option value={300}>每 5 分钟</option>
                        <option value={600}>每 10 分钟</option>
                      </select>
                    </label>
                    <p className="muted">
                      {isMobile
                        ? "Norr 在前台时自动采集。切到其他应用或锁屏后暂停，返回时继续。"
                        : "关闭窗口后 Norr 继续在菜单栏或系统托盘运行。退出应用后停止采集。"}
                      车辆指令发送后会短时回读核对结果。
                    </p>
                  </section>
                </>
              )}
              {settingsTab === "账号" && (
                <section className="native-section">
                  <h2>
                    {session?.hasSession ? "本机登录会话" : "登录 Polestar"}
                  </h2>
                  {session?.hasSession && <p>会话已存入{credentialStorage}</p>}
                  {session?.expiresAt && (
                    <p className="muted">
                      当前访问授权有效至{" "}
                      {new Date(session.expiresAt).toLocaleString("zh-CN")}
                      ，到期时尝试续期。
                    </p>
                  )}
                  <PhoneSignIn
                    session={session}
                    busy={busy}
                    onBusyChange={setBusy}
                    onSignedIn={signedIn}
                  />
                  {fleet.some((car) => car.platform === "HUANFU") && (
                    <div className="native-section">
                      <h3>P4 远程授权</h3>
                      <p className="muted">
                        登录 Polestar 后，Norr 会用当前会话自动换取 ECARX
                        的 xchanger 授权，用于 P4 的位置、空气质量与远程空调，无需手动粘贴令牌。
                      </p>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void refreshXchanger()}
                      >
                        重新获取授权
                      </button>
                      {xchangerError && (
                        <p className="native-inline-error" role="alert">
                          {xchangerError}
                        </p>
                      )}
                    </div>
                  )}
                  {isIOS && (
                    <div className="native-section">
                      <h3>Apple Watch</h3>
                      <p className="muted">
                        恢复车辆连接、切换车辆及更新授权后，自动同步到已配对的手表。手表通过可用网络读取车辆及发送操作。清除手表登录态会暂停自动同步，点击下方同步按钮可恢复。
                      </p>
                      <button
                        className="secondary-button"
                        disabled={busy || !session?.hasSession || !vin}
                        onClick={() => void syncWatch()}
                      >
                        同步到 Apple Watch
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void syncWatch(true)}
                      >
                        清除手表登录态
                      </button>
                    </div>
                  )}
                  {import.meta.env.DEV && !isWindows && !isMobile && (
                    <>
                      <label className="native-field">
                        现有程序配置文件路径
                        <input
                          value={configPath}
                          placeholder="/path/to/.env.secrets"
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) =>
                            setConfigPath(event.target.value)
                          }
                        />
                      </label>
                      <p className="muted">
                        {session?.hasSigningKey
                          ? "签名配置已存入钥匙串，路径可留空。"
                          : "首次恢复时，选择包含 POLESTAR_CN_SIGNING_KEY 的原程序配置文件。"}
                      </p>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void importSession()}
                      >
                        复用 Hisingen 会话
                      </button>
                    </>
                  )}
                </section>
              )}
              {settingsTab === "偏好" && (
                <>
                  <div className="setting-row">
                    <div>
                      <h3>显示模式</h3>
                      <p>保存在本机</p>
                    </div>
                    <div className="segmented-control">
                      {(["light", "dark"] as const).map((mode) => (
                        <button
                          key={mode}
                          aria-pressed={theme === mode}
                          onClick={() => setTheme(mode)}
                        >
                          {mode === "light" ? "浅色" : "深色"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <section className="native-section">
                    <h2>车辆展示图片</h2>
                    <p className="muted">
                      图片按你的选择显示。实际车辆身份来自已连接账号。
                    </p>
                    <div className="form-stack">
                      <VehicleAppearancePicker
                        value={appearance}
                        modelLabel="素材车型"
                        onChange={(next) => {
                          setAppearance(next);
                          try {
                            localStorage.setItem(
                              `norr-appearance-${vin}`,
                              JSON.stringify(next),
                            );
                          } catch {
                            setError("图片选择暂时无法保存");
                          }
                        }}
                      />
                    </div>
                  </section>
                  <section className="native-section">
                    <h2>未验证平台（实验）</h2>
                    <p className="muted">
                      中国区 Polestar 2 的协议已完成实车验证。其他平台（例如 Polestar 4）的读取会按通用 C3
                      格式尝试；写入默认关闭，开启后才允许发送指令。
                    </p>
                    <div className="setting-row">
                      <div>
                        <h3>允许未验证平台控制</h3>
                        <p>仅在你理解风险、并会在车旁逐项核对时开启。</p>
                      </div>
                      <button
                        className="secondary-button"
                        aria-pressed={experimental}
                        disabled={busy || !session?.hasSession}
                        onClick={() => {
                          setBusy(true);
                          void native
                            .setExperimentalP4(!experimental)
                            .then((settings) =>
                              setHistory((data) => ({ ...data, settings })),
                            )
                            .catch((problem: unknown) =>
                              setError(String(problem)),
                            )
                            .finally(() => setBusy(false));
                        }}
                      >
                        {experimental ? "已开启" : "已关闭"}
                      </button>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={busy || !connected || !vin}
                      onClick={() => void runProbe()}
                    >
                      {busy ? "正在探测" : "运行兼容性探测"}
                    </button>
                    <p className="muted">
                      探测只读取车辆状态，不发送指令；失败项不代表车辆不支持。
                    </p>
                    {probe && (
                      <div className="probe-report">
                        <p>
                          {probe.model}
                          {probe.platform ? ` · ${probe.platform}` : ""} ·{" "}
                          {probe.protocol}协议 · 成功 {probe.succeeded}/
                          {probe.total}
                        </p>
                        <p className="muted">{probe.summary}</p>
                        <ul className="probe-list">
                          {probe.endpoints.map((endpoint) => (
                            <li
                              key={endpoint.kind}
                              data-status={endpoint.status}
                            >
                              <span>{endpoint.kind}</span>
                              <span>
                                {endpoint.status === "success"
                                  ? `${endpoint.fields} 个字段`
                                  : (endpoint.error ?? "失败")}
                              </span>
                              <span className="muted">
                                {endpoint.protocol}
                                {endpoint.fallback ? " · 回退" : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                </>
              )}
              {settingsTab === "隐私与数据" && (
                <>
                  <div className="setting-row">
                    <div>
                      <h3>本机历史与备份</h3>
                      <p>
                        查看采集、指令、充电和行程记录，导出或恢复 Norr 备份。
                      </p>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => setPage("history")}
                    >
                      管理历史数据
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>凭据保存</h3>
                      <p>登录会话保存在{credentialStorage}。</p>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>位置地图</h3>
                      <p>
                        有效车辆位置会自动加载高德地图，并将坐标提供给高德。坐标系与车辆外观选择保存在本机。
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        ) : page === "history" ? (
          <HistoryPanel
            vin={vin}
            revision={history.snapshots.at(-1)?.fetchedAt ?? 0}
          />
        ) : !vehicle ? (
          <section className="empty-state">
            <KeyRound size={48} strokeWidth={1} />
            <h2>
              {busy
                ? "正在连接车辆"
                : connected
                  ? "账号尚未返回车辆"
                  : "连接你的 Polestar"}
            </h2>
            <p>
              {busy
                ? "读取本机登录会话并连接厂商车辆服务。"
                : connected
                  ? "请确认此手机号已在 Polestar App 绑定车辆，然后刷新重试。"
                  : "使用中国大陆 Polestar 账号的手机号，通过短信验证码或密码登录。"}
            </p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setSettingsTab("账号");
                setPage("settings");
              }}
            >
              {session?.hasSession ? "管理账号" : "登录 Polestar"}
            </button>
          </section>
        ) : (
          <>
            {page === "vehicle" && (
              <>
                <div className="overview-grid">
                  <section
                    className="vehicle-stage"
                    aria-labelledby="vehicle-title"
                  >
                    <div className="vehicle-heading">
                      <div>
                        <h2 id="vehicle-title">{vehicle.model}</h2>
                        <p>{vehicle.modelYear ?? "年份待读取"} · 中国区</p>
                      </div>
                      <span className="lock-state">
                        <LockKeyhole size={15} />
                        {lockLabel}
                      </span>
                    </div>
                    <div className="vehicle-art">
                      <VehicleArtwork appearance={appearance} priority darkStage={theme === "dark"} />
                    </div>
                    <div className="vehicle-stage-footer">
                      <span>VIN ···· {vehicle.vin.slice(-4)}</span>
                      <span>
                        车内{" "}
                        {valueText(
                          numeric(snapshot, "climate", "interiorTemperature"),
                          " °C",
                          1,
                        )}
                      </span>
                    </div>
                  </section>
                  <EnergyPanelView
                    percent={percent}
                    target={target}
                    range={valueText(
                      numeric(snapshot, "battery", "rangeKm"),
                      " km",
                    )}
                    status={
                      chargeStates[
                        numeric(snapshot, "battery", "chargeState") ?? 0
                      ] ?? "充电状态未知"
                    }
                    detail={
                      <small title={readingText(snapshot, "battery")}>
                        {readingText(snapshot, "battery", compact)}
                      </small>
                    }
                    actions={
                      <button
                        className="light-button"
                        onClick={() => setPage("charging")}
                      >
                        {compact ? (
                          <>
                            充电详情
                            <ChevronRight size={16} aria-hidden="true" />
                          </>
                        ) : (
                          "查看充电数据"
                        )}
                      </button>
                    }
                  />
                </div>
                <div className="section-heading">
                  <h2>快捷控制</h2>
                  <button
                    className="text-button"
                    onClick={() => setPage("controls")}
                  >
                    全部控制
                    <ArrowRight size={17} aria-hidden="true" />
                  </button>
                </div>
                <div className="quick-controls">
                  <button
                    className="control-tile"
                    data-active={active.unlocked}
                    disabled={
                      busy ||
                      !connected ||
                      !!unavailableReason(vehicle, lockAction, experimental)
                    }
                    onClick={() => openCommand(lockAction)}
                  >
                    <div className="tile-heading">
                      <h3>车门与门锁</h3>
                      <ArrowUpRight size={21} aria-hidden="true" />
                    </div>
                    <p>{lockLabel}</p>
                    {unavailableReason(vehicle, lockAction, experimental) && (
                      <p>{unavailableReason(vehicle, lockAction, experimental)}</p>
                    )}
                    <div className="tile-bottom">
                      <LockKeyhole
                        size={35}
                        strokeWidth={1.2}
                        aria-hidden="true"
                      />
                      <span>{actionLabels[lockAction]}</span>
                    </div>
                  </button>
                  <button
                    className="control-tile"
                    data-active={active.climate}
                    disabled={
                      busy ||
                      !connected ||
                      !!unavailableReason(vehicle, climateAction, experimental)
                    }
                    onClick={() => openCommand(climateAction)}
                  >
                    <div className="tile-heading">
                      <h3>座舱温度</h3>
                      <ArrowUpRight size={21} aria-hidden="true" />
                    </div>
                    <p>
                      {climateStates[climate] ?? "状态未知"} ·{" "}
                      {valueText(
                        numeric(snapshot, "climate", "interiorTemperature"),
                        " °C",
                        1,
                      )}
                    </p>
                    {unavailableReason(vehicle, climateAction, experimental) && (
                      <p>{unavailableReason(vehicle, climateAction, experimental)}</p>
                    )}
                    <div className="tile-bottom">
                      <Fan size={35} strokeWidth={1.2} aria-hidden="true" />
                      <span>{actionLabels[climateAction]}</span>
                    </div>
                  </button>
                  {!compact && (
                    <button
                      className="control-tile"
                      onClick={() => {
                        detailsRef.current?.focus();
                        detailsRef.current?.scrollIntoView({
                          block: "start",
                        });
                      }}
                    >
                      <div className="tile-heading">
                        <h3>车辆详情</h3>
                        <ArrowUpRight size={21} aria-hidden="true" />
                      </div>
                      <p>
                        总里程{" "}
                        {valueText(
                          numeric(snapshot, "odometer", "km"),
                          " km",
                          1,
                        )}
                      </p>
                      <div className="tile-bottom">
                        <Shield
                          size={35}
                          strokeWidth={1.2}
                          aria-hidden="true"
                        />
                        <span>状态与健康</span>
                      </div>
                    </button>
                  )}
                </div>
                {compact ? (
                  <div className="native-overview-links">
                    <button
                      className="text-button"
                      onClick={() => setVehicleSheet("details")}
                    >
                      <Shield size={18} aria-hidden="true" />
                      车辆详情
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setVehicleSheet("location")}
                    >
                      <MapPin size={18} aria-hidden="true" />
                      车辆位置
                    </button>
                  </div>
                ) : (
                  <>
                    <div ref={detailsRef} tabIndex={-1}>
                      <VehicleDetails
                        snapshot={displaySnapshot}
                        position={xchangerPoint}
                        onError={setError}
                      />
                    </div>
                    <EndpointStatus snapshot={displaySnapshot} />
                  </>
                )}
              </>
            )}
            {page === "controls" && (
              <NativeControls
                key={vin}
                vehicle={vehicle}
                appearance={appearance}
                history={history.snapshots}
                snapshot={displaySnapshot}
                receipts={history.receipts}
                disabled={busy || !connected}
                control={control}
                experimental={experimental}
                onCommand={setDialog}
                onHistory={() => setPage("history")}
                openings={<OpeningStatus snapshot={snapshot} />}
              />
            )}
            {page === "charging" && (
              <>
                <SectionTabs
                  items={["充电状态", "计划与地点"]}
                  value={chargingTab}
                  onChange={setChargingTab}
                  label="充电分类"
                />
                {chargingTab === "充电状态" ? (
                  <div className="charging-layout">
                    <EnergyPanelView
                      percent={percent}
                      target={target}
                      range={valueText(
                        numeric(snapshot, "battery", "rangeKm"),
                        " km",
                      )}
                      status={
                        chargeStates[
                          numeric(snapshot, "battery", "chargeState") ?? 0
                        ] ?? "充电状态未知"
                      }
                      detail={<small>{readingText(snapshot, "battery")}</small>}
                      actions={
                        <button
                          className="light-button"
                          disabled={
                            busy ||
                            !connected ||
                            !!unavailableReason(vehicle, "target", experimental)
                          }
                          onClick={() => openCommand("target")}
                        >
                          充电设置
                        </button>
                      }
                    />
                    <section className="charge-details">
                      <h2>当前充电读数</h2>
                      <DataRows
                        rows={[
                          [
                            "当前功率",
                            valueText(
                              numeric(snapshot, "battery", "powerKw"),
                              " kW",
                              1,
                            ),
                          ],
                          [
                            "电压 / 电流",
                            `${valueText(numeric(snapshot, "battery", "voltage"), " V")} / ${valueText(numeric(snapshot, "battery", "currentA"), " A", 1)}`,
                          ],
                          [
                            "充至目标剩余",
                            valueText(
                              numeric(snapshot, "battery", "minutesToTarget"),
                              " 分钟",
                            ),
                          ],
                          ["目标电量", valueText(target, "%")],
                        ]}
                      />
                      <div className="list-row">
                        <div>
                          <h3>电流限制</h3>
                          <p>
                            {valueText(
                              numeric(snapshot, "amperage", "amps"),
                              " A",
                            )}{" "}
                            · {readingText(snapshot, "amperage")}
                          </p>
                        </div>
                        {control("amperage")}
                      </div>
                      <div className="list-row">
                        <div>
                          <h3>临时充电</h3>
                          <p>立即充电或恢复车辆已保存的充电日程。</p>
                        </div>
                        <div className="row-actions">
                          {["chargeStart", "chargeStop"].map((action) =>
                            control(action),
                          )}
                        </div>
                      </div>
                      <p className="muted native-reading-time">
                        目标电量 · {readingText(displaySnapshot, "target")}
                      </p>
                    </section>
                  </div>
                ) : (
                  <>
                    <SchedulePanel
                      kind="charging"
                      vehicle={vehicle}
                      snapshot={snapshot}
                      disabled={busy || !connected}
                      experimental={experimental}
                      onCommand={setDialog}
                    />
                    <ChargeLocations snapshot={snapshot} />
                  </>
                )}
              </>
            )}
          </>
        )}
        <footer className="page-footer">
          <span>Norr 北行 · {desktopName}</span>
          <span>{connected ? "中国区车辆服务已连接" : "车辆服务未连接"}</span>
        </footer>
      </main>
      {vehicleSheet && (
        <Modal
          title={vehicleSheet === "details" ? "车辆详情" : "车辆位置"}
          className="native-vehicle-sheet"
          onClose={() => setVehicleSheet(null)}
        >
          <div className="native-vehicle-sheet-content">
            {vehicleSheet === "details" ? (
              <>
                <VehicleDetails
                  snapshot={displaySnapshot}
                  position={xchangerPoint}
                  onError={setError}
                  includeMap={false}
                />
                <EndpointStatus snapshot={displaySnapshot} />
              </>
            ) : (
              <VehicleMap
                  key={vin}
                  snapshot={displaySnapshot}
                  position={xchangerPoint}
                  onError={setError}
                />
            )}
            {error && (
              <p role="alert" className="native-inline-error">
                {error}
              </p>
            )}
          </div>
        </Modal>
      )}
      {dialog && (
        <Modal
          title={actionLabels[dialog.action]}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <p className="modal-description">
            将对 {vehicle?.model} · {dialog.vin.slice(-4)} 执行此操作。
          </p>
          {dialog.action === "climateStart" && !supportsTemperature && (
            <p className="modal-description">使用默认舒适温度 22 °C。</p>
          )}
          {dialog.schedule && (
            <p className="modal-description">
              {scheduleText(dialog.schedule)}
              <br />
              时区 {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>
          )}
          {dialog.action === "deleteClimateTimer" && (
            <p className="modal-description">
              删除后将重新读取完整日程列表核对结果。
            </p>
          )}
          {["otaInstall", "otaSchedule"].includes(dialog.action) && (
            <p className="modal-description">
              请确认车辆已停妥并符合车机更新条件。软件安装期间车辆可能无法使用。
            </p>
          )}
          {["windowsOpen", "tailgateOpen", "tailgateClose"].includes(
            dialog.action,
          ) && (
            <p className="modal-description">请确认车辆周围空间允许此操作。</p>
          )}
          {chargeOptions && (
            <>
              <div className="limit-readout">
                <output htmlFor="native-charge-limit">
                  {dialog.value ?? "待选择"}
                  <span>{chargeUnit}</span>
                </output>
              </div>
              <label className="range-label" htmlFor="native-charge-limit">
                {chargeAction === "target" ? "目标电量" : "交流电流上限"}
                <span>
                  {limits.min}–{limits.max} {chargeUnit}
                </span>
              </label>
              <input
                id="native-charge-limit"
                type="range"
                min={0}
                max={Math.max(0, chargeOptions.values.length - 1)}
                step={1}
                value={Math.max(
                  0,
                  chargeOptions.values.indexOf(dialog.value ?? NaN),
                )}
                aria-valuetext={`${dialog.value ?? "待选择"} ${chargeUnit}`}
                disabled={busy || chargeOptions.values.length < 2}
                onChange={(event) =>
                  setDialog({
                    ...dialog,
                    value: chargeOptions.values[Number(event.target.value)],
                  })
                }
              />
              <div
                className="limit-presets native-charge-presets"
                role="group"
                aria-label="快捷档位"
              >
                {chargeOptions.presets.map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    aria-pressed={dialog.value === value}
                    onClick={() => setDialog({ ...dialog, value })}
                  >
                    {value} {chargeUnit}
                  </button>
                ))}
              </div>
              <p className="modal-description">
                {chargeAction === "target"
                  ? "按 5% 调节，可保留车辆当前值及范围端点。"
                  : "按 1 A 调节，实际交流充电电流受充电桩与线缆限制。"}
              </p>
            </>
          )}
          {needsValue && !chargeOptions && (
            <label className="native-field">
              {dialog.action === "climateStart"
                ? "目标温度 °C"
                : dialog.action === "otaSchedule"
                  ? "从现在起等待分钟数"
                  : dialog.action === "target"
                    ? "目标电量 %"
                    : "交流电流上限 A"}
              <input
                type="number"
                step={limits.step}
                min={limits.min}
                max={limits.max}
                disabled={busy}
                value={dialog.value ?? ""}
                onChange={(event) =>
                  setDialog({
                    ...dialog,
                    value:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                  })
                }
              />
            </label>
          )}
          {needsValue && !validValue && (
            <p role="status">
              {chargeOptions
                ? "请选择车辆支持范围内的档位。"
                : `请输入 ${limits.min} 至 ${limits.max}，步长为 ${limits.step}。`}
            </p>
          )}
          {experimental && unverifiedPlatform && (
            <p className="native-inline-error" role="note">
              该平台（{vehicle?.platform ?? "未知"}
              ）尚未实车验证，指令按通用格式发送；请以车辆实际动作和回读为准。
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="button-row">
            <button
              className="primary-button"
              disabled={
                busy ||
                !!unavailableReason(vehicle, dialog.action, experimental) ||
                !validValue
              }
              onClick={() => void sendCommand()}
            >
              {busy ? "正在发送并读取状态" : "确认执行"}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              取消
            </button>
          </div>
          {openingActions.length > 0 && (
            <details className="native-command-options">
              <summary>
                {dialog.action.startsWith("windows")
                  ? "其他车窗操作"
                  : "其他尾门操作"}
              </summary>
              <div className="native-actions">
                {openingActions
                  .filter((action) => action !== dialog.action)
                  .map((action) => control(action))}
              </div>
            </details>
          )}
          <p className="modal-footnote">
            服务回执与车辆回读可在指令记录中查看。
          </p>
        </Modal>
      )}
    </>
  );
}

function EndpointStatus({ snapshot }: { snapshot: Snapshot | undefined }) {
  return (
    <details className="native-section native-endpoint-status">
      <summary>数据更新时间</summary>
      <dl className="native-readings">
        {Object.entries(endpointLabels).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{readingText(snapshot, key)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function OpeningStatus({ snapshot }: { snapshot: Snapshot | undefined }) {
  const openings = snapshot?.readings.exterior?.value?.openings as
    Record<string, number | null> | undefined;
  const labels: Record<string, string> = {
    frontLeftDoor: "左前门",
    frontRightDoor: "右前门",
    rearLeftDoor: "左后门",
    rearRightDoor: "右后门",
    frontLeftWindow: "左前窗",
    frontRightWindow: "右前窗",
    rearLeftWindow: "左后窗",
    rearRightWindow: "右后窗",
    hood: "前盖",
    tailgate: "尾门",
    chargeLid: "充电盖",
    sunroof: "天窗",
  };
  return (
    <dl className="native-readings">
      {Object.entries(labels).map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>
            {openings?.[key] === 1
              ? "开启"
              : openings?.[key] === 2
                ? "关闭"
                : openings?.[key] === 3
                  ? "未关严"
                  : "未知"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
