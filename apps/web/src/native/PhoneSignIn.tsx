import { credentialStorage } from "./platform";
import { useEffect, useState } from "react";
import { native, type SessionStatus } from "./client";

interface Props {
  session: SessionStatus | undefined;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSignedIn: (session: SessionStatus) => Promise<void>;
}

export function PhoneSignIn({
  session,
  busy,
  onBusyChange,
  onSignedIn,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentPhone, setSentPhone] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const validPhone = /^1[0-9]{10}$/.test(phone);
  const validCode = /^[0-9]{6}$/.test(code);

  useEffect(() => {
    const update = () =>
      setSeconds(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    update();
    if (retryAt <= Date.now()) return;
    const interval = window.setInterval(() => {
      update();
      if (retryAt <= Date.now()) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [retryAt]);

  async function sendCode() {
    if (busy || !validPhone || seconds > 0) return;
    onBusyChange(true);
    setError("");
    setStatus("请在手机验证窗口完成滑块验证。");
    try {
      const nextSendAt = await native.requestLoginCode(phone);
      if (nextSendAt === null) {
        setStatus("已取消手机验证。");
        return;
      }
      setRetryAt(nextSendAt);
      setSentPhone(phone);
      setStatus("验证码已发送，请查看短信。");
    } catch (problem) {
      setStatus("");
      if (problem && typeof problem === "object" && "message" in problem) {
        setError(String(problem.message));
        if ("retryAt" in problem && typeof problem.retryAt === "number")
          setRetryAt(problem.retryAt);
      } else {
        setError(String(problem));
      }
    } finally {
      onBusyChange(false);
    }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !validPhone || !validCode || sentPhone !== phone) return;
    onBusyChange(true);
    setError("");
    setStatus("正在登录…");
    try {
      const nextSession = await native.signInPhone(phone, code);
      setCode("");
      setPhone("");
      setSentPhone("");
      setExpanded(false);
      setStatus("");
      await onSignedIn(nextSession);
    } catch (problem) {
      setStatus("");
      setError(String(problem));
    } finally {
      onBusyChange(false);
    }
  }

  if (session?.hasSession && !expanded) {
    return (
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => setExpanded(true)}
      >
        重新登录
      </button>
    );
  }

  return (
    <form
      className="native-sign-in"
      onSubmit={(event) => void signIn(event)}
      aria-busy={busy}
    >
      <p className="muted" id="phone-login-help">
        使用中国大陆 Polestar 账号绑定的手机号登录。
      </p>
      <label className="native-field">
        手机号 · +86
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          aria-describedby="phone-login-help"
          maxLength={11}
          value={phone}
          placeholder="11 位手机号"
          disabled={busy}
          onChange={(event) => {
            setPhone(event.target.value.trim());
            setCode("");
            setSentPhone("");
            setStatus("");
            setError("");
          }}
        />
      </label>
      <div className="native-sign-in-code">
        <label className="native-field">
          短信验证码
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            placeholder="6 位验证码"
            disabled={busy}
            onChange={(event) => setCode(event.target.value.trim())}
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={
            busy || !validPhone || seconds > 0 || !session?.hasSigningKey
          }
          onClick={() => void sendCode()}
        >
          {seconds > 0
            ? `${seconds} 秒后重发`
            : sentPhone && sentPhone === phone
              ? "重新获取验证码"
              : "获取验证码"}
        </button>
      </div>
      {!session?.hasSigningKey && !busy && (
        <p className="native-inline-error" role="alert">
          此安装包缺少中国区登录配置，请安装包含登录配置的版本。
        </p>
      )}
      <div className="native-sign-in-feedback">
        {status && (
          <p className="muted" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="native-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="row-actions">
        <button
          className="primary-button"
          type="submit"
          disabled={busy || !validCode || !validPhone || sentPhone !== phone}
        >
          登录并读取车辆
        </button>
        {session?.hasSession && (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setExpanded(false);
              setCode("");
              setError("");
              setStatus("");
            }}
          >
            取消
          </button>
        )}
      </div>
      <p className="muted native-sign-in-note">
        登录后，会话保存在{credentialStorage}中。当前支持中国区 Polestar
        2，Polestar 4 车辆服务仍在接入。
      </p>
    </form>
  );
}
