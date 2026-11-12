export const capabilityLabels = {
  lock: "门锁",
  climate: "空调",
  charge: "充电设置",
  windows: "车窗",
  tailgate: "尾门",
  cleaning: "空气净化",
  locate: "鸣笛与闪灯",
  engine: "发动机",
  software: "软件安装",
  climateSchedule: "空调定时",
  chargeSchedule: "全局充电日程",
  chargeLocation: "充电地点写入",
};

export type Capability = keyof typeof capabilityLabels;
export type CapabilityFlags = Partial<
  Record<Capability, boolean | "unavailable">
>;
export interface CapabilityProfile {
  capabilities?: CapabilityFlags;
  controlAccess?: "owner" | "denied" | "unchecked";
}

export function demoCapabilityProfile(
  brand: string,
  region: string,
  model: string,
): CapabilityProfile {
  if (brand === "Volvo")
    return {
      controlAccess: "owner",
      capabilities: { lock: true, climate: true, locate: true, engine: true },
    };
  if (region === "中国区")
    return {
      controlAccess: "owner",
      capabilities:
        model === "Polestar 2"
          ? {
              lock: true,
              climate: true,
              charge: true,
              windows: true,
              tailgate: true,
              locate: true,
              climateSchedule: true,
              chargeSchedule: true,
              engine: false,
              chargeLocation: "unavailable",
            }
          : {},
    };
  return {
    controlAccess: "owner",
    capabilities: {
      lock: true,
      climate: true,
      charge: true,
      windows: true,
      tailgate: true,
      cleaning: true,
      locate: true,
      engine: false,
      software: true,
      climateSchedule: true,
      chargeSchedule: true,
      chargeLocation: true,
    },
  };
}

export function supports(vehicle: CapabilityProfile, capability: Capability) {
  return (
    vehicle.controlAccess === "owner" &&
    vehicle.capabilities?.[capability] === true
  );
}

export function capabilityStatus(
  vehicle: CapabilityProfile,
  capability: Capability,
) {
  if (vehicle.controlAccess === "denied") return "无操作权限";
  if (vehicle.controlAccess !== "owner") return "权限待确认";
  const value = vehicle.capabilities?.[capability];
  if (value === "unavailable") return "接入待完成";
  if (value === false) return "不支持";
  return value === true ? "可演示" : "尚未检查";
}

export function capabilityReason(
  vehicle: CapabilityProfile & { region: string; model: string },
  capability?: Capability,
) {
  if (capability) {
    const status = capabilityStatus(vehicle, capability);
    if (status === "接入待完成") return "此操作的服务适配待完成。";
    if (status === "不支持") return "当前能力数据明确标记为不支持。";
    if (status === "无操作权限") return "当前账号未获得车辆操作权限。";
    if (status === "权限待确认") return "请先确认当前账号的车辆操作权限。";
    if (status === "尚未检查") return "尚未取得此操作的能力信息。";
  }
  if (vehicle.region === "中国区" && vehicle.model === "Polestar 4")
    return "中国区 Polestar 4 的服务适配与能力仍待验证。";
  return "按钮按当前演示的权限与能力数据显示。真实车辆以账号权限和车辆返回结果为准。";
}
