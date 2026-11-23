import { useEffect, useState } from "react";
import { native, type NativeVehicle, type SessionStatus } from "./client";
import { invoke } from "./transport";
import { PhoneSignIn } from "./PhoneSignIn";
import { isIOS } from "./platform";
import { P4Recording } from "./P4Recording";
import App from "../App";
import { P4TestLog } from "./P4TestLog";

export function P4FieldApp({ onViewVehicle }: { onViewVehicle?: () => void }) {
  const [session, setSession] = useState<SessionStatus>();
  const [loginGeneration, setLoginGeneration] = useState(0);
  const [cars, setCars] = useState<NativeVehicle[]>([]);
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const [preview, setPreview] = useState(false);

  async function selectCar(id: string) {
    setVin("");
    if (!id) return;
    if (!isIOS) await invoke("open_field_log", { vin: id });
    setVin(id);
  }
  async function load(next: SessionStatus) {
    setSession(next);
    setCars([]);
    setVin("");
    setEmpty(false);
    setError("");
    if (!next.hasSession) return;
    const fleet = (await native.connect()).filter(car => car.platform?.toUpperCase() === "HUANFU");
    setCars(fleet);
    setEmpty(fleet.length === 0);
    if (fleet.length === 1) await selectCar(fleet[0].vin);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await work(); } catch (problem) { setError(String(problem)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    let active = true;
    void run(async () => {
      const status = await native.status();
      if (active) await load(status);
    });
    return () => { active = false; };
  }, []);

  return <>
    {preview && <App p4 onExit={() => setPreview(false)} />}
    <main hidden={preview} className="native-main" style={{ maxWidth: 760, margin: "0 auto", padding: "max(32px, env(safe-area-inset-top)) 24px" }}>
    <h1>Polestar 4 实测</h1>
    {isIOS && <button className="secondary-button" onClick={() => { setPreview(true); window.scrollTo(0, 0); }}>查看功能演示</button>}
    <section className="native-section">
      <h2>中国区账号</h2>
      <PhoneSignIn fieldTest session={session} busy={busy} onBusyChange={setBusy} onSignedIn={async next => {
        setLoginGeneration(n => n + 1);
        await run(() => load(next));
      }} />
    </section>
    {busy && <p role="status">正在处理账号或车辆请求…</p>}
    {error && <div role="alert"><p>{error}</p><button className="secondary-button" disabled={busy}
      onClick={() => void run(async () => load(await native.status()))}>重试</button></div>}
    {empty && <p>此账号的车库未返回 Polestar 4。</p>}
    {cars.length > 1 && <label className="native-field">测试车辆
      <select disabled={busy} value={vin} onChange={e => { const id = e.target.value; void run(() => selectCar(id)); }}>
        <option value="">选择车辆</option>
        {cars.map(car => <option key={car.vin} value={car.vin}>{car.model} · {car.vin.slice(-4)}</option>)}
      </select>
    </label>}
    {isIOS && session?.hasSession && <P4Recording key={loginGeneration} vin={vin} refreshing={busy}
      onRefresh={() => void run(() => load(session))} />}
    {isIOS && vin && <p role="status">已选车辆 · Polestar 4 · {vin.slice(-4)}</p>}
    {!isIOS && vin && !busy && <>
      <p role="status">已开始记录 · Polestar 4 · {vin.slice(-4)}</p>
      <P4TestLog key={vin} vin={vin} field={{
        record: (action, outcome, source) => invoke<void>("mark_field_log", { vin, action, outcome, source }),
        exportFile: () => invoke<boolean>("export_field_log", { vin }),
      }}/>
    </>}
    {onViewVehicle && <button className="secondary-button" onClick={onViewVehicle}>查看车况</button>}
  </main></>;
}
