import { useState } from "react";
import { actionLabels, native, p4FindActions } from "./client";

const actions: [string, string][] = [
  ["climateCreate", "新增空调预约"], ["climateEdit", "修改空调预约"], ["climateDelete", "删除空调预约"],
  ["climateTemperature", "设置空调目标温度"], ["driverSeatHeat", "主驾座椅加热"],
  ["passengerSeatHeat", "副驾座椅加热"], ["steeringWheelHeat", "方向盘加热"],
  ["driverSeatVent", "主驾座椅通风"], ["passengerSeatVent", "副驾座椅通风"],
  ["chargeOnce", "单次充电预约"], ["chargeRepeat", "周期充电预约"],
  ["chargeOverride", "临时立即充电"], ["chargeResume", "恢复充电预约"],
  ...["lock", "unlock", "unlockTrunk", "tailgateOpen", "tailgateClose", "windowsOpen", "windowsClose", "windowsVent", "chargeLidOpen", "chargeLidClose",
    ...p4FindActions, "climateStart", "climateStop", "cleanStart", "cleanStop", "target",
    "amperage"].map((id): [string, string] => [id, actionLabels[id]]),
];
const outcomes = [
  ["before", "准备操作"], ["observed", "观察到预期变化"], ["error", "操作报错"],
  ["missing", "未看到入口"], ["unknown", "结果未明"],
];

export function P4TestLog({ vin, field }: { vin: string; field?: {
  record: (action: string, outcome: string, source: string) => Promise<void>;
  exportFile?: () => Promise<boolean>;
} }) {
  const [action, setAction] = useState(actions[0][0]);
  const [outcome, setOutcome] = useState(outcomes[0][0]);
  const [source, setSource] = useState("officialApp");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save(exportFile: boolean) {
    setBusy(true);
    setMessage("");
    try {
      if (exportFile) {
        if (await (field ? field.exportFile?.() : native.exportHistory(vin, "p4-log"))) setMessage("测试日志已导出");
      } else {
        if (field) await field.record(action, outcome, source);
        else await native.recordP4Observation(vin, action, outcome);
        setMessage("实测结果已保存在本机");
      }
    } catch (problem) {
      setMessage(String(problem));
    } finally {
      setBusy(false);
    }
  }

  return <section className="native-section">
    {(!field || field.exportFile) && <h2>P4 测试日志</h2>}
    <p className="muted">{field ? (field.exportFile ? "操作前记一次「准备操作」。在官方 App 或车上完成操作后，选择观察结果并保存。导出最近 7 天的记录。" : "选择你在车上或官方 App 看到的结果。保存后会随本轮日志一起导出。") : "记录你在车上或官方 App 看到的结果。导出文件包含最近 7 天的实测标记、预约读数，以及门窗、充电和空调状态。"}</p>
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
      <button className="secondary-button" disabled={busy} onClick={() => void save(false)}>记录实测结果</button>
      {(!field || field.exportFile) && <button className="secondary-button" disabled={busy} onClick={() => void save(true)}>导出测试日志</button>}
    </div>
    <p role="status">{message}</p>
  </section>;
}
