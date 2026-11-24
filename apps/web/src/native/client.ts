import { invoke, listen } from "./transport";
import type { WidgetTarget, widgetData } from "./widgets";
import { isAndroid } from "./platform";

export interface NativeVehicle {
  vin: string;
  model: string;
  modelYear: string | null;
  owner: boolean | null;
  platform: string | null;
  capabilities: Record<string, boolean | null>;
  limits: Record<string, number>;
  installedVersion?: string | null;
}
export interface Reading {
  status: "success" | "failed";
  value: Record<string, unknown> | null;
  observedAt: number;
  reportedAt: number | null;
  error: string | null;
}
export interface Snapshot {
  vehicle: NativeVehicle;
  fetchedAt: number;
  readings: Record<string, Reading>;
}

export function refreshOutcome(snapshot: Snapshot | undefined): "success" | "partial" | "error" {
  const readings = Object.values(snapshot?.readings ?? {});
  const successful = readings.filter(reading => reading.status === "success" && reading.value !== null).length;
  if (successful === 0) return "error";
  return successful === readings.length ? "success" : "partial";
}
export interface Command {
  vin: string;
  action: string;
  value?: number;
  schedule?: Schedule;
  timerId?: string;
  timezoneOffset?: number;
}
export interface Schedule {
  id: string | null;
  index: number | null;
  start: number;
  end: number | null;
  weekdays: number[];
  active: boolean;
  repeats: boolean | null;
}
export interface NativeSettings {
  refreshSeconds: number;
  selectedVin: string | null;
  launchAtLogin: boolean;
  notifyCharging: boolean;
  notifyCommands: boolean;
  refreshOnWake: boolean;
}
export interface DesktopState {
  status: { launchAtLogin: number; notifications: number };
  settings: NativeSettings;
}
export interface Receipt {
  id: string;
  command: Command;
  time: number;
  status: string;
  message: string;
  readbackAt: number | null;
  readback: string | null;
}
export interface History {
  snapshots: Snapshot[];
  receipts: Receipt[];
  settings?: NativeSettings;
}
export interface HistoryPoint {
  time: number;
  value: number;
}
export interface HistorySample {
  time: number;
  source: string;
  percent: number | null;
  rangeKm: number | null;
  powerKw: number | null;
  odometerKm: number | null;
  temperature: number | null;
}
export interface HistoryCommand {
  id: string;
  time: number;
  source: string;
  name: string;
  status: string;
  message: string | null;
  readback: string | null;
}
export interface ChargingRecord {
  id: string;
  start: number;
  end: number | null;
  source: string;
  startPercent: number | null;
  endPercent: number | null;
  energyKwh: number | null;
  peakKw: number | null;
  cost: number | null;
  currency: string | null;
  status: string | null;
  energySource: string | null;
  coverage: number | null;
  location: string | null;
}
export interface HistoryReport {
  vehicles: string[];
  counts: Record<string, number>;
  battery: HistoryPoint[];
  odometer: HistoryPoint[];
  samples: HistorySample[];
  commands: HistoryCommand[];
  charging: ChargingRecord[];
  trips: { start: number; end: number; km: number }[];
}
export interface ImportSummary {
  token: string;
  source: string;
  total: number;
  added: number;
  duplicates: number;
  categories: Record<string, number>;
  vehicles: Record<string, number>;
}
export interface SessionStatus {
  hasSession: boolean;
  hasSigningKey: boolean;
  expiresAt: number | null;
}

