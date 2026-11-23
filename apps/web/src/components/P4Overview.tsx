import { Battery, ChevronRight, Fan, LocateFixed, LockKeyhole, LockKeyholeOpen, MapPin, PanelTopOpen } from "lucide-react";
import { VehicleArtwork } from "./VehicleArtwork";
import { appearanceFor, type VehicleAppearance } from "../vehicle-catalog";
import { useWorkspace } from "../workspace";
import { p4DemoAir, p4SetpointLabel } from "../p4-demo";
type HomeAction = "lock" | "climate" | "limit" | "tailgate" | "locate" | "cleaning";
type Navigation = "charging" | "location" | "details" | "controls";
type Events = { onControl: (action: HomeAction) => void; onNavigate: (page: Navigation) => void };
const shortcuts = [
  { action: "lock", name: "车锁", icon: LockKeyhole },
  { action: "climate", name: "空调", icon: Fan },
  { action: "tailgate", name: "尾门", icon: PanelTopOpen },
  { action: "locate", name: "寻车", icon: LocateFixed },
] as const;

export function P4Overview(events: Events) {
  const { vehicle, distance, temperature } = useWorkspace();
  if (!vehicle) return null;
  const [range, unit] = distance(vehicle.range).split(" ");
  return <P4OverviewView {...events} appearance={appearanceFor(vehicle)} range={range} unit={unit}
    battery={vehicle.battery} locked={vehicle.locked} outside={temperature(vehicle.outsideTemperature)}
    inside={temperature(vehicle.cabinTemperature)} climate={p4SetpointLabel(vehicle, temperature)}
    air={p4DemoAir} cleaning={vehicle.cleaning ? "净化中" : "净化已停止"} limit={`当前设定 ${vehicle.chargeLimit}%`} />;
}

export function P4OverviewView({ appearance, range, unit, battery, locked, outside, inside, climate, air, cleaning, limit, onControl, onNavigate }: Events & {
  appearance: VehicleAppearance; range: string; unit: string; battery: number | null; locked: boolean | null;
  outside: string; inside: string; climate: string; air: number | null; cleaning: string; limit: string;
}) {
  const LockState = locked === false ? LockKeyholeOpen : LockKeyhole;
  const charge = battery === null ? "未返回" : `${battery}%`;
  return <div className="p4-overview">
    <div className="p4-overview-main">
      <section className="p4-stage" aria-label="续航与电量">
        <div className="p4-stage-top">
          <div><span>剩余续航</span><p className="p4-range">{range}<small>{unit}</small></p></div>
          <button className="p4-battery" onClick={() => onNavigate("charging")} aria-label={`查看充电，剩余电量 ${charge}`}>
            <Battery size={17} aria-hidden="true" /> {charge}</button>
        </div>
        <div className="p4-car"><VehicleArtwork appearance={appearance} priority darkStage /></div>
        <div className="p4-stage-foot"><span>{locked !== null && <LockState size={15} aria-hidden="true" />}{locked === null ? "门锁状态未知" : locked ? "已锁车" : "已解锁"}</span>
          <button onClick={() => onNavigate("location")}><MapPin size={15} />车辆位置</button></div>
      </section>
      <div className="p4-shortcuts" role="group" aria-label="快捷控制">{shortcuts.map(({action, name, icon: Icon}) =>
        <button key={action} onClick={() => onControl(action)}><Icon size={24} strokeWidth={1.45} aria-hidden="true" />{name}</button>
      )}</div>
    </div>
    <div className="p4-overview-side">
      <section aria-label="座舱">
        <div className="p4-section-title"><h2>座舱</h2><span>车外 {outside}</span></div>
        <div className="p4-instruments">
          <button onClick={() => onControl("climate")}><span>空调设置</span>
            <strong>{climate}</strong><small>车内 {inside}</small></button>
          <button onClick={() => onControl("cleaning")}><span>空气净化</span>
            <strong>{air ?? "—"}{air !== null && <em>μg/m³</em>}</strong><small>PM2.5 · {cleaning}</small></button>
        </div>
      </section>
      <section className="p4-overview-rows" aria-label="车辆管理">
        <button onClick={() => onNavigate("details")}><span>车况管理<small>车身、轮胎与行车日志</small></span><ChevronRight /></button>
        <button onClick={() => onControl("limit")}><span>充电上限<small>{limit}</small></span><ChevronRight /></button>
        <button onClick={() => onNavigate("controls")}><span>全部控制<small>车窗、充电口盖与操作记录</small></span><ChevronRight /></button>
      </section>
    </div>
  </div>;
}
