import { useEffect, useId, useState } from "react";
import { Modal } from "../components/Modal";
import { invoke } from "./transport";

type Action = { kind: "lock" | "unlock" | "climateStart" | "climateStop" } | { kind: "target"; percent: number };
type Setting = "lock" | "climate" | "target";
function setting(action: Action): Setting {
  if (action.kind === "target") return "target";
  return action.kind === "lock" || action.kind === "unlock" ? "lock" : "climate";
}
type Operation = { kind: "status" } | { kind: "submit"; requestId: string; action: Action } | { kind: "check"; requestId: string };
type Status = "accepted" | "rejected" | "unknown";
type RecordItem = { requestId: string; requestedAt: number; action: Action; status: Status; readback: string | null };
type Panel = {
  availability: "missingClientId" | "awaitingIntegration" | "authorizationRequired" | "unavailable" | "ready";
  grants: { lock: boolean; unlock: boolean; climateStart: boolean; climateStop: boolean; chargeTargets: number[] };
  commands: RecordItem[];
};
const availabilityText = {
  missingClientId: "此版本尚未配置 Norr 的车控客户端标识。",
  awaitingIntegration: "此版本尚未接入授权车控服务。",
  authorizationRequired: "该账号尚未取得这辆车的控制授权。",
  unavailable: "暂时无法读取车控权限。",
};
const serviceText: Record<Status, string> = { accepted: "服务已受理", rejected: "服务已拒绝", unknown: "受理结果未知" };
function label(action: Action) {
  if (action.kind === "target") return `设置充电上限为 ${action.percent}%`;
  if (action.kind === "lock") return "锁定车辆";
  if (action.kind === "unlock") return "解锁车辆";
  return action.kind === "climateStart" ? "启动驻车空调" : "停止驻车空调";
}

export function P4PartnerControls({ id, vin, disabled, onPending, only, onReadback }: {
  id: number; vin: string; disabled: boolean; onPending: (pending: boolean) => void; only?: Setting;
  onReadback?: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<Panel>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [target, setTarget] = useState("");
  const targetId = useId();
  const [confirmation, setConfirmation] = useState<{ action: Action; requestId: string }>();
  useEffect(() => {
    let current = true;
    invoke<Panel>("p4_partner_control", { id, vin, operation: { kind: "status" } })
      .then(next => { if (current) setPanel(next); })
      .catch(() => { if (current) setError("无法读取车控权限"); });
    return () => { current = false; };
  }, [id, vin]);

  async function run(operation: Operation) {
    if (pending) return;
    setPending(true);
    onPending(true);
    setError("");
    try {
      const next = await invoke<Panel>("p4_partner_control", { id, vin, operation });
      setPanel(next);
      if (operation.kind !== "status") await onReadback?.();
    } catch (problem) {
      setError(String(problem));
    } finally {
      setPending(false);
      onPending(false);
    }
  }
  function ask(action: Action) {
    setConfirmation({ action, requestId: crypto.randomUUID() });
  }
  const blocked = disabled || pending;
  const ready = panel?.availability === "ready";
  const grants = panel?.grants;
  const buttons = (["lock", "unlock", "climateStart", "climateStop"] as const)
    .filter(kind => grants?.[kind] && (!only || only === setting({kind})));
  const targets = only && only !== "target" ? [] : grants?.chargeTargets ?? [];
  const commands = panel?.commands.filter(r => !only || setting(r.action) === only) ?? [];
  return <section className="native-section" aria-label="实车控制" aria-busy={pending}>
    <h3>实车控制</h3>
    {panel && panel.availability !== "ready" && <p className="muted">{availabilityText[panel.availability]}</p>}
    {!panel && !error && <p role="status">正在读取车控权限…</p>}
    {pending && <p role="status">正在核对控制状态…</p>}
    {ready && grants && <>
      {buttons.length > 0 && <div className="native-actions">{buttons.map(kind =>
        <button key={kind} className="secondary-button" disabled={blocked} onClick={() => ask({kind})}>{label({kind})}</button>
      )}</div>}
      {targets.length > 0 && <div className="native-actions p4-charge-target">
        <div className="native-field">
          <label htmlFor={targetId}>充电上限</label>
          <select id={targetId} value={target} disabled={blocked} onChange={e => setTarget(e.target.value)}>
            <option value="">选择目标电量</option>
            {targets.map(p => <option key={p} value={p}>{p}%</option>)}
          </select>
        </div>
        <button className="secondary-button" disabled={blocked || !grants.chargeTargets.includes(Number(target))}
          onClick={() => ask({ kind: "target", percent: Number(target) })}>设置充电上限</button>
      </div>}
      {!buttons.length && !targets.length && <p>当前账号在此项下没有可用的车辆操作。</p>}
    </>}
    {(error || panel?.availability === "unavailable" || panel?.availability === "authorizationRequired") &&
      <button className="secondary-button" disabled={blocked} onClick={() => void run({ kind: "status" })}>刷新控制状态</button>}
    {commands.length > 0 && <ul>
      {commands.slice().reverse().map((record, i, rows) => {
        const latest = !rows.slice(0, i).some(r => setting(r.action) === setting(record.action));
        return <li key={record.requestId}>{label(record.action)} · {serviceText[record.status]}
          {record.readback && <span> · {record.readback}</span>}
          {latest && ready && record.status !== "rejected" && record.readback !== "回读一致" && Date.now() - record.requestedAt <= 600_000 &&
            <button className="secondary-button" disabled={blocked} onClick={() => void run({ kind: "check", requestId: record.requestId })}>核对车辆状态</button>}
        </li>;
      })}
    </ul>}
    {error && <p role="alert">{error}</p>}
    {confirmation && <Modal className="p4-sheet" title={label(confirmation.action)} onClose={() => setConfirmation(undefined)}>
      <p>将对所选 Polestar 4（尾号 {vin.slice(-4)}）执行此操作。</p>
      <div className="native-actions"><button className="secondary-button" onClick={() => setConfirmation(undefined)}>取消</button>
        <button className="primary-button" disabled={blocked} onClick={() => {
          const operation = confirmation;
          setConfirmation(undefined);
          void run({ kind: "submit", ...operation });
        }}>确认发送</button></div>
    </Modal>}
  </section>;
}
