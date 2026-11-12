import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, Fan, LockKeyhole } from "lucide-react";
import { Modal } from "../components/Modal";
import { EmptyState, SectionTabs } from "../components/WorkspaceUI";
import { SchedulePanel } from "./SchedulePanel";
import { AirQuality, SoftwarePanel } from "./VehicleDetails";
import {
  actionLabels,
  activeControls,
  numeric,
  openingState,
  readingText,
  unavailableReason,
} from "./client";
import type { Command, NativeVehicle, Receipt, Snapshot } from "./client";

export function NativeControls({
  vehicle,
  snapshot,
  receipts,
  disabled,
  control,
  onCommand,
  onHistory,
  openings,
}: {
  vehicle: NativeVehicle;
  snapshot?: Snapshot;
  receipts: Receipt[];
  disabled: boolean;
  control: (action: string, onSelect?: () => void) => ReactNode;
  onCommand: (command: Command) => void;
  onHistory: () => void;
  openings: ReactNode;
}) {
  const [tab, setTab] = useState("即时控制");
  const [panel, setPanel] = useState<string | null>(null);
  const temperature = numeric(snapshot, "climate", "interiorTemperature");
  const climate = snapshot?.readings.climate?.value?.activity;
  const locked = snapshot?.readings.exterior?.value?.locked;
  const active = activeControls(snapshot);
  const climateLabel =
    climate === "active"
      ? "空调运行中"
      : climate === "starting"
        ? "空调启动中"
        : climate === "idle"
          ? "空调已关闭"
          : "空调状态未知";
  const entries = receipts.filter(
    (receipt) => receipt.command.vin === vehicle.vin,
  );
  const windows = openingState(snapshot, [
    "frontLeftWindow",
    "frontRightWindow",
    "rearLeftWindow",
    "rearRightWindow",
  ]);
  const tailgate = openingState(snapshot, ["tailgate"]);
  const windowAction =
    windows === "open"
      ? "windowsClose"
      : windows === "closed"
        ? "windowsOpen"
        : undefined;
  const tailgateAction =
    vehicle.capabilities.supportsRemoteTrunkControl !== true &&
    vehicle.capabilities.supportsRemoteTrunkUnlock === true
      ? "unlockTrunk"
      : tailgate === "open"
        ? "tailgateClose"
        : tailgate === "closed"
          ? "tailgateOpen"
          : undefined;
  const actions: {
    panel: string;
    title: string;
    description: string;
    actions: string[];
    directAction?: string;
  }[] = [
    {
      panel: "车窗控制",
      title: windowAction ? actionLabels[windowAction] : "车窗控制",
      description:
        windows === "closed"
          ? "当前全部关闭"
          : windows === "open"
            ? "当前有车窗打开或未关严"
            : "车窗状态未知，请选择操作",
      actions: ["windowsOpen", "windowsClose"],
      directAction: windowAction,
    },
    {
      panel: "尾门控制",
      title: tailgateAction ? actionLabels[tailgateAction] : "尾门控制",
      description: "操作前确认车辆后方空间",
      actions: ["unlockTrunk", "tailgateOpen", "tailgateClose"],
      directAction: tailgateAction,
    },
    {
      panel: "鸣笛与闪灯",
      title: "鸣笛与闪灯",
      description: "帮助寻找停车位置",
      actions: ["flash", "honkFlash"],
    },
    {
      panel: "空气净化",
      title: "空气净化",
      description:
        numeric(snapshot, "airQuality", "state") === 1
          ? "正在预清洁"
          : "查看空气质量与预清洁状态",
      actions: ["cleanStart", "cleanStop"],
    },
    {
      panel: "软件更新",
      title: "软件更新",
      description: vehicle.installedVersion
        ? `已安装 ${vehicle.installedVersion}`
        : "查看版本、安装状态与预约",
      actions: ["otaSchedule", "otaInstall", "otaCancel"],
    },
  ];
  const selectedAction = actions.find((item) => item.panel === panel);
  return (
    <>
      <SectionTabs
        items={["即时控制", "出发计划", "快捷组合", "指令记录"]}
        value={tab}
        onChange={setTab}
        label="控制分类"
      />
      {tab === "即时控制" && (
        <>
          <div className="control-lead">
            <section data-active={active.climate}>
              <Fan size={28} strokeWidth={1.2} aria-hidden="true" />
              <div>
                <span className="muted">座舱温度</span>
                <p
                  className={`large-number${temperature === null ? " native-unknown-number" : ""}`}
                >
                  {temperature === null
                    ? "未返回"
                    : `${temperature.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}°C`}
                </p>
                <p>{climateLabel}</p>
              </div>
              <button
                className="primary-button"
                onClick={() => setPanel("调节空调")}
              >
                调节空调 <ArrowRight size={17} aria-hidden="true" />
              </button>
            </section>
            <section data-active={active.unlocked}>
              <LockKeyhole size={28} strokeWidth={1.2} aria-hidden="true" />
              <div>
                <span className="muted">中央门锁</span>
                <h2>
                  {locked === true
                    ? "车辆已锁定"
                    : locked === false
                      ? "车辆已解锁"
                      : "门锁状态未知"}
                </h2>
                <p>
                  <button
                    className="text-button native-control-detail-link"
                    onClick={() => setPanel("车身与门锁")}
                  >
                    查看车身开闭状态
                  </button>
                </p>
              </div>
              {control(locked === true ? "unlock" : "lock")}
            </section>
          </div>
          <div className="control-list">
            {actions.map((item) => {
              const reason = item.directAction
                ? unavailableReason(vehicle, item.directAction)
                : null;
              return (
                <div className="list-row" key={item.panel}>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                    {reason && <p>{reason}</p>}
                  </div>
                  <button
                    className="secondary-button"
                    data-active={item.panel === "空气净化" && active.cleaning}
                    aria-label={`${item.panel}操作`}
                    disabled={disabled || !!reason}
                    onClick={() =>
                      item.directAction
                        ? onCommand({ vin: vehicle.vin, action: item.directAction })
                        : setPanel(item.panel)
                    }
                  >
                    操作
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {tab === "出发计划" && (
        <SchedulePanel
          kind="climate"
          vehicle={vehicle}
          snapshot={snapshot}
          disabled={disabled}
          onCommand={onCommand}
        />
      )}
      {tab === "快捷组合" && (
        <EmptyState title="快捷组合尚未接入">
          <p>锁车与空调可在即时控制中分别执行，出发计划可保存车辆空调日程。</p>
          <button className="text-button" onClick={() => setTab("即时控制")}>
            返回即时控制
          </button>
        </EmptyState>
      )}
      {tab === "指令记录" && (
        <section>
          <div className="section-heading">
            <h2>指令记录</h2>
            <button className="text-button" onClick={onHistory}>
              全部历史记录
            </button>
          </div>
          {entries.length === 0 && (
            <EmptyState title="还没有操作记录">
              <p>执行车辆控制后，可以在这里查看服务结果与独立回读。</p>
            </EmptyState>
          )}
          {entries
            .slice(-50)
            .reverse()
            .map((receipt) => (
              <article className="receipt-row" key={receipt.id}>
                <div>
                  <h3>
                    {actionLabels[receipt.command.action] ??
                      receipt.command.action}
                  </h3>
                  <p>
                    {new Date(receipt.time).toLocaleString("zh-CN", {
                      hour12: false,
                    })}{" "}
                    · {receipt.message}
                  </p>
                  <p className="muted">
                    {receipt.readback ?? "独立回读待核对"}
                  </p>
                </div>
              </article>
            ))}
          {entries.length > 50 && (
            <p className="muted">
              此处展示最近 50 条，完整记录可在历史页查看。
            </p>
          )}
        </section>
      )}
      {panel && (
        <Modal title={panel} onClose={() => setPanel(null)}>
          {panel === "调节空调" && (
            <>
              <p className="modal-description">
                {climateLabel} · {readingText(snapshot, "climate")}
              </p>
              <div className="native-actions">
                {["climateStart", "climateStop"].map((action) =>
                  control(action, () => setPanel(null)),
                )}
              </div>
            </>
          )}
          {panel === "车身与门锁" && (
            <>
              <p className="muted">{readingText(snapshot, "exterior")}</p>
              {openings}
              <div className="native-actions">
                {["lock", "unlock"].map((action) =>
                  control(action, () => setPanel(null)),
                )}
              </div>
            </>
          )}
          {["车窗控制", "尾门控制"].includes(panel) && (
            <p className="modal-description">{selectedAction?.description}</p>
          )}
          {panel === "空气净化" ? (
            <AirQuality
              snapshot={snapshot}
              controls={["cleanStart", "cleanStop"].map((action) =>
                control(action, () => setPanel(null)),
              )}
            />
          ) : panel === "软件更新" ? (
            <SoftwarePanel
              snapshot={snapshot}
              controls={["otaSchedule", "otaInstall", "otaCancel"].map(
                (action) => control(action, () => setPanel(null)),
              )}
            />
          ) : selectedAction ? (
            <div className="native-actions">
              {selectedAction.actions.map((action) =>
                control(action, () => setPanel(null)),
              )}
            </div>
          ) : null}
        </Modal>
      )}
    </>
  );
}
