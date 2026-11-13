import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  exportHistory: (vin: string, format: "csv" | "json") =>
    invoke<boolean>("export_history", { vin, format }),
};

export function numeric(
  snapshot: Snapshot | undefined,
  endpoint: string,
  field: string,
): number | null {
  const value = snapshot?.readings[endpoint]?.value?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readingText(
  snapshot: Snapshot | undefined,
  endpoint: string,
): string {
  const reading = snapshot?.readings[endpoint];
  if (!reading) return "尚未读取";
  if (reading.status === "failed") return reading.error ?? "读取失败";
  const date = new Date(
    reading.reportedAt ?? reading.observedAt,
  ).toLocaleString("zh-CN", { hour12: false });
  return `${reading.reportedAt ? "车辆上报" : "读取于"} ${date}`;
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
  unlockTrunk: "解锁尾门",
  tailgateOpen: "打开尾门",
  tailgateClose: "关闭尾门",
  windowsOpen: "打开车窗",
  windowsClose: "关闭车窗",
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
  if (action === "otaSchedule") return { min: 2, max: 10080, step: 1 };
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

export function unavailableReason(
  vehicle: NativeVehicle | undefined,
  action: string,
): string | null {
  if (!vehicle) return "尚未连接车辆";
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
