import { useState } from "react";
import { Battery, Fan, LockKeyhole, LockKeyholeOpen } from "lucide-react";
import { Modal } from "../components/Modal";
import { ControlCard, ControlRow } from "../components/VehicleControls";
import { numeric, readingText, type Snapshot } from "./client";
import { OpeningStatus, P4ClimateDetails } from "./VehicleDetails";
import { P4PartnerControls } from "./P4PartnerControls";

const titles = { lock: "车锁", climate: "座舱设置", target: "充电上限" };

export function P4RecordingControls({ id, vin, snapshot, disabled, onPending, onReadback }: {
  id: number; vin: string; snapshot?: Snapshot; disabled: boolean;
  onPending: (pending: boolean) => void; onReadback: () => Promise<void>;
}) {
  const [sheet, setSheet] = useState<keyof typeof titles>();
  const [sending, setSending] = useState(false);
  const locked = snapshot?.readings.exterior?.value?.locked;
  const activity = snapshot?.readings.climate?.value?.activity;
  const climate = activity === "active" ? "运行中" : activity === "idle" ? "已关闭" : activity === "starting" ? "启动中" : "状态未知";
  const target = numeric(snapshot, "target", "percent");
  const lock = locked === true ? "已锁定" : locked === false ? "已解锁" : "状态未知";
  const targetText = target == null ? "尚无车辆读数" : `${target}%`;
  const controls = sheet && <P4PartnerControls key={sheet} id={id} vin={vin} only={sheet}
    disabled={disabled} onPending={pending => { setSending(pending); onPending(pending); }} onReadback={onReadback} />;
  return <section className="p4-workspace" aria-label="车辆控制">
    <h3>车辆控制</h3>
    <div className="control-lead">
      <ControlCard title="空调" icon={Fan} value={climate} active={activity === "active"}>
        <button className="secondary-button" disabled={disabled} onClick={() => setSheet("climate")}>调节空调</button>
      </ControlCard>
      <ControlCard title="门锁" icon={locked === false ? LockKeyholeOpen : LockKeyhole} value={lock} active={locked === false}>
        <button className="secondary-button" disabled={disabled} onClick={() => setSheet("lock")}>车锁设置</button>
      </ControlCard>
    </div>
    <div className="control-list">
      <ControlRow icon={Battery} title="充电上限" description={targetText}>
        <button className="secondary-button" disabled={disabled} onClick={() => setSheet("target")}>设置上限</button>
      </ControlRow>
    </div>
    {sheet && <Modal className="p4-sheet" title={titles[sheet]} onClose={() => { if (!sending) setSheet(undefined); }}>
      {sheet === "climate" ? <P4ClimateDetails snapshot={snapshot} activity={climate} controls={controls} /> : <>
        {sheet === "lock" ? <OpeningStatus snapshot={snapshot} /> : <p className="limit-readout">{targetText}</p>}
        <p className="muted">{readingText(snapshot, sheet === "lock" ? "exterior" : "target", true)}</p>
        {controls}
      </>}
    </Modal>}
  </section>;
}
