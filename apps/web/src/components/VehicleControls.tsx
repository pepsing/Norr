import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { sideCutoutPath, type VehicleAppearance } from "../vehicle-catalog";

export function CabinAirPanel({
  pm25, aqi, note, appearance, onDetails,
}: {
  pm25: number | null;
  aqi: number | null;
  note: string;
  appearance?: VehicleAppearance;
  onDetails?: () => void;
}) {
  const value = pm25 ?? aqi;
  return (
    <section className="cabin-air" aria-label="座舱空气">
      {appearance && (
        <div className="cabin-air-photo" aria-hidden="true"
          style={{ backgroundImage: `url("${sideCutoutPath(appearance)}")` }} />
      )}
      <header>
        <h2>座舱空气</h2>
        {onDetails && (
          <button className="cabin-air-detail" onClick={onDetails}>
            详情与净化 <ChevronRight aria-hidden="true" size={15} />
          </button>
        )}
      </header>
      <div className="cabin-air-reading">
        {value !== null ? (
          <>
            <p>{pm25 !== null ? "车内 PM2.5" : "空气质量指数 AQI"}</p>
            <div className="cabin-air-number">
              {value.toLocaleString("zh-CN")}
              {pm25 !== null && <small>μg/m³</small>}
            </div>
          </>
        ) : <p className="cabin-air-empty">暂无空气读数</p>}
      </div>
      <footer>
        {pm25 !== null && aqi !== null && <span>空气质量指数 <b>{aqi}</b></span>}
        <span>{note}</span>
      </footer>
    </section>
  );
}

export function ControlCard({
  icon: Icon,
  title,
  value,
  status,
  active,
  onDetails,
  children,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  status?: string;
  active: boolean;
  onDetails?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="control-card" data-active={active}>
      <div className="control-card-summary">
        <Icon size={25} strokeWidth={1.4} aria-hidden="true" />
        <div>
          <h2>{title}</h2>
          <div className="control-card-meta">
            <span className="control-card-value">{value}</span>
            {onDetails && (
              <button className="control-card-detail" onClick={onDetails}
                aria-label="查看车身状态">
                车身详情 <ChevronRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          {status && <p className="control-card-status">{status}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function ControlRow({
  icon: Icon,
  title,
  description,
  reason,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  reason?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="control-row">
      <span className="control-row-icon">
        <Icon size={19} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        {reason && <p>{reason}</p>}
      </div>
      {children}
    </div>
  );
}
