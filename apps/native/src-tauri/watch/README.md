# Norr Apple Watch

SwiftUI 配套 App，加入现有 iPhone 工程并嵌入同一 IPA。应用和 Widget 分别编译、签名；HTML 设计稿在 `docs/design/watch`。

## 构建与预览

在仓库根目录运行 `npm run build:watch`。需要完整 Xcode、watchOS SDK 与 XcodeGen。模拟器运行还需安装 watchOS Simulator runtime，可用官方 `xcodebuild -downloadPlatform watchOS` 下载。

模拟器 App 输出：`target/watch/Build/Products/debug-watchsimulator/NorrWatch.app`。通过 Xcode 的 NorrWatch scheme 运行，或用 simctl 安装到 watchOS 模拟器后启动 `app.norr.ios.watchkitapp`。

本机 Xcode 27.2 的模拟器窗口由 Device Hub（`com.apple.dt.Devices`）管理，路径为 `/Applications/Xcode.app/Contents/Applications/DeviceHub.app`。

启动参数 `--demo` 使用明确标记的固定车辆样例。可体验门锁二次确认、默认 22 °C 空调启停、充电读取、橙色活动入口和超时后的只读核对。演示不会发送车辆请求。默认启动不使用模拟数据，未同步时显示手机登录与同步说明。

`npm run build:watch -- --device` 仅使用真机 SDK 构建。它不等同于个人开发签名，也不会安装到真实手表。真机签名、Watch 安装和个人重签分发需分别验收。

## 执行与状态

- Watch 通过 URLSession 执行服务发现和 gRPC 请求，由系统选择实际网络。WatchConnectivity 用于手机同步授权，不承担车辆指令转发。
- 手机恢复车辆连接、切换当前车辆后的读取成功，以及定时读取完成授权续期时，自动同步当前车辆与有效 access token。相同授权忽略版本时间后去重；设置入口保留手动重试。清除手表授权会暂停自动同步，手动同步可恢复。Watch 授权单独存入 Keychain，组件缓存不含凭据；refresh token 不复制。
- 门锁和空调写入提交一次，持久化请求身份、车辆、动作和发送时间。只有新的车辆观测与目标一致才确认完成；超时、读取失败和旧观测保留待核对。
- 待核对记录按账号与 VIN 隔离，切换车辆后切回可恢复；刷新同车授权不清记录，显式清除授权清当前账号记录。记录不含 token。
- 页面离开不重复发令。首页橙色来自实际锁态和空调状态，发送中不提前切换。
- 开启空调沿用默认舒适温度 22 °C，不提供手动调温。当前车型能力、权限不足与未知值由请求层检查，不将缺失数据显示为零。
- Widget 显示本地快照及新旧提示，按系统机会更新。点击只打开 App，不直接执行车辆控制。

手机使用 WatchConnectivity 的最新 application context 交给系统投递，不是实时镜像，也没有收到回执。手机必须获得运行机会才能续期和产生新的同步包；暂停或被终止时不承诺持续刷新。已提交的包由系统择机投递，Watch 收到新授权后读取车辆。

## 验证边界

原生模拟器点击验收、截图和适用项检查见 [native-qa.md](../../../../docs/design/watch/native-qa.md)。本机演示设备为 `Norr Watch Preview`（Series 11 46mm），UUID `062E7573-E6CE-4B81-A49E-EEA987914961`，已保留在 Device Hub 窗口中。再次打开已安装的演示可运行：

```sh
xcrun simctl launch 062E7573-E6CE-4B81-A49E-EEA987914961 app.norr.ios.watchkitapp --demo
```

后续联调已将当前 Watch 退出 `--demo`，改为正常模式。`--demo` 是手表单端的本地样例，不与 iPhone 状态同步，不能用于验证真实登录态或跨端数据一致性。真实联调需在配对的 `Norr Watch Companion` 登录并恢复车辆连接，成功读取后自动发送授权；“设置 → 账号 → 同步到 Apple Watch”用于手动重试或恢复暂停的同步。同步后两端各自读取车辆服务，操作后的显示更新还取决于刷新与车辆上报时间。

可重复运行 `node apps/native/scripts/check-watch.mjs`，直接编译生产协议、授权和待核对记录模型，验证畸形响应、时间与状态一致性、授权清除及跨车辆恢复。测试范围见 `Tests/README.md`。

2026-11-17 已通过独立 Watch simulator/device SDK 构建、完整 iOS simulator 构建与 `npm run build:ios:unsigned`，输出 `target/ios/Norr_0.1.0_ios-arm64-unsigned.ipa`。包中包含 Watch App 及其 Widget，嵌套 ad-hoc 签名校验和签名脚本回归通过；unsigned IPA 仍需真实开发证书和匹配的描述文件才能安装到真机。

2026-11-17 用户在配对 iPhone 模拟器完成登录后，修复 `sync_watch` 遗漏 Tauri ACL 权限导致的同步拦截。覆盖安装后实际点击同步，Watch 自动进入真实车辆首页，读取到与 iPhone 一致的 31%、130 km 和已锁车状态。授权命令权限回归、完整 simulator 构建和 unsigned IPA 构建通过。模拟器授权同步及真实读取已验证，未发送真实车辆控制指令；watchOS 真机网络、后台调度、续期和安装仍需验证。

当前使用固定 P2 Snow 车图，未同步手机自定义外观；Widget 的真实表盘呈现和全尺寸可访问性仍待设备验证。

40mm 与 Dynamic Type 大字号的逐页覆盖、修复和截图见 [布局补充检查](../../../../docs/design/watch/layout-qa.md)。常规字号的主要信息与操作优先同屏；点击首页电量区进入充电，左上角“更多”提供刷新。演示模式的“更多”提供“大字号预览”开关，真实模式使用系统字号。大字号、错误和待核对信息保留纵向滚动，可通过拖动或 Digital Crown 继续查看。

车图和 Archivo 字体复用已有项目资产，来源及 SHA-256 见 `App/Resources/manifest.json`；原始许可继续适用。SwiftUI 图标采用 SF Symbols。
