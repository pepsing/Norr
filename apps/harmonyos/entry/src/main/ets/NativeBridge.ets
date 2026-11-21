import nativeCore from 'libentry.so';
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

interface LoginFailure { message: string; retryAt: number; }
interface CoreValue { loginError?: LoginFailure; path?: string; name?: string; }
interface CoreResponse { ok: boolean; value?: CoreValue; error?: string; }
interface VehicleCommand { action: string; }
interface Arguments {
  phone?: string;
  code?: string;
  password?: string;
  verification?: Verification;
  command?: VehicleCommand;
  authorized?: boolean;
  source?: string;
  url?: string;
}
export interface Verification { sessionId: string; sig: string; token: string; }
interface Request { id: string; command: string; args: Arguments; }

const COMMANDS: string[] = [
  'session_status', 'request_login_code', 'sign_in_phone', 'sign_in_password', 'connect',
  'refresh', 'history', 'history_report', 'set_refresh_interval',
  'set_experimental_p4', 'probe_vehicle', 'desktop_status',
  'set_desktop_option', 'take_notification_target', 'take_widget_target', 'send_command',
  'preview_history_import', 'commit_history_import', 'cancel_history_import', 'export_history',
  'open_map_link'
];

export async function coreCall(command: string, args: Object): Promise<string> {
  return nativeCore.invoke(JSON.stringify({ command, args }));
}

export class NativeBridge {
  private controller: webview.WebviewController;
  private context: common.UIAbilityContext;
  private applyTheme: (theme: string) => void;
  private verify: () => Promise<string | null>;
  private loginBusy: boolean = false;
  private commandBusy: boolean = false;

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext,
    applyTheme: (theme: string) => void, verify: () => Promise<string | null>) {
    this.controller = controller;
    this.context = context;
    this.applyTheme = applyTheme;
    this.verify = verify;
  }

  setTheme(theme: string): string {
    if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid theme');
    this.applyTheme(theme);
    return theme;
  }

  post(text: string): void {
    if (text.length > 2 * 1024 * 1024) return;
    let request: Request;
    try {
      request = JSON.parse(text) as Request;
      if (typeof request.id !== 'string' || request.id.length > 64 || !COMMANDS.includes(request.command)) return;
    } catch { return; }
    this.perform(request).then((response: string) => {
      this.respond(request.id, response);
    }).catch((error: Error) => {
      this.respond(request.id, JSON.stringify({ ok: false, error: error.message || '原生操作未完成，请重试' }));
    });
  }

  private respond(id: string, response: string): void {
    const script = 'window.dispatchEvent(new CustomEvent("norr-native-response",{detail:{id:' +
      JSON.stringify(id) + ',response:' + response + '}}))';
    this.controller.runJavaScript(script).catch(() => {});
  }

  private async perform(request: Request): Promise<string> {
    if (['request_login_code', 'sign_in_phone', 'sign_in_password'].includes(request.command)) {
      if (this.loginBusy) throw new Error('登录操作正在进行，请完成或取消当前验证');
      this.loginBusy = true;
      try {
        if (request.command === 'request_login_code') {
          const ready = await coreCall('prepare_login_code', request.args);
          const reply = JSON.parse(ready) as CoreResponse;
          if (!reply.ok || reply.value?.loginError) return ready;
          const verification = await this.verify();
          if (verification === null) return '{"ok":true,"value":null}';
          request.args.verification = JSON.parse(verification) as Verification;
        }
        return await coreCall(request.command, request.args);
      } finally {
        this.loginBusy = false;
      }
    }
    if (request.command === 'send_command') {
      if (this.commandBusy) throw new Error('正在处理车辆指令，请等待完成');
      this.commandBusy = true;
      try {
        request.args.authorized = false;
        if (['unlock', 'unlockTrunk', 'tailgateOpen', 'windowsOpen', 'honkFlash', 'otaInstall',
          'otaSchedule', 'deleteClimateTimer'].includes(request.args.command?.action || '')) {
          request.args.authorized = await this.authenticate();
        }
        return await coreCall(request.command, request.args);
      } finally {
        this.commandBusy = false;
      }
    }
    if (request.command === 'open_map_link') {
      const url = request.args.url || '';
      if (!/^https:\/\/(uri\.amap\.com\/marker\?|www\.google\.com\/maps\/search\/\?|maps\.apple\.com\/\?)/.test(url)) {
        throw new Error('地图地址不受支持');
      }
      await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: url });
      return '{"ok":true,"value":null}';
    }
    if (request.command === 'preview_history_import') {
      if (request.args.source !== 'backup') throw new Error('请选择 Norr 历史备份');
      const documents = new picker.DocumentViewPicker(this.context);
      const selected = await documents.select({ maxSelectNumber: 1, fileSuffixFilters: ['JSON|.json'] });
      if (selected.length === 0) return '{"ok":true,"value":null}';
      const input = fs.openSync(selected[0], fs.OpenMode.READ_ONLY);
      try {
        if (fs.statSync(input.fd).size > 64 * 1024 * 1024) throw new Error('备份文件超过 64 MB');
        fs.copyFileSync(input.fd, this.context.filesDir + '/import.json');
      } finally { fs.closeSync(input); }
    }
    if (request.command === 'export_history') {
      const response = await coreCall(request.command, request.args);
      const reply = JSON.parse(response) as CoreResponse;
      if (!reply.ok) return response;
      const path = reply.value?.path || '';
      const name = reply.value?.name || '';
      try {
        const documents = new picker.DocumentViewPicker(this.context);
        const selected = await documents.save({ newFileNames: [name] });
        if (selected.length === 0) return '{"ok":true,"value":false}';
        const output = fs.openSync(selected[0], fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        try { fs.copyFileSync(path, output.fd); } finally { fs.closeSync(output); }
        return '{"ok":true,"value":true}';
      } finally {
        if (path) fs.unlinkSync(path);
      }
    }
    return coreCall(request.command, request.args);
  }

  private async authenticate(): Promise<boolean> {
    const random = cryptoFramework.createRandom();
    const challenge = await random.generateRandom(32);
    return new Promise<boolean>((resolve, reject) => {
      try {
        const auth = userAuth.getUserAuthInstance({ challenge: challenge.data,
          authType: [userAuth.UserAuthType.PIN, userAuth.UserAuthType.FINGERPRINT, userAuth.UserAuthType.FACE],
          authTrustLevel: userAuth.AuthTrustLevel.ATL3 }, { title: '确认 Norr 的车辆操作' });
        auth.on('result', { onResult: (result: userAuth.UserAuthResult) => {
          auth.off('result');
          resolve(result.result === userAuth.UserAuthResultCode.SUCCESS);
        } });
        auth.start();
      } catch {
        reject(new Error('请先在系统设置中配置锁屏密码或生物识别，再确认车辆操作'));
      }
    });
  }
}
