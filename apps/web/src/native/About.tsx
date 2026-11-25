import { useCallback, useEffect, useRef, useState } from "react";
import { OpenSourceLicense } from "../components/OpenSourceLicense";
import { invoke } from "./transport";
import { desktopName, isHarmonyOS } from "./platform";

const DAY = 24 * 60 * 60 * 1000;
const enabledKey = "norr-auto-update";
const checkedKey = "norr-update-last-check";

function saved(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function useAppUpdates(supported: boolean) {
  const [automatic, setAutomatic] = useState(() => saved(enabledKey) !== "off");
  const [available, setAvailable] = useState("");
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState("");
  const [installError, setInstallError] = useState("");
  const active = useRef(false);
  const generation = useRef(0);

  const check = useCallback(async (manual: boolean) => {
    if (!supported || active.current) return;
    const request = ++generation.current;
    active.current = true;
    setChecking(true);
    if (manual) setStatus("");
    try {
      const version = await invoke<string | null>("check_update");
      if (generation.current !== request) return;
      save(checkedKey, String(Date.now()));
      setAvailable(version ?? "");
      setInstallError("");
      if (manual) setStatus(version ? "" : "当前已是最新版本");
    } catch (error) {
      if (manual && generation.current === request) setStatus(String(error));
    } finally {
      active.current = false;
      setChecking(false);
    }
  }, [supported]);

  useEffect(() => {
    if (!supported || !automatic) return;
    let lastAttempt = 0;
    const background = () => {
      const elapsed = Date.now() - Number(saved(checkedKey));
      if (document.hidden || Date.now() - lastAttempt < 15 * 60 * 1000) return;
      if (!Number.isFinite(elapsed) || elapsed >= DAY || elapsed < 0) {
        lastAttempt = Date.now();
        void check(false);
      }
    };
    const initial = window.setTimeout(background, 1500);
    const interval = window.setInterval(background, DAY);
    document.addEventListener("visibilitychange", background);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", background);
    };
  }, [automatic, supported, check]);

  function toggle(on: boolean) {
    if (!save(enabledKey, on ? "on" : "off")) {
      setStatus("无法保存更新偏好，请检查本机存储");
      return;
    }
    generation.current++;
    setAutomatic(on);
    setStatus("");
    if (!on) { setAvailable(""); setInstallError(""); }
  }

  async function install() {
    if (!available || active.current) return;
    active.current = true;
    setInstalling(true);
    setInstallError("");
    try {
      await invoke("install_update", { version: available });
      setAvailable("");
      setStatus("已打开安装程序");
    } catch (error) {
      setInstallError(String(error));
    } finally {
      active.current = false;
      setInstalling(false);
    }
  }
  function later() {
    save(checkedKey, String(Date.now()));
    setAvailable("");
    setInstallError("");
  }

  return { supported, automatic, toggle, available, checking, check, installing, install, later, status, installError };
}

type Updates = ReturnType<typeof useAppUpdates>;

export function UpdatePrompt({ updates }: { updates: Updates }) {
  if (!updates.available) return null;
  return <section className="native-section update-prompt" aria-label="版本更新">
    <p role="status">发现新版本 <strong>{updates.available}</strong></p>
    {updates.installError && <p role="alert">{updates.installError}</p>}
    <div className="button-row">
      <button className="primary-button" disabled={updates.installing || updates.checking} onClick={() => void updates.install()}>
        {updates.installing ? "正在准备安装…" : "下载并更新"}
      </button>
      <button className="secondary-button" disabled={updates.installing} onClick={updates.later}>稍后</button>
    </div>
  </section>;
}

export function About({ updates }: { updates: Updates }) {
  const [version, setVersion] = useState("读取中…");
  useEffect(() => {
    void invoke<string>("app_version").then(setVersion, () => setVersion("无法读取版本号"));
  }, []);
  return <section aria-label="关于北行">
    <div className="setting-row"><div><h2>Norr 北行</h2><p>{desktopName} · {version}</p></div></div>
    <UpdatePrompt updates={updates} />
    {updates.supported && <>
      <div className="setting-row"><div><h3>版本更新</h3><p>从 GitHub Releases 检查适用于本机的安装包，包含公开测试版。</p></div>
        <button className="secondary-button" disabled={updates.checking || updates.installing} onClick={() => void updates.check(true)}>
          {updates.checking ? "正在检查…" : "检查更新"}
        </button>
      </div>
      <div className="setting-row"><label className="update-preference">
        <input type="checkbox" checked={updates.automatic} disabled={updates.installing} onChange={event => updates.toggle(event.target.checked)} />
        自动检查更新
      </label></div>
      {updates.status && <p role="status">{updates.status}</p>}
    </>}
    {isHarmonyOS && <p>GitHub Release 暂未提供 HarmonyOS 安装包。</p>}
    <OpenSourceLicense />
  </section>;
}
