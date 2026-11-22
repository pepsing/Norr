import { useEffect, useState } from "react";
import { native, type NativeVehicle, type SessionStatus } from "./client";
import { PhoneSignIn } from "./PhoneSignIn";
import { P4Recording } from "./P4Recording";

export function P4FieldApp() {
  const [session, setSession] = useState<SessionStatus>();
  const [loginGeneration, setLoginGeneration] = useState(0);
  const [cars, setCars] = useState<NativeVehicle[]>([]);
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);

  async function selectCar(id: string) {
    setVin("");
    if (!id) return;
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
    <main className="native-main" style={{ maxWidth: 760, margin: "0 auto", padding: "max(32px, env(safe-area-inset-top)) 24px" }}>
    <h1>Polestar 4 实测</h1>
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
    {session?.hasSession && <P4Recording key={loginGeneration} vin={vin} refreshing={busy}
      onRefresh={() => void run(() => load(session))} />}
    {vin && <p role="status">已选车辆 · Polestar 4 · {vin.slice(-4)}</p>}
  </main></>;
}
