import { useContext, useEffect, useRef, useState } from "react";
import { WorkspaceContext } from "./workspace-context";
import type { ReactNode } from "react";
import { initialVehicle } from "./vehicle";
import type { Vehicle, PreviewScenario } from "./vehicle";
import {
  defaultAppearance,
  validAppearance,
  vehicleConfiguration,
} from "./vehicle-catalog";
import type { VehicleAppearance } from "./vehicle-catalog";
import {
  demoCapabilityProfile,
  supports,
  capabilityLabels,
} from "./capabilities";
import type { Capability, CapabilityProfile } from "./capabilities";
export {
  supports,
  capabilityReason,
  capabilityStatus,
  capabilityLabels,
  demoCapabilityProfile,
} from "./capabilities";
export type { Capability } from "./capabilities";

export interface DemoVehicle extends Vehicle, CapabilityProfile {
  appearance?: VehicleAppearance;
  scheduleReads?: Partial<Record<Schedule["kind"], ScheduleRead>>;
  id: string;
  brand: "Polestar" | "Volvo";
  region: "国际区" | "中国区";
  nickname: string;
  windowsOpen: boolean;
  tailgateOpen: boolean;
  cleaning: boolean;
  engineOn: boolean;
  software: string;
  currentLimit: number;
}
export interface Schedule {
  id: string;
  vehicleId: string;
  kind: "充电" | "空调";
  time: string;
  end: string;
  days: string[];
  enabled: boolean;
  target?: number;
  confirmation?: "accepted" | "deleting";
}
export interface ScheduleRead {
  status: "unrequested" | "failed" | "cached" | "partial" | "success";
  observedAt: number;
}
export interface ChargeLocation {
  id: string;
  vehicleId: string;
  name: string;
  current: number;
  minimum: number;
  optimized: boolean;
}
export interface Receipt {
  id: string;
  vehicleId: string;
  label: string;
  capability: Capability;
  changes: Partial<DemoVehicle>;
  previous: Partial<DemoVehicle>;
  status:
    | "pending"
    | "accepted"
    | "delivered"
    | "completed"
    | "success"
    | "failed"
    | "unknown"
    | "undone";
  time: number;
  observation?: { result: "match" | "mismatch" | "unavailable"; time: number };
}
export interface Settings {
  distance: "km" | "mi";
  temperature: "C" | "F";
  notifications: boolean;
  privacy: boolean;
  rate: number;
  refresh: string;
  startAtLogin: boolean;
  miniPanel: boolean;
}
export interface FuelEntry {
  id: string;
  vehicleId: string;
  liters: number;
  cost: number;
  odometer: number;
}
export interface WorkspaceData {
  vehicles: DemoVehicle[];
  selected: string;
  settings: Settings;
  schedules: Schedule[];
  locations: ChargeLocation[];
  receipts: Receipt[];
  fuel: FuelEntry[];
  hiddenTrips: string[];
  clearedHistory: string[];
  routines: { id: string; vehicleId: string; name: string }[];
}

export function makeVehicle(
  brand: DemoVehicle["brand"],
  region: DemoVehicle["region"],
  nickname: string,
  appearance = defaultAppearance(),
): DemoVehicle {
  const profile = demoCapabilityProfile(
    brand,
    region,
    vehicleConfiguration(appearance).model,
  );
  return {
    ...initialVehicle,
    id: crypto.randomUUID(),
    brand,
    region,
    nickname,
    ...(brand === "Polestar"
      ? vehicleConfiguration(appearance)
      : { model: "Volvo XC60", variant: "T8 plug-in hybrid" }),
    ...profile,
    scheduleReads: {
      空调: {
        status:
          profile.capabilities?.climateSchedule === true
            ? "success"
            : "unrequested",
        observedAt: Date.now(),
      },
      充电: {
        status:
          profile.capabilities?.chargeSchedule === true
            ? "success"
            : "unrequested",
        observedAt: Date.now(),
      },
    },
    range: brand === "Polestar" ? 356 : 62,
    windowsOpen: false,
    tailgateOpen: false,
    cleaning: false,
    engineOn: false,
    software: "P4.2.1",
    currentLimit: 16,
    updatedAt: Date.now(),
  };
}

