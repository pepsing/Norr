type Reading<T> = T & { status: string; reportedAt: number | null };
export type P4VehicleSample = {
  collectedAt: number;
  battery?: Reading<{ percent: number | null }>;
  exterior?: Reading<{ locked: boolean | null }>;
  climate?: Reading<{ activity: string | null; interiorTemperature: number | null; exteriorTemperature?: number | null }>;
  target?: Reading<{ percent?: number | null; referencePercent?: number | null }>;
  odometer?: Reading<{ km: number | null }>;
  health?: Reading<{ kpa: Partial<Record<string, number | null>> }>;
  software?: Reading<{ version: string | null }>;
};

const activities: Record<string, string> = { active: "运行中", idle: "已停止", starting: "正在启动" };
const wheels = [["frontLeft", "左前"], ["frontRight", "右前"], ["rearLeft", "左后"], ["rearRight", "右后"]];

function number(value: number | null | undefined, unit: string, digits = 0) {
  return typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) + unit : undefined;
}

export function P4VehicleReadings({ sample }: { sample: P4VehicleSample }) {
  const lock = sample.exterior?.locked;
  const rows = [
    ["门锁", sample.exterior, lock == null ? undefined : lock ? "已锁定" : "已解锁"],
    ["驻车空调", sample.climate, activities[sample.climate?.activity ?? ""]],
    ["车内温度", sample.climate, number(sample.climate?.interiorTemperature, " °C", 1)],
    ["车外温度", sample.climate, number(sample.climate?.exteriorTemperature, " °C", 1)],
    ["当前电量", sample.battery, number(sample.battery?.percent, "%", 1)],
    ["充电上限", sample.target, number(sample.target?.percent, "%", 1)],
    ...(sample.target?.referencePercent != null ? [["充电上限（C3 参考值）", sample.target, number(sample.target.referencePercent, "%")] as const] : []),
    ["总里程", sample.odometer, number(sample.odometer?.km, " km")],
    ...wheels.map(([key, name]) => [name + "胎压", sample.health, number(sample.health?.kpa?.[key], " kPa")] as const),
    ["软件服务返回的版本", sample.software, sample.software?.version],
  ] as const;
  return <>
    <h3>车况读数</h3>
    <p className="muted">采集于 {new Date(sample.collectedAt).toLocaleTimeString("zh-CN")}。充电上限以车机或官方 App 显示为准。</p>
    <dl className="native-details">{rows.map(([label, reading, value]) =>
      <div key={label}><dt>{label}</dt><dd>{reading?.status === "failed" ? "读取失败" : value ?? "未返回"}
        {(label === "门锁" || label === "驻车空调") && reading?.reportedAt != null && <small style={{display: "block"}}>
          上报于 {new Date(reading.reportedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </small>}
      </dd></div>
    )}</dl>
  </>;
}
