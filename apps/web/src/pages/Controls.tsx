import { useEffect, useState } from "react";
import {
  ArrowRight,
  Fan,
  LockKeyhole,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { Modal } from "../components/Modal";
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
      {receipts.map((receipt) => (
        <div className="receipt-row" key={receipt.id}>
          <div>
            <h3>{receipt.label}</h3>
            <p>
              {new Date(receipt.time).toLocaleTimeString("zh-CN")} ·{" "}
              {receiptLabels[receipt.status]}
            </p>
            {["accepted", "delivered", "completed", "unknown"].includes(
              receipt.status,
            ) && <p className="muted">等待独立回读确认车辆结果。</p>}
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
            {["accepted", "delivered", "completed", "unknown"].includes(
              receipt.status,
            ) && (
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
      ))}
    </section>
  );
}

export function Controls({
  onControl,
}: {
  onControl: (control: "lock" | "climate") => void;
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
  const actions: {
    label: string;
    description: string;
    capability: Capability;
    changes: Partial<DemoVehicle>;
  }[] = [
    {
      label: vehicle.windowsOpen ? "关闭车窗" : "打开车窗",
      description: vehicle.windowsOpen ? "当前已打开" : "当前全部关闭",
      capability: "windows",
      changes: { windowsOpen: !vehicle.windowsOpen },
    },
    {
      label: vehicle.tailgateOpen ? "关闭尾门" : "打开尾门",
      description: "操作前确认车辆后方空间",
      capability: "tailgate",
      changes: { tailgateOpen: !vehicle.tailgateOpen },
    },
    {
      label: "鸣笛与闪灯",
      description: "帮助寻找停车位置",
      capability: "locate",
      changes: {},
    },
    {
      label: vehicle.cleaning ? "停止空气净化" : "开启空气净化",
      description: vehicle.cleaning ? "净化运行中" : "净化已停止",
      capability: "cleaning",
      changes: { cleaning: !vehicle.cleaning },
    },
    {
      label: vehicle.engineOn ? "停止发动机" : "启动发动机",
      description: "仅适用于支持此能力的 Volvo 示例",
      capability: "engine",
      changes: { engineOn: !vehicle.engineOn },
    },
    {
      label: "安装软件更新",
      description:
        vehicle.software === "P4.2.2"
          ? "已安装演示更新 P4.2.2"
          : "P4.2.2 · 演示更新",
      capability: "software",
      changes: { software: "P4.2.2" },
    },
  ];
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
            <section data-active={vehicle.climateOn === true}>
              <Fan size={28} strokeWidth={1.2} />
              <div>
                <span className="muted">座舱温度</span>
                <p className="large-number">
                  {temperature(vehicle.targetTemperature)}
                </p>
                <p>{vehicle.climateOn ? "空调运行中" : "空调已关闭"}</p>
                {!supports(vehicle, "climate") && (
                  <p className="muted">
                    {capabilityReason(vehicle, "climate")}
                  </p>
                )}
              </div>
              <button
                className="primary-button"
                disabled={disabled || !supports(vehicle, "climate")}
                onClick={() => onControl("climate")}
              >
                调节空调
                <ArrowRight size={17} />
              </button>
            </section>
            <section data-active={vehicle.locked === false}>
              <LockKeyhole size={28} strokeWidth={1.2} />
              <div>
                <span className="muted">中央门锁</span>
                <h2>{vehicle.locked ? "车辆已锁定" : "车辆已解锁"}</h2>
                <p>车身状态在车辆详情中查看</p>
                {!supports(vehicle, "lock") && (
                  <p className="muted">{capabilityReason(vehicle, "lock")}</p>
                )}
              </div>
              <button
                className="secondary-button"
                disabled={disabled || !supports(vehicle, "lock")}
                onClick={() => onControl("lock")}
              >
                {vehicle.locked ? "解锁车辆" : "锁定车辆"}
              </button>
            </section>
          </div>
          <div className="control-list">
            {actions.map((action) => (
              <div className="list-row" key={action.capability}>
                <div>
                  <h3>{action.label}</h3>
                  <p>{action.description}</p>
                  {!supports(vehicle, action.capability) && (
                    <p className="muted">
                      {capabilityReason(vehicle, action.capability)}
                    </p>
                  )}
                </div>
                <button
                  className="secondary-button"
                  data-active={action.capability === "cleaning" && vehicle.cleaning === true}
                  disabled={
                    disabled ||
                    !supports(vehicle, action.capability) ||
                    (action.capability === "software" &&
                      vehicle.software === "P4.2.2")
                  }
                  onClick={() => setPending(action)}
                >
                  {supports(vehicle, action.capability)
                    ? "操作"
                    : capabilityStatus(vehicle, action.capability)}
                </button>
              </div>
            ))}
          </div>
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
                    锁定车门 · 空调 {temperature(vehicle.targetTemperature)}
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
        <Modal title="新建快捷组合" onClose={() => setRoutineName(null)}>
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
