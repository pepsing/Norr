import { useState } from "react";
import type { HistoryPoint } from "./client";

export function HistoryTrend({
  title,
  points,
  unit,
}: {
  title: string;
  points: HistoryPoint[];
  unit: "%" | "km";
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const days = new Map<string, HistoryPoint>();
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    days.set(new Date(point.time).toLocaleDateString("zh-CN"), point);
  }
  const daily = [...days.values()].slice(-31);
  const index = Math.min(selected ?? daily.length - 1, daily.length - 1);
  const current = daily[index];
  const values = daily.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = Math.max((high - low) * 0.15, 1);
  const minimum = unit === "%" ? 0 : Math.max(0, Math.floor(low - padding));
  const maximum = unit === "%" ? 100 : Math.ceil(high + padding);
  const start = daily[0]?.time ?? 0;
  const span = (daily.at(-1)?.time ?? start) - start;
  const positions = daily.map((point) => ({
    x: span ? ((point.time - start) / span) * 100 : 50,
    y: 100 - ((point.value - minimum) / (maximum - minimum)) * 100,
  }));
  const date = (time: number) =>
    new Date(time).toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    });
  const number = (value: number) =>
    value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

  return (
    <section
      className={`native-history-trend${daily.length < 2 ? " native-history-trend-sparse" : ""}`}
    >
      <h2>{title}</h2>
      {current ? (
        <>
          <div className="native-trend-value" aria-live="polite">
            <strong>
              {number(current.value)}
              <small>{unit}</small>
            </strong>
            <span>{new Date(current.time).toLocaleDateString("zh-CN")}</span>
          </div>
          {daily.length > 1 && (
            <>
              <div className="native-trend-chart">
                <div className="native-trend-axis" aria-hidden="true">
                  <span>{number(maximum)}</span>
                  <span>{number(minimum)}</span>
                </div>
                <div
                  className="native-trend-plot"
                  role="group"
                  aria-label={`${title}读数`}
                >
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      className="native-trend-grid"
                      d="M0 0 H100 M0 50 H100 M0 100 H100"
                    />
                    <polyline
                      points={positions
                        .map(({ x, y }) => `${x},${y}`)
                        .join(" ")}
                    />
                  </svg>
                  {daily.map((point, position) => (
                    <button
                      key={point.time}
                      className="native-trend-point"
                      style={{
                        left: `${positions[position].x}%`,
                        top: `${positions[position].y}%`,
                      }}
                      aria-label={`${new Date(point.time).toLocaleDateString("zh-CN")}，${number(point.value)} ${unit}`}
                      aria-pressed={index === position}
                      tabIndex={index === position ? 0 : -1}
                      onClick={() => setSelected(position)}
                      onFocus={() => setSelected(position)}
                      onKeyDown={(event) => {
                        const next = {
                          ArrowLeft: position - 1,
                          ArrowRight: position + 1,
                          Home: 0,
                          End: daily.length - 1,
                        }[event.key];
                        if (next === undefined) return;
                        event.preventDefault();
                        const target = Math.max(
                          0,
                          Math.min(next, daily.length - 1),
                        );
                        const buttons =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            "button",
                          );
                        buttons?.[target]?.focus();
                      }}
                    >
                      <span />
                    </button>
                  ))}
                </div>
              </div>
              <div className="native-trend-dates" aria-hidden="true">
                <span>{date(start)}</span>
                <span>{date(daily.at(-1)!.time)}</span>
              </div>
            </>
          )}
          <p className="native-history-note">
            {daily.length === 1
              ? "1 个采样日，持续采集后显示趋势"
              : `${daily.length} 个采样日 · 每日最后一条有效上报`}
          </p>
        </>
      ) : (
        <div className="native-trend-empty">
          <p>暂无有效读数</p>
          <small>车辆上报后将显示趋势。</small>
        </div>
      )}
    </section>
  );
}
