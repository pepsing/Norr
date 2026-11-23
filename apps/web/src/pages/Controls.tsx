import { useEffect, useState } from "react";
import {
  AudioLines,
  Download,
  Fan,
  PlugZap,
  LockKeyhole,
  LockKeyholeOpen,
  PanelTop,
  PanelTopOpen,
  Plus,
  Power,
  SlidersHorizontal,
  Wind,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Modal } from "../components/Modal";
import { CabinAirPanel, ControlCard, ControlRow } from "../components/VehicleControls";
import { appearanceFor } from "../vehicle-catalog";
import { isChinaP4, p4DemoAir, p4SetpointLabel } from "../p4-demo";
import { isP4BodyAction, type P4BodyAction } from "../components/P4BodyDialog";
import {
  Confirmation,
  EmptyState,
  ScheduleList,
  SectionTabs,
} from "../components/WorkspaceUI";
import {
  capabilityReason,
  capabilityStatus,
  supports,
  useWorkspace,
} from "../workspace";
import type { Capability, DemoVehicle, Receipt } from "../workspace";

const receiptLabels = {
  pending: "正在发送",
  accepted: "服务已接受",
  delivered: "已送达车辆",
  completed: "服务报告完成",
  success: "独立回读已确认",
  failed: "请求未发出",
  unknown: "结果未确认",
  undone: "已撤销",
};

