import { useState } from "react";
import type { ReactNode } from "react";
import {
  AudioLines,
  Download,
  Fan,
  LockKeyhole,
  LockKeyholeOpen,
  PanelTop,
  PanelTopOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Modal } from "../components/Modal";
import { CabinAirPanel, ControlCard, ControlRow } from "../components/VehicleControls";
import type { VehicleAppearance } from "../vehicle-catalog";
import { EmptyState, SectionTabs } from "../components/WorkspaceUI";
import { SchedulePanel } from "./SchedulePanel";
import { AirQuality, P4ClimateDetails, SoftwarePanel } from "./VehicleDetails";
import {
  actionLabels,
  p4FindActions,
  activeControls,
  cabinAirSnapshot,
  isNativeP4,
  cabinAirTime,
  numeric,
  openingState,
  readingText,
  unavailableReason,
} from "./client";
import type { Command, NativeVehicle, Receipt, Snapshot } from "./client";

export function NativeControls({
  vehicle,
  appearance,
  history,
  snapshot,
  receipts,
  disabled,
  control,
  onCommand,
  onHistory,
  openings,
}: {
  vehicle: NativeVehicle;
  appearance: VehicleAppearance;
  history: Snapshot[];
  snapshot?: Snapshot;
  receipts: Receipt[];
  disabled: boolean;
  control: (action: string, onSelect?: () => void) => ReactNode;
  onCommand: (command: Command) => void;
  onHistory?: () => void;
  openings: ReactNode;
}) {
  const [tab, setTab] = useState("即时控制");
  const [panel, setPanel] = useState<string | null>(null);
  const p4 = isNativeP4(vehicle);
  const air = cabinAirSnapshot(vehicle.vin, snapshot, history);
  const airNote = air
    ? (air === snapshot ? "" : "上次读数 · ") + cabinAirTime(air)
    : snapshot?.readings.airQuality?.status === "failed" ? "读取失败" : readingText(snapshot, "airQuality", true);
  const climate = snapshot?.readings.climate?.value?.activity;
  const locked = snapshot?.readings.exterior?.value?.locked;
  const active = activeControls(snapshot);
  const climateLabel =
    climate === "active"
      ? "运行中"
      : climate === "starting"
        ? "启动中"
        : climate === "idle"
          ? "已关闭"
          : "状态未知";
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
    icon: LucideIcon;
    description: string;
    actions: string[];
    button?: string;
    directAction?: string;
  }[] = [
    {
      panel: "车窗控制",
      title: "车窗",
      icon: PanelTop,
      description:
        windows === "closed"
          ? "全部关闭"
          : windows === "open"
            ? "有车窗打开或未关严"
            : "状态未知",
      actions: p4 ? ["windowsOpen", "windowsVent", "windowsClose"] : ["windowsOpen", "windowsClose"],
      directAction: p4 ? undefined : windowAction,
    },
    {
      panel: "充电口盖",
      title: "充电口盖",
      icon: PanelTopOpen,
      description: openingState(snapshot, ["chargeLid"]) === "open" ? "已打开" : openingState(snapshot, ["chargeLid"]) === "closed" ? "已关闭" : "状态未知",
      actions: ["chargeLidOpen", "chargeLidClose"],
    },
    {
      panel: "尾门控制",
      title: "尾门",
      icon: PanelTopOpen,
      description:
        tailgate === "closed"
          ? "已关闭"
          : tailgate === "open"
            ? "已打开或未关严"
            : "状态未知",
      actions: ["unlockTrunk", "tailgateOpen", "tailgateClose"],
      directAction: p4 ? undefined : tailgateAction,
    },
    {
      panel: "鸣笛与闪灯",
      title: "鸣笛与闪灯",
      icon: AudioLines,
      description: "在停车场寻找车辆",
      actions: p4 ? p4FindActions : ["flash", "honkFlash"],
    },
    {
      panel: "软件更新",
      title: "软件更新",
      icon: Download,
      description: vehicle.installedVersion
        ? `已安装 ${vehicle.installedVersion}`
        : "已安装版本未知",
      actions: ["otaSchedule", "otaInstall", "otaCancel"],
      button: "查看版本",
    },
  ];
  const visibleActions = actions.filter(item => p4 ? item.panel !== "软件更新" : item.panel !== "充电口盖");
  const selectedAction = visibleActions.find((item) => item.panel === panel);
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
            <CabinAirPanel
              pm25={numeric(air, "airQuality", "pm25")}
              aqi={numeric(air, "airQuality", "aqi")}
              note={airNote}
              appearance={/polestar|极星/i.test(vehicle.model) ? appearance : undefined}
              onDetails={() => setPanel("空气净化")}
            />
            <ControlCard
              icon={Fan}
              title="空调"
              value={climateLabel}
              active={active.climate}
            >
              <button
                className="secondary-button"
                onClick={() => setPanel("调节空调")}
              >
                {p4 && unavailableReason(vehicle, "climateStart") ? "查看空调状态" : "调节空调"}
              </button>
            </ControlCard>
            <ControlCard
              icon={locked === false ? LockKeyholeOpen : LockKeyhole}
              title="门锁"
              value={
                locked === true
                  ? "已锁定"
                  : locked === false
                    ? "已解锁"
                    : "状态未知"
              }
              active={active.unlocked}
              onDetails={() => setPanel("车身与门锁")}
            >
              {control(locked === true ? "unlock" : "lock")}
            </ControlCard>
          </div>
          <section className="control-list" aria-labelledby="vehicle-controls-heading">
            <h2 id="vehicle-controls-heading">车辆功能</h2>
            {visibleActions.map((item) => {
              const reason = item.directAction
                ? unavailableReason(vehicle, item.directAction)
                : null;
              const label = item.directAction
                ? actionLabels[item.directAction]
                : item.button ?? "选择操作";
              return (
                <ControlRow
                  key={item.panel}
                  icon={item.icon}
                  title={item.title}
                  description={item.description}
                  reason={reason}
                >
                  <button
                    className="secondary-button"
                    aria-label={
                      label === "选择操作" ? `${item.title}：${label}` : undefined
                    }
                    disabled={disabled || !!reason}
                    onClick={() =>
                      item.directAction
                        ? onCommand({ vin: vehicle.vin, action: item.directAction })
                        : setPanel(item.panel)
                    }
                  >
                    {label}
                  </button>
                </ControlRow>
              );
            })}
          </section>
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
          <p>{p4 ? "可在即时控制中查看门锁、车窗和空调状态。" : "锁车与空调可在即时控制中分别执行，出发计划可保存车辆空调日程。"}</p>
          <button className="text-button" onClick={() => setTab("即时控制")}>
            返回即时控制
          </button>
        </EmptyState>
      )}
      {tab === "指令记录" && (
        <section>
          <div className="section-heading">
            <h2>指令记录</h2>
            {onHistory && <button className="text-button" onClick={onHistory}>
              全部历史记录
            </button>}
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
      {panel && (!p4 || panel !== "软件更新") && (
        <Modal className={p4 ? "p4-sheet" : undefined} title={p4 && panel === "调节空调" ? "座舱设置" : panel} onClose={() => setPanel(null)}>
          {panel === "调节空调" && (
            <>
              {p4 ? <P4ClimateDetails snapshot={snapshot} activity={climateLabel} disabled={disabled} onCommand={command => { setPanel(null); onCommand(command); }} controls={<div className="native-actions">{["climateStart", "climateStop"].map(action => control(action, () => setPanel(null)))}</div>} /> : <><p className="modal-description">
                空调{climateLabel} · {readingText(snapshot, "climate")}
              </p>
              <div className="native-actions">
                {["climateStart", "climateStop"].map((action) =>
                  control(action, () => setPanel(null)),
                )}
              </div></>}
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
          {panel === "车窗控制" && (
            <p className="modal-description">{selectedAction?.description}</p>
          )}
          {panel === "尾门控制" && (
            <p className="modal-description">{p4 ? selectedAction?.description : "操作前请确认车辆后方有足够空间。"}</p>
          )}
          {panel === "空气净化" ? (
            <AirQuality
              snapshot={snapshot}
              cabinReading={air}
              controls={["cleanStart", "cleanStop"].map((action) =>
                control(action, () => setPanel(null)),
              )}
            />
          ) : !p4 && panel === "软件更新" ? (
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
