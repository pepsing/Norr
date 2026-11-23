import { useState } from "react";
import { Modal } from "./Modal";
import { capabilityReason, supports, useWorkspace } from "../workspace";
import type { DemoVehicle } from "../workspace";
import { p4DemoAir } from "../p4-demo";

export type P4BodyAction = "tailgate" | "locate" | "windows" | "chargeLid" | "cleaning";
export function isP4BodyAction(value: string): value is P4BodyAction {
  return ["tailgate", "locate", "windows", "chargeLid", "cleaning"].includes(value);
}
const titles = { tailgate: "尾门", locate: "寻车", windows: "车窗", chargeLid: "充电口盖", cleaning: "座舱净化" };
const signals = ["闪灯", "鸣笛并闪灯", "单独鸣笛"];
export function P4BodyDialog({ action, onClose }: { action: P4BodyAction; onClose: () => void }) {
  const { vehicle, scenario, busy, command } = useWorkspace();
  const [signal, setSignal] = useState(signals[0]);
  if (!vehicle) return null;
  const actions: Record<P4BodyAction, [string, Partial<DemoVehicle>]> = {
    tailgate: ["解锁尾门", { trunkLocked: false }],
    windows: [vehicle.windowsOpen ? "关闭车窗" : "打开车窗", { windowsOpen: !vehicle.windowsOpen }],
    chargeLid: [vehicle.chargeLidOpen ? "关闭充电口盖" : "打开充电口盖", { chargeLidOpen: !vehicle.chargeLidOpen }],
    cleaning: [vehicle.cleaning ? "停止净化" : "启动净化", { cleaning: !vehicle.cleaning }],
    locate: [signal, {}],
  };
  const [label, changes] = actions[action];
  const allowed = supports(vehicle, action);
  return <Modal title={titles[action]} onClose={onClose} className="p4-sheet">
    {action === "locate" ? <fieldset className="p4-signal"><legend>寻车方式</legend>{signals.map(item =>
      <label key={item}><input type="radio" name="p4-signal" checked={item === signal} onChange={() => setSignal(item)} />{item}</label>
    )}</fieldset> : action === "cleaning" ? <div className="p4-clean">
      <span>车内 PM2.5</span><p>{p4DemoAir}<small>μg/m³</small></p>
      <span>{vehicle.cleaning ? "净化运行中" : "净化已停止"}</span>
    </div> : <dl className="p4-body-states">
      {action === "tailgate" && <><div><dt>锁止状态</dt><dd>{vehicle.trunkLocked === false ? "已解锁" : "已锁定"}</dd></div>
        <div><dt>尾门位置</dt><dd>{vehicle.tailgateOpen ? "已打开" : "已关闭"}</dd></div></>}
      {action === "windows" && <div><dt>车窗状态</dt><dd>{vehicle.windowsOpen ? "已打开" : "全部关闭"}</dd></div>}
      {action === "chargeLid" && <div><dt>盖板位置</dt><dd>{vehicle.chargeLidOpen ? "已打开" : "已关闭"}</dd></div>}
    </dl>}
    <p className="p4-action-note">{!allowed ? capabilityReason(vehicle, action) : scenario !== "connected" ? "车辆离线，当前显示上次快照。" : "模拟操作将保存到指令记录。"}</p>
    <button className="primary-button full-width" disabled={busy || !allowed || scenario !== "connected" || (action === "tailgate" && vehicle.trunkLocked === false)}
      onClick={async () => { await command(label, action, changes); onClose(); }}>{busy ? "正在发送…" : label}</button>
  </Modal>;
}