function initialData(): WorkspaceData {
  const vehicle = makeVehicle("Polestar", "国际区", "我的 Polestar");
  return {
    vehicles: [vehicle],
    selected: vehicle.id,
    settings: {
      distance: "km",
      temperature: "C",
      notifications: false,
      privacy: false,
      rate: 0.58,
      refresh: "5",
      startAtLogin: false,
      miniPanel: false,
    },
    schedules: [
      {
        id: crypto.randomUUID(),
        vehicleId: vehicle.id,
        kind: "充电",
        time: "23:00",
        end: "07:00",
        days: ["一", "二", "三", "四", "五"],
        enabled: true,
      },
    ],
    locations: [
      {
        id: crypto.randomUUID(),
        vehicleId: vehicle.id,
        name: "家庭充电",
        current: 16,
        minimum: 50,
        optimized: true,
      },
    ],
    receipts: [],
    fuel: [],
    hiddenTrips: [],
    clearedHistory: [],
    routines: [],
  };
}

const storageKey = "hisingen-design-workspace-v2";

function loadWorkspace() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return parseBackup(raw, true);
  } catch {
    /* An invalid preview snapshot falls back to the initial demo. */
  }
  return initialData();
}

export function parseBackup(
  raw: string,
  migrateDefaultDemo = false,
): WorkspaceData {
  const value = JSON.parse(raw);
  const sample = initialData();
  const vehicleShape = { ...sample.vehicles[0] };
  delete vehicleShape.appearance;
  delete vehicleShape.capabilities;
  delete vehicleShape.controlAccess;
  delete vehicleShape.scheduleReads;
  function sameShape(candidate: unknown, example: unknown): boolean {
    if (typeof example === "number")
      return typeof candidate === "number" && Number.isFinite(candidate);
    if (typeof example !== "object" || example === null)
      return typeof candidate === typeof example;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    return Object.entries(example).every(([key, field]) =>
      sameShape((candidate as Record<string, unknown>)[key], field),
    );
  }
  if (
    !value ||
    !Array.isArray(value.vehicles) ||
    value.vehicles.length > 30 ||
    !sameShape(value.settings, sample.settings)
  )
    throw new Error("备份结构不完整");
  if (
    !value.vehicles.every(
      (vehicle: DemoVehicle) =>
        sameShape(vehicle, vehicleShape) &&
        (vehicle.appearance === undefined ||
          validAppearance(vehicle.appearance)) &&
        (vehicle.controlAccess === undefined ||
          ["owner", "denied", "unchecked"].includes(vehicle.controlAccess)) &&
        (vehicle.capabilities === undefined ||
          (vehicle.capabilities !== null &&
            typeof vehicle.capabilities === "object" &&
            !Array.isArray(vehicle.capabilities) &&
            Object.entries(vehicle.capabilities).every(
              ([key, flag]) =>
                Object.hasOwn(capabilityLabels, key) &&
                (typeof flag === "boolean" || flag === "unavailable"),
            ))) &&
        (vehicle.scheduleReads === undefined ||
          (vehicle.scheduleReads !== null &&
            typeof vehicle.scheduleReads === "object" &&
            !Array.isArray(vehicle.scheduleReads) &&
            Object.entries(vehicle.scheduleReads).every(
              ([kind, read]) =>
                ["空调", "充电"].includes(kind) &&
                read &&
                [
                  "unrequested",
                  "failed",
                  "cached",
                  "partial",
                  "success",
                ].includes(read.status) &&
                Number.isFinite(read.observedAt),
            ))) &&
        ["Polestar", "Volvo"].includes(vehicle.brand) &&
        ["国际区", "中国区"].includes(vehicle.region) &&
        vehicle.battery >= 0 &&
        vehicle.battery <= 100 &&
        vehicle.chargeLimit >= 50 &&
        vehicle.chargeLimit <= 100,
    )
  )
    throw new Error("车辆数据无效");
  if (
    new Set(value.vehicles.map((v: DemoVehicle) => v.id)).size !==
    value.vehicles.length
  )
    throw new Error("车辆标识重复");
  if (
    !["km", "mi"].includes(value.settings.distance) ||
    !["C", "F"].includes(value.settings.temperature) ||
    value.settings.rate < 0
  )
    throw new Error("设置数据无效");
  const ids = new Set(value.vehicles.map((v: DemoVehicle) => v.id));
  if (
    !Array.isArray(value.schedules) ||
    !value.schedules.every(
      (s: Schedule) =>
        s &&
        typeof s.id === "string" &&
        ids.has(s.vehicleId) &&
        ["充电", "空调"].includes(s.kind) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(s.end) &&
        typeof s.enabled === "boolean" &&
        (s.confirmation === undefined ||
          ["accepted", "deleting"].includes(s.confirmation)) &&
        Array.isArray(s.days) &&
        s.days.length > 0 &&
        (s.target === undefined ||
          (Number.isFinite(s.target) && s.target >= 50 && s.target <= 100)) &&
        s.days.every((d) =>
          ["一", "二", "三", "四", "五", "六", "日"].includes(d),
        ),
    )
  )
    throw new Error("计划数据无效");
  if (
    !Array.isArray(value.locations) ||
    !value.locations.every(
      (l: ChargeLocation) =>
        l &&
        typeof l.id === "string" &&
        ids.has(l.vehicleId) &&
        typeof l.name === "string" &&
        Number.isFinite(l.current) &&
        l.current >= 6 &&
        l.current <= 16 &&
        Number.isFinite(l.minimum) &&
        l.minimum >= 20 &&
        l.minimum <= 100 &&
        typeof l.optimized === "boolean",
    )
  )
    throw new Error("充电地点数据无效");
  if (
    !Array.isArray(value.fuel) ||
    !value.fuel.every(
      (f: FuelEntry) =>
        f &&
        typeof f.id === "string" &&
        ids.has(f.vehicleId) &&
        [f.cost, f.liters, f.odometer].every(
          (n) => Number.isFinite(n) && n >= 0,
        ),
    )
  )
    throw new Error("加油数据无效");
  for (const key of ["hiddenTrips", "clearedHistory"])
    if (
      !Array.isArray(value[key]) ||
      !value[key].every((s: unknown) => typeof s === "string")
    )
      throw new Error("历史设置无效");
  if (
    !Array.isArray(value.routines) ||
    !value.routines.every(
      (r: { id: string; vehicleId: string; name: string }) =>
        r &&
        typeof r.id === "string" &&
        ids.has(r.vehicleId) &&
        typeof r.name === "string",
    )
  )
    throw new Error("快捷组合无效");
  const changeKeys = [
    "locked",
    "climateOn",
    "targetTemperature",
    "charging",
    "chargeLimit",
    "windowsOpen",
    "tailgateOpen",
    "cleaning",
    "engineOn",
    "software",
    "currentLimit",
  ];
  function validChanges(changes: unknown) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes))
      return false;
    return Object.entries(changes).every(
      ([key, field]) =>
        changeKeys.includes(key) &&
        sameShape(field, sample.vehicles[0][key as keyof DemoVehicle]),
    );
  }
  if (
    !Array.isArray(value.receipts) ||
    !value.receipts.every(
      (r: Receipt) =>
        r &&
        typeof r.id === "string" &&
        ids.has(r.vehicleId) &&
        typeof r.label === "string" &&
        Object.hasOwn(capabilityLabels, r.capability) &&
        [
          "pending",
          "accepted",
          "delivered",
          "completed",
          "success",
          "failed",
          "unknown",
          "undone",
        ].includes(r.status) &&
        (r.observation === undefined ||
          (r.observation !== null &&
            ["match", "mismatch", "unavailable"].includes(
              r.observation.result,
            ) &&
            Number.isFinite(r.observation.time))) &&
        Number.isFinite(r.time) &&
        validChanges(r.changes) &&
        validChanges(r.previous),
    )
  )
    throw new Error("指令记录无效");
  return {
    vehicles: value.vehicles.map((vehicle: DemoVehicle, index: number) => {
      const replaceOriginalDemo =
        migrateDefaultDemo &&
        index === 0 &&
        !vehicle.appearance &&
        vehicle.nickname === "我的 Polestar" &&
        vehicle.model === "Polestar 4";
      const appearance =
        vehicle.appearance ??
        defaultAppearance(
          !replaceOriginalDemo && vehicle.model === "Polestar 4"
            ? "polestar-4"
            : "polestar-2",
        );
      const configured =
        vehicle.brand === "Polestar"
          ? { ...vehicle, ...vehicleConfiguration(appearance) }
          : vehicle;
      return vehicle.capabilities === undefined &&
        vehicle.controlAccess === undefined
        ? {
            ...configured,
            ...demoCapabilityProfile(
              configured.brand,
              configured.region,
              configured.model,
            ),
          }
        : configured;
    }),
    selected: ids.has(value.selected)
      ? value.selected
      : (value.vehicles[0]?.id ?? ""),
    settings: value.settings,
    schedules: value.schedules,
    locations: value.locations,
    fuel: value.fuel,
    hiddenTrips: value.hiddenTrips,
    clearedHistory: value.clearedHistory,
    routines: value.routines,
    receipts: value.receipts.map((r: Receipt) =>
      r.status === "pending"
        ? { ...r, status: "unknown" }
        : r.status === "success" && r.observation?.result !== "match"
          ? { ...r, status: "completed" }
          : r,
    ),
  };
}

