import {
  credentialStorage,
  desktopName,
  isAndroid,
  isIOS,
  isMobile,
  isWindows,
  supportsAppUpdates,
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
import { SkyPullRefresh, type RefreshOutcome } from "../components/SkyPullRefresh";
import { P4OverviewView } from "../components/P4Overview";
import { VehicleArtwork } from "../components/VehicleArtwork";
import { VehicleAppearancePicker } from "../components/VehicleAppearancePicker";
import { EnergyPanelView } from "../components/EnergyPanel";
import { DataRows, SectionTabs } from "../components/WorkspaceUI";
import { NativeControls } from "./NativeControls";
import { SchedulePanel } from "./SchedulePanel";
import { HistoryPanel } from "./HistoryPanel";
import { P4TestLog } from "./P4TestLog";
import { P4Recording } from "./P4Recording";
import { DesktopSettings } from "./DesktopSettings";
import { PhoneSignIn } from "./PhoneSignIn";
import { ChargeLocations, OpeningStatus, P4ClimateDetails, VehicleDetails } from "./VehicleDetails";
import { About, UpdatePrompt, useAppUpdates } from "./About";
import { VehicleMap } from "./VehicleMap";
import { artworkPath, defaultAppearance, sideCutoutPath, validAppearance } from "../vehicle-catalog";
import type { VehicleAppearance } from "../vehicle-catalog";
import {
  actionLabels, serviceMessage,
  p4FindActions,
  activeControls,
  isNativeP4,
  p4CabinActions,
  commandLimits,
  chargingOptions,
  chargingPlugText,
  chargingStatusText,
  chargingTimeText,
  native,
  numeric,
  readingText,
  refreshOutcome,
  scheduleText,
  unavailableReason,
} from "./client";
import type {
  Command,
  History,
  NativeVehicle,
  Receipt,
  SessionStatus,
  Snapshot,
} from "./client";
import { useIOSTabBar } from "./useIOSTabBar";
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

function recoveryError(message: string) {
  return message.includes("重新登录中国区账号") ||
    (message.includes("P4 会话恢复") && /HTTP 400，业务码 6666[）)]/.test(message));
}

