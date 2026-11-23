import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Modal } from "./Modal";
import { SectionTabs } from "./WorkspaceUI";
import { capabilityReason, supports, useWorkspace } from "../workspace";
import cabin from "../assets/p4-design/front-cabin.jpg";

const seats = {
  主驾: {
    heat: "driverSeatHeat", vent: "driverSeatVent", viewBox: "0 0 359 594",
    outline: `M 124 223 Q 132 218 141 220 C 160 228 232 229 250 221 Q 258 218 269 224
      C 290 231 302 272 302 319 Q 303 362 298 397 C 305 402 308 439 305 468
      C 303 499 291 530 273 540 Q 256 550 238 542 C 218 527 166 526 147 540
      Q 128 551 109 540 C 89 526 81 478 83 443 Q 83 414 88 399
      Q 83 386 85 362 C 81 310 84 259 106 233 Q 113 226 124 223 Z`,
  },
  副驾: {
    heat: "passengerSeatHeat", vent: "passengerSeatVent", viewBox: "359 0 359 594",
    outline: `M 449 223 C 479 212 551 212 588 221 Q 605 223 614 238
      C 633 266 633 308 632 349 Q 632 381 630 400 C 636 417 638 450 634 479
      C 631 509 621 533 607 541 Q 590 551 572 541 C 546 526 507 526 483 540
      Q 465 551 447 540 C 426 528 414 493 412 464 Q 409 430 417 400
      C 415 373 414 331 417 295 C 420 260 429 229 449 223 Z`,
  },
} as const;
const setpoints = ["Lo", ...Array.from({ length: 13 }, (_, i) => i + 16), "Hi"] as const;
export type P4Seat = keyof typeof seats;

export function P4CabinPhoto({ seat, onSelect }: { seat?: P4Seat; onSelect: (seat: P4Seat) => void }) {
  return <div className="p4-cabin-photo">
    <div className="p4-cabin-frame">
      <img src={cabin} alt="Polestar 4 前排座舱俯视图" width={718} height={594} />
      {seat && <div className="p4-seat-pickers" role="group" aria-label="选择座位">
        {(Object.keys(seats) as P4Seat[]).map(name => <button type="button" key={name}
          aria-label={name} aria-pressed={name === seat} onClick={() => onSelect(name)}>
          <svg viewBox={seats[name].viewBox} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path d={seats[name].outline} />
          </svg>
        </button>)}
      </div>}
    </div>
  </div>;
}

export function P4CabinDialog({ onClose }: { onClose: () => void }) {
  const { vehicle, temperature, scenario, busy, command, notice } = useWorkspace();
  const [tab, setTab] = useState("空调");
  const [seat, setSeat] = useState<keyof typeof seats>("主驾");
  const [draft, setDraft] = useState<number | "Lo" | "Hi">(
    vehicle?.targetTemperatureMode === "Lo" || vehicle?.targetTemperatureMode === "Hi" ? vehicle.targetTemperatureMode : vehicle?.targetTemperature ?? 22
  );
  if (!vehicle) return null;
  const index = setpoints.indexOf(draft);
  const allowed = supports(vehicle, "climate");
  const blocked = busy || !allowed || scenario !== "connected";
  const selected = seats[seat];
  const commandNote = !allowed ? capabilityReason(vehicle, "climate") : scenario !== "connected" ? "车辆离线，当前显示上次快照。" : notice;
  return <Modal title="座舱设置" onClose={onClose} className="p4-sheet p4-cabin">
    <SectionTabs items={["空调", "座椅"]} label="座舱设置" value={tab} onChange={setTab} />
    <P4CabinPhoto seat={tab === "座椅" ? seat : undefined} onSelect={setSeat} />
    {tab === "空调" ? <>
      <div className="p4-cabin-ambient"><span>车内 <b>{temperature(vehicle.cabinTemperature)}</b></span>
        <span>车外 <b>{temperature(vehicle.outsideTemperature)}</b></span></div>
      <div className="p4-setpoint"><span>设定温度</span><div>
        <button className="icon-button" aria-label="降低温度" disabled={index <= 0 || blocked} onClick={() => setDraft(setpoints[index - 1])}><Minus /></button>
        <output>{typeof draft === "number" ? temperature(draft) : draft}</output>
        <button className="icon-button" aria-label="提高温度" disabled={index >= setpoints.length - 1 || blocked} onClick={() => setDraft(setpoints[index + 1])}><Plus /></button>
      </div></div>
      <button className="primary-button full-width" disabled={blocked} onClick={async () => {
        await command(vehicle.climateOn ? "应用空调温度" : "启动驻车空调", "climate", {
          climateOn: true, targetTemperatureMode: typeof draft === "number" ? "temperature" : draft,
          ...(typeof draft === "number" ? { targetTemperature: draft } : {}),
        });
      }}>{busy ? "正在发送…" : vehicle.climateOn ? "应用温度" : "开启空调"}</button>
      {vehicle.climateOn && <button className="text-button p4-stop" disabled={blocked}
        onClick={() => void command("停止驻车空调", "climate", { climateOn: false })}>关闭空调</button>}
    </> : <>
      {(["heat", "vent"] as const).map(kind => {
        const key = selected[kind];
        const name = kind === "heat" ? "加热" : "通风";
        const opposite = selected[kind === "heat" ? "vent" : "heat"];
        return <div className="p4-seat-row" key={kind}><span>{seat}{name}</span><div role="group" aria-label={seat + name}>
          {[0, 1, 2, 3].map(level => <button key={level} aria-pressed={(vehicle[key] ?? 0) === level}
            disabled={blocked || (level > 0 && (vehicle[opposite] ?? 0) > 0)}
            onClick={() => { if ((vehicle[key] ?? 0) !== level) void command(seat + name + (level ? ` ${level} 档` : "关闭"), "climate", { [key]: level }); }}>
            {level || "关"}</button>)}</div></div>;
      })}
      {((vehicle[selected.heat] ?? 0) > 0 || (vehicle[selected.vent] ?? 0) > 0) &&
        <p className="p4-action-note">关闭当前档位后，可切换加热或通风。</p>}
      <button className="p4-wheel" role="switch" aria-checked={vehicle.steeringWheelHeat === true} disabled={blocked}
        onClick={() => void command("方向盘加热", "climate", { steeringWheelHeat: !vehicle.steeringWheelHeat })}>
        <span>方向盘加热</span><span>{vehicle.steeringWheelHeat ? "已开启" : "已关闭"}<i aria-hidden="true" /></span>
      </button>
    </>}
    <p className="p4-action-note" role="status">{commandNote || "演示模式"}</p>
  </Modal>;
}
