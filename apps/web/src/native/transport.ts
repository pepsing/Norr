import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { isHarmonyOS } from "./platform";

interface HarmonyHost {
  post(request: string): void;
}

interface NativeResponse {
  id: string;
  response: { ok: boolean; value?: unknown; error?: string };
}

export function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isHarmonyOS) return tauriInvoke<T>(command, args);
  const host = (window as Window & { NorrHost?: HarmonyHost }).NorrHost;
  if (!host) return Promise.reject("鸿蒙原生接口尚未就绪，请重新打开应用");
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("norr-native-response", receive);
    };
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<NativeResponse>).detail;
      if (detail.id !== id) return;
      finish();
      if (!detail.response.ok) reject(detail.response.error ?? "原生请求失败");
      else {
        const value = detail.response.value;
        if (value && typeof value === "object" && "loginError" in value) reject(value.loginError);
        else resolve(value as T);
      }
    };
    const timeout = window.setTimeout(() => {
      finish();
      reject("请求超时，请核对当前状态后重试");
    }, 420_000);
    window.addEventListener("norr-native-response", receive);
    try {
      host.post(JSON.stringify({ id, command, args }));
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export function listen<T>(name: string, callback: EventCallback<T>): Promise<UnlistenFn> {
  if (!isHarmonyOS) return tauriListen<T>(name, callback);
  const receive = (event: Event) => callback({ event: name, id: 0, payload: (event as CustomEvent<T>).detail });
  window.addEventListener(`norr-${name}`, receive);
  return Promise.resolve(() => window.removeEventListener(`norr-${name}`, receive));
}
