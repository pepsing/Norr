# Norr 鸿蒙宿主

此目录包含原生 HarmonyOS 的 ArkTS + ArkWeb 工程，应用标识为 `app.norr.harmonyos`。Release 包加载共用原生客户端界面，通过 N-API 调用 `crates/vehicle-core` 的中国区 Polestar 生产服务。登录与实际车辆数据需要用户在应用内完成账号验证。

宿主随包携带 `../web` 的生产构建、字体和车辆图片，通过本地资源拦截加载 `https://norr.localhost/`。深浅主题通过限定来源的 Web / ArkTS 桥接同步到系统栏。页面载入失败时提供重新加载入口。应用图标复用 `../native/src-tauri/icons/icon.png`，资源来源记录在 `manifest.json`。

界面沿用 `DESIGN.md` 的 ENERGY 2 / RHYTHM 2 / MOTION 1。共用页面保持各端视觉一致，系统栏随主题变化，Web 内容使用系统安全区避免遮挡。

## 构建

开发环境为 Apple Silicon Mac、DevEco Studio 26.0.0 Release 与内置 HarmonyOS SDK 26.0.0.105。当前最低兼容版本设为 HarmonyOS 5.1.0 / API 18，目标真机为 Pura 80 Pro，完整系统版本及真机兼容性待核对。

在仓库根目录执行以下命令。脚本先交叉编译 Rust 静态库，再构建共用前端并复制资源，最后调用 DevEco 自带的 OHPM、CMake 与 Hvigor 打包 Release HAP。

```sh
npm ci
rustup target add aarch64-unknown-linux-ohos
npm run build:harmonyos
```

默认工具目录为 `/Applications/DevEco-Studio.app/Contents`。安装位置不同时，设置 `DEVECO_STUDIO_HOME` 指向对应 `Contents` 目录。`DEVECO_SDK_HOME` 可覆盖 SDK 根目录。

构建从环境变量或仓库本机 `.env.secrets` 读取 `NORR_POLESTAR_CN_SIGNING_KEY`，沿用其他原生客户端的登录配置。凭据文件应保留在本机受控目录。

Release 包输出为 `target/harmonyos/entry-default-unsigned.hap`，包含 ARM64 原生库。在 DevEco 中打开本目录即可继续开发。启动模拟器后可使用 SDK 自带的 `hdc` 安装，存在多台设备时用 `-t` 指定目标。

```sh
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc list targets
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc install target/harmonyos/entry-default-unsigned.hap
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc shell aa start -a EntryAbility -b app.norr.harmonyos
```

真机安装需要在 DevEco 配置包含目标设备的 HarmonyOS 调试签名，再安装生成的签名包。签名文件与密码保存在本机。

## 原生接入

- ArkWeb 通过限定本地来源的异步桥接调用 Rust，共用手机号登录、车辆读取、能力判断、命令回执与回读确认逻辑。
- 手机验证码使用单独的官方验证 Web 页面，验证结果经原生桥接传给共享登录核心。手机号、验证码和密码由用户输入。
- Asset Store 保存随机 AES-256-GCM 密钥，账号会话与设备标识保存在应用私有目录的加密文件中。启动时验证设备标识的加密写入和读取。
- 历史备份、SQLite 记录和报表复用已有原生模块。文件选择、导出、系统身份确认、前台定时刷新与回到前台刷新已接入 ArkTS。
- 系统通知与桌面卡片待接入，界面按平台能力禁用通知设置。

模拟器已完成真实短信登录并显示 P2 车辆概览。其余车辆项目、备份选择、身份确认与前后台恢复需要继续逐项实测。真机用于后续验收安全存储与实际车辆控制。当前范围对齐共用核心的中国区 P2 能力，P4 HUANFU 服务接入列在共用核心待办中。

## 环境准备

2026-11-17 已确认 DevEco、内置 SDK、Native Clang、`hdc`、`ohpm` 与 `hvigorw`，并安装 Rust 的 `aarch64-unknown-linux-ohos` 目标。工具使用完整路径调用。

Rust 车辆核心与新宿主已完成 OHOS Release 编译，网络库采用与 Android 相同的 WebPKI 根证书配置。C++ N-API 通过异步任务调用 Rust，避免阻塞界面线程。

## 本轮验证

2026-11-17 创建并启动 `Norr_Phone_API18` 本地模拟器，使用 HarmonyOS 5.1.0 / API 18、ARM64、1260 × 2720、4 GB RAM 与 6 GB 存储。Pura 80 Pro 真机测试待连接设备后开展。

- `npm run build:harmonyos` 通过，最新 Release HAP 为 33,677,141 字节，包含 274 项共用 Web 资源、`libentry.so` 与 `libc++_shared.so`。
- `npm test --workspace @norr/web` 的 20 项测试通过。
- `npm run check:native` 的 42 项测试通过。
- `hdc` 覆盖安装 Release HAP 和启动 `EntryAbility` 成功，日志确认原生核心就绪、加密存储读写成功、登录配置存在及浅色主题桥接就绪。
- DevEco ArkUI 检查器已显示实际运行的「连接你的 Polestar」页面及登录入口。
- 用户此前已在预览包中确认深浅主题切换正常。当前修复包由用户完成真实短信登录，并确认验证弹框自动关闭、登录成功。检查器已显示 Polestar 2 车辆概览，电量 31%、续航 130 km。

首次真实登录发现滑块验证成功后弹框持续显示。核对官方页面脚本发现，默认原生回调按 Android / iOS User-Agent 分支处理，鸿蒙未进入这两个分支。现使用官方 `from=webview` 回调，通过同源、同窗口的 `message` 事件交给 ArkTS。弹框结束回调放在清理操作的 `finally` 中，避免 WebView 停止异常阻断关闭。诊断日志仅记录桥接就绪、验证结果接收与弹框关闭状态。

`node --test apps/harmonyos/scripts/verification.test.mjs` 的 4 项回归通过，覆盖官方 WebView 模式、同源与同窗口限制、重复注入和无效消息。修复版 Release 已重新构建、覆盖安装并启动。用户复测确认弹框关闭和登录成功，运行日志依次记录桥接就绪、验证结果接收、弹框关闭。[官方验证页面](https://h5.app.polestar-auto.com/account-components/auth-slider/index.html) · [官方回调脚本](https://h5.app.polestar-auto.com/account-components/jsbridge.js)

本轮适用项检查覆盖共用登录入口、验证码回调修复、构建、模拟器登录与车辆概览读取。其余完整交互验收待完成。

- Hard Gate PASS。用户完成滑块验证与真实登录，弹框已关闭，检查器显示 P2 车辆概览及读数，系统通知呈现明确的能力限制。
- Purpose Gate PASS。限定来源的桥接承载原生接口，官方验证页面承载短信验证，加载错误提供重试操作。
- Liveliness PASS。沿用 ENERGY 2 / RHYTHM 2 / MOTION 1、Archivo 与现有间距，登录入口保持单一操作焦点。
- Craftsmanship PASS。Release 构建、包校验、20 项前端测试、42 项原生测试、4 项验证桥接回归、模拟器覆盖安装及原生存储启动检查通过。真实登录由用户确认，车辆概览通过检查器核对。

[官方安装说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-software-install/) · [Rust OHOS 配置](https://doc.rust-lang.org/rustc/platform-support/openharmony.html) · [自动签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto/)

[开发进展](../../docs/PROGRESS.md)记录最新测试包、实际验证范围与下一步工作。

[鸿蒙适配研究](../../docs/research/web-pwa-native-stack-2026-11-12.md#原生鸿蒙适配)
