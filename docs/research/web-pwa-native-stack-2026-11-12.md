# Hisingen Web、PWA 与原生壳技术栈评估

整理日期为 2026-11-12。调研依据为 2026-11-11 至 2026-11-12 的项目源码检查、官方文档查询与技术栈讨论。

本次更新同步中国区 P2 的最新实现、实车反馈及 1,810 项非 live 测试记录，沿用原有技术栈选择与官方文档引用。未新增跨端真机、浏览器直连或真实车辆写入验证。

本文记录建议方案、已知限制和待验证事项。用户已确定各设备直连厂商，并选择 iPhone 原生壳。当前推荐验证四端统一 Tauri 2，具体框架和迁移实现仍待验证。当前应用采用 SwiftUI／AppKit，车辆请求由用户的 Mac 直接发往厂商服务。

## 推荐结论与用户约束

推荐采用 React + TypeScript 共用前端、Tauri 2 四端宿主和 Rust 本地车辆核心，覆盖 iOS、Android、macOS、Windows。原生鸿蒙另设 ArkTS + ArkWeb 宿主。

用户最初倾向 Web/PWA，随后因 iPhone PWA 登录风险选择套壳，并明确希望各设备独立直连。各端本地完成登录、令牌刷新和车辆读取，长期凭据保存在本机系统安全存储。用户暂时没有苹果开发者账号，iOS 分发仍需安排。

早期 Flutter 推荐基于四端原生应用优先的假设。明确 Web/PWA 优先后，推荐调整为 Web。Flutter 更适合原生应用体验优先、愿意承担各平台构建与分发维护的目标。更换 UI 框架仍需处理厂商登录、通信协议和后台任务限制。

当前选型需要验证以下能力。

- Tauri 在 iOS 和 Android 上承载官方验证码页面、注册所需桥接并正确处理登录回调。
- Rust 车辆核心在四端运行 REST/gRPC、管理网关与 global 凭据的各自用途，并接入各平台安全存储。现有车辆链路的 global 续期不以外层网关 token 未过期为前提。
- 多台设备同时登录、刷新、退出时，厂商会话策略是否造成相互失效。

## 建议技术组合

| 部分 | 建议实现 | 选择条件 |
| --- | --- | --- |
| 共用前端 | React + TypeScript + Vite | 复用页面、图表、交互和展示模型 |
| 本地车辆核心 | Rust，共用 crate | 处理签名、REST/gRPC、令牌生命周期、读取观测、状态合并及命令回读规则 |
| iPhone／iPad、Android | Tauri 2 | 验证登录 WebView，按需开发 Swift／Kotlin 插件 |
| macOS／Windows | Tauri 2 | 复用 Rust 核心，适配菜单栏、托盘和系统存储 |
| 各端持久化 | 系统安全存储与本地数据库 | 凭据在本机保存，历史按设备持久化 |
| 原生鸿蒙 | ArkTS + ArkWeb 宿主 | 加载共用前端，单独实现鸿蒙原生桥接与构建 |