export default function NativeApp({ onFieldLog, p4Logging = false }: { onFieldLog?: () => void; p4Logging?: boolean }) {
  const [page, setPage] = useState("vehicle");
  useIOSTabBar(pages, setPage);
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  const [chargingTab, setChargingTab] = useState("充电状态");
  const updates = useAppUpdates(supportsAppUpdates && !onFieldLog && !p4Logging);
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
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [desktopError, setDesktopError] = useState("");
  const [notificationTarget, setNotificationTarget] = useState<{
    vin: string;
    page: string;
  } | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [dialog, setDialog] = useState<Command | null>(null);
  const [vehicleSheet, setVehicleSheet] = useState<
    "details" | "location" | "车锁" | "空调" | "尾门" | "寻车" | "座舱净化" | "充电上限" | null
  >(null);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const [appearance, setAppearance] = useState(defaultAppearance());
  const [carplayView, setCarplayView] = useState<"side" | "front">(() => {
    try { return localStorage.getItem("norr-carplay-view") === "front" ? "front" : "side"; }
    catch { return "side"; }
  });
  const [widgetTarget, setWidgetTarget] = useState<WidgetTarget | null>(null);
  const widgetSync = useRef(Promise.resolve());
  const [themeMode, setTheme] = useState<"light" | "dark" | "system">(() => {
    try {
      const stored = localStorage.getItem("norr-native-theme");
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
      return "system";
    }
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
  const started = useRef(false);
  const selectedVehicle = useRef("");
  const refreshing = useRef(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  const vehicle =
    snapshot?.vehicle.vin === vin
      ? snapshot.vehicle
      : fleet.find((car) => car.vin === vin);
  const supportsTemperature =
    vehicle?.capabilities
      .supportsParkingClimatizationCompartmentTemperatureSettings === true;
  const p4 = isNativeP4(vehicle);
  const active = activeControls(snapshot);
  const needsValue =
    dialog?.action === "target" ||
    dialog?.action === "amperage" ||
    dialog?.action === "otaSchedule" ||
    p4CabinActions.includes(dialog?.action ?? "") ||
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
    const query = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    document.title = `Norr 北行 · ${pages.find((item) => item.id === page)?.label}`;
  }, [page]);

  useLayoutEffect(() => {
    if (!isIOS) return;
    document.documentElement.classList.add("native-ios");
    return () => document.documentElement.classList.remove("native-ios");
  }, []);

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
      localStorage.setItem("norr-native-theme", themeMode);
    } catch {
      /* Theme still applies to the current window. */
    }
  }, [theme, themeMode]);

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
    if (p4Logging || !supportsWidgets) {
      setWidgetError("");
      return;
    }
    let disposed = false;
    const data = snapshot && snapshot.vehicle.vin === vin
      ? { ...widgetData(snapshot, storedAppearance(vin, snapshot.vehicle.model)), carplayFront: isIOS && carplayView === "front" }
      : null;
    widgetSync.current = widgetSync.current
      .then(() => native.updateWidgets(data))
      .then(() => { if (!disposed) setWidgetError(""); })
      .catch((problem) => {
        console.error("小组件数据同步失败", problem);
        if (!disposed) setWidgetError(String(problem));
      });
    return () => { disposed = true; };
  }, [snapshot, vin, appearance, p4Logging, carplayView]);

  useEffect(() => {
    if (p4Logging || !supportsWidgets) return;
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
      const reason = unavailableReason(vehicle, action);
      if (reason) setError(reason);
      else openCommand(action);
    }
  }, [widgetTarget, busy, connected, vin, fleet]);

  useEffect(() => {
    let disposed = false;
    const subscriptions = [
      native.onSnapshot((next) => {
        if (disposed) return;
        if (next.vehicle.vin === selectedVehicle.current) {
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
      const preferred = data.settings?.selectedVin;
      const cached = preferred
        ? data.snapshots.filter((item) => item.vehicle.vin === preferred).at(-1)
        : data.snapshots.at(-1);
      if (cached) {
        setSnapshot(cached);
        setVin(cached.vehicle.vin);
      }
      const status = await native.status();
      setSession(status);
      if (status.hasSession && status.hasSigningKey)
        await connect(preferred ?? cached?.vehicle.vin);
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
    let next: Snapshot | undefined;
    if (selected) {
      selectedVehicle.current = selected.vin;
      setVin(selected.vin);
      if (selected.vin !== preferred) setSnapshot(undefined);
      next = await native.refresh(selected.vin);
      if (next.vehicle.vin !== selectedVehicle.current) return;
      setSnapshot(next);
      await reloadHistory();
    } else {
      setVin("");
      setSnapshot(undefined);
    }
    setSession(await native.status());
    return next;
  }

  async function refresh(receiptId?: string): Promise<RefreshOutcome> {
    if (busy || refreshing.current) return "cancelled";
    refreshing.current = true;
    setBusy(true);
    setError("");
    try {
      let next: Snapshot | undefined;
      if (!receiptId && (!connected || !vin)) next = await connect(vin);
      else {
        next = await native.refresh(vin, receiptId);
        if (next.vehicle.vin !== selectedVehicle.current) return "cancelled";
        setSnapshot(next);
        await reloadHistory();
      }
      setSession(await native.status());
      setBackgroundError("");
      return refreshOutcome(next);
    } catch (problem) {
      setError(String(problem));
      if (!receiptId) setConnected(false);
      return "error";
    } finally {
      refreshing.current = false;
      setBusy(false);
    }
  }

  async function selectVehicle(selected: string) {
    setDialog(null);
    setVehicleSheet(null);
    setNotice("");
    selectedVehicle.current = selected;
    setVin(selected);
    setSnapshot(
      history.snapshots.filter((item) => item.vehicle.vin === selected).at(-1),
    );
    setBusy(true);
    setError("");
    try {
      const next = await native.refresh(selected);
      if (next.vehicle.vin !== selectedVehicle.current) return;
      setSnapshot(next);
      await reloadHistory();
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function checkReceipt(receipt: Receipt) {
    if (receipt.command.vin !== vin || busy) return;
    if (Date.now() - receipt.time >= 600_000) {
      setNotice("已超过十分钟核对时限。原操作结果仍待确认。");
      await refresh();
      return;
    }
    setNotice(receipt);
    await refresh(receipt.id);
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
    setRecoveryOpen(false);
    selectedVehicle.current = "";
    setDialog(null);
    setVehicleSheet(null);
    setHistory({ snapshots: [], receipts: [] });
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
        ? numeric(snapshot, "target", "percent")
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

  async function sendCommand() {
    if (!dialog || busy || !validValue) return;
    const reason = unavailableReason(vehicle, dialog.action);
    if (dialog.vin !== vin || reason) { setError(reason ?? "车辆已切换，请重新选择操作"); return; }
    setBusy(true);
    setError("");
    try {
      const receipt = await native.command(dialog);
      if (selectedVehicle.current !== receipt.command.vin) return;
      setNotice(receipt);
      setDialog(null);
      await reloadHistory();
      if (!receipt.readback && receipt.status !== "rejected" && !(p4 && p4FindActions.includes(dialog.action))) {
        const next = await native.refresh(dialog.vin);
        if (next.vehicle.vin !== selectedVehicle.current) return;
        setSnapshot(next);
        await reloadHistory();
      }
    } catch (problem) {
      setError(String(problem));
    } finally {
      setBusy(false);
    }
  }

  function control(action: string, onSelect?: () => void) {
    let reason = unavailableReason(vehicle, action);
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
  const rangeKm = numeric(snapshot, "battery", "rangeKm");
  const exterior = snapshot?.readings.exterior;
  const body = exterior?.status === "success" ? exterior.value : null;
  const locked = body?.locked;
  const lockLabel =
    locked === true ? "已锁车" : locked === false ? "已解锁" : "门锁状态未知";
  const climate = String(
    snapshot?.readings.climate?.status === "success" ? snapshot.readings.climate.value?.activity ?? "unknown" : "unknown",
  );
  const chargeLabel = chargingStatusText(snapshot);
  const chargeTime = chargingTimeText(snapshot);
  const chargingSummary = snapshot?.readings.battery?.status === "success" && numeric(snapshot, "battery", "chargeState") === 1
    ? `正在充电 · ${chargeTime === null ? "充满时间未返回" : `预计充满还需 ${chargeTime}`}`
    : null;
  const target = numeric(snapshot, "target", "percent");
  const tailgate = (body?.openings as Record<string, unknown> | undefined)?.tailgate;
  const p4Air = numeric(snapshot, "airQuality", "pm25");
  const cleaning = numeric(snapshot, "airQuality", "state");
  const cleaningLabel = cleaning === 1 ? "净化中" : cleaning === 2 ? "净化已停止" : "净化状态未知";
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
  const pendingReceipt = noticeReceipt?.command.vin === vin && noticeReceipt.readback &&
    noticeReceipt.status !== "rejected" && noticeReceipt.readback !== "回读一致" &&
    !p4FindActions.includes(noticeReceipt.command.action) ? noticeReceipt : null;
  const [delayedReceipt, setDelayedReceipt] = useState("");
  useEffect(() => {
    if (!pendingReceipt) return;
    const id = window.setTimeout(() => setDelayedReceipt(pendingReceipt.id),
      Math.max(0, pendingReceipt.time + 60_000 - Date.now()));
    return () => window.clearTimeout(id);
  }, [pendingReceipt?.id, pendingReceipt?.time]);
  const noticeText = noticeReceipt
    ? [
        actionLabels[noticeReceipt.command.action],
        serviceMessage(noticeReceipt),
        noticeReceipt.readback,
      ]
        .filter(Boolean)
        .join(" · ")
    : String(notice);
  const signInAction = <button type="button" disabled={busy} onClick={() => setRecoveryOpen(true)}>重新登录账号</button>;

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
          {onFieldLog && <button className="text-button" onClick={onFieldLog}>返回实测</button>}
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
        {isIOS && vehicle && (
          <div className="fold-portrait" aria-hidden="true"
            style={{ backgroundImage: `url("${sideCutoutPath(appearance)}")` }} />
        )}
      </header>
      <SkyPullRefresh enabled={page === "vehicle" && !!vehicle && !!session?.hasSession && !dialog && !vehicleSheet}
        busy={busy} onRefresh={refresh} resetKey={`${page}:${vin}`}>
      <main id="main" className={`app-main native-main native-page-${page}${p4 ? " p4-workspace" : ""}`}>
        <div className="page-heading">
          <h1>{p4 && page === "vehicle" ? vehicle?.model : pages.find((item) => item.id === page)?.title}</h1>
          <button
            className="refresh-button"
            disabled={busy || !session?.hasSession}
            onClick={() => void refresh()}
          >
            <span>{busy ? "正在连接车辆" : "刷新车辆"}</span>
            <RefreshCw size={16} className={busy ? "spinning" : ""} />
          </button>
        </div>
        {!(page === "settings" && settingsTab === "关于") && <UpdatePrompt updates={updates} />}
        {error && (
          <div className="state-banner" role="alert">
            <span>{error}</span>
            {recoveryError(error) ? signInAction : <button disabled={busy} onClick={() => void refresh()}>
              重新连接
            </button>}
          </div>
        )}
        {notice && (
          <div className="native-notice" role="status">
            <span>{noticeText}</span>
            {pendingReceipt && delayedReceipt === pendingReceipt.id && <span>已超过一分钟，本次操作仍待确认。</span>}
            {pendingReceipt && (
                <button className="text-button" disabled={busy} onClick={() => void checkReceipt(pendingReceipt)}>
                  {busy ? "正在读取车况…" : Date.now() - pendingReceipt.time < 600_000 ? "重新核对车况" : "查看当前车况"}
                </button>
              )}
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
        {backgroundError && !(recoveryError(error) && recoveryError(backgroundError)) && (
          <div className={recoveryError(backgroundError) ? "state-banner" : "native-cache-note"} role="status">
            <span>
            自动采集未完成 · {backgroundError}
            </span>
            {recoveryError(backgroundError) && signInAction}
          </div>
        )}
        {recoveryOpen && <Modal title="重新登录中国区账号" onClose={() => setRecoveryOpen(false)}>
          <PhoneSignIn session={session} busy={busy} onBusyChange={setBusy}
            onCancel={() => setRecoveryOpen(false)} onSignedIn={signedIn} />
        </Modal>}
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
              items={["偏好", "账号", "通知与系统", "隐私与数据", "关于"]}
              value={settingsTab}
              onChange={setSettingsTab}
              label="设置分类"
            />
            <div className="settings-page">
              {settingsTab === "关于" && <About updates={updates} />}
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
                  {isIOS && !p4Logging && (
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
                      {(["system", "light", "dark"] as const).map((mode) => (
                        <button
                          key={mode}
                          aria-pressed={themeMode === mode}
                          onClick={() => setTheme(mode)}
                        >
                          {mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"}
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
                  {isIOS && !p4Logging && (
                    <section className="native-section">
                      <h2>CarPlay 小组件</h2>
                      <p className="muted">在 CarPlay 的小组件中添加「北行车影」。车漆、轮毂和下饰板跟随当前车辆。</p>
                      <div className="carplay-angles" role="group" aria-label="车辆视角">
                        {(["side", "front"] as const).map(view => (
                          <button key={view} aria-pressed={carplayView === view} onClick={() => {
                            try {
                              localStorage.setItem("norr-carplay-view", view);
                              setCarplayView(view);
                            } catch { setError("小组件视角未能保存"); }
                          }}>
                            <img src={artworkPath(appearance, view).replace(".jpg", view === "side" ? "-cutout.webp" : "-portrait.webp")} width="160" height="78" alt="" />
                            {view === "side" ? "侧面" : "前侧"}{carplayView === view && <span aria-hidden="true"> ✓</span>}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
              {settingsTab === "隐私与数据" && (
                <>
                  {(p4Logging || (p4 && (isIOS || isWindows || isAndroid))) && session?.hasSession ? <P4Recording key={vin} vin={vin} controls={false} onRefresh={() => void refresh()} refreshing={busy} /> : p4 && <P4TestLog key={vin} vin={vin} />}
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
                        {p4 ? "首次打开高德地图需点按确认。可在车辆位置页开启或关闭此车的自动显示。" : "有效车辆位置会自动加载高德地图，并将坐标提供给高德。坐标系与车辆外观选择保存在本机。"}
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
            {page === "vehicle" && p4 && <P4OverviewView appearance={appearance}
              range={rangeKm === null ? "—" : valueText(rangeKm)} unit={rangeKm === null ? "" : "km"} battery={percent}
              locked={typeof locked === "boolean" ? locked : null}
              inside={valueText(numeric(snapshot, "climate", "interiorTemperature"), " °C", 1)}
              outside={valueText(numeric(snapshot, "climate", "exteriorTemperature"), " °C", 1)}
              climate={climateStates[climate] ?? "状态未知"} air={p4Air} cleaning={cleaningLabel}
              limit={target === null ? "尚无车辆读数" : `当前设定 ${target}%`}
              chargingSummary={chargingSummary}
              chargingUpdated={readingText(snapshot, "battery", compact)}
              onControl={action => setVehicleSheet(({ lock: "车锁", climate: "空调", tailgate: "尾门",
                locate: "寻车", cleaning: "座舱净化", limit: "充电上限" } as const)[action])}
              onNavigate={destination => {
                if (destination === "details" || destination === "location") setVehicleSheet(destination);
                else setPage(destination);
              }} />}
            {page === "vehicle" && !p4 && (
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
                      <span>车内 {valueText(numeric(snapshot, "climate", "interiorTemperature"), " °C", 1)}</span>
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
                      chargingSummary ?? chargeLabel
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
                      !!unavailableReason(vehicle, lockAction)
                    }
                    onClick={() => openCommand(lockAction)}
                  >
                    <div className="tile-heading">
                      <h3>车门与门锁</h3>
                      <ArrowUpRight size={21} aria-hidden="true" />
                    </div>
                    <p>{lockLabel}</p>
                    {unavailableReason(vehicle, lockAction) && (
                      <p>{unavailableReason(vehicle, lockAction)}</p>
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
                      !!unavailableReason(vehicle, climateAction)
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
                    {unavailableReason(vehicle, climateAction) && (
                      <p>{unavailableReason(vehicle, climateAction)}</p>
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
                      <VehicleDetails snapshot={snapshot} onError={setError} />
                    </div>
                    <EndpointStatus snapshot={snapshot} />
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
                snapshot={snapshot}
                receipts={history.receipts}
                disabled={busy || !connected}
                control={control}
                onCommand={setDialog}
                onCheckReceipt={checkReceipt}
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
                        chargeLabel
                      }
                      detail={<small>{readingText(snapshot, "battery")}</small>}
                      actions={p4 ? (
                        <button className="light-button" onClick={() => setChargingTab("计划与地点")}>
                          查看充电预约
                        </button>
                      ) : (
                        <button
                          className="light-button"
                          disabled={
                            busy ||
                            !connected ||
                            !!unavailableReason(vehicle, "target")
                          }
                          onClick={() => openCommand("target")}
                        >
                          充电设置
                        </button>
                      )}
                    />
                    <section className="charge-details">
                      <h2>当前充电读数</h2>
                      <DataRows
                        rows={p4 ? [
                          ["预计充满剩余", chargeTime ?? "未知"],
                          ["充电枪", chargingPlugText(snapshot)],
                        ] : [
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
                            "预计充满剩余",
                            chargeTime ?? "未知",
                          ],
                          ["目标电量", valueText(target, "%")],
                        ]}
                      />
                      {p4 ? <button className="text-button" onClick={() => setVehicleSheet("充电上限")}>充电上限</button> : <>
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
                        目标电量 · {readingText(snapshot, "target")}
                      </p></>}
                    </section>
                  </div>
                ) : (
                  <>
                    <SchedulePanel
                      kind="charging"
                      vehicle={vehicle}
                      snapshot={snapshot}
                      disabled={busy || !connected}
                      onCommand={setDialog}
                    />
                    {p4 ? <details><summary>充电地点</summary><p>充电地点数据待接入。</p></details> : <ChargeLocations snapshot={snapshot} />}
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
      </SkyPullRefresh>
      {vehicleSheet && (
        <Modal
          title={vehicleSheet === "details" ? "车辆详情" : vehicleSheet === "location" ? "车辆位置" : p4 && vehicleSheet === "空调" ? "座舱设置" : vehicleSheet}
          className={p4 && vehicleSheet !== "details" && vehicleSheet !== "location" ? "p4-sheet" : "native-vehicle-sheet"}
          onClose={() => setVehicleSheet(null)}
        >
          <div className="native-vehicle-sheet-content">
            {vehicleSheet === "座舱净化" ? <>
              <div className="p4-clean"><span>车内 PM2.5</span><p>{p4Air ?? "—"}{p4Air !== null && <small>μg/m³</small>}</p><span>{cleaningLabel}</span></div>
              <p className="p4-action-note">{readingText(snapshot, "airQuality")}</p>{control(cleaning === 1 ? "cleanStop" : "cleanStart", () => setVehicleSheet(null))}
            </> : vehicleSheet === "充电上限" ? <>
              <div className="limit-readout"><output>{target ?? "—"}{target !== null && <span>%</span>}</output></div>
              <p className="p4-action-note">{readingText(snapshot, "target")}</p>{control("target", () => setVehicleSheet(null))}
            </> : vehicleSheet === "寻车" ? (
              <div className="native-actions">{p4FindActions.map((action) => control(action, () => setVehicleSheet(null)))}</div>
            ) : vehicleSheet === "空调" ? <P4ClimateDetails snapshot={snapshot} activity={climateStates[climate] ?? "未知"} disabled={busy || !connected} onCommand={command => { setVehicleSheet(null); setError(""); setDialog(command); }} controls={control(climateAction, () => setVehicleSheet(null))} /> :
             vehicleSheet === "尾门" || vehicleSheet === "车锁" ? <>
               <dl className="p4-body-states"><div><dt>{vehicleSheet === "车锁" ? "门锁状态" : "尾门位置"}</dt>
                 <dd>{vehicleSheet === "车锁" ? lockLabel : tailgate === 1 ? "已打开" : tailgate === 2 ? "已关闭" : "状态未知"}</dd></div></dl>
               <p className="p4-action-note">{readingText(snapshot,"exterior",true)}</p>
               {vehicleSheet === "尾门" ? control("unlockTrunk", () => setVehicleSheet(null)) : typeof locked === "boolean" ? control(lockAction, () => setVehicleSheet(null)) : <OpeningStatus snapshot={snapshot}/>}
             </> :
             vehicleSheet === "details" ? (
              <>
                <VehicleDetails
                  snapshot={snapshot}
                  onError={setError}
                  includeMap={p4}
                  appearance={appearance}
                  dark={theme === "dark"}
                />
                <EndpointStatus snapshot={snapshot} />
              </>
            ) : (
              <VehicleMap key={vin} snapshot={snapshot} onError={setError} />
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
          {p4 && !p4FindActions.includes(dialog.action) && (
            <p className="modal-description">服务受理后将读取车辆状态。{dialog.action === "climateStart" ? "空调运行状态与设定温度分别核对。" : "收到操作后的车辆上报才确认结果。"}结果不明时请先查看回读，避免重复发送。</p>
          )}
          {p4 && p4FindActions.includes(dialog.action) && <p className="modal-description">请确认车辆周围环境适合寻车。服务受理后，鸣笛或闪灯结果需要现场核对。</p>}
          {p4 && p4CabinActions.includes(dialog.action) && <fieldset className="p4-cabin-control" disabled={busy}>
            <legend>{dialog.action === "steeringWheelHeat" ? "加热开关" : "目标档位"}</legend>
            <div className="limit-presets">
              {Array.from({ length: limits.max + 1 }, (_, value) => <button type="button" key={value} aria-pressed={dialog.value === value} onClick={() => setDialog({ ...dialog, value })}>
                {value === 0 ? "关闭" : limits.max === 1 ? "开启" : `${value} 档`}
              </button>)}
            </div>
          </fieldset>}
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
          {["windowsOpen", "windowsClose", "windowsVent", "chargeLidOpen", "chargeLidClose", "tailgateOpen", "tailgateClose"].includes(
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
          {needsValue && !chargeOptions && !p4CabinActions.includes(dialog.action) && (
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
          {error && <p role="alert">{error}</p>}
          <div className="button-row">
            <button
              className="primary-button"
              disabled={
                busy ||
                !!unavailableReason(vehicle, dialog.action) ||
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
        {Object.entries(isNativeP4(snapshot?.vehicle)
          ? Object.fromEntries(Object.keys(snapshot?.readings ?? {}).map((key) => [
              key, ({vehicleModes: "车辆模式", p4Reservations: "充电预约"} as Record<string, string>)[key] ?? endpointLabels[key] ?? key,
            ]))
          : endpointLabels).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{readingText(snapshot, key)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