export const native = {
  updateWidgets: (data: ReturnType<typeof widgetData> | null) => invoke<void>("update_widgets", { data }),
  syncWatch: (vin: string, clear = false) => invoke<void>("sync_watch", { vin, clear }),
  takeWidgetTarget: () => invoke<WidgetTarget | null>("take_widget_target"),
  onWidgetOpen: (callback: () => void) => {
    if (!isAndroid) return listen("widget-open", callback);
    window.addEventListener("norr-widget-open", callback);
    return Promise.resolve(() => window.removeEventListener("norr-widget-open", callback));
  },
  setAndroidTheme: (dark: boolean) => invoke<void>("set_android_theme", { dark }),
  status: () => invoke<SessionStatus>("session_status"),
  requestLoginCode: (phone: string) =>
    invoke<number | null>("request_login_code", { phone }),
  signInPhone: (phone: string, code: string) =>
    invoke<SessionStatus>("sign_in_phone", { phone, code }),
  signInPassword: (phone: string, password: string) =>
    invoke<SessionStatus>("sign_in_password", { phone, password }),
  import: import.meta.env.DEV
    ? (configPath?: string) =>
        invoke<SessionStatus>("import_hisingen", { configPath })
    : undefined,
  connect: () => invoke<NativeVehicle[]>("connect"),
  refresh: (vin: string) => invoke<Snapshot>("refresh", { vin }),
  history: () => invoke<History>("history"),
  historyReport: (vin: string, start: number, end: number) =>
    invoke<HistoryReport>("history_report", { vin, start, end }),
  previewHistoryImport: (source: "hisingen" | "backup") =>
    invoke<ImportSummary | null>("preview_history_import", { source }),
  commitHistoryImport: (token: string) =>
    invoke<ImportSummary>("commit_history_import", { token }),
  cancelHistoryImport: (token: string) =>
    invoke<void>("cancel_history_import", { token }),
  command: (command: Command) => invoke<Receipt>("send_command", { command }),
  setRefreshInterval: (seconds: number) =>
    invoke<NativeSettings>("set_refresh_interval", { seconds }),
  onSnapshot: (callback: (snapshot: Snapshot) => void) =>
    listen<Snapshot>("vehicle-updated", (event) => callback(event.payload)),
  onRefreshError: (callback: (error: string) => void) =>
    listen<string>("refresh-failed", (event) => callback(event.payload)),
  openLocation: (vin: string) => invoke<void>("open_location", { vin }),
  openMapLink: (url: string) => invoke<void>("open_map_link", { url }),
  desktopStatus: () => invoke<DesktopState>("desktop_status"),
  setDesktopOption: (option: string, enabled: boolean) =>
    invoke<void>("set_desktop_option", { option, enabled }),
  openSystemSettings: (section: "login" | "notifications") =>
    invoke<void>("open_system_settings", { section }),
  testNotification: () => invoke<void>("test_notification"),
  takeNotificationTarget: () =>
    invoke<{ vin: string; page: string } | null>("take_notification_target"),
  onDesktopError: (callback: (message: string) => void) =>
    listen<string>("desktop-failed", (event) => callback(event.payload)),
  onNotificationOpen: (
    callback: (target: { vin: string; page: string }) => void,
  ) =>
    listen<{ vin: string; page: string }>("notification-open", (event) =>
      callback(event.payload),
    ),
  recordP4Observation: (vin: string, action: string, outcome: string) =>
    invoke<void>("record_p4_observation", { vin, action, outcome }),
  exportHistory: (vin: string, format: "csv" | "json" | "p4-log") =>
    invoke<boolean>("export_history", { vin, format }),
};

