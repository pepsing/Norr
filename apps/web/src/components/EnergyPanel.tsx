import { ArrowUpRight, PlugZap } from "lucide-react";
import type { Vehicle } from "../vehicle";
import { useWorkspace } from "../workspace";

interface EnergyPanelProps {
  vehicle: Vehicle;
  busy: boolean;
  unavailable: boolean;
  onToggleCharge: () => void;
  onSettings: () => void;
}

export function EnergyPanel({
  vehicle,
  busy,
  unavailable,
  onToggleCharge,
  onSettings,
}: EnergyPanelProps) {
  const { distance } = useWorkspace();
  const atLimit = vehicle.battery >= vehicle.chargeLimit;
  const remainingMinutes = Math.round(
    (vehicle.chargeLimit - vehicle.battery) * 6.5,
  );
  const remaining = `${Math.floor(remainingMinutes / 60)} 小时 ${remainingMinutes % 60} 分`;

  return (
    <section className="energy-panel" aria-labelledby="energy-title">
      <div className="energy-heading">
        <h2 id="energy-title">电量与续航</h2>
        <PlugZap size={20} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="battery-number">
        {vehicle.battery}
        <span>%</span>
      </div>
      <div
        className="battery-track"
        role="meter"
        aria-label="电池电量"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={vehicle.battery}
      >
        <div
          className="battery-fill"
          style={{ width: `${vehicle.battery}%` }}
        />
        <span
          className="battery-limit"
          style={{ left: `${vehicle.chargeLimit}%` }}
        />
      </div>
      <div className="battery-caption">
        <span>当前电量</span>
        <span>目标 {vehicle.chargeLimit}%</span>
      </div>
      <div className="range-row">
        <span>预计续航</span>
        <span className="range-value">{distance(vehicle.range)}</span>
      </div>
      <div className="charge-summary">
        <div className="charge-indicator">
          <span
            className={
              vehicle.charging ? "status-square active" : "status-square"
            }
          />
          <span>
            {vehicle.charging
              ? "正在充电"
              : atLimit
                ? "已达到目标电量"
                : "充电已暂停"}
          </span>
        </div>
        <span>
          {vehicle.charging ? `7.2 kW · 约 ${remaining}` : "充电线已连接"}
        </span>
      </div>
      <div className="energy-actions">
        <button
          className="light-button"
          disabled={busy || unavailable || atLimit}
          onClick={onToggleCharge}
        >
          {busy ? "处理中…" : vehicle.charging ? "暂停充电" : "继续充电"}
        </button>
        <button className="energy-link" onClick={onSettings}>
          充电设置 <ArrowUpRight size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
