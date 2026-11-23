import { useEffect, useState } from "react";
import { invoke } from "./transport";
import { P4RecordingControls } from "./P4RecordingControls";
import type { Snapshot } from "./client";
import { P4TestLog } from "./P4TestLog";

import { P4VehicleReadings, type P4VehicleSample } from "./P4VehicleReadings";

type Recording = { id: number; startedAt: number; finishedAt: number | null };
type Operation = "start" | "finish";

export function P4Recording({ onRefresh, refreshing, vin, controls = true }: { onRefresh: () => void; refreshing: boolean; vin: string; controls?: boolean }) {
  const [runs, setRuns] = useState<Recording[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(true);
  const [commandPending, setCommandPending] = useState(false);
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<{ id: number; vin: string; sample: P4VehicleSample; snapshot: Snapshot }>();
  const active = runs.find(run => run.finishedAt === null);
  const completed = runs.filter(run => run.finishedAt !== null);
  const chosen = completed.find(run => run.id === selected) ?? completed[0];
  useEffect(() => {
    let mounted = true;
    invoke<Recording[]>("field_recordings", { operation: "list" })
      .then(value => { if (mounted) setRuns(value); })
      .catch(error => { if (mounted) setMessage(String(error)); })
      .finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; };
  }, []);
  async function sampleVehicle(id: number) {
    if (!vin) return;
    try {
      const result = await invoke<{sample: P4VehicleSample; snapshot: Snapshot}>("read_recording_vehicle", { id, vin, includeSnapshot: true });
      setLatest({ id, vin, ...result });
    } catch (error) {
      setMessage("读取车况失败 · " + String(error));
    }
  }
  async function readVehicle(id: number) {
    setBusy(true);
    setMessage("");
    try { await sampleVehicle(id); }
    finally { setBusy(false); }
  }
  async function update(operation: Operation) {
    setBusy(true);
    setMessage("");
    try {
      if (operation === "finish" && active) await sampleVehicle(active.id);
      const next = await invoke<Recording[]>("field_recordings", { operation, id: active?.id });
      setRuns(next);
      if (operation === "finish" && active) setSelected(active.id);
      if (operation === "start") {
        const run = next.find(row => row.finishedAt === null);
        if (run) await sampleVehicle(run.id);
      }
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  async function share() {
    if (!chosen) return;
    setBusy(true);
    setMessage("");
    try {
      const sent = await invoke<boolean>("share_recording", { id: chosen.id });
      setMessage(sent ? "日志已导出" : "已取消分享，日志仍保存在本机");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  const visible = latest && latest.vin === vin && latest.id === (active ?? chosen)?.id ? latest : undefined;
  return <section className="native-section">
    <h2>{controls ? "操作记录" : "P4 诊断日志"}</h2>
    {!controls && <p className="muted">开启后记录指令受理结果与车辆回读。完成记录后可导出 JSON；不包含密钥、令牌、账号和完整车架号。</p>}
    <p className="muted">{active ? "记录中。完成时会再读取一次车况。" : chosen ? "记录已完成，可导出日志。" : "开始和完成记录时会自动读取所选车辆的车况。"}</p>
    {completed.length > 1 && <label className="native-field">已完成的记录
      <select value={chosen.id} onChange={e => setSelected(Number(e.target.value))}>
        {completed.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.id}</option>)}
      </select>
    </label>}
    <div className="native-actions">
      {chosen && !active && <button className="primary-button" disabled={busy} onClick={() => void share()}>导出日志</button>}
      <button className={!active && chosen ? "secondary-button" : "primary-button"} disabled={commandPending || busy || refreshing} onClick={() => void update(active ? "finish" : "start")}>{active ? "完成记录" : "开始记录"}</button>
      {active && <button className="secondary-button" disabled={commandPending || busy || refreshing || !vin} onClick={() => void readVehicle(active.id)}>读取车况</button>}
      {active && <button className="secondary-button" disabled={commandPending || busy || refreshing} onClick={onRefresh}>{controls ? "刷新车库" : "刷新车辆"}</button>}
      {active && chosen && <button className="secondary-button" disabled={busy} onClick={() => void share()}>导出已完成的日志</button>}
    </div>
    {message && <p role="status">{message}</p>}
    {controls && active && vin && <P4RecordingControls key={`controls-${active.id}-${vin}`} id={active.id} vin={vin}
      snapshot={visible?.snapshot} disabled={busy || refreshing || commandPending} onPending={setCommandPending}
      onReadback={() => sampleVehicle(active.id)} />}
    {visible && <P4VehicleReadings sample={visible.sample} />}
    {active && vin && <details className="native-section" key={active.id + vin}>
      <summary>添加实车观察（可选）</summary>
      <P4TestLog vin={vin} field={{ record: (action, outcome, source) => invoke<void>("record_session_observation", {
        id: active.id, vin, action, outcome, source,
      }) }} />
    </details>}
  </section>;
}
