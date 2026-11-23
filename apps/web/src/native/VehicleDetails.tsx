import { useState, type ReactNode } from "react";
import { P4CabinPhoto, type P4Seat } from "../components/P4CabinDialog";
import { SectionTabs } from "../components/WorkspaceUI";
import overhead from "../assets/p4-design/overhead.webp";
import { actionLabels, cabinAirTime, isNativeP4, numeric, readingText, unavailableReason } from "./client";
import { VehicleArtwork } from "../components/VehicleArtwork";
import type { VehicleAppearance } from "../vehicle-catalog";
import { VehicleMap } from "./VehicleMap";
import type { Command, Snapshot } from "./client";

function text(value: unknown, unit = "", maximumFractionDigits = 1): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("zh-CN", { maximumFractionDigits })}${unit}`
    : "未返回";
}

function Metrics({ items }: { items: [string, string][] }) {
  return (
    <dl className="native-details">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function seatLevelText(level: number | null): string {
  if (level === 0) return "关闭";
  return level !== null && Number.isInteger(level) && level >= 1 && level <= 3 ? `${level} 档` : "未返回";
}

export function P4ClimateDetails({ snapshot, activity, controls, onCommand, disabled = false }: { snapshot?: Snapshot; activity: string; controls?: ReactNode; onCommand?: (command: Command) => void; disabled?: boolean }) {
  const [tab, setTab] = useState("空调");
  const [seat, setSeat] = useState<P4Seat>("主驾");
  const prefix = seat === "主驾" ? "driver" : "passenger";
  const climate = snapshot?.readings.climate;
  const steering = climate?.status === "success" ? climate.value?.steeringWheelHeatActive : null;
  const seatControl = (action: string, label: string, current: number | null, max: number) => {
    if (!onCommand || !snapshot) return null;
    const reason = unavailableReason(snapshot.vehicle, action);
    return <fieldset className="p4-cabin-control" disabled={disabled || !!reason}>
      <legend>{label}</legend>
      <div className="limit-presets">
        {Array.from({ length: max + 1 }, (_, value) => <button type="button" key={value}
          aria-pressed={current === value}
          onClick={() => onCommand({ vin: snapshot.vehicle.vin, action, value })}>
          {value === 0 ? "关闭" : max === 1 ? "开启" : `${value} 档`}
        </button>)}
      </div>
      {reason && <p className="p4-action-note">{reason}</p>}
    </fieldset>;
  };
  return (
    <>
      <SectionTabs items={["空调", "座椅"]} value={tab} onChange={setTab} label="座舱设置" />
      <P4CabinPhoto seat={tab === "座椅" ? seat : undefined} onSelect={setSeat} />
      {tab === "空调" ? <><Metrics items={[
        ["驻车空调", activity],
        ["车内温度", text(numeric(snapshot, "climate", "interiorTemperature"), " °C")],
        ["车外温度", text(numeric(snapshot, "climate", "exteriorTemperature"), " °C")],
        ["目标温度", "尚无车辆回读"],
      ]} />{controls}</> : <><Metrics items={[
        [seat + "加热", seatLevelText(numeric(snapshot, "climate", prefix + "SeatHeatLevel"))],
        [seat + "通风", seatLevelText(numeric(snapshot, "climate", prefix + "SeatVentLevel"))],
        ["方向盘加热", typeof steering === "boolean" ? (steering ? "开启" : "关闭") : "未返回"],
      ]} />
        {seatControl(prefix + "SeatHeat", seat + "座椅加热", numeric(snapshot, "climate", prefix + "SeatHeatLevel"), 3)}
        {seatControl(prefix + "SeatVent", seat + "座椅通风", numeric(snapshot, "climate", prefix + "SeatVentLevel"), 3)}
        {seatControl("steeringWheelHeat", "方向盘加热", typeof steering === "boolean" ? Number(steering) : null, 1)}
        {onCommand && <p className="p4-action-note">切换加热或通风前，请先关闭当前模式并等待车辆回读。</p>}
      </>}
      <p className="muted native-reading-time">{readingText(snapshot, "climate")}</p>
    </>
  );
}

export function VehicleDetails({
  snapshot,
  onError,
  includeMap = true,
  appearance,
  dark = false,
}: {
  snapshot?: Snapshot;
  onError: (message: string) => void;
  includeMap?: boolean;
  appearance?: VehicleAppearance;
  dark?: boolean;
}) {
  const [tab, setTab] = useState("状态");
  const p4 = isNativeP4(snapshot?.vehicle);
  const healthReading = snapshot?.readings.health;
  const health = healthReading?.status === "success" ? healthReading.value : undefined;
  const tyres = (Array.isArray(health?.tyres) ? health.tyres : []) as {
    wheel: string;
    kpa: number | null;
    warning: number | null;
    sourceWarning?: number | null;
    referenceKpa: number | null;
    temperatureC?: number | null;
  }[];
  const wheelLabels: Record<string, string> = {
    frontLeft: "左前轮",
    frontRight: "右前轮",
    rearLeft: "左后轮",
    rearRight: "右后轮",
  };
  const tyreWarnings: Record<number, string> = {
    1: "正常",
    2: "严重偏低",
    3: "偏低",
    4: "偏高",
  };
  const warningLabels: Record<string, string> = {
    service: "保养提醒",
    brakeFluid: "制动液",
    coolant: "冷却液",
    oil: "机油",
    washerFluid: "玻璃水",
    lowVoltageBattery: "低压电池",
  };
  const warnings = (health?.warnings ?? {}) as Record<string, number | null>;
  if (p4 && snapshot) return <>
    <SectionTabs label="车辆详情分类" items={["状态", "行车日志", ...(includeMap ? ["位置"] : []), "健康", "规格与能力"]} value={tab} onChange={setTab} />
    {tab === "状态" && <section className="native-section"><h2>轮胎与车身</h2>
      <div className="p4-wheels" role="group" aria-label="四轮胎压和胎温">
        {Object.entries(wheelLabels).map(([wheel, label]) => {
          const tyre = tyres.find(item => item.wheel === wheel);
          return <div key={wheel}><span>{label}</span><strong>{text(tyre?.kpa, "", 0)}{Number.isFinite(tyre?.kpa) && <small> kPa</small>}</strong>
            <span>{text(tyre?.temperatureC, " °C")} · {tyre?.sourceWarning === 0 ? "正常" : "状态待核实"}</span></div>;
        })}
        <img src={overhead} alt="Polestar 4 俯视图，车头向上" width={342} height={766} />
      </div><p className="muted">{readingText(snapshot, "health")}</p><OpeningStatus snapshot={snapshot} />
      {snapshot.readings.vehicleModes?.value && <details><summary>车辆模式</summary><p>露营与驻车舒适状态待核实。</p>
        <p className="muted">{readingText(snapshot, "vehicleModes")}</p></details>}
    </section>}
    {tab === "行车日志" && <section className="native-section"><h2>行车日志</h2>
      {appearance && <div className="p4-trip-car"><VehicleArtwork appearance={appearance} view={dark ? "side" : "front"} darkStage={dark} /></div>}
      <Metrics items={[["总里程", text(numeric(snapshot, "odometer", "km"), " km")],
        ["上一次里程", text(numeric(snapshot, "odometer", "tripKm"), " km")],
        ["平均电耗", text(numeric(snapshot, "battery", "averageConsumptionKwhPer100Km"), " kWh/100 km")],
        ["手动行程均速", text(numeric(snapshot, "odometer", "manualAverageSpeed"), " km/h")]]} />
      <p className="muted">{readingText(snapshot, "odometer")}</p></section>}
    {tab === "位置" && includeMap && <VehicleMap snapshot={snapshot} onError={onError} />}
    {tab === "健康" && <section className="native-section"><h2>健康与保养</h2><Metrics items={[
      ["距保养天数", text(health?.daysToService, " 天")], ["距保养里程", text(health?.kmToService, " km")]]} />
      <p className="muted">{readingText(snapshot, "health")}</p></section>}
    {tab === "规格与能力" && <section className="native-section"><h2>车辆档案</h2><Metrics items={[
      ["车型", snapshot.vehicle.model], ["年份", snapshot.vehicle.modelYear ?? "未返回"], ["地区", "中国区"]]} />
      <h2>控制接入状态</h2><Metrics items={["lock", "unlock", "unlockTrunk", "climateStart", "target", "honkFlash"].map(
        action => [actionLabels[action], unavailableReason(snapshot.vehicle, action) ?? "已接入"])} /></section>}
  </>;
  return (
    <div className="native-detail-columns">
      <section className="native-section">
        <h2>健康与保养</h2>
        <p className="muted">{readingText(snapshot, "health")}</p>
        <Metrics
          items={[
            ["距保养天数", text(health?.daysToService, " 天")],
            ["距保养里程", text(health?.kmToService, " km")],
          ]}
        />
        {!/^polestar\s*2(?:\b|$)/i.test(snapshot?.vehicle.model ?? "") &&
          tyres.length > 0 && (
            <div className="native-table-wrap">
              <table className="native-table">
                <thead>
                  <tr>
                    <th>轮胎</th>
                    <th>实测压力</th>
                    <th>参考压力</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {tyres.map((tyre) => (
                    <tr key={tyre.wheel}>
                      <td>{wheelLabels[tyre.wheel] ?? tyre.wheel}</td>
                      <td>{text(tyre.kpa, " kPa")}</td>
                      <td>{text(tyre.referenceKpa, " kPa")}</td>
                      <td>{tyreWarnings[tyre.warning ?? 0] ?? "未知"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Metrics
          items={Object.entries(warnings)
            .filter(([key]) => key !== "oil")
            .map(([key, value]) => [
              warningLabels[key] ?? key,
              value === null || value === 0
                ? "未知"
                : value === 1
                  ? "正常"
                  : "需检查",
            ])}
        />
      </section>
      <section className="native-section">
        <h2>行程读数</h2>
        <p className="muted">{readingText(snapshot, "odometer")}</p>
        <Metrics
          items={[
            ["总里程", text(numeric(snapshot, "odometer", "km"), " km")],
            ["手动行程", text(numeric(snapshot, "odometer", "tripKm"), " km")],
            [
              "自动行程",
              text(numeric(snapshot, "odometer", "automaticTripKm"), " km"),
            ],
            [
              "充电后行程",
              text(numeric(snapshot, "odometer", "sinceChargeTripKm"), " km"),
            ],
            [
              "手动行程均速",
              text(
                numeric(snapshot, "odometer", "manualAverageSpeed"),
                " km/h",
              ),
            ],
            [
              "自动行程均速",
              text(
                numeric(snapshot, "odometer", "automaticAverageSpeed"),
                " km/h",
              ),
            ],
            [
              "充电后均速",
              text(
                numeric(snapshot, "odometer", "sinceChargeAverageSpeed"),
                " km/h",
              ),
            ],
          ]}
        />
      </section>
      {includeMap && (
        <VehicleMap
          key={snapshot?.vehicle.vin}
          snapshot={snapshot}
          onError={onError}
        />
      )}
    </div>
  );
}

export function AirQuality({
  snapshot,
  cabinReading,
  controls,
}: {
  snapshot?: Snapshot;
  cabinReading?: Snapshot;
  controls: ReactNode;
}) {
  const state = numeric(snapshot, "airQuality", "state");
  return (
    <section className="native-section">
      <h2>空气质量</h2>
      <p>
        {(
          { 1: "正在预清洁", 2: "预清洁已关闭", 3: "预清洁等待启动" } as Record<
            number,
            string
          >
        )[state ?? 0] ?? "预清洁状态未知"}
      </p>
      <p className="muted">{readingText(snapshot, "airQuality")}</p>
      {cabinReading && cabinReading !== snapshot && (
        <p className="muted">车内空气读数来自上次记录 · {cabinAirTime(cabinReading)}</p>
      )}
      <Metrics
        items={[
          [
            "车内 PM2.5",
            text(numeric(cabinReading, "airQuality", "pm25"), " μg/m³"),
          ],
          [
            "车外 PM2.5",
            text(numeric(snapshot, "airQuality", "externalPm25"), " μg/m³"),
          ],
          ["空气质量指数", text(numeric(cabinReading, "airQuality", "aqi"))],
          [
            "滤芯剩余",
            text(numeric(snapshot, "airQuality", "filterPercent"), "%"),
          ],
        ]}
      />
      <div className="native-actions">{controls}</div>
    </section>
  );
}

const softwareStates: Record<number, string> = {
  0: "未知",
  1: "等待下载",
  2: "正在下载",
  3: "已下载",
  4: "下载失败",
  5: "正在安装",
  6: "正在安装",
  7: "已中止",
  8: "安装失败",
  9: "安装完成",
  10: "已推迟",
  11: "安装失败",
  12: "已预约",
  13: "正在安装",
  14: "安装状态未知",
  15: "有可用更新",
};

export function SoftwarePanel({
  snapshot,
  controls,
}: {
  snapshot?: Snapshot;
  controls: ReactNode;
}) {
  const software = snapshot?.readings.software?.value;
  const installed =
    snapshot?.vehicle.installedVersion ??
    (software?.state === 9 ? software?.version : null);
  const scheduledAt = numeric(snapshot, "softwareSchedule", "scheduledAt");
  return (
    <section className="native-section">
      <h2>车辆软件</h2>
      <Metrics
        items={[
          ["已安装版本", typeof installed === "string" ? installed : "未返回"],
          [
            "更新状态",
            software?.noUpdate === true
              ? "当前没有更新信息"
              : (softwareStates[Number(software?.state)] ?? "未知"),
          ],
          [
            "服务返回版本",
            typeof software?.version === "string" ? software.version : "未返回",
          ],
          [
            "预计安装耗时",
            text(
              typeof software?.durationSeconds === "number"
                ? Math.ceil(software.durationSeconds / 60)
                : null,
              " 分钟",
            ),
          ],
        ]}
      />
      {scheduledAt !== null && (
        <p>预约安装于 {new Date(scheduledAt).toLocaleString("zh-CN")}</p>
      )}
      {typeof software?.description === "string" && (
        <details>
          <summary>版本说明</summary>
          <p className="native-release-notes">{software.description}</p>
        </details>
      )}
      <p className="muted">{readingText(snapshot, "software")}</p>
      <p className="muted">
        安装计划 · {readingText(snapshot, "softwareSchedule")}
      </p>
      <div className="native-actions">{controls}</div>
    </section>
  );
}

export function ChargeLocations({ snapshot }: { snapshot?: Snapshot }) {
  const reading = snapshot?.readings.chargeLocations;
  const locations = (reading?.value?.locations ?? []) as {
    id: string;
    name: string | null;
    amps: number | null;
    minimumPercent: number | null;
    timers: {
      kind: string;
      start: number;
      end: number | null;
      active: boolean;
      weekdays: number[];
    }[];
  }[];
  return (
    <section className="native-section">
      <h2>充电地点</h2>
      <p className="muted">{readingText(snapshot, "chargeLocations")}</p>
      {reading?.status === "success" && locations.length === 0 && (
        <p className="muted">车辆当前没有保存充电地点。</p>
      )}
      {locations.map((location) => (
        <article key={location.id} className="native-setting-row">
          <div>
            <h3>{location.name || "未命名地点"}</h3>
            <p>
              电流上限 {text(location.amps, " A")} · 最低电量{" "}
              {text(location.minimumPercent, "%")}
            </p>
            {location.timers.map((timer, index) => (
              <p key={index}>
                {timer.kind === "departure" ? "出发" : "充电"} ·{" "}
                {String(Math.floor(timer.start / 60)).padStart(2, "0")}:
                {String(timer.start % 60).padStart(2, "0")} ·{" "}
                {timer.active ? "启用" : "停用"}
              </p>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

export function OpeningStatus({ snapshot }: { snapshot: Snapshot | undefined }) {
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
