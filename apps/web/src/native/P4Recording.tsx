import { useEffect, useState } from "react";
import { invoke } from "./transport";
import { P4TestLog } from "./P4TestLog";

import { P4VehicleReadings, type P4VehicleSample } from "./P4VehicleReadings";

type Recording = { id: number; startedAt: number; finishedAt: number | null };
type Operation = "start" | "finish";

export function P4Recording({ onRefresh, refreshing, vin }: { onRefresh: () => void; refreshing: boolean; vin: string }) {
  const [runs, setRuns] = useState<Recording[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<{ id: number; vin: string; sample: P4VehicleSample }>();
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
    setLatest(undefined);
    try {
      const sample = await invoke<P4VehicleSample>("read_recording_vehicle", { id, vin });
      setLatest({ id, vin, sample });
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
  const visible = latest && latest.vin === vin && latest.id === (active ?? chosen)?.id ? latest.sample : undefined;
  return <section className="native-section">
    <h2>操作记录</h2>
    <p className="muted">{active ? "记录中。可随时读取车况，完成时会再读取一次。" : "选择车辆后，开始和完成记录时会自动读取车况。"}</p>
    <div className="native-actions">
      <button className="primary-button" disabled={busy || refreshing} onClick={() => void update(active ? "finish" : "start")}>{active ? "完成记录" : "开始记录"}</button>
      {active && <button className="secondary-button" disabled={busy || refreshing || !vin} onClick={() => void readVehicle(active.id)}>读取车况</button>}
      {active && <button className="secondary-button" disabled={busy || refreshing} onClick={onRefresh}>刷新车库</button>}
    </div>
    {visible && <P4VehicleReadings sample={visible} />}
    {active && vin && <details className="native-section" key={active.id + vin}>
      <summary>添加实车观察（可选）</summary>
      <P4TestLog vin={vin} field={{ record: (action, outcome, source) => invoke<void>("record_session_observation", {
        id: active.id, vin, action, outcome, source,
      }) }} />
    </details>}
    {!!completed.length && <>
      {completed.length > 1 && <label className="native-field">已完成的记录
        <select value={chosen.id} onChange={e => setSelected(Number(e.target.value))}>
          {completed.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.id}</option>)}
        </select>
      </label>}
      <button className="secondary-button" disabled={busy} onClick={() => void share()}>导出日志</button>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
