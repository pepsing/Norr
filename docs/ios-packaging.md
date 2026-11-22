# iOS 打包与分发

给朋友测试中国区 Polestar 4 的车况读取与日志导出，选本地 **P4 实测 IPA**。通过 GitHub Releases 安装常规 Norr，选标准版未签名 IPA。收到 TestFlight 邀请的测试者直接在 TestFlight 中安装。下表按 2026-11-22 的脚本和归档核对。

| 用途 | 构建入口 | 应用标识 | 产物或安装位置 |
| --- | --- | --- | --- |
| 本地模拟器 | `npm run build:ios` | `app.norr.ios` | `target/ios/Norr.app` 和 ARM64 模拟器 ZIP |
| 本地标准版真机 | `npm run build:ios:unsigned` | `app.norr.ios` | `target/ios/` 下带 Watch、无 Watch 两份未签名 IPA |
| 本地 P4 实测 | `npm run build:ios:p4` | `app.norr.ios.p4test` | `target/ios/Norr-P4-Test_0.1.0_build5_ios-arm64-unsigned.ipa` |
| GitHub 标准版 | Actions → Release packages → Run workflow | `app.norr.ios` | GitHub Release 附件及 Actions artifacts |
| TestFlight 标准版 | 本机签名归档 → Xcode Organizer → App Store Connect | `app.norr.ios` | App Store Connect 的 TestFlight 标签页 |

## 本地构建

在装有完整 Xcode、Node.js 22.12+ 和 Rust 的 Mac 上，从仓库根目录执行 `npm ci`。真机构建先运行 `rustup target add aarch64-apple-ios`，模拟器构建使用 `rustup target add aarch64-apple-ios-sim`。然后运行表中对应的 npm 命令。

标准版从同一次真机归档生成两份 IPA。文件名以 `ios-arm64-unsigned.ipa` 结尾的包含 Watch App 和手表小组件，以 `ios-arm64-no-watch-unsigned.ipa` 结尾的保留 iOS 小组件、Siri 和快捷指令，适合用 AltStore Classic 安装。[自助签名与安装](ios-self-signing.md)

P4 实测包使用独立的应用标识和钥匙串服务。Build 5 的包信息是 `0.1.0 (5)`，目标平台是 iPhoneOS。打包脚本生成这份未签名 IPA 时会移除 Watch 和扩展，并写入实测版的构建号及应用标识。这个包支持实车读取和日志分享，车控演示使用模拟数据。[打包脚本](../apps/native/scripts/finalize-ios.mjs) · [P4 实测范围](plans/polestar4-compatibility.md)

## GitHub Actions 与 Releases

普通 PR 和推送到 `main` 的代码更新触发检查。发布包由 `Release packages` 在 `main` 上调用构建工作流生成。定时任务每天北京时间 03:20 检查待发布提交。手动发 iOS 测试版，在 **Actions → Release packages → Run workflow** 选择 `main`，留空 `version` 并选择 `platform=ios-ipa`。发布脚本会先判断该平台是否有待发布的提交。正式发行时填写正式版本号，并选 `all`。[发布工作流](../.github/workflows/release.yml) · [发布入口](https://github.com/pepsing/Norr/actions/workflows/release.yml)

发布成功后，在 Releases 下载标准版 IPA 和 `SHA256SUMS.txt`。Actions 同时将两个真机产物保存 14 天，名称分别为 `Norr-ios-arm64-unsigned` 和 `Norr-ios-arm64-no-watch-unsigned`。当前 GitHub 矩阵只包含标准版 iOS 构建，发布终点是 GitHub Releases。P4 Build 5 由本机构建。[构建矩阵](../.github/workflows/build.yml) · [下载 Release](https://github.com/pepsing/Norr/releases)

## TestFlight

2026-11-19，本机 Xcode Organizer 记录了标准版 `app.norr.ios` 的一次成功上传（`Uploaded to Apple`）。归档中的主 App、iOS 小组件、Watch App 和手表小组件均为 `0.2.1 (1018)`。P4 Build 5 目前只有本地未签名 IPA 的交付记录。

1. 在 App Store Connect 选定与归档 Bundle ID 匹配的 App。为本次上传准备新的构建号，核对主 App 与嵌入扩展的版本和构建号一致。仓库的版本脚本会修改工作副本中的版本配置。[版本脚本](../scripts/release/version.mjs)
2. 在 `apps/native/src-tauri/gen/apple/` 的 Xcode 工程中核对主 App、扩展的签名团队和 App Groups。使用标准版 `norr_iOS` scheme，从 `apps/native/` 运行 `npm exec -- tauri ios build --target aarch64 --archive-only` 生成 iPhoneOS Release 归档。产物在 `apps/native/src-tauri/gen/apple/build/norr_iOS.xcarchive`。
3. 用 Xcode 打开这份 `.xcarchive`，在 Organizer 中点 **Distribute App → App Store Connect → Upload**。上传使用 App Store Connect 分发方式。仓库检入的 `ExportOptions.plist` 用于 `debugging` 导出。[Xcode 分发说明](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases) · [Apple 上传说明](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
4. 等 Apple 处理完构建，在 **App Store Connect → TestFlight** 按版本和构建号选中它，填写测试内容并分配测试组。邀请团队外的朋友时使用外部测试组，按页面提示提交 Beta App Review，通过后发送邀请。构建是否已向朋友开放，以该组在 TestFlight 的状态为准。[外部测试邀请](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)

如需把独立 P4 实测版送上 TestFlight，需为 `app.norr.ios.p4test` 配置对应的 App ID、App Store Connect 记录与分发签名，并在归档阶段使用该标识及实测配置。当前本地 P4 脚本在归档完成后才改写标识，生成的未签名 IPA 仅供侧载。

## 中国区登录配置

本地标准版和 P4 实测版共用中国区登录配置 `NORR_POLESTAR_CN_SIGNING_KEY`。构建脚本优先读取环境变量，缺省时从仓库根目录的 `.env.secrets` 读取同名项。GitHub 的 iOS 发布任务从 Actions secret 取得这个值，为当次作业生成临时配置，作业结束时清理。当前脚本只为中国区登录读取这个名称，`.env.secrets` 中的其他条目不会因此自动进入 iOS 包。[本地构建](../apps/native/scripts/build.mjs) · [Xcode 构建脚本](../apps/native/scripts/ios-xcode.mjs) · [GitHub iOS 作业](../.github/workflows/build.yml)

Rust 会把该登录配置编入应用。Git 忽略规则与 Actions Secrets 保护的是源码和构建过程，取得安装包的人仍可能提取包内的值。TestFlight 分发已上传的构建，修改登录配置需要重新构建和上传。车主在安装后登录产生的会话保存在设备钥匙串。目前本地和 GitHub 的 iOS 打包脚本均未接入 P4 xchanger 车控签名。[客户端凭据读取逻辑](../crates/vehicle-core/src/credentials.rs)