export function numeric(
  snapshot: Snapshot | undefined,
  endpoint: string,
  field: string,
): number | null {
  const reading = snapshot?.readings[endpoint];
  if (reading?.status === "failed") return null;
  const value = reading?.value?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
export function chargingStatusText(snapshot?: Snapshot): string {
  const battery = snapshot?.readings.battery;
  if (battery?.status !== "success") return "充电状态未知";
  const state = numeric(snapshot, "battery", "chargeState");
  if (state !== null && chargeStates[state]) return chargeStates[state];
  if (isNativeP4(snapshot?.vehicle)) {
    if (state === 9) return "充电准备中";
    if (battery.value?.plugged === false) return "未插枪";
    if (battery.value?.plugged === true) return "已插枪";
  }
  return "充电状态未知";
}

export function chargingTimeText(snapshot?: Snapshot): string | null {
  if (snapshot?.readings.battery?.status !== "success") return null;
  const value = numeric(snapshot, "battery", "minutesToFull");
  if (value === null || value < 0 || value > 10080) return null;
  const minutes = Math.ceil(value);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${minutes} 分钟`;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

export function cabinAirSnapshot(vin: string, current: Snapshot | undefined, history: Snapshot[]) {
  const hasReading = (sample: Snapshot | undefined) =>
    sample?.vehicle.vin === vin && sample.readings.airQuality?.status === "success" &&
    (numeric(sample, "airQuality", "pm25") !== null || numeric(sample, "airQuality", "aqi") !== null);
  if (hasReading(current)) return current;
  let last: Snapshot | undefined;
  let latestTime = 0;
  for (const sample of history) {
    if (!hasReading(sample)) continue;
    const air = sample.readings.airQuality;
    const time = numeric(sample, "airQuality", "measuredAt") || air.reportedAt || air.observedAt;
    if (time > latestTime) {
      last = sample;
      latestTime = time;
    }
  }
  return last;
}

export function cabinAirTime(sample: Snapshot) {
  const measured = numeric(sample, "airQuality", "measuredAt");
  if (!measured || measured <= 0) return readingText(sample, "airQuality", true);
  const time = new Date(measured);
  return `测量于 ${time.toLocaleString("zh-CN", {
    year: time.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  })}`;
}

export function readingText(
  snapshot: Snapshot | undefined,
  endpoint: string,
  compact = false,
): string {
  const reading = snapshot?.readings[endpoint];
  if (!reading) return isNativeP4(snapshot?.vehicle) ? "此项数据待接入" : "尚未读取";
  if (reading.status === "failed") return reading.error ?? "读取失败";
  const timestamp = new Date(reading.reportedAt ?? reading.observedAt);
  const date = timestamp.toLocaleString(
    "zh-CN",
    compact
      ? {
          year: timestamp.getFullYear() === new Date().getFullYear()
            ? undefined
            : "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      : { hour12: false },
  );
  return `${reading.reportedAt ? "车辆上报" : "读取于"} ${date}${reading.value?.freshnessPending === true ? " · 等待更新" : ""}`;
}

export const actionLabels: Record<string, string> = {
  lock: "锁定车辆",
  unlock: "解锁车辆",
  climateStart: "开启空调",
  climateStop: "关闭空调",
  target: "设置充电上限",
  amperage: "设置交流电流上限",
  flash: "闪灯寻车",
  honkFlash: "鸣笛并闪灯",
  honk: "单独鸣笛",
  unlockTrunk: "解锁尾门",
  tailgateOpen: "打开尾门",
  tailgateClose: "关闭尾门",
  windowsOpen: "打开车窗",
  windowsClose: "关闭车窗",
  windowsVent: "车窗通风",
  steeringWheelHeat: "设置方向盘加热",
  driverSeatHeat: "设置主驾座椅加热",
  passengerSeatHeat: "设置副驾座椅加热",
  driverSeatVent: "设置主驾座椅通风",
  passengerSeatVent: "设置副驾座椅通风",
  chargeLidOpen: "打开充电口盖",
  chargeLidClose: "关闭充电口盖",
  cleanStart: "开始空气预清洁",
  cleanStop: "停止空气预清洁",
  chargeStart: "临时立即充电",
  chargeStop: "恢复充电日程",
  climateTimer: "保存空调日程",
  deleteClimateTimer: "删除空调日程",
  chargeTimer: "保存充电窗口",
  otaSchedule: "预约软件安装",
  otaInstall: "立即安装软件",
  otaCancel: "取消软件安装计划",
};

export const actionFlags: Record<string, string> = {
  lock: "supportsLock",
  unlock: "supportsUnlock",
  climateStart: "supportsParkingClimatization",
  climateStop: "supportsParkingClimatization",
  target: "supportsTargetChargeLevelSetting",
  amperage: "supportsGlobalChargeAmperageLimitSetting",
  flash: "supportsFlash",
  honkFlash: "supportsHonkAndFlash",
  unlockTrunk: "supportsRemoteTrunkUnlock",
  tailgateOpen: "supportsRemoteTrunkControl",
  tailgateClose: "supportsRemoteTrunkControl",
  windowsOpen: "supportsRemoteWindowControl",
  windowsClose: "supportsRemoteWindowControl",
  cleanStart: "supportsAirPurification",
  cleanStop: "supportsAirPurification",
  chargeStart: "supportsChargeNowTimerOverride",
  chargeStop: "supportsChargeNowTimerOverride",
  chargeTimer: "supportsGlobalChargeTimer",
  otaSchedule: "supportsRemoteOtaInstallSchedule",
  otaInstall: "supportsRemoteOtaInstallSchedule",
  otaCancel: "supportsRemoteOtaInstallSchedule",
};

export function commandLimits(
  vehicle: NativeVehicle | undefined,
  action: string,
) {
  const limits = vehicle?.limits ?? {};
  if (action === "steeringWheelHeat") return { min: 0, max: 1, step: 1 };
  if (p4SeatActions.includes(action)) return { min: 0, max: 3, step: 1 };
  if (action === "otaSchedule") return { min: 2, max: 10080, step: 1 };
  if (action === "climateStart" && vehicle?.capabilities.norrXchanger === true)
    return { min: 16, max: 28, step: 1 };
  if (action === "target" && vehicle?.capabilities.norrXchanger === true)
    return { min: 40, max: 100, step: 1 };
  if (action === "climateStart")
    return {
      min: Math.max(
        16,
        limits.parkingClimatizationCompartmentTemperatureMinLimit ?? 16,
      ),
      max: Math.min(
        30,
        limits.parkingClimatizationCompartmentTemperatureMaxLimit ?? 30,
      ),
      step: 0.5,
    };
  if (action === "target")
    return {
      min: limits.targetChargeLevelPercentageMinLimit ?? 40,
      max: 100,
      step: 1,
    };
  return {
    min: limits.chargeAmperageMinLimit ?? 6,
    max: limits.chargeAmperageMaxLimit ?? 32,
    step: 1,
  };
}

export function chargingOptions(
  vehicle: NativeVehicle | undefined,
  action: "target" | "amperage",
  current: number | null,
) {
  const { min, max } = commandLimits(vehicle, action);
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 1 ||
    max > 100 ||
    min > max
  )
    return { values: [], presets: [] };
  const step = action === "target" ? 5 : 1;
  const values = new Set([min, max]);
  for (let value = Math.ceil(min / step) * step; value <= max; value += step)
    values.add(value);
  if (
    current !== null &&
    Number.isInteger(current) &&
    current >= min &&
    current <= max
  )
    values.add(current);
  const candidates =
    action === "target"
      ? [min, ...[...values].filter((value) => value % 10 === 0), max]
      : [min, 6, 8, 10, 13, 16, 20, 24, 32, max];
  return {
    values: [...values].sort((a, b) => a - b),
    presets: [...new Set(candidates)]
      .filter((value) => value >= min && value <= max)
      .sort((a, b) => a - b),
  };
}

export function isGeelyReadOnly(vehicle: NativeVehicle | undefined): boolean {
  return vehicle?.capabilities?.norrGeelyReadOnly === true;
}

export function isNativeP4(vehicle: NativeVehicle | undefined): boolean {
  return vehicle?.platform?.toUpperCase() === "HUANFU" || vehicle?.capabilities?.norrXchanger === true || isGeelyReadOnly(vehicle);
}

export const p4FindActions = ["flash", "honkFlash", "honk"];
export const p4SeatActions = ["driverSeatHeat", "passengerSeatHeat", "driverSeatVent", "passengerSeatVent"];
export const p4CabinActions = ["steeringWheelHeat", ...p4SeatActions];
const p4ImplementedActions = ["climateStart", "climateStop", "target", ...p4CabinActions,
  "lock", "unlock", "unlockTrunk", "windowsOpen", "windowsClose", "windowsVent", ...p4FindActions,
  "cleanStart", "cleanStop", "chargeLidOpen", "chargeLidClose"];

const p4ControllerActions = new Set([
  "lock", "unlock", "unlockTrunk", "windowsOpen", "windowsClose",
  ...p4FindActions, "climateStart", "climateStop", "cleanStart", "cleanStop",
  "climateTimer", "deleteClimateTimer", "target",
]);

const p4CapabilityFlags: Record<string, string> = {
  lock: "remote_control_lock_2", unlock: "remote_control_unlock_2",
  climateStart: "remote_climate_control_2", climateStop: "remote_climate_control_2",
  target: "remote_charge_2",
  honkFlash: "honk_flash",
};

export function unavailableReason(
  vehicle: NativeVehicle | undefined,
  action: string,
): string | null {
  if (!vehicle) return "尚未连接车辆";
  if (isGeelyReadOnly(vehicle) || vehicle.capabilities.norrXchanger === true) {
    if (vehicle.capabilities.norrXchanger === true && p4ImplementedActions.includes(action)) {
      const key = `norrP4.${action}`;
      if (Object.hasOwn(vehicle.capabilities, key)) {
        const permission = vehicle.capabilities[key];
        return permission === true ? null : permission === false ? "车辆未开放此功能" : "能力或对应车况未确认，请刷新车辆";
      }
      if (!["climateStart", "climateStop", "target"].includes(action)) return "能力或对应车况未确认，请刷新车辆";
    }
    const flag = p4CapabilityFlags[action];
    if (flag && vehicle.capabilities[`geely.${flag}`] === false) return "车辆未开放此功能";
    if (vehicle.capabilities.norrXchanger === true && ["climateStart", "climateStop", "target"].includes(action)) {
      return vehicle.capabilities[`geely.${flag}`] === true ? null : "服务尚未提供能力信息，请刷新车辆";
    }
    if (p4ControllerActions.has(action)) return "官方 App 有此操作，Norr 尚未接入";
    if (action === "tailgateOpen" || action === "tailgateClose") return "此版本的 P4 接口未实现电动开关尾门";
    if (action === "amperage") return "此版本的 P4 接口未实现电流上限设置";
    if (action === "chargeTimer") return "P4 使用充电预约";
    return "尚未找到对应的 P4 控制接口";
  }
  if (!["ICUP", "AccountLinking"].includes(vehicle.platform ?? ""))
    return "该平台适配待完成";
  if (
    ["target", "amperage", "chargeStart", "chargeStop", "chargeTimer"].includes(
      action,
    ) &&
    vehicle.capabilities.supportsChargingFunctions !== true
  )
    return "车辆未确认开放充电控制";
  const timerFlags = [
    "supportsParkingClimatizationRepeatedWeekdayTimers",
    "supportsParkingClimatizationUnrepeatedWeekdayTimers",
    "supportsParkingClimatization24hTimers",
  ];
  const flag = ["climateTimer", "deleteClimateTimer"].includes(action)
    ? timerFlags.some((key) => vehicle.capabilities[key] === true)
      ? true
      : timerFlags.every((key) => vehicle.capabilities[key] === false)
        ? false
        : null
    : vehicle.capabilities[actionFlags[action]];
  if (flag !== true)
    return flag === false ? "车辆未开放此功能" : "服务尚未提供能力信息";
  return null;
}

export function openingState(
  snapshot: Snapshot | undefined,
  parts: readonly string[],
): "open" | "closed" | "unknown" {
  const exterior = snapshot?.readings.exterior;
  if (exterior?.status !== "success" || parts.length === 0) return "unknown";
  const openings = exterior.value?.openings as
    | Record<string, number | null>
    | undefined;
  const states = parts.map((part) => openings?.[part]);
  if (states.some((state) => state === 1 || state === 3)) return "open";
  return states.every((state) => state === 2) ? "closed" : "unknown";
}

export function activeControls(snapshot: Snapshot | undefined) {
  const climate = snapshot?.readings.climate;
  const exterior = snapshot?.readings.exterior;
  const airQuality = snapshot?.readings.airQuality;
  return {
    climate: climate?.status === "success" && climate.value?.activity === "active",
    unlocked: exterior?.status === "success" && exterior.value?.locked === false,
    cleaning: airQuality?.status === "success" && airQuality.value?.state === 1,
  };
}

export function timeText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export const weekdayLabels = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];

export function scheduleText(schedule: Schedule): string {
  const time =
    schedule.end === null
      ? timeText(schedule.start)
      : `${timeText(schedule.start)} 至 ${timeText(schedule.end)}`;
  const days = schedule.weekdays
    .map((day) => weekdayLabels[day - 1])
    .join("、");
  const repeat =
    schedule.end !== null
      ? "每天"
      : schedule.repeats === true
        ? "每周"
        : schedule.repeats === false
          ? "一次性"
          : "重复方式未知";
  return `${time} · ${repeat}${days ? ` ${days}` : ""} · ${schedule.active ? "已启用" : "已停用"}`;
}
