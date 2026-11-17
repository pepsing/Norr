# Watch 原生验收记录

2026-11-17，Xcode 27.2，watchOS 27.2（24S118），Apple Watch Series 11 46mm。Device Hub 中的隔离设备为 `Norr Watch Preview`，已与新建的 `Norr Watch Companion` iPhone 17 配对。没有使用原有设备的账号、凭据或车辆。

本记录是最初的 46mm 默认字号验收，不表示所有页面状态和尺寸都已覆盖。后续反馈触发的 40mm / 大字号修复、逐页覆盖范围和截图见 [布局补充检查](layout-qa.md)。原配对 Watch 的真实授权同步已完成，结果见下方补充记录。

## 已运行的检查

- SwiftUI 首页、空调、门锁、充电页面均已在模拟器运行。首屏显示复用车图、Archivo 数字和完整门锁 / 空调入口；长页面通过触控滑动访问后续内容。
- 演示空调以 22 °C 默认舒适温度开启，回读后显示运行状态；关闭后恢复关闭状态。没有手动调温控件。
- 解锁、锁车均经确认页；解锁取消保持原锁态。确认解锁后显示已解锁，确认锁车并核对后显示已锁车。
- 首页空调和门锁独立变橙；两者活动时同时橙色，锁车和关闭空调后分别恢复深灰。
- 开启“模拟请求超时”后提交锁车，原锁态保持不变、写入禁用；显示“结果待核对”和只读核对入口。核对后才更新状态，没有自动重发。
- 充电页面显示 78%、7.2 kW 与 90% 演示值；页面刷新和首页刷新显示未连接车辆的提示。重置演示会清除操作反馈。
- 不带 `--demo` 启动时显示 iPhone 登录与同步引导，没有伪造车辆读数。验收结束恢复 `--demo` 首页，保留窗口供用户体验。

## 构建与测试

- `npm run build:watch` 与 `npm run build:watch -- --device` 通过。
- 完整 iOS simulator 构建与 `npm run build:ios:unsigned` 通过。最终 IPA、iOS simulator App、独立 Watch simulator App 均已包含最终布局、Asset Catalog 车图和按账号 / VIN 保存的待核对记录。
- 包内包含 Watch App 与 Watch Widget，companion 标识、平台及嵌套 ad-hoc 签名检查通过；签名脚本回归 2/2 通过。
- `node apps/native/scripts/check-watch.mjs` 通过：协议畸形、截断、大小边界、溢出、NaN；新旧观测、状态不一致、缺失时间；授权清除重启；切车切回、授权续期、账号隔离及旧记录迁移。
- `npm run typecheck` 与 `git diff --check` 通过。

## 截图

- [最终首页](native-preview.jpg)
- [两个入口活动](native-home-active.jpg)
- [锁车且空调关闭](native-home-idle.jpg)
- [空调运行](native-climate.jpg)
- [解锁确认](native-unlock-confirm.jpg)
- [超时核对](native-timeout.jpg)
- [未同步引导](native-unconfigured.jpg)

## Delivery Gate

- Hard Gate PASS：复用已有车图、字体与图标；演示有明确标记；主要操作首屏完整，确认与超时页面可滚动；实际构建和上述点击流程通过。原生系统导航及 Button 保留可访问性语义。
- Purpose Gate PASS：车图、读数和操作按使用顺序排列；暖橙区分活动状态和主操作，深色文字保证橙底可读；SF Symbols 对应门锁、风扇和充电，不加装饰图形。
- Liveliness PASS：沿用 DESIGN.md 的 ENERGY 2 / RHYTHM 2 / MOTION 1、Snow P2 侧面车图、Archivo 数字及 Norr 暖橙，首页读数和详情主操作分别形成焦点。
- Craftsmanship PASS：已运行模拟器并检查导航、确认、取消、启停、刷新、重置与超时核对；正常模式未配置时无样例冒充数据；原生布局修复了车图不显示及首页入口被挤出首屏的问题。

## 真实授权同步补充验收

2026-11-17，用户在配对 iPhone 模拟器完成真实登录后，同步按钮报 `Command sync_watch not allowed by ACL`。原因是 `sync_watch` 未列入 Tauri `main-app` 权限，调用在手机端被拦截，尚未到达 WatchConnectivity。现已补齐权限，并扩展授权命令回归，验证本地主窗口允许调用，远程来源及其他窗口拒绝调用。

覆盖安装保留登录态后，实际点击“设置 → 账号 → 同步到 Apple Watch”。Watch 在正常模式下自动从未配置引导进入车辆首页，读回与 iPhone 一致的 31% 电量、130 km 续航和已锁车状态；这证明本次配对模拟器的授权传递与真实车辆读取成功。未确认或发送真实车辆控制指令。截图见 [真实同步结果](native-real-sync.png)。手机提示仍表示提交系统，并非 Watch 收到授权的回执。

权限回归 `cargo test -p norr --lib authorization_commands_are_allowed_only_from_the_local_main_window --release`、完整 iOS simulator 构建及 unsigned IPA 构建通过；模拟器已安装修正版。

## 尚未验收的环境

先前控制流程使用固定演示数据，后续真实联调仅验证授权同步与读取，不证明真实车辆控制成功。真机 HTTP/2 gRPC 与响应 trailers、真机授权传递、系统网络选路、后台恢复、VoiceOver、全部表壳尺寸及极端字号、真实表盘上的 Widget、开发证书和个人重签安装仍待验证。Widget 本轮完成编译及缓存逻辑，未宣称表盘运行验收通过。首版不复制 refresh token；iPhone 成功读取车辆并续期后自动同步，手机未获得运行机会时仍可能到期。当前车图固定复用 P2 Snow，未同步手机自定义外观。

## 自动同步补充验收

2026-11-17，手机在成功读取当前车辆后自动提交授权，包括恢复连接、切车后的读取和定时读取中的续期。WatchConnectivity 保存最新授权上下文，忽略仅版本变化的重复包；账号、车辆、token 或有效期变化会重新提交。手动清除暂停后续自动提交，手动同步恢复。重新登录提交清除事件，防止旧账号授权继续留在手表。

实际配对模拟器验证：Watch 起初提示授权到期；在 iPhone 恢复车辆读取后，未点击同步按钮，Watch 的到期提示消失并读回空调关闭状态，首页显示 31%、130 km。这验证了本轮自动授权传递和真实读取。未发送真实车控指令，切账号和多车切换仅经过离线策略测试，尚未做真实账号验收。

最终 Watch simulator、完整 iOS simulator 和 unsigned IPA 均构建成功，并覆盖安装到配对设备。自动同步策略与既有 Swift 协议 / 生命周期测试、TypeScript 和差异格式检查通过。当前 Watch 为 Series 11 46mm；独立 40mm 设备仅作布局演示，不复制真实授权。

系统投递可能延迟；手机 UI 的成功提示只代表已提交，不是 Watch 收件回执。自动续期依赖手机获得运行机会，不承诺 App 被终止或长期挂起后仍持续同步。
