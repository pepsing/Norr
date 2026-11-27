import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NativeBridge, coreCall } from '../NativeBridge';
import { PhoneVerification } from './PhoneVerification';

const ORIGIN = 'https://norr.localhost';
const MIME_TYPES: Record<string, string> = {
  'html': 'text/html',
  'js': 'application/javascript',
  'css': 'text/css',
  'json': 'application/json',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'woff': 'font/woff',
  'woff2': 'font/woff2'
};

const THEME_SCRIPT = `(() => {
  const root = document.documentElement;
  const update = () => {
    root.dataset.norrHostTheme = NorrHost.setTheme(root.dataset.theme || 'light');
  };
  update();
  new MutationObserver(update).observe(root, {
    attributes: true,
    attributeFilter: ['data-theme']
  });
  return root.dataset.norrHostTheme;
})()`;

interface CoreStatus { ok: boolean; value?: Object; error?: string; }
interface CoreArguments { directory?: string; waking?: boolean; }
interface PollValue { snapshot?: Object; error?: string; woke?: boolean; }
interface PollResult { ok: boolean; value?: PollValue; }

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
  private bridge: NativeBridge = new NativeBridge(this.controller, this.context,
    (theme: string) => this.applyTheme(theme), () => this.verifyPhone());
  private verificationResolve?: (result: string | null) => void;
  private verificationReject?: (error: Error) => void;
  private pollTimer: number = -1;
  private polling: boolean = false;
  private wakeGeneration: number = 0;
  @State private ready: boolean = false;
  @State private verifying: boolean = false;
  @State pageBackground: string = '#F7F7F5';
  @State foreground: string = '#20221F';
  @State loadError: string = '';

  aboutToAppear(): void { this.initialize(); }

  aboutToDisappear(): void { clearInterval(this.pollTimer); }

  private initialize(): void {
    const args: CoreArguments = { directory: this.context.filesDir };
    const empty: CoreArguments = {};
    coreCall('initialize', args).then(async (text: string) => {
      const result = JSON.parse(text) as CoreStatus;
      if (!result.ok) throw new Error(result.error || '车辆核心初始化失败');
      const check = JSON.parse(await coreCall('health_check', empty)) as CoreStatus;
      if (!check.ok) throw new Error(check.error || '凭据存储检查失败');
      hilog.info(0, 'Norr', 'Native core ready %{public}s', JSON.stringify(check.value));
      this.ready = true;
    }).catch((error: Error) => { this.loadError = error.message || '车辆核心初始化失败'; });
  }

  private verifyPhone(): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      this.verificationResolve = resolve;
      this.verificationReject = reject;
      this.verifying = true;
    });
  }

  private finishVerification(result: string | null, error?: string): void {
    this.verifying = false;
    hilog.info(0, 'Norr', 'Phone verification dialog closed');
    if (error) this.verificationReject?.(new Error(error));
    else this.verificationResolve?.(result);
    this.verificationResolve = undefined;
    this.verificationReject = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.verifying || !AppStorage.get<boolean>('norrActive')) return;
    this.polling = true;
    const generation = AppStorage.get<number>('norrWakeGeneration') || 0;
    try {
      const args: CoreArguments = { waking: generation !== this.wakeGeneration };
      const result = JSON.parse(await coreCall('poll', args)) as PollResult;
      if (result.value?.woke) this.wakeGeneration = generation;
      if (result.value?.snapshot) {
        await this.controller.runJavaScript('window.dispatchEvent(new CustomEvent("norr-vehicle-updated",{detail:' +
          JSON.stringify(result.value.snapshot) + '}))');
      }
      if (result.value?.error) {
        await this.controller.runJavaScript('window.dispatchEvent(new CustomEvent("norr-refresh-failed",{detail:' +
          JSON.stringify(result.value.error) + '}))');
      }
    } finally { this.polling = false; }
  }

  private applyTheme(theme: string): void {
    const dark = theme === 'dark';
    this.pageBackground = dark ? '#000000' : '#F7F7F5';
    this.foreground = dark ? '#EEEFE9' : '#20221F';
    const mainWindow = AppStorage.get<window.Window>('norrMainWindow');
    if (!mainWindow) return;
    mainWindow.setWindowSystemBarProperties({
      statusBarColor: this.pageBackground,
      navigationBarColor: this.pageBackground,
      statusBarContentColor: this.foreground,
      navigationBarContentColor: this.foreground
    }).catch((error: BusinessError) => {
      hilog.error(0, 'Norr', 'System bar theme failed (%{public}d)', error.code);
    });
  }

  private resourceResponse(requestUrl: string): WebResourceResponse {
    const response = new WebResourceResponse();
    response.setResponseCode(404);
    response.setReasonMessage('Not Found');
    response.setResponseData('');
    if (!requestUrl.startsWith(ORIGIN + '/')) return response;

    try {
      const path = decodeURIComponent(requestUrl.slice(ORIGIN.length).split('?')[0].split('#')[0]);
      if (path.includes('..') || path.includes('\\') || path.includes('\u0000')) return response;
      const filename = path === '/' ? '/index.html' : path;
      const extension = filename.substring(filename.lastIndexOf('.') + 1);
      const bytes = this.context.resourceManager.getRawFileContentSync('web' + filename);
      response.setResponseData(bytes.buffer as ArrayBuffer);
      response.setResponseMimeType(MIME_TYPES[extension] || 'application/octet-stream');
      response.setResponseEncoding('UTF-8');
      response.setResponseCode(200);
      response.setReasonMessage('OK');
    } catch {
      hilog.warn(0, 'Norr', 'Packaged web resource missing');
    }
    return response;
  }

  onBackPress(): boolean {
    if (this.verifying) { this.finishVerification(null); return true; }
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (error) {
      hilog.warn(0, 'Norr', 'Web navigation unavailable (%{public}d)', (error as BusinessError).code);
    }
    return false;
  }

  build() {
    Stack() {
      if (this.ready) {
      Web({ src: ORIGIN + '/index.html', controller: this.controller })
        .zoomAccess(false)
        .width('100%')
        .height('100%')
        .backgroundColor(this.pageBackground)
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(false)
        .mixedMode(MixedMode.None)
        .javaScriptProxy({
          object: this.bridge,
          name: 'NorrHost',
          methodList: ['setTheme', 'post'],
          controller: this.controller,
          permission: '{"javascriptProxyPermission":{"urlPermissionList":' +
            '[{"scheme":"https","host":"norr.localhost","port":"","path":"/"}]}}'
        })
        .javaScriptOnDocumentStart([{ script: 'window.__NORR_PLATFORM__="harmonyos";', scriptRules: [ORIGIN] }])
        .onInterceptRequest((event) => this.resourceResponse(event.request.getRequestUrl()))
        .onLoadIntercept((event) => {
          const destination = event.data.getRequestUrl();
          if (destination.startsWith(ORIGIN + '/')) return false;
          if (event.data.isMainFrame() && destination.startsWith('https://')) {
            this.context.startAbility({ action: 'ohos.want.action.viewData', uri: destination })
              .catch((error: BusinessError) => {
                this.getUIContext().getPromptAction().showToast({ message: '系统浏览器打开失败，请重试' });
                hilog.warn(0, 'Norr', 'External link failed (%{public}d)', error.code);
              });
          }
          return true;
        })
        .onPageBegin(() => { this.loadError = ''; })
        .onPageEnd(() => {
          clearInterval(this.pollTimer);
          this.pollTimer = setInterval(() => { this.poll().catch(() => {}); }, 2000);
          this.controller.runJavaScript(THEME_SCRIPT).then((theme: string) => {
            hilog.info(0, 'Norr', 'Web theme bridge ready (%{public}s)', theme);
          }).catch((error: BusinessError) => {
            this.loadError = '页面与系统连接失败，请重新加载';
            hilog.error(0, 'Norr', 'Web theme bridge failed (%{public}d)', error.code);
          });
        })
        .onErrorReceive((event) => {
          if (event.request.isMainFrame()) this.loadError = '页面加载失败，请重新加载';
        })
        .onHttpErrorReceive((event) => {
          if (event.request.isMainFrame()) this.loadError = '页面资源加载失败，请重新加载';
        })
        .onRenderExited(() => { this.loadError = '页面已停止运行，请重新加载'; })
      } else if (!this.loadError) {
        Text('正在初始化车辆服务…').fontSize(16).fontColor(this.foreground)
      }

      if (this.verifying) {
        PhoneVerification({ onComplete: (result: string | null, error?: string) => this.finishVerification(result, error) })
      }

      if (this.loadError) {
        Column({ space: 24 }) {
          Text(this.loadError).fontSize(18).fontColor(this.foreground)
          Button('重新加载', { type: ButtonType.Normal })
            .backgroundColor(this.foreground)
            .fontColor(this.pageBackground)
            .onClick(() => {
              this.loadError = '';
              if (this.ready) this.controller.refresh();
              else this.initialize();
            })
        }
        .padding(24)
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor(this.pageBackground)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBackground)
  }
}