export function downloadFile(
  name: string,
  text: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function useWorkspaceState() {
  const [data, setData] = useState<WorkspaceData>(loadWorkspace);
  const [scenario, setScenario] = useState<PreviewScenario>("connected");
  const [outcome, setOutcome] =
    useState<Exclude<Receipt["status"], "pending" | "undone">>("success");
  const [readbackOutcome, setReadbackOutcome] = useState<
    "match" | "mismatch" | "unavailable"
  >("match");
  const simulatedVehicleReads = useRef(new Map<string, Partial<DemoVehicle>>());
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const vehicle = data.vehicles.find((v) => v.id === data.selected);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {
      setNotice("浏览器存储不可用，本次修改仅保留到关闭页面。");
    }
  }, [data]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function command(
    label: string,
    capability: Capability,
    changes: Partial<DemoVehicle>,
    retryId?: string,
  ) {
    if (
      !vehicle ||
      inFlight.current ||
      scenario !== "connected" ||
      !supports(vehicle, capability)
    )
      return;
    if (
      retryId &&
      !data.receipts.some(
        (receipt) =>
          receipt.id === retryId &&
          receipt.vehicleId === vehicle.id &&
          receipt.status === "failed",
      )
    )
      return;
    inFlight.current = true;
    setBusy(true);
    const previous = Object.fromEntries(
      Object.keys(changes).map((key) => [
        key,
        vehicle[key as keyof DemoVehicle],
      ]),
    );
    const receipt: Receipt = {
      id: retryId ?? crypto.randomUUID(),
      vehicleId: vehicle.id,
      label,
      capability,
      changes,
      previous,
      status: "pending",
      time: Date.now(),
    };
    setData((old) => ({
      ...old,
      receipts: [receipt, ...old.receipts.filter((r) => r.id !== receipt.id)],
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    if (outcome !== "failed") {
      if (readbackOutcome === "unavailable")
        simulatedVehicleReads.current.delete(vehicle.id);
      else
        simulatedVehicleReads.current.set(
          vehicle.id,
          readbackOutcome === "match"
            ? { ...vehicle, ...changes }
            : { ...vehicle },
        );
    }
    const observed = simulatedVehicleReads.current.get(vehicle.id);
    const matched =
      outcome === "success" &&
      observed &&
      Object.keys(changes).length > 0 &&
      Object.entries(changes).every(
        ([key, value]) => observed[key as keyof DemoVehicle] === value,
      );
    const status = outcome === "success" && !matched ? "completed" : outcome;
    setData((old) =>
      old.receipts.some((r) => r.id === receipt.id && r.status === "pending")
        ? {
            ...old,
            vehicles: matched
              ? old.vehicles.map((v) =>
                  v.id === receipt.vehicleId ? { ...v, ...changes } : v,
                )
              : old.vehicles,
            receipts: old.receipts.map((r) =>
              r.id === receipt.id
                ? {
                    ...r,
                    status,
                    observation: matched
                      ? { result: "match", time: Date.now() }
                      : undefined,
                  }
                : r,
            ),
          }
        : old,
    );
    setNotice(
      matched
        ? `${label} · 模拟回读已确认`
        : outcome === "failed"
          ? "模拟请求未发出，可在指令记录手动重试。"
          : "指令结果待核对，可在指令记录读取车辆状态。",
    );
    inFlight.current = false;
    setBusy(false);
  }

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    setData((old) => ({
      ...old,
      vehicles: old.vehicles.map((v) => ({ ...v, updatedAt: Date.now() })),
    }));
    setScenario("connected");
    setNotice("演示车辆快照已更新");
    setBusy(false);
    inFlight.current = false;
  }

  async function resolveReceipt(id: string, undo: boolean) {
    if (inFlight.current || scenario !== "connected") return;
    const receipt = data.receipts.find((r) => r.id === id);
    if (
      !receipt ||
      receipt.vehicleId !== vehicle?.id ||
      (undo &&
        (receipt.status !== "success" || Date.now() - receipt.time > 30000))
    )
      return;
    if (undo) {
      await command(
        `恢复先前设置 · ${receipt.label}`,
        receipt.capability,
        receipt.previous,
      );
      return;
    }
    if (
      !["accepted", "delivered", "completed", "unknown"].includes(
        receipt.status,
      )
    )
      return;
    inFlight.current = true;
    setBusy(true);
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    const observed = simulatedVehicleReads.current.get(receipt.vehicleId);
    const fields = Object.entries(receipt.changes);
    const result =
      !observed || fields.length === 0
        ? "unavailable"
        : fields.every(
              ([key, value]) => observed[key as keyof DemoVehicle] === value,
            )
          ? "match"
          : "mismatch";
    const changes =
      result === "unavailable"
        ? {}
        : Object.fromEntries(
            fields.map(([key]) => [key, observed![key as keyof DemoVehicle]]),
          );
    setData((old) =>
      old.receipts.some(
        (r) => r.id === receipt.id && r.status === receipt.status,
      )
        ? {
            ...old,
            vehicles:
              result === "unavailable"
                ? old.vehicles
                : old.vehicles.map((v) =>
                    v.id === receipt.vehicleId ? { ...v, ...changes } : v,
                  ),
            receipts: old.receipts.map((r) =>
              r.id === id
                ? {
                    ...r,
                    status: result === "match" ? "success" : r.status,
                    observation: { result, time: Date.now() },
                  }
                : r,
            ),
          }
        : old,
    );
    setNotice(
      result === "match"
        ? "模拟回读与目标一致"
        : result === "mismatch"
          ? "模拟回读与目标不一致，已显示读取到的状态"
          : "本次没有可用的独立回读，请稍后再次核对",
    );
    inFlight.current = false;
    setBusy(false);
  }

  function setScheduleRead(
    kind: Schedule["kind"],
    status: ScheduleRead["status"] | "empty",
  ) {
    if (!vehicle || inFlight.current) return;
    setData((old) => ({
      ...old,
      vehicles: old.vehicles.map((car) =>
        car.id === vehicle.id
          ? {
              ...car,
              scheduleReads: {
                ...car.scheduleReads,
                [kind]: {
                  status: status === "empty" ? "success" : status,
                  observedAt: ["empty", "success"].includes(status)
                    ? Date.now()
                    : (car.scheduleReads?.[kind]?.observedAt ?? 0),
                },
              },
            }
          : car,
      ),
      schedules:
        status === "empty"
          ? old.schedules.filter(
              (item) => item.vehicleId !== vehicle.id || item.kind !== kind,
            )
          : old.schedules,
    }));
  }

  async function readSchedules(kind: Schedule["kind"]) {
    const capability = kind === "空调" ? "climateSchedule" : "chargeSchedule";
    if (
      !vehicle ||
      inFlight.current ||
      scenario !== "connected" ||
      !supports(vehicle, capability)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    const status = vehicle.scheduleReads?.[kind]?.status;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    if (status === "failed" || status === "partial") {
      setNotice("模拟读取未取得完整列表，继续保留现有记录");
    } else {
      setData((old) => ({
        ...old,
        schedules: old.schedules.filter(
          (item) =>
            !(
              item.vehicleId === vehicle.id &&
              item.kind === kind &&
              item.confirmation === "deleting"
            ),
        ),
        vehicles: old.vehicles.map((car) =>
          car.id === vehicle.id
            ? {
                ...car,
                scheduleReads: {
                  ...car.scheduleReads,
                  [kind]: { status: "success", observedAt: Date.now() },
                },
              }
            : car,
        ),
      }));
      setNotice("模拟完整列表已读取");
    }
    inFlight.current = false;
    setBusy(false);
  }

  function saveSchedule(schedule: Schedule) {
    const capability =
      schedule.kind === "空调" ? "climateSchedule" : "chargeSchedule";
    if (
      !vehicle ||
      schedule.vehicleId !== vehicle.id ||
      inFlight.current ||
      scenario !== "connected" ||
      !supports(vehicle, capability)
    )
      return;
    setData((old) => ({
      ...old,
      schedules: [
        ...old.schedules.filter((item) => item.id !== schedule.id),
        { ...schedule, confirmation: "accepted" },
      ],
    }));
    setNotice("模拟服务已接受计划，目标字段等待回读确认");
  }

  async function deleteSchedule(schedule: Schedule) {
    const capability =
      schedule.kind === "空调" ? "climateSchedule" : "chargeSchedule";
    if (
      !vehicle ||
      schedule.vehicleId !== vehicle.id ||
      inFlight.current ||
      scenario !== "connected" ||
      !supports(vehicle, capability)
    )
      return;
    setData((old) => ({
      ...old,
      schedules: old.schedules.map((item) =>
        item.id === schedule.id ? { ...item, confirmation: "deleting" } : item,
      ),
    }));
    setNotice("模拟删除已提交，等待完整列表回读");
    if (schedule.kind === "空调") await readSchedules(schedule.kind);
  }

  function removeVehicle(id: string) {
    setData((old) => {
      const vehicles = old.vehicles.filter((v) => v.id !== id);
      return {
        ...old,
        vehicles,
        selected: old.selected === id ? (vehicles[0]?.id ?? "") : old.selected,
        schedules: old.schedules.filter((s) => s.vehicleId !== id),
        locations: old.locations.filter((l) => l.vehicleId !== id),
        receipts: old.receipts.filter((r) => r.vehicleId !== id),
        fuel: old.fuel.filter((f) => f.vehicleId !== id),
        routines: old.routines.filter((r) => r.vehicleId !== id),
        hiddenTrips: old.hiddenTrips.filter((t) => !t.startsWith(id)),
        clearedHistory: old.clearedHistory.filter((v) => v !== id),
      };
    });
    setNotice("已移除该演示车辆及其本地记录");
  }

  const distance = (km: number) =>
    `${(data.settings.distance === "mi" ? km / 1.609344 : km).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${data.settings.distance}`;
  const temperature = (c: number) =>
    `${Math.round(data.settings.temperature === "F" ? (c * 9) / 5 + 32 : c)}°${data.settings.temperature}`;
  return {
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
    saveSchedule,
    deleteSchedule,
    readSchedules,
    notice,
    setNotice,
    busy,
    command,
    refresh,
    resolveReceipt,
    removeVehicle,
    distance,
    temperature,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceState();
  return (
    <WorkspaceContext.Provider value={workspace}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("WorkspaceProvider required");
  return workspace;
}
