import { useEffect, useState } from "react";
import { MapPin, ExternalLink } from "lucide-react";
import { isNativeP4, native, numeric, readingText } from "./client";
import type { Snapshot } from "./client";
import { vehicleMapLinks } from "./mapLinks";
import type { CoordinateSystem } from "./mapLinks";

type VehicleMapProps = {
  snapshot?: Snapshot;
  onError: (message: string) => void;
};

export function VehicleMap(props: VehicleMapProps) {
  return <VehicleLocationMap key={props.snapshot?.vehicle.vin} {...props} />;
}

function VehicleLocationMap({ snapshot, onError }: VehicleMapProps) {
  const vin = snapshot?.vehicle.vin ?? "";
  const p4 = isNativeP4(snapshot?.vehicle);
  const [mapVisible, setVisible] = useState<boolean | null>(null);
  const preferenceKey = `norr-amap-auto-${vin}`;
  const [automatic, setAutomatic] = useState(() => {
    try {
      return Boolean(p4 && vin && localStorage.getItem(preferenceKey) !== "false");
    } catch {
      return false;
    }
  });
  const visible = mapVisible ?? (!p4 || automatic);
  function changeAutomatic(enabled: boolean) {
    setAutomatic(enabled);
    setVisible(enabled);
    try {
      localStorage.setItem(preferenceKey, String(enabled));
    } catch {
      onError("无法保存地图偏好，请检查本机存储。");
    }
  }
  const [showLoading, setShowLoading] = useState(false);
  const [googleSystem] = useState<CoordinateSystem>(() => {
    try {
      return localStorage.getItem(`norr-coordinate-${vin}`) === "gcj02"
        ? "gcj02"
        : "wgs84";
    } catch {
      return "wgs84";
    }
  });
  const [vehicleSystem, setVehicleSystem] = useState<CoordinateSystem>(() => {
    try {
      return localStorage.getItem(`norr-amap-coordinate-${vin}`) === "wgs84"
        ? "wgs84"
        : "gcj02";
    } catch {
      return "gcj02";
    }
  });
  const lat = numeric(snapshot, "location", "latitude");
  const lon = numeric(snapshot, "location", "longitude");
  const valid =
    snapshot?.readings.location?.status === "success" &&
    (!p4 || snapshot.readings.location.value?.coordinateSystem === "wgs84") &&
    lat !== null &&
    lon !== null &&
    (!p4 || (lat !== 0 && lon !== 0)) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;
  const links = vehicleMapLinks(
    valid ? lon : 0,
    valid ? lat : 0,
    p4 ? "wgs84" : vehicleSystem,
    p4 ? "wgs84" : googleSystem,
  );
  const embed = links.embed;
  useEffect(() => {
    setShowLoading(visible && valid);
    if (!visible || !valid) return;
    // Third-party telemetry can keep the iframe load event pending after the map renders.
    const timer = window.setTimeout(() => setShowLoading(false), 8000);
    return () => window.clearTimeout(timer);
  }, [embed, visible, valid]);
  function open(provider: "amap" | "google" | "apple") {
    void native
      .openMapLink(links[provider])
      .catch((problem: unknown) => onError(String(problem)));
  }
  return (
    <section className="native-section native-map-section">
      <div className="native-map-heading">
        <h2>车辆位置</h2>
        <MapPin size={20} aria-hidden="true" />
      </div>
      <p className="muted native-reading-time">
        {p4 && !snapshot?.readings.location ? "尚未读取位置" : readingText(snapshot, "location")}
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
          {p4 ? (
            visible && <button className="text-button" onClick={() => setVisible(false)}>收起地图</button>
          ) : <details className="native-map-options">
            <summary>坐标与显示设置</summary>
            <label className="native-field">
              高德与 Apple 坐标来源
              <select
                value={vehicleSystem}
                onChange={(event) => {
                  const value = event.target.value === "wgs84" ? "wgs84" : "gcj02";
                  setVehicleSystem(value);
                  try {
                    localStorage.setItem(
                      `norr-amap-coordinate-${vin}`,
                      value,
                    );
                  } catch {
                    onError("坐标系选择暂时无法保存");
                  }
                }}
              >
                <option value="gcj02">车辆坐标为 GCJ-02</option>
                <option value="wgs84">车辆坐标为 GPS / WGS84</option>
              </select>
            </label>
            <p className="muted">
              默认按 GCJ-02 处理车辆坐标，高德直接标注，Apple 转换为 WGS84。
              若车辆返回 GPS 坐标，请选择 WGS84。此选择按车辆保存。
            </p>
            {visible && (
              <button className="text-button" onClick={() => setVisible(false)}>
                收起地图
              </button>
            )}
          </details>}
        </>
      ) : (!p4 || snapshot?.readings.location?.status === "success") && (
        <p className="muted">车辆尚未返回有效位置。</p>
      )}
      {p4 && vin && (valid || automatic) && (
        <label className="native-map-auto">
          <input type="checkbox" checked={automatic} onChange={event => changeAutomatic(event.target.checked)} />
          在此设备自动显示此车的高德地图，加载时向高德提供车辆位置
        </label>
      )}
    </section>
  );
}