Tauri 官方支持 Linux、macOS、Windows、Android、iOS，移动端插件可以使用 Swift 和 Kotlin。平台支持仍需结合本项目所需插件和协议逐项验证。鸿蒙应单独规划宿主及车辆核心适配。[Tauri 平台范围](https://tauri.app/)、[Tauri 移动插件](https://tauri.app/develop/plugins/develop-mobile/)

前端通过 Tauri commands 调用本机 Rust 核心，由核心直接访问厂商服务。验证码由受限的原生 WebView 完成人机交互并回传结果，原生适配层负责凭据存储、通知和系统集成。长效令牌尽量保留在原生层，界面读取业务结果和会话状态。

### 与手机 Capacitor、桌面 Tauri 方案的比较

两个方案都可以共享 React 界面。统一 Tauri 还可以让手机和桌面编译使用同一份 Rust 车辆核心，适合本次各端直连目标。其代价是将现有 Swift 车辆逻辑移植到 Rust，并验证移动端依赖与插件。

Capacitor 提供移动端插件体系，适合评估已有插件能覆盖的功能。手机采用 Capacitor、桌面采用 Tauri 时，需要维护两套宿主适配。若希望继续共享 Rust 协议核心，还需增加移动端原生集成。[Capacitor 插件](https://capacitorjs.com/docs/plugins)

## Web/PWA 能力与限制

下表保留纯浏览器入口的能力评估。当前主要交付目标为各平台原生壳，PWA 的独立登录与车辆直连仍待验证。

| 能力 | 评估 | 实现影响 |
| --- | --- | --- |
| 车辆概览、电量、续航、图表、设置 | 适合 Web | SwiftUI 界面需重写，数据模型和业务规则可移植 |
| 厂商 REST 直连 | 取决于 CORS、Cookie 和认证策略 | 全部接口的浏览器可用性尚未实测，应预留服务端或原生网络适配 |
| 当前车辆 gRPC | 浏览器与原生 gRPC 存在协议差异 | 服务端提供业务 API 或 gRPC-Web 转换，壳端也可使用原生协议实现 |
| 中国区验证码与国际区登录 | 存在跨域页面、桥接和授权回调依赖 | 优先验证完整登录链路 |
| 关闭页面后持续采集 | 无法保证固定频率执行 | 由服务器或常开设备运行采集任务 |
| 离线查看 | 可以缓存车辆快照和历史 | 界面显示数据时间及过期状态，新的车辆数据仍需联网 |
| 历史存储 | IndexedDB 可承担本地缓存 | 长期记录应有服务端持久化或导出备份方案 |
| 菜单栏、托盘、开机启动 | 缺少统一的跨浏览器实现 | 通过原生宿主补充 |

安装 PWA 后仍受浏览器同源策略约束。Service Worker 会被浏览器停止，后台同步适用于受限任务，无法承诺持续车辆轮询。[同源策略](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)、[PWA 离线与后台运行](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)

gRPC-Web 使用与原生 gRPC 不同的协议。前端安装 gRPC-Web 库后，仍需厂商端点支持该协议或配置转换服务。通用原生 HTTP 插件也需要单独验证流式响应、gRPC 状态和 trailers。[gRPC-Web 协议](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md)、[Capacitor HTTP](https://capacitorjs.com/docs/apis/http)、[Tauri HTTP](https://tauri.app/plugin/http-client/)

浏览器存储受到配额和驱逐策略影响。持久化授权可以改善保留条件，历史记录仍应具有备份或恢复途径。[浏览器存储配额与驱逐](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

## 登录是首要验证项

### 中国区滑块与短信登录

当前原生实现用 WKWebView 加载官方验证码页面，注册 `dispatch` 消息处理器，并注入 `window.chromium` 桥接。用户完成验证后，应用接收结果并请求发送短信。此前用户已实测收到短信并完成车辆读取。验证码视图源码（旧工程 `Sources/Hisingen/UI/Settings/PolestarChinaVerificationView.swift`）

浏览器中的共用前端无法向其他域名的 iframe 注入同样的桥接。即使验证码页面允许嵌入，也需要页面主动提供可用的 `postMessage` 或 Web 回调。服务端可以处理签名和网络请求，但浏览器获取验证结果的机制仍需独立打通。

各平台宿主可以使用原生 WebView 桥接，分别验证页面的 User-Agent 分支、回调格式和生命周期。当前优先验证 iOS 和 Android 壳。纯 Web，尤其是 iPhone PWA，独立完成这条链路的可行性尚未实测。

此前讨论过壳端授权后配对 Web 的方案。当前各设备独立直连的选择意味着每台设备需要具备自己的登录与会话恢复路径。

### 国际区与 Volvo

国际区 Polestar 当前通过 WKWebView 拦截跳转到厂商域名的授权回调。Web 迁移需要可配置的授权回调或其他受支持的接入方式。Volvo 的浏览器 OAuth 也需重新核对应用注册、回调地址、客户端凭据和令牌兑换路径。Polestar 网页登录源码（旧工程 `Sources/Hisingen/Services/Security/PolestarWebSignInPresenter.swift`）、认证架构（旧工程 `docs/api/authentication.md`）

### 已实现能力与现有边界

以下状态针对当前 macOS 原生实现的中国区 P2／ICUP C3 路径。它们提供迁移参考，不能直接证明同一功能已在 Web、Tauri 或 P4 上可用。中国区 API 源码（旧工程 `Sources/Hisingen/Services/API/PolestarChinaAPI.swift`）、适配记录（旧工程 `docs/research/polestar-cn-adaptation/README.md`）

| 能力 | 当前证据 | 迁移边界 |
| --- | --- | --- |
| 滑块、短信登录、服务发现、车辆列表 | 已完成真实账号联调 | 各宿主仍需验证官方验证码桥接及来源、重复回调和取消处理 |
| global token 续期 | 已实测不带外层 Authorization 刷新成功，刷新后可读取车辆列表 | 已删除外层 access token 到期即阻止 global 刷新的本地策略；完整有效期、撤销和多设备互相影响仍待验证 |
| P2 遥测 | 电池、车身、空调、目标电量、电流上限、定位、健康、里程/行程、空气质量、软件版本与状态已取得真实数据 | 不代表所有子字段都有值，也不代表其他车型或账号具有相同权限 |
| 核心远程控制 | 门锁、空调、车窗、尾门、鸣笛闪灯、充电设置等已接入，用户确认空调控制成功 | 按车主及能力标志门控，其余写操作仍待逐项实车验证 |
| 空调定时 | 读取、新增、修改、删除已接入；用户删除后，新版真实回读与本地快照均为 0 条 | 删除已有专属列表回读证明；新增/修改仍为 acknowledged 后自动刷新，未逐字段确认目标值 |
| 充电日程 | 已接入读取与全局窗口设置；成功空列表误补旧值已修复，模拟回归通过 | 中国区完整列表含全局和地点日程，两路都成功才可用空列表清除旧值；设置后的目标字段确认尚未补齐，最新修复未实车验证 |
| 电池与车身订阅 | 两种订阅均收到真实初始数据 | 长期推送、重连和前后台恢复仍待验证 |
| 其余边界 | 当前 Dashboard 连网状态端点返回 UNIMPLEMENTED；充电地点/地点日程写入、独立鸣笛、天气未接入 | 端点不可用或适配尚未实现，不等于车辆确定不支持；P4 相关 HUANFU/Geely 分支需独立适配 |

外层网关 token 的刷新仍未实现，但现有车辆访问和内层续期已不依赖其持续有效。应在 global 刷新授权本身过期、被撤销或服务要求重新验证时进入登录恢复，不能仅按外层到期时间强制短信登录。该结论限于已核对的车辆链路，不推断其他网关业务接口的鉴权要求。刷新鉴权实测（旧工程 `docs/research/polestar-cn-adaptation/refresh-auth-verification.md`）

定时列表曾有两类客户端缺陷：编辑器漏接单独存放的空调定时；成功返回空列表后，合并逻辑又补回旧列表。空调定时的修复已通过真实空列表回读核对，充电日程的同类修复已完成模拟回归。最新完整非 live 测试为 1,810 项；这不替代真实写入验证。OTA 已有代码接入，但不在本轮修复与验证范围内，不将其列为已完成实车验证的能力。P2 扩展记录（旧工程 `docs/research/polestar-cn-adaptation/p2-expansion-20261112.md`）、删除后刷新修复（旧工程 `docs/research/polestar-cn-adaptation/p2-timer-refresh-20261112.md`）、充电日程修复与确认核查（旧工程 `docs/research/polestar-cn-adaptation/p2-charge-schedule-empty-20261112.md`）

### 迁移必须保留的状态与命令语义

Rust 核心需移植的范围包括现有状态规则，不能只复刻接口地址和界面。

- 使用服务发现返回的 C3 与 C3 LBS 地址，并保持中国区 Chronos 路由与国际区的差异。
- 分开表示未请求、读取失败、缓存、成功有值和成功空列表；记录具体端点的观测时间。部分读取成功不能证明完整集合为空。
- 保留能力字段缺失与明确 false 的差别；缺失显示尚未检查，不能套用车型推测开放控制。
- 区分服务接受、送达、完成和独立回读确认。删除以命令之后取得的专属列表和目标 ID 消失为证；新增/修改与充电窗口设置的字段确认缺口继续作为未完成项迁移。
- 保留账号、区域和 VIN 隔离、迟到结果丢弃，以及同一 VIN 的命令并发限制。网络或鉴权结果不明时不自动重放车辆写请求。

应把这些分支纳入共享核心的模拟 transport 回归。迁移到新框架不会自动补齐结果确认或长期会话能力。状态合并（旧工程 `Sources/Hisingen/Domain/SnapshotMerging.swift`）、命令确认（旧工程 `Sources/Hisingen/Domain/CommandReceipt+Confirmation.swift`）

### Web 演示与原生实测分开验收

仓库 `apps/web/` 当前使用演示数据和模拟交互。中国区 P2 的核心控制和定时已有模拟流程，中国区 P4 能力适配待验证。Tauri／Rust 方案及纯浏览器直连仍需各自验证，不能用演示页面的限制替代原生能力结论，也不能用原生联调结果证明跨端已迁移完成。[Web 演示说明](../../apps/web/README.md)、[演示状态与命令门控](../../apps/web/src/workspace.tsx)

Tauri 移动端登录、四端 Rust gRPC、鸿蒙登录和跨端长期会话稳定性均待验证。纯浏览器的 CORS 与登录可行性也仍待验证。

## 后台采集、通知与账号分发

iOS/iPadOS 16.4 起，添加到主屏幕的 Web App 可以在用户主动操作并授权后接收 Web Push。此能力无需加入 Apple Developer Program。充电状态变化的检测仍需厂商事件或服务器／常开设备采集支持。[WebKit Web Push 说明](https://webkit.org/blog/13878/)

Android 原生应用的前台服务受后台启动和部分服务类型运行时长限制。鸿蒙长时任务也有明确的适用场景和系统约束。固定频率的全天采集应优先交给服务器或常开设备。[Android 前台服务启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[Android 服务超时](https://developer.android.com/develop/background-work/services/fgs/timeout)、[鸿蒙长时任务](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/continuous-task/)

各设备直连时，每台设备只能记录自身实际取得的数据。手机进入后台后的采样频率受系统调度影响，桌面电脑睡眠、断网和退出也会造成采集间断。历史完整性应按实际采样时间呈现。

手机后台任务由操作系统调度，套壳后仍需遵守平台限制。检测到充电状态变化时可发本地通知。应用挂起后的持续监测和远程通知投递需要另行设计事件来源与推送链路。[Apple 后台任务策略](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app)

iPhone 原生壳可通过 Xcode 在个人设备测试。通过 TestFlight 或 App Store 分发需要 Apple Developer Program 会员。[Apple 开发者账号](https://developer.apple.com/help/account/basics/about-your-developer-account)

macOS 原生壳仍需按 macOS 应用的方式构建和分发。Developer ID 签名与公证涉及 Apple Developer Program。Windows 安装包需考虑签名和 SmartScreen 信誉。鸿蒙工程需要对应的证书、签名配置及调试设备管理。[Apple Developer ID](https://developer.apple.com/developer-id/)、[Windows SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)、[鸿蒙调试证书](https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-debugcert-0000001914263178/)

## 原生鸿蒙适配

本文的鸿蒙目标为 HarmonyOS NEXT／5 及后续原生应用体系。

ArkWeb 提供 Web 与 ArkTS 原生能力的双向通信，可据此实现共用前端加原生宿主的混合应用。React 页面在 ArkWeb 内运行，ArkTS 侧维护平台适配代码。若目标进一步要求全部界面由 ArkUI 原生组件绘制，则需要单独开发鸿蒙界面。[ArkWeb 混合开发](https://developer.huawei.com/consumer/cn/doc/best-practices-V14/bpta-arkweb_rendering_framework-V14/)

| 适配内容 | 实现方向 | 验证状态 |
| --- | --- | --- |
| 共用界面 | ArkWeb 加载前端资源 | 布局、输入、路由和 Web API 待真机验证 |
| 验证码 | 独立验证页面与 JSBridge | 官方页面在鸿蒙下的回调分支待验证 |
| 敏感会话 | Asset Store Kit 等系统存储 | 需实现并验证恢复与退出清理 |
| 通知 | 首先评估本地通知，远程推送可接入 HarmonyOS Push Kit | 远程推送需要事件来源和服务端通道 |
| 本地直连 | 原生网络与 gRPC 适配 | 需单独评估协议支持与维护成本 |
| 构建分发 | 鸿蒙宿主工程、签名与真机测试 | 待实施 |

ArkWeb 支持 JSBridge，Asset Store Kit 提供短敏感数据安全存储。HarmonyOS Push Kit 需要按其接入流程配置，客户端与服务端均涉及开发。[ArkWeb JSBridge](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkweb-ndk-jsbridge/)、[Asset Store Kit](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/asset-store-kit-overview/)、[Push Kit 接入](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/push-gettingstart)

## 凭据归属与各设备直连

用户已选择各设备直连厂商，与 ADR-0002 的本地持有凭据方向一致。每台设备本地保存会话，并通过共用车辆核心直接访问厂商服务。现有架构决定（旧工程 `docs/adr/0002-no-hisingen-backend.md`）

| 部署方式 | 优点 | 维护责任和限制 |
| --- | --- | --- |
| 项目方托管后端 | 多端共享数据、集中采集与推送 | 持有用户车辆凭据，需要用户隔离、存储保护、备份和服务运维 |
| 用户自部署 NAS／服务器 | 用户掌握凭据，支持多端访问 | 需要部署与安全远程访问配置 |
| 桌面宿主充当本地服务 | 接近当前设备本地持有凭据的模式 | 手机使用依赖电脑在线及安全连接 |
| 各壳端独立直连，当前选择 | 每端本地持有会话，四端可共用 Rust 协议核心 | 存储与系统能力分别适配，后台采集受设备状态影响 |

长期凭据接入各平台系统安全存储，历史保存在本地数据库。验证码页面的桥接仅暴露验证所需能力，并校验来源和回调所属会话。

共用代码在每台设备独立运行。账号、历史与设置的跨设备同步需要单独设计。厂商是否允许多个会话长期共存、刷新或退出是否影响其他设备，需通过多设备联调确认。

## 迁移验证顺序

1. 在 iOS 和 Android Tauri 宿主验证完整滑块登录，核对来源、取消、重复回调和原生桥接。
2. 将最小车辆协议链路移植到 Rust，在四端读取车辆列表、电量与续航，核对服务发现、C3/C3 LBS 路由、gRPC 状态、trailers 及车辆上报时间。
3. 接入系统安全存储，验证重启恢复、global 刷新轮换持久化与退出清理，保留已验证的不依赖外层 Authorization 的续期路径。
4. 迁移读取观测、空列表合并、能力门控和命令回读，用模拟 transport 复现已修复的定时问题；保留新增/修改与充电窗口结果确认的未完成标记。真实写入联调另行安排。
5. 验证 global 授权的长期有效性、撤销恢复及多设备会话共存；按实际接口用途核对外层网关会话，明确重新登录的触发条件。
6. 验证本地历史、前后台恢复、采集间断与本地通知。
7. 根据结果迁移图表、设置、菜单栏和托盘，并单独验证鸿蒙宿主及协议适配。

前两项结果用于确认统一 Tauri 的实现成本和四端可用性。中国区 P2 已有的读取与控制代码可作为移植参考；跨端验收需分别记录模拟通过、真实读取通过和真实写入通过，不再将中国区车控整体列为尚未实现。

## 来源与检查范围

讨论来源为项目中的技术栈讨论及“调研登录流程并输出流程图”记录。相关讨论已在原调研时读取。

本文引用的是原调研时查阅的官方文档，以及本次核对的本地实现与联调记录；本次未重新验证外部平台政策或框架支持。实施时需要按选定版本复核。本文未给出未经测量的性能、包体、代码复用比例或工期数字。

文案按项目 antislop 的 during 模式检查。以下为本次 Markdown 文档适用项的验收结果，界面布局、动效和交互运行项不适用。

- Hard Gate PASS。原平台能力保留官方来源及复核边界，最新中国区能力附本地源码和核验记录；macOS 实测、Web 演示和待验证的跨端链路分开说明。1,810 项仅指已有非 live 测试记录，无新增实车或性能主张。本次没有新增界面、资产或交互控件。
- Purpose Gate PASS。能力、平台与部署比较采用表格，便于核对选择条件。
- Liveliness PASS。内容围绕 Hisingen 的验证码桥接、双层令牌、gRPC 与凭据归属展开，语气遵循项目技术文档的具体、克制表达。视觉参数不适用于本文。
- Craftsmanship PASS（本次 Markdown 修改范围）。已逐个核对本地引用目标与文档索引入口，保留未实现及待验证项。完整仓库链接检查仍受工作区中未纳入 Git 的既有链接目标影响，未修改 Git 索引或忽略规则来绕过。
