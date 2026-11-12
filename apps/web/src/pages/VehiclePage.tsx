import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CarFront,
  Fan,
  LockKeyhole,
  MapPin,
  ShieldCheck,
  Thermometer,
} from "lucide-react";
import { EnergyPanel } from "../components/EnergyPanel";
import { Bars, DataRows, SectionTabs } from "../components/WorkspaceUI";
import {
  capabilityReason,
  capabilityStatus,
  capabilityLabels,
  downloadFile,
  supports,
  useWorkspace,
} from "../workspace";
import type { Capability } from "../workspace";
import { VehicleArtwork } from "../components/VehicleArtwork";
import { appearanceFor, appearanceDetails } from "../vehicle-catalog";

export function VehiclePage({
  onNavigate,
  onControl,
}: {
  onNavigate: (page: string) => void;
  onControl: (control: "lock" | "climate") => void;
}) {
  const { vehicle, data, busy, scenario, command, temperature } =
    useWorkspace();
  if (!vehicle) return null;
  const unavailable = busy || scenario !== "connected";
  return (
    <>
      <div className="overview-grid">
        <section className="vehicle-stage" aria-labelledby="vehicle-title">
          <div className="vehicle-heading">
            <div>
              <h2 id="vehicle-title">{vehicle.model}</h2>
              <p>{vehicle.variant}</p>
            </div>
            <span className="lock-state">
              <LockKeyhole size={15} />
              {vehicle.locked ? "已锁车" : "已解锁"}
            </span>
          </div>
          <div className="vehicle-art">
            {vehicle.brand === "Polestar" ? (
              <VehicleArtwork appearance={appearanceFor(vehicle)} priority />
            ) : (
              <div className="art-placeholder">
                <CarFront size={80} strokeWidth={1} />
                <span>Volvo XC60 · 车辆图片待接入</span>
              </div>
            )}
          </div>
          <div className="vehicle-stage-footer">
            <span>
              {vehicle.nickname} · {vehicle.region}
            </span>
            <div>
              <Thermometer size={16} />
              <span>车外 {temperature(vehicle.outsideTemperature)}</span>
              <span>车内 {temperature(vehicle.cabinTemperature)}</span>
            </div>
          </div>
        </section>
        <EnergyPanel
          vehicle={vehicle}
          busy={busy}
          unavailable={unavailable || !supports(vehicle, "charge")}
          onToggleCharge={() =>
            command(vehicle.charging ? "暂停充电" : "继续充电", "charge", {
              charging: !vehicle.charging,
            })
          }
          onSettings={() => onNavigate("charging")}
        />
      </div>
      {vehicle.region === "中国区" && (
        <p className="capability-note">{capabilityReason(vehicle)}</p>
      )}
      <div className="section-heading">
        <h2>快捷控制</h2>
        <button className="text-button" onClick={() => onNavigate("controls")}>
          全部控制
          <ArrowRight size={17} />
        </button>
      </div>
      <div className="quick-controls">
        <button
          className="control-tile"
          data-active={vehicle.locked === false}
          disabled={unavailable || !supports(vehicle, "lock")}
          onClick={() => onControl("lock")}
        >
          <div className="tile-heading">
            <h3>车门与门锁</h3>
            <ArrowUpRight size={21} />
          </div>
          <p>{vehicle.locked ? "所有车门已锁定" : "车门已解锁"}</p>
          <div className="tile-bottom">
            <LockKeyhole size={35} strokeWidth={1.2} />
            <span>{vehicle.locked ? "解锁车辆" : "锁定车辆"}</span>
          </div>
        </button>
        <button
          className="control-tile"
          data-active={vehicle.climateOn === true}
          disabled={unavailable || !supports(vehicle, "climate")}
          onClick={() => onControl("climate")}
        >
          <div className="tile-heading">
            <h3>座舱温度</h3>
            <ArrowUpRight size={21} />
          </div>
          <p>
            {vehicle.climateOn
              ? `空调运行中 · ${temperature(vehicle.targetTemperature)}`
              : `空调已关闭 · 车内 ${temperature(vehicle.cabinTemperature)}`}
          </p>
          <div className="tile-bottom">
            <Fan size={35} strokeWidth={1.2} />
            <span>{vehicle.climateOn ? "调整空调" : "开启空调"}</span>
          </div>
        </button>
        <button className="control-tile" onClick={() => onNavigate("details")}>
          <div className="tile-heading">
            <h3>车辆详情</h3>
            <ArrowUpRight size={21} />
          </div>
          <p>{vehicle.windowsOpen ? "车窗已打开" : "车窗关闭"} · 胎压正常</p>
          <div className="tile-bottom">
            <ShieldCheck size={35} strokeWidth={1.2} />
            <span>状态与健康</span>
          </div>
        </button>
      </div>
      <section className="recent-section">
        <div className="section-heading">
          <h2>最近一次充电</h2>
          <button className="text-button" onClick={() => onNavigate("history")}>
            全部记录
            <ArrowRight size={17} />
          </button>
        </div>
        {data.clearedHistory.includes(vehicle.id) ? (
          <p className="inline-empty">本车记录已清空，后续采样会出现在这里。</p>
        ) : (
          <div className="recent-session">
            <div className="session-description">
              <h3>家庭充电</h3>
              <p>昨日 · 22:18 至次日 06:42 · 示例</p>
            </div>
            <div className="session-level">
              42%
              <ArrowRight size={17} />
              90%
            </div>
            <div className="session-energy">
              32.6 <small>kWh</small>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

export function VehicleDetails() {
  const { vehicle, data, distance, temperature } = useWorkspace();
  const [tab, setTab] = useState("状态");
  const [includeVin, setIncludeVin] = useState(false);
  if (!vehicle) return null;
  const capabilities = Object.entries(capabilityLabels) as [
    Capability,
    string,
  ][];
  return (
    <>
      <div className="detail-hero">
        <div>
          <p className="eyebrow">{vehicle.nickname}</p>
          <h2>{vehicle.model}</h2>
          <p>
            {vehicle.variant} · {vehicle.region}
          </p>
        </div>
        <div>
          <span className="muted">累计里程</span>
          <p className="large-number">{distance(vehicle.odometer)}</p>
        </div>
      </div>
      <SectionTabs
        items={["状态", "位置", "健康", "软件", "规格与能力"]}
        value={tab}
        onChange={setTab}
        label="车辆详情分类"
      />
      {tab === "状态" && (
        <div className="split-content">
          <section>
            <h2>车身与座舱</h2>
            <DataRows
              rows={[
                ["中央门锁", vehicle.locked ? "已锁定" : "已解锁"],
                ["四门", "已关闭"],
                ["车窗", vehicle.windowsOpen ? "已打开" : "全部关闭"],
                ["尾门", vehicle.tailgateOpen ? "已打开" : "已关闭"],
                ["前舱盖", "已关闭"],
                ["车内温度", temperature(vehicle.cabinTemperature)],
                ["空气净化", vehicle.cleaning ? "运行中" : "已停止"],
              ]}
            />
          </section>
          <section>
            <h2>轮胎与出发状态</h2>
            <div className="tyre-layout">
              {["左前", "右前", "左后", "右后"].map((label) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>正常</strong>
                </div>
              ))}
              <CarFront size={65} strokeWidth={1} />
            </div>
            <p className="muted">
              间接胎压监测示例，仅显示状态。出发前请检查车辆周边。
            </p>
            <DataRows
              rows={[
                ["12 V 电池", "状态正常"],
                ["警告", "当前示例未报告警告"],
              ]}
            />
          </section>
        </div>
      )}
      {tab === "位置" && (
        <div className="split-content">
          <section className="location-panel">
            <MapPin size={44} strokeWidth={1} />
            <h2>
              {data.settings.privacy ? "位置已隐藏" : "哥德堡 · 演示停车位置"}
            </h2>
            <p>公开地点用于位置界面演示</p>
            <p className="location-coordinate">
              {data.settings.privacy
                ? "隐私模式已开启"
                : "57.7089° N / 11.9746° E"}
            </p>
            {!data.settings.privacy && (
              <a
                className="primary-button"
                target="_blank"
                rel="noreferrer"
                href="https://www.openstreetmap.org/?mlat=57.7089&mlon=11.9746#map=16/57.7089/11.9746"
              >
                在地图中查看
                <ArrowUpRight size={17} />
              </a>
            )}
          </section>
          <section>
            <h2>停车与环境</h2>
            <DataRows
              rows={[
                ["定位状态", "上次停车位置 · 示例"],
                [
                  "位置时间",
                  new Date(vehicle.updatedAt).toLocaleTimeString("zh-CN"),
                ],
                ["室外温度", temperature(vehicle.outsideTemperature)],
                ["天气", "多云 · 演示"],
                ["停车时长", "2 小时 18 分 · 演示"],
              ]}
            />
            <p className="muted">
              定位记录随车辆上报更新，时间较早时需先刷新确认。
            </p>
          </section>
        </div>
      )}
      {tab === "健康" && (
        <div className="split-content">
          <section>
            <h2>保养与诊断</h2>
            <DataRows
              rows={[
                ["下次保养", `剩余 ${distance(7154)} 或 8 个月`],
                ["制动液", "正常"],
                ["清洗液", "正常"],
                ["灯光系统", "正常"],
                ["诊断故障", "示例快照未报告故障"],
              ]}
            />
            <p className="muted">以上均为演示读数，保养周期由车辆上报。</p>
          </section>
          <section>
            <h2>电池健康趋势</h2>
            <p className="large-number">
              96.2<small>%</small>
            </p>
            <p className="muted">实验性估算 · 示例数据</p>
            <Bars
              title="月度健康估算"
              unit="%"
              values={[97.1, 96.8, 96.5, 96.2]}
              labels={["8月", "9月", "10月", "11月"]}
            />
            <p className="muted">
              估算受温度、采样和充电区间影响，可在记录页查看采样间断。
            </p>
          </section>
        </div>
      )}
      {tab === "软件" && (
        <section className="reading-width">
          <h2>车辆软件</h2>
          <DataRows
            rows={[
              ["当前版本", vehicle.software],
              [
                "更新状态",
                vehicle.software === "P4.2.2"
                  ? "演示更新已安装"
                  : "P4.2.2 可用 · 演示",
              ],
              ["更新说明", "连接稳定性与座舱功能改进 · 示例"],
            ]}
          />
          <p className="muted">
            支持的软件安装操作位于控制页，执行前需确认驻车与电量条件。
          </p>
          <details className="disclosure">
            <summary>查看更新与失败处理说明</summary>
            <p>
              安装期间车辆可能暂时离线。结果未确认时，先刷新车辆状态。失败记录保留在指令历史中。
            </p>
          </details>
        </section>
      )}
      {tab === "规格与能力" && (
        <>
          <div className="split-content">
            <section>
              <h2>车辆档案</h2>
              <DataRows
                rows={[
                  ["品牌", vehicle.brand],
                  ["车型", vehicle.model],
                  [
                    "动力形式",
                    vehicle.brand === "Polestar" ? "纯电动" : "插电式混合动力",
                  ],
                  [
                    "车身颜色",
                    vehicle.brand === "Polestar"
                      ? appearanceDetails(appearanceFor(vehicle)).color.name
                      : "示例未提供",
                  ],
                  ["版本", vehicle.variant],
                  [
                    "轮毂",
                    vehicle.brand === "Polestar"
                      ? appearanceDetails(appearanceFor(vehicle)).variant.wheels
                      : "示例未提供",
                  ],
                  [
                    "图片年款",
                    vehicle.brand === "Polestar"
                      ? "MY2027 · 英国官网素材"
                      : "示例未提供",
                  ],
                  [
                    "VIN",
                    data.settings.privacy ? "已隐藏" : "DEMO-VEHICLE-0001",
                  ],
                  ["数据来源", "本地演示配置"],
                ]}
              />
            </section>
            <section>
              <h2>能力说明</h2>
              {capabilities.map(([id, label]) => (
                <div className="list-row" key={id}>
                  <span>{label}</span>
                  <span className={supports(vehicle, id) ? "" : "muted"}>
                    {capabilityStatus(vehicle, id)}
                  </span>
                </div>
              ))}
              <p className="muted">
                {capabilityReason(vehicle)} 所有能力为预览配置。
              </p>
            </section>
          </div>
          <section className="content-section">
            <h2>车辆交接</h2>
            <p className="muted">
              导出车型、保养摘要与演示行程及充电记录。交接数据省略位置信息。
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={includeVin}
                onChange={(e) => setIncludeVin(e.target.checked)}
              />
              包含演示 VIN
            </label>
            <button
              className="secondary-button"
              onClick={() =>
                downloadFile(
                  "norr-demo-handover.json",
                  JSON.stringify(
                    {
                      type: "演示交接资料",
                      model: vehicle.model,
                      odometer: vehicle.odometer,
                      vin: includeVin ? "DEMO-VEHICLE-0001" : undefined,
                      service: "剩余 7154 km 或 8 个月（示例）",
                      charging: data.clearedHistory.includes(vehicle.id)
                        ? []
                        : [{ energy: 32.6, start: 42, end: 90 }],
                      trips: data.clearedHistory.includes(vehicle.id)
                        ? []
                        : [{ distance: 28.4, energy: 4.8 }],
                      checklist: [
                        "在厂商应用解除车辆关联",
                        "在车机清除个人数据",
                        "检查数字钥匙与共享权限",
                      ],
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              导出交接资料
            </button>
          </section>
        </>
      )}
    </>
  );
}
