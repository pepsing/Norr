# iOS 打包与分发

从此次 P4 更新开始，标准 Norr 构建默认包含中国区 Polestar 4 的车况读取、定位、xchanger 控制和诊断日志。GitHub Releases 提供标准未签名 IPA；TestFlight 使用原有 `app.norr.ios` 应用记录，保留 P2、小组件、Siri 与 Watch 包。Watch 的独立车辆接口仍仅支持 P2。独立 P4 Build 6 保留为此前侧载测试记录。

| 用途 | 构建入口 | 应用标识 | 产物或安装位置 |
| --- | --- | --- | --- |
| 本地模拟器 | `npm run build:ios` | `app.norr.ios` | `target/ios/Norr.app` 和 ARM64 模拟器 ZIP |
| 本地标准版真机 | `npm run build:ios:unsigned` | `app.norr.ios` | `target/ios/` 下带 Watch、无 Watch 两份未签名 IPA |
| 本地 P4 控制与日志 | `npm run build:ios:p4` | `app.norr.ios.p4test` | `target/ios/Norr-P4-Controls_0.1.0_build6_ios-arm64-unsigned.ipa` |
| GitHub 标准版 | Actions → Release packages → Run workflow | `app.norr.ios` | GitHub Release 附件及 Actions artifacts |
| TestFlight 标准版 | 本机签名归档 → Xcode Organizer → App Store Connect | `app.norr.ios` | App Store Connect 的 TestFlight 标签页 |

## 本地构建

在装有完整 Xcode、Node.js 22.12+ 和 Rust 的 Mac 上，从仓库根目录执行 `npm ci`。真机构建先运行 `rustup target add aarch64-apple-ios`，模拟器构建使用 `rustup target add aarch64-apple-ios-sim`。然后运行表中对应的 npm 命令。

标准版从同一次真机归档生成两份 IPA。文件名以 `ios-arm64-unsigned.ipa` 结尾的包含 Watch App 和手表小组件，以 `ios-arm64-no-watch-unsigned.ipa` 结尾的保留 iOS 小组件、Siri 和快捷指令，适合用 AltStore Classic 安装。[自助签名与安装](ios-self-signing.md)

P4 控制包使用独立的应用标识和钥匙串服务。Build 6 的包信息为 `0.1.0 (6)`，目标平台是 ARM64 iPhoneOS。脚本移除 Watch、扩展、App Intents 元数据、代码签名和描述文件，生成待自行签名的 IPA。该包使用完整车辆界面与 xchanger 适配器，包含 21 个控制动作，按当前账号能力决定开放范围；实车执行仍待验证。[打包脚本](../apps/native/scripts/finalize-ios.mjs) · [P4 实测范围](plans/polestar4-compatibility.md)

## GitHub Actions 与 Releases

