import { webview } from '@kit.ArkWeb';
import { url } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Verification } from '../NativeBridge';
import { VERIFICATION_ORIGIN, VERIFICATION_PAGE, VERIFICATION_SCRIPT } from '../PhoneVerificationBridge';

class VerificationBridge {
  private receive: (text: string) => void;
  constructor(receive: (text: string) => void) { this.receive = receive; }
  postMessage(text: string): void { this.receive(text); }
}

@Component
export struct PhoneVerification {
  onComplete: (result: string | null, error?: string) => void = () => {};
  @State private status: string = '正在加载 Polestar 验证页面…';
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: VerificationBridge = new VerificationBridge((text: string) => this.receive(text));
  private timeout: number = -1;
  private finished: boolean = false;

  aboutToAppear(): void {
    this.timeout = setTimeout(() => this.finish(null, '手机验证已超时，请重新获取验证码'), 300000);
  }

  aboutToDisappear(): void {
    clearTimeout(this.timeout);
    if (!this.finished) this.finish(null);
  }

  private official(destination: string): boolean {
    try {
      const parsed = new url.URL(destination);
      return parsed.protocol === 'https:' && parsed.hostname === 'h5.app.polestar-auto.com' &&
        parsed.pathname === '/account-components/auth-slider/index.html' &&
        parsed.username === '' && parsed.password === '' && (parsed.port === '' || parsed.port === '443');
    } catch { return false; }
  }

  private receive(text: string): void {
    if (this.finished || text.length > 16384) return;
    try {
      if (!this.official(this.controller.getUrl())) return;
      let data = text;
      if (!data.trimStart().startsWith('{')) {
        const callback = new url.URL(data);
        if (callback.protocol !== 'polestar:' || callback.hostname !== 'webview' ||
          callback.pathname !== '/autoAccount' || callback.username || callback.password || callback.port || callback.hash) {
          throw new Error('Invalid verification callback');
        }
        data = callback.params.get('data') || '';
      }
      const result = JSON.parse(data) as Verification;
      if ([result.sessionId, result.sig, result.token].some((field: string) =>
        typeof field !== 'string' || !field.trim() || field.length > 8192)) {
        throw new Error('Invalid verification result');
      }
      hilog.info(0, 'Norr', 'Phone verification result accepted');
      this.finish(JSON.stringify(result));
    } catch {
      hilog.warn(0, 'Norr', 'Phone verification result rejected');
      this.status = '验证结果无效，请重新加载后重试';
    }
  }

  private finish(result: string | null, error?: string): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timeout);
    try {
      this.controller.stop();
    } catch {
      hilog.warn(0, 'Norr', 'Phone verification page already stopped');
    } finally {
      this.onComplete(result, error);
    }
  }

  build() {
    Column({ space: 20 }) {
      Text('Polestar 手机验证').fontSize(22).fontColor('#20221F')
      Web({ src: VERIFICATION_PAGE, controller: this.controller })
        .height(300)
        .width('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(false)
        .mixedMode(MixedMode.None)
        .javaScriptProxy({ object: this.bridge, name: 'NorrVerification', methodList: ['postMessage'],
          controller: this.controller,
          permission: '{"javascriptProxyPermission":{"urlPermissionList":' +
            '[{"scheme":"https","host":"h5.app.polestar-auto.com","port":"","path":"/account-components/auth-slider/index.html"}]}}' })
        .javaScriptOnDocumentStart([{ script: VERIFICATION_SCRIPT, scriptRules: [VERIFICATION_ORIGIN] }])
        .onLoadIntercept((event) => event.data.isMainFrame() ? !this.official(event.data.getRequestUrl()) :
          !event.data.getRequestUrl().startsWith('https://'))
        .onPageEnd(() => {
          if (this.official(this.controller.getUrl())) {
            this.controller.runJavaScript(VERIFICATION_SCRIPT).then((ready: string) => {
              this.status = ready === 'true' ? '完成验证后会向所填手机号发送短信' : '验证页面连接失败，请重新加载';
              hilog.info(0, 'Norr', 'Phone verification bridge ready (%{public}s)', ready);
            }).catch(() => { this.status = '验证页面连接失败，请重新加载'; });
          }
        })
        .onErrorReceive((event) => {
          if (event.request.isMainFrame()) this.status = '验证页面加载失败，请检查网络后重新加载';
        })
      Text(this.status).fontSize(14).fontColor('#62665E')
      Row({ space: 24 }) {
        Button('重新加载', { type: ButtonType.Normal }).onClick(() => {
          this.status = '正在加载 Polestar 验证页面…';
          this.controller.loadUrl(VERIFICATION_PAGE);
        }).backgroundColor('#20221F').fontColor('#F7F7F5')
        Button('取消', { type: ButtonType.Normal }).onClick(() => this.finish(null))
          .backgroundColor('#F7F7F5').fontColor('#20221F')
      }
    }
    .padding(20)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#F7F7F5')
  }
}
