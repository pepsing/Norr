import { useEffect, useState } from "react";
import { MapPin, ExternalLink } from "lucide-react";
import coordinates from "coordtransform";
import { native, numeric, readingText } from "./client";
import type { Snapshot } from "./client";

export function VehicleMap({
  snapshot,
  onError,
}: {
  snapshot?: Snapshot;
  onError: (message: string) => void;
}) {
  const vin = snapshot?.vehicle.vin ?? "";
  const [visible, setVisible] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [system, setSystem] = useState(() => {
    try {
      return localStorage.getItem(`norr-coordinate-${vin}`) === "gcj02"
        ? "gcj02"
        : "wgs84";
    } catch {
      return "wgs84";
    }
  });
  const lat = numeric(snapshot, "location", "latitude");
  const lon = numeric(snapshot, "location", "longitude");
  const valid =
    snapshot?.readings.location?.status === "success" &&
    lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;
  const [mapLon, mapLat] = valid
    ? system === "wgs84"
      ? coordinates.wgs84togcj02(lon, lat)
      : [lon, lat]
    : [0, 0];
  const [gpsLon, gpsLat] = valid
    ? system === "gcj02"
      ? coordinates.gcj02towgs84(lon, lat)
      : [lon, lat]
    : [0, 0];
  const embed = `https://www.amap.com/ssr/embed/place?lng=${mapLon.toFixed(6)}&lat=${mapLat.toFixed(6)}&name=Norr%20Polestar&zoom=16&platform=pc&src=Norr`;
  useEffect(() => {
    setShowLoading(visible && valid);
    if (!visible || !valid) return;
    // Third-party telemetry can keep the iframe load event pending after the map renders.
    const timer = window.setTimeout(() => setShowLoading(false), 8000);
    return () => window.clearTimeout(timer);
  }, [embed, visible, valid]);
  function open(provider: "amap" | "google" | "apple") {
    const url =
      provider === "amap"
        ? `https://uri.amap.com/marker?position=${mapLon},${mapLat}&name=Polestar&coordinate=gaode&src=Norr&callnative=1`
        : provider === "google"
          ? `https://www.google.com/maps/search/?api=1&query=${gpsLat},${gpsLon}`
          : `https://maps.apple.com/?ll=${gpsLat},${gpsLon}&q=Polestar`;
    void native
      .openMapLink(url)
      .catch((problem: unknown) => onError(String(problem)));
  }
  return (
    <section className="native-section native-map-section">
      <div className="native-map-heading">
        <h2>车辆位置</h2>
        <MapPin size={20} aria-hidden="true" />
      </div>
      <p className="muted native-reading-time">
        {readingText(snapshot, "location")}
      </p>
      {valid ? (
        <>
          <div className="native-map-frame">
            {visible ? (
              <>
                <iframe
                  key={embed}
                  src={embed}
                  title="高德地图中的车辆位置"
                  width="600"
                  height="360"
                  referrerPolicy="strict-origin-when-cross-origin"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  onLoad={() => setShowLoading(false)}
                />
                {showLoading && (
                  <p role="status" className="native-map-loading">
                    正在加载高德地图。
                  </p>
                )}
              </>
            ) : (
              <div className="native-map-placeholder">
                <MapPin size={30} strokeWidth={1.5} aria-hidden="true" />
                <p className="native-coordinates">
                  {lat.toFixed(5)}, {lon.toFixed(5)}
                </p>
                <button
                  className="primary-button"
                  onClick={() => setVisible(true)}
                >
                  显示高德地图
                </button>
                <small>加载时向高德提供此车辆位置。</small>
              </div>
            )}
          </div>
          <div className="native-map-links">
            <button className="text-button" onClick={() => open("amap")}>
              高德地图 <ExternalLink size={13} aria-hidden="true" />
            </button>
            <button className="text-button" onClick={() => open("google")}>
              Google Maps <ExternalLink size={13} aria-hidden="true" />
            </button>
            <button className="text-button" onClick={() => open("apple")}>
              Apple 地图 <ExternalLink size={13} aria-hidden="true" />
            </button>
          </div>
          <details className="native-map-options">
            <summary>坐标与显示设置</summary>
            <label className="native-field">
              车辆坐标系
              <select
                value={system}
                onChange={(event) => {
                  setSystem(event.target.value);
                  try {
                    localStorage.setItem(
                      `norr-coordinate-${vin}`,
                      event.target.value,
                    );
                  } catch {
                    onError("坐标系选择暂时无法保存");
                  }
                }}
              >
                <option value="wgs84">GPS / WGS84</option>
                <option value="gcj02">高德 / GCJ-02</option>
              </select>
            </label>
            <p className="muted">
              接口未标注坐标系，默认按 GPS
              坐标转换。可切换后核对停车位置。地图加载受网络状况影响，也可使用上方入口打开地图。
            </p>
            {visible && (
              <button className="text-button" onClick={() => setVisible(false)}>
                收起地图
              </button>
            )}
          </details>
        </>
      ) : (
        <p className="muted">车辆尚未返回有效位置。</p>
      )}
    </section>
  );
}