普通 PR 和推送到 `main` 的代码更新触发检查。发布包由 `Release packages` 在 `main` 上调用构建工作流生成。定时任务每天北京时间 03:20 检查待发布提交。手动发 iOS 测试版，在 **Actions → Release packages → Run workflow** 选择 `main`，留空 `version` 并选择 `platform=ios-ipa`。发布脚本会先判断该平台是否有待发布的提交。正式发行时填写正式版本号，并选 `all`。[发布工作流](../.github/workflows/release.yml) · [发布入口](https://github.com/pepsing/Norr/actions/workflows/release.yml)

发布成功后，在 Releases 下载标准版 IPA 和 `SHA256SUMS.txt`。Actions 同时将两个真机产物保存 14 天，名称分别为 `Norr-ios-arm64-unsigned` 和 `Norr-ios-arm64-no-watch-unsigned`。GitHub 矩阵构建默认启用 P4 的标准版，发布终点是 GitHub Releases。TestFlight 另外从同一源提交进行本机签名归档和上传。[构建矩阵](../.github/workflows/build.yml) · [下载 Release](https://github.com/pepsing/Norr/releases)

## TestFlight

2026-11-19，本机 Xcode Organizer 记录了标准版 `app.norr.ios` 的一次成功上传（`Uploaded to Apple`）。归档中的主 App、iOS 小组件、Watch App 和手表小组件均为 `0.2.1 (1018)`。该构建在 2026-11-23 的 App Store Connect 中显示正在测试。本次更新沿用该 App 的测试组，上传及审核状态以 TestFlight 页面为准。

1. 在 App Store Connect 选定与归档 Bundle ID 匹配的 App。为本次上传准备新的构建号，核对主 App 与嵌入扩展的版本和构建号一致。仓库的版本脚本会修改工作副本中的版本配置。[版本脚本](../scripts/release/version.mjs)
2. 在 `apps/native/src-tauri/gen/apple/` 的 Xcode 工程中核对主 App、扩展的签名团队和 App Groups。使用标准版 `norr_iOS` scheme，从 `apps/native/` 运行 `npm exec -- tauri ios build --target aarch64 --archive-only` 生成 iPhoneOS Release 归档。产物在 `apps/native/src-tauri/gen/apple/build/norr_iOS.xcarchive`。
3. 用 Xcode 打开这份 `.xcarchive`，在 Organizer 中点 **Distribute App → App Store Connect → Upload**。上传使用 App Store Connect 分发方式。仓库检入的 `ExportOptions.plist` 用于 `debugging` 导出。[Xcode 分发说明](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases) · [Apple 上传说明](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
4. 等 Apple 处理完构建，在 **App Store Connect → TestFlight** 按版本和构建号选中它，填写测试内容并分配测试组。邀请团队外的朋友时使用外部测试组，按页面提示提交 Beta App Review，通过后发送邀请。构建是否已向朋友开放，以该组在 TestFlight 的状态为准。[外部测试邀请](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)

本次 TestFlight 使用标准包与默认 `polestar4` 特性，不使用 `--polestar4-test`。标准特性启用服务适配器但不改变应用标识、钥匙串空间或扩展。独立测试包脚本会在归档后改写标识并移除扩展，仅供侧载。

## 中国区登录配置

本地标准版和 P4 控制实测版要求中国区登录配置 `NORR_POLESTAR_CN_SIGNING_KEY` 与 P4 签名配置 `NORR_XCHANGER_APP_SECRET`。构建脚本优先读取环境变量，缺省时从仓库根目录的 `.env.secrets` 读取同名项。GitHub 的 iOS 发布任务从 Actions secrets 取得这两个值，为当次作业生成临时配置，作业结束时清理。[本地构建](../apps/native/scripts/build.mjs) · [Xcode 构建脚本](../apps/native/scripts/ios-xcode.mjs) · [GitHub iOS 作业](../.github/workflows/build.yml)

旧 P4 Build 5 为 Norr 预留了可选的公开客户端标识 `NORR_P4_PARTNER_CLIENT_ID`，来源和优先级与上述登录配置相同。目前可以留空。取得官方授权后，在原生端接入为 Norr 提供的 SDK 或服务，由它返回当前账号和车辆可用的操作、指令受理结果及带上报时间的车辆状态。单独填写标识不会开启车控。当前 GitHub 发布作业注入登录和 xchanger 配置。[构建配置](../apps/native/scripts/ios-build-config.mjs) · [P4 授权接入接口](../apps/native/src-tauri/src/p4_partner.rs)

旧 Build 5 开始记录后，可以从「车辆控制」打开门锁、座舱和充电上限。三个面板使用当前所选车辆的快照，沿用同一个原生调用 `p4_partner_control`。导出内容包含本轮指令、服务受理状态和独立回读。门锁、空调和目标电量分别核对，每项都需要操作之后的车辆上报。测试适配器已经覆盖锁车、解锁、驻车空调启停和设置充电上限；生产写入适配器仍未绑定。

Rust 会把该登录配置编入应用。Git 忽略规则与 Actions Secrets 保护的是源码和构建过程，取得安装包的人仍可能提取包内的值。TestFlight 分发已上传的构建，修改登录配置需要重新构建和上传。车主在安装后登录产生的会话保存在设备钥匙串。Build 6 本地构建同时注入 `NORR_XCHANGER_APP_SECRET`，iOS 使用与 macOS 相同的 xchanger 签名及控制逻辑。标准版现已默认启用该适配器；旧 field-test 模式通过 `--no-default-features` 保留原实测流程。[客户端凭据读取逻辑](../crates/vehicle-core/src/credentials.rs)

## 日志使用与 Build 6 历史验证

标准版 P4 的日志入口和步骤与 Build 6 一致。逐项实车操作、结果判断和日志反馈见 [iOS P4 Build 6 测试操作手册](polestar4-ios-test-manual.md)，手册不包含安装步骤。

1. 登录后打开「设置 → 隐私与数据 → P4 诊断日志」，点击「开始记录」。开始时自动读取一次车况。
2. 返回车辆或控制页操作。记录期间会保存指令提交、服务受理/拒绝/未知结果，以及随后采集的车辆状态和回读结论。切换页面不会结束记录。
3. 回到同一入口，点击「完成记录」。完成前再读取一次车况；即使这次读取失败，也能结束并导出已有日志。
4. 点击「导出日志」，通过 iOS 文件选择器保存 JSON。取消导出不会删除本机记录；多轮记录可选择后分别导出。

日志沿用 `norr-ios-session-log` version 1，并以 `source=xchanger` 标注新事件。包含座椅、方向盘、车窗、口盖、净化和充电上限等规范化读数、能力判断、采集时间与车辆上报时间。账号隔离，车辆在每轮记录中用匿名标识关联。导出不包含密钥、访问/刷新令牌、完整 VIN、位置、账号原始响应或签名请求头。它是应用诊断记录，不是原始网络抓包。iOS 退到后台后可能暂停采集，未验证持续后台记录。

- P4 Rust 测试 89 项通过（原生 28、核心 61），新增开启/结束边界、账号隔离、指令回执导出和敏感字段排除测试；普通构建 64 项通过。
- iOS ARM64 `cargo clippy -p norr --target aarch64-apple-ios --features polestar4-test --locked -- -D warnings` 通过，前端 28 项及构建/签名脚本 7 项测试通过。
- `npm run build:ios:p4` 完成；包内架构、iPhoneOS 平台、应用标识、Build 6 标志、控制/日志代码及 ZIP 完整性核对通过。代码签名与描述文件已移除。两项密钥只由程序读取并验证注入，276 个前端产物未包含配置值。

产物：`target/ios/Norr-P4-Controls_0.1.0_build6_ios-arm64-unsigned.ipa`（26,723,808 字节）。SHA-256：`7617081694f58cf2fd23d258f01b9a3122315ffd78758c5e63558fa47737be1e`。

浏览器以 iOS 模式和模拟 IPC 验证：开始记录 → 返回车辆页开启方向盘加热 → 返回设置恢复进行中的记录 → 完成 → 导出。取消导出保留记录；结束前读车失败仍可完成和导出。320、390、756 像素浅深主题均无横向溢出，控制台错误与警告为 0。截图为 `output/playwright/p4-ios-log-light-320.png` 与 `p4-ios-log-dark-390.png`。未安装到 iPhone，系统文件选择器和实车执行尚待真机验证。

| 交付检查 | 结果 | 依据 |
| --- | --- | --- |
| Hard Gate | PASS | 开启、完成、导出、取消、读车失败逐项模拟点击；iOS 控制代码编译与 IPA 结构验证；模拟和真机状态明确区分 |
| Purpose Gate | PASS | 日志入口复用隐私与数据设置，按钮对应实际记录生命周期，说明导出范围与过滤内容 |
| Liveliness | PASS | 沿用 DESIGN.md 的字体、颜色、导航和控件，未创建新素材；手机浅深主题已查看 |
| Craftsmanship | PASS | 89 项 P4 测试、64 项普通构建、28 项前端及 7 项脚本测试通过；iOS ARM64 Clippy、未签名检查和六种页面布局通过 |
