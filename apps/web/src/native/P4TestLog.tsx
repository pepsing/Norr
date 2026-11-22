import { useState } from "react";
import { actionLabels } from "./client";

const actions: [string, string][] = [
  ["climateCreate", "新增空调预约"], ["climateEdit", "修改空调预约"], ["climateDelete", "删除空调预约"],
  ["climateTemperature", "设置空调目标温度"], ["driverSeatHeat", "主驾座椅加热"],
  ["passengerSeatHeat", "副驾座椅加热"], ["steeringWheelHeat", "方向盘加热"],
  ["driverSeatVent", "主驾座椅通风"], ["passengerSeatVent", "副驾座椅通风"],
  ["chargeOnce", "单次充电预约"], ["chargeRepeat", "周期充电预约"],
  ["chargeOverride", "临时立即充电"], ["chargeResume", "恢复充电预约"],
  ...["lock", "unlock", "unlockTrunk", "tailgateOpen", "tailgateClose", "windowsOpen", "windowsClose",
    "flash", "honkFlash", "honk", "climateStart", "climateStop", "cleanStart", "cleanStop", "target",
    "amperage"].map((id): [string, string] => [id, id === "honk" ? "单独鸣笛" : actionLabels[id]]),
];
const outcomes = [
  ["before", "准备操作"], ["observed", "观察到预期变化"], ["error", "操作报错"],
  ["missing", "未看到入口"], ["unknown", "结果未明"],
];

export function P4TestLog({ field }: { vin: string; field: {
  record: (action: string, outcome: string, source: string) => Promise<void>;
} }) {
  const [action, setAction] = useState(actions[0][0]);
  const [outcome, setOutcome] = useState(outcomes[0][0]);
  const [source, setSource] = useState("officialApp");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      await field.record(action, outcome, source);
      setMessage("实测结果已保存在本机");
    } catch (problem) {
      setMessage(String(problem));
    } finally {
      setBusy(false);
    }
  }

  return <section className="native-section">
    <p className="muted">选择你在车上或官方 App 看到的结果。保存后会随本轮日志一起导出。</p>
    <div className="native-actions">
      {field && <label className="native-field">操作位置 <select value={source} onChange={e => { setSource(e.target.value); setOutcome("before"); setMessage(""); }}>
        <option value="officialApp">官方 App</option><option value="vehicle">车机或车辆</option>
      </select></label>}
      <label className="native-field">测试项目 <select value={action} onChange={e => { setAction(e.target.value); setMessage(""); }}>
        {actions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label className="native-field">观察结果 <select value={outcome} onChange={e => { setOutcome(e.target.value); setMessage(""); }}>
        {field && source === "officialApp" && <option value="appAccepted">官方 App 提示已受理</option>}
        {outcomes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
    </div>
    <div className="native-actions">
      <button className="secondary-button" disabled={busy} onClick={() => void save()}>记录实测结果</button>
    </div>
    <p role="status">{message}</p>
  </section>;
}