export function CommandHistory() {
  const { data, vehicle, busy, scenario, command, resolveReceipt } =
    useWorkspace();
  const [now, setNow] = useState(Date.now());
  const receipts = data.receipts.filter((r) => r.vehicleId === vehicle?.id);
  useEffect(() => {
    if (
      !receipts.some(
        (r) => r.status === "success" && Date.now() - r.time < 30000,
      )
    )
      return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [data.receipts]);
  function canUndo(receipt: Receipt) {
    const latest = receipts.find(
      (r) =>
        r.status === "success" &&
        Object.keys(r.changes).some((key) => key in receipt.changes),
    );
    return (
      latest?.id === receipt.id &&
      !receipts.some(
        (item) =>
          item.time > receipt.time &&
          !["failed", "undone"].includes(item.status) &&
          Object.keys(item.changes).some((key) => key in receipt.changes),
      ) &&
      receipt.status === "success" &&
      now - receipt.time < 30000 &&
      Object.keys(receipt.previous).length > 0 &&
      !("software" in receipt.changes)
    );
  }
  return (
    <section>
      <div className="section-heading">
        <h2>指令记录</h2>
        <span>当前车辆 · 演示</span>
      </div>
      {receipts.length === 0 && (
        <EmptyState title="还没有操作记录">
          <p>执行车辆控制后，可以在这里查看结果与后续操作。</p>
        </EmptyState>
      )}
      {receipts.map((receipt) => {
        const waiting = ["accepted", "delivered", "completed", "unknown"].includes(receipt.status);
        const signal = isChinaP4(vehicle) && receipt.capability === "locate";
        return (
          <div className="receipt-row" key={receipt.id}>
            <div>
              <h3>{receipt.label}</h3>
              <p>
                {new Date(receipt.time).toLocaleTimeString("zh-CN")} ·{" "}
                {receiptLabels[receipt.status]}
              </p>
              {waiting && <p className="muted">{signal ? "寻车信号仅持续片刻，实车效果需在车旁观察。" : "等待独立回读确认车辆结果。"}</p>}
              {receipt.observation && (
                <p className="muted">
                  回读于{" "}
                  {new Date(receipt.observation.time).toLocaleTimeString("zh-CN")}{" "}
                  ·
                  {receipt.observation.result === "match"
                    ? "目标字段一致"
                    : receipt.observation.result === "mismatch"
                      ? "与目标不一致"
                      : "未取得可用状态"}
                </p>
              )}
            </div>
            <div className="row-actions">
              {receipt.status === "failed" && (
                <button
                  disabled={
                    busy ||
                    scenario !== "connected" ||
                    !vehicle ||
                    !supports(vehicle, receipt.capability)
                  }
                  className="text-button"
                  onClick={() =>
                    command(
                      receipt.label,
                      receipt.capability,
                      receipt.changes,
                      receipt.id,
                    )
                  }
                >
                  重试
                </button>
              )}
              {waiting && !signal && (
                <button
                  disabled={busy || scenario !== "connected"}
                  className="text-button"
                  onClick={() => resolveReceipt(receipt.id, false)}
                >
                  核对状态
                </button>
              )}
              {canUndo(receipt) && (
                <button
                  disabled={
                    busy ||
                    scenario !== "connected" ||
                    !vehicle ||
                    !supports(vehicle, receipt.capability)
                  }
                  className="text-button"
                  onClick={() => resolveReceipt(receipt.id, true)}
                >
                  恢复先前设置（
                  {Math.max(0, Math.ceil((30000 - (now - receipt.time)) / 1000))}
                  s）
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function Controls({
  onControl,
}: {
  onControl: (control: "lock" | "climate" | P4BodyAction) => void;
}) {
  const {
    vehicle,
    data,
    setData,
    busy,
    scenario,
    command,
    setNotice,
    temperature,
  } = useWorkspace();
  const [tab, setTab] = useState("即时控制");
  const [pending, setPending] = useState<{
    label: string;
    capability: Capability;
    changes: Partial<DemoVehicle>;
  } | null>(null);
  const [routineName, setRoutineName] = useState<string | null>(null);
  if (!vehicle) return null;
  const disabled = busy || scenario !== "connected";
  const p4 = isChinaP4(vehicle);
  const actions: {
    label: string;
    title: string;
    icon: LucideIcon;
    description: string;
    capability: Capability;
    changes: Partial<DemoVehicle>;
  }[] = [
    {
      label: vehicle.windowsOpen ? "关闭车窗" : "打开车窗",
      title: "车窗",
      icon: PanelTop,
      description: vehicle.windowsOpen ? "已打开" : "全部关闭",
      capability: "windows",
      changes: { windowsOpen: !vehicle.windowsOpen },
    },
    {
      label: p4 ? "解锁尾门" : vehicle.tailgateOpen ? "关闭尾门" : "打开尾门",
      title: "尾门",
      icon: PanelTopOpen,
      description: p4 ? (vehicle.trunkLocked === false ? "已解锁" : "已锁定") : vehicle.tailgateOpen ? "已打开" : "已关闭",
      capability: "tailgate",
      changes: p4 ? { trunkLocked: false } : { tailgateOpen: !vehicle.tailgateOpen },
    },
    {
      label: p4 ? "选择寻车方式" : "鸣笛与闪灯",
      title: p4 ? "寻车" : "鸣笛与闪灯",
      icon: AudioLines,
      description: "在停车场寻找车辆",
      capability: "locate",
      changes: {},
    },
    {
      label: vehicle.cleaning ? "停止空气净化" : "开启空气净化",
      title: "空气净化",
      icon: Wind,
      description: vehicle.cleaning ? "净化运行中" : "净化已停止",
      capability: "cleaning",
      changes: { cleaning: !vehicle.cleaning },
    },
    {
      label: vehicle.engineOn ? "停止发动机" : "启动发动机",
      title: "发动机",
      icon: Power,
      description: "仅适用于支持此能力的 Volvo 示例",
      capability: "engine",
      changes: { engineOn: !vehicle.engineOn },
    },
    {
      label: "安装软件更新",
      title: "软件更新",
      icon: Download,
      description:
        vehicle.software === "P4.2.2"
          ? "已安装演示更新 P4.2.2"
          : "P4.2.2 · 演示更新",
      capability: "software",
      changes: { software: "P4.2.2" },
    },
  ];
  if (p4) actions.push({
    label: vehicle.chargeLidOpen ? "关闭充电口盖" : "打开充电口盖", title: "充电口盖", icon: PlugZap,
    description: vehicle.chargeLidOpen ? "已打开" : "已关闭", capability: "chargeLid",
    changes: { chargeLidOpen: !vehicle.chargeLidOpen },
  });
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
              pm25={supports(vehicle, "cleaning") && scenario === "connected" ? (p4 ? p4DemoAir : 8) : null}
              aqi={!p4 && supports(vehicle, "cleaning") && scenario === "connected" ? 18 : null}
              note="演示数据"
              onDetails={p4 ? () => onControl("cleaning") : undefined}
              appearance={vehicle.brand === "Polestar" ? appearanceFor(vehicle) : undefined}
            />
            <ControlCard
              icon={Fan}
              title="空调"
              value={vehicle.climateOn ? "运行中" : "已关闭"}
              active={vehicle.climateOn === true}
              status={
                supports(vehicle, "climate")
                  ? undefined
                  : capabilityReason(vehicle, "climate")
              }
            >
              <button
                className="secondary-button"
                disabled={disabled || !supports(vehicle, "climate")}
                onClick={() => onControl("climate")}
              >
                调节空调
              </button>
            </ControlCard>
            <ControlCard
              icon={vehicle.locked ? LockKeyhole : LockKeyholeOpen}
              title="门锁"
              value={vehicle.locked ? "已锁定" : "已解锁"}
              active={vehicle.locked === false}
              status={
                supports(vehicle, "lock") ? undefined : capabilityReason(vehicle, "lock")
              }
            >
              <button
                className="secondary-button"
                disabled={disabled || !supports(vehicle, "lock")}
                onClick={() => onControl("lock")}
              >
                {vehicle.locked ? "解锁车辆" : "锁定车辆"}
              </button>
            </ControlCard>
          </div>
          <section className="control-list" aria-labelledby="vehicle-controls-heading">
            <h2 id="vehicle-controls-heading">车辆功能</h2>
            {actions.filter(action => !p4 || !["software", "engine"].includes(action.capability)).map((action) => (
              <ControlRow
                key={action.capability}
                icon={action.icon}
                title={action.title}
                description={action.description}
                reason={
                  supports(vehicle, action.capability)
                    ? null
                    : capabilityReason(vehicle, action.capability)
                }
              >
                <button
                  className="secondary-button"
                  data-active={action.capability === "cleaning" && vehicle.cleaning === true}
                  disabled={
                    disabled ||
                    !supports(vehicle, action.capability) ||
                    (action.capability === "software" &&
                      vehicle.software === "P4.2.2")
                  }
                  onClick={() => p4 && isP4BodyAction(action.capability) ? onControl(action.capability) : setPending(action)}
                >
                  {supports(vehicle, action.capability)
                    ? action.label
                    : capabilityStatus(vehicle, action.capability)}
                </button>
              </ControlRow>
            ))}
          </section>
        </>
      )}
      {tab === "出发计划" && <ScheduleList kind="空调" />}
      {tab === "指令记录" && <CommandHistory />}
      {tab === "快捷组合" && (
        <>
          <div className="section-heading">
            <div>
              <h2>出发准备</h2>
              <p className="muted">保存一组锁车与开启空调操作。</p>
            </div>
            <button
              className="text-button"
              disabled={disabled || !supports(vehicle, "climate")}
              onClick={() => setRoutineName("出发准备")}
            >
              <Plus size={17} />
              新建组合
            </button>
          </div>
          {data.routines
            .filter((r) => r.vehicleId === vehicle.id)
            .map((routine) => (
              <div className="list-row" key={routine.id}>
                <div>
                  <h3>{routine.name}</h3>
                  <p>
                    锁定车门 · 空调 {p4 ? p4SetpointLabel(vehicle, temperature) : temperature(vehicle.targetTemperature)}
                  </p>
                </div>
                <div className="row-actions">
                  <button
                    className="primary-button"
                    disabled={
                      disabled ||
                      !supports(vehicle, "lock") ||
                      !supports(vehicle, "climate")
                    }
                    onClick={() =>
                      setPending({
                        label: routine.name,
                        capability: "climate",
                        changes: { locked: true, climateOn: true },
                      })
                    }
                  >
                    运行
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setData((old) => ({
                        ...old,
                        routines: old.routines.filter(
                          (r) => r.id !== routine.id,
                        ),
                      }));
                      setNotice("组合已删除");
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          {!data.routines.some((r) => r.vehicleId === vehicle.id) && (
            <EmptyState title="还没有快捷组合">
              <SlidersHorizontal size={32} />
              <p>创建出发准备，将常用操作一起保存。</p>
            </EmptyState>
          )}
        </>
      )}
      {pending && (
        <Confirmation
          title={pending.label}
          confirm="确认模拟执行"
          busy={busy}
          onClose={() => setPending(null)}
          onConfirm={async () => {
            await command(pending.label, pending.capability, pending.changes);
            setPending(null);
          }}
        >
          <p>将对 {vehicle.nickname} 执行此操作。</p>
          {pending.capability === "tailgate" && !p4 && (
            <p>操作前请确认车辆后方有足够空间。</p>
          )}
          {pending.capability === "software" && (
            <p>安装前需驻车并保证电量充足。预览将模拟更新结果。</p>
          )}
          {pending.capability === "engine" && (
            <p>启动前需确认车辆处于通风的室外环境。</p>
          )}
          <p>本次为演示操作，结果会保存在指令记录中。</p>
        </Confirmation>
      )}
      {routineName !== null && (
        <Modal className={p4 ? "p4-sheet" : undefined} title="新建快捷组合" onClose={() => setRoutineName(null)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              setData((old) => ({
                ...old,
                routines: [
                  ...old.routines,
                  {
                    id: crypto.randomUUID(),
                    vehicleId: vehicle.id,
                    name: routineName.trim(),
                  },
                ],
              }));
              setRoutineName(null);
              setNotice("快捷组合已保存");
            }}
          >
            <label>
              组合名称
              <input
                required
                maxLength={30}
                value={routineName}
                onChange={(e) => setRoutineName(e.target.value)}
              />
            </label>
            <p>操作顺序为锁定车门、开启空调。目标温度沿用当前空调设置。</p>
            <button className="primary-button" disabled={!routineName.trim()}>
              保存组合
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
