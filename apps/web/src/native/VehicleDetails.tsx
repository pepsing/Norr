import type { ReactNode } from "react";
import { numeric, readingText } from "./client";
import { VehicleMap } from "./VehicleMap";
import type { Snapshot } from "./client";

function text(value: unknown, unit = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}${unit}`
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

export function VehicleDetails({
  snapshot,
  onError,
  includeMap = true,
}: {
  snapshot?: Snapshot;
  onError: (message: string) => void;
  includeMap?: boolean;
}) {
  const health = snapshot?.readings.health?.value;
  const tyres = (health?.tyres ?? []) as {
    wheel: string;
    kpa: number | null;
    warning: number | null;
    referenceKpa: number | null;
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
      <div>
        {includeMap && (
          <VehicleMap
            key={snapshot?.vehicle.vin}
            snapshot={snapshot}
            onError={onError}
          />
        )}
        <section className="native-section">
          <h2>行程读数</h2>
          <p className="muted">{readingText(snapshot, "odometer")}</p>
          <Metrics
            items={[
              ["总里程", text(numeric(snapshot, "odometer", "km"), " km")],
              [
                "手动行程",
                text(numeric(snapshot, "odometer", "tripKm"), " km"),
              ],
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
      </div>
    </div>
  );
}

export function AirQuality({
  snapshot,
  controls,
}: {
  snapshot?: Snapshot;
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
      <Metrics
        items={[
          [
            "车内 PM2.5",
            text(numeric(snapshot, "airQuality", "pm25"), " μg/m³"),
          ],
          [
            "车外 PM2.5",
            text(numeric(snapshot, "airQuality", "externalPm25"), " μg/m³"),
          ],
          ["空气质量指数", text(numeric(snapshot, "airQuality", "aqi"))],
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
