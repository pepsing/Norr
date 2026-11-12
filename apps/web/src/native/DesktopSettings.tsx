import { desktopName, isMobile, isWindows } from "./platform";
import { useEffect, useRef, useState } from "react";
import { native } from "./client";
import type { DesktopState } from "./client";

const loginLabels: Record<number, string> = {
  0: "未注册",
  1: "已启用",
  2: "等待系统批准",
  3: "注册需要更新",
};
const notificationLabels: Record<number, string> = {
  0: "尚未授权",
  1: "系统已关闭通知",
  2: "系统已允许通知",
  3: "允许静默通知",
};

export function DesktopSettings() {
  const [data, setData] = useState<DesktopState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  async function load() {
    const id = ++generation.current;
    try {
      const next = await native.desktopStatus();
      if (generation.current === id) setData(next);
    } catch (problem) {
      if (generation.current === id) setError(String(problem));
    }
  }
  useEffect(() => {
    void load();
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      generation.current++;
      window.removeEventListener("focus", focus);
    };
  }, []);

  async function change(option: string, enabled: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await native.setDesktopOption(option, enabled);
    } catch (problem) {
      setError(String(problem));
    } finally {
      await load();
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await native.testNotification();
      setNotice(`测试通知已提交给 ${desktopName}，可在通知中心查看。`);
    } catch (problem) {
      setError(String(problem));
    } finally {
      await load();
      setBusy(false);
    }
  }
  function settings(section: "login" | "notifications") {
    void native
      .openSystemSettings(section)
      .catch((problem: unknown) => setError(String(problem)));
  }
  return (
    <section className="native-section native-desktop-settings">
      <h2>{desktopName} 与通知</h2>
      {!data && <p className="muted">正在读取系统设置。</p>}
      {error && (
        <p role="alert" className="native-inline-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {!isMobile && (
        <label className="native-preference">
          <span>
            <strong>登录时启动 Norr</strong>
            <small>
              {data
                ? isWindows && data.status.launchAtLogin === 2
                  ? "已在 Windows 启动设置中禁用"
                  : (loginLabels[data.status.launchAtLogin] ?? "状态未知")
                : "读取中"}
            </small>
          </span>
          <input
            type="checkbox"
            checked={data?.settings.launchAtLogin ?? false}
            disabled={busy || !data}
            onChange={(event) =>
              void change("launchAtLogin", event.target.checked)
            }
          />
        </label>
      )}
      <label className="native-preference">
        <span>
          <strong>{isMobile ? "返回应用时刷新车辆" : "唤醒后刷新车辆"}</strong>
          <small>
            {isMobile
              ? "返回 Norr 后重新读取，网络恢复前自动重试。"
              : "电脑唤醒后重新读取，网络恢复前自动重试。"}
          </small>
        </span>
        <input
          type="checkbox"
          checked={data?.settings.refreshOnWake ?? true}
          disabled={busy || !data}
          onChange={(event) =>
            void change("refreshOnWake", event.target.checked)
          }
        />
      </label>
      <label className="native-preference">
        <span>
          <strong>充电状态通知</strong>
          <small>充电开始、完成、异常与意外中断。</small>
        </span>
        <input
          type="checkbox"
          checked={data?.settings.notifyCharging ?? false}
          disabled={busy || !data}
          onChange={(event) =>
            void change("notifyCharging", event.target.checked)
          }
        />
      </label>
      <label className="native-preference">
        <span>
          <strong>指令结果通知</strong>
          <small>服务结果、回读一致或回读待核对。</small>
        </span>
        <input
          type="checkbox"
          checked={data?.settings.notifyCommands ?? false}
          disabled={busy || !data}
          onChange={(event) =>
            void change("notifyCommands", event.target.checked)
          }
        />
      </label>
      <p className="muted">
        {data
          ? (notificationLabels[data.status.notifications] ?? "通知状态未知")
          : "读取通知权限"}
        。通知依赖 Norr 运行和车辆新上报。
      </p>
      <div className="native-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void test()}
        >
          发送测试通知
        </button>
        <button
          className="text-button"
          onClick={() => settings("notifications")}
        >
          系统通知设置
        </button>
        {!isMobile && (
          <button className="text-button" onClick={() => settings("login")}>
            启动项设置
          </button>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void load()}
        >
          刷新系统状态
        </button>
      </div>
    </section>
  );
}
