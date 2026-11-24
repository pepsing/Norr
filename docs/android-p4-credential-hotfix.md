# Android P4 会话凭据 hotfix

排查日期：2026-11-24。用户反馈 Android 登录后持续显示“无法解密本机登录会话，请重新登录”，同时页面显示登录成功、会话已保存。

## 发布包证据

- GitHub 最新 Android 包为 [v0.2.1-alpha.6](https://github.com/pepsing/Norr/releases/tag/v0.2.1-alpha.6)，源提交 `7b54ab10c778b61b41623038ba111ceedaf763ee`。
- APK 清单：`app.norr.mobile`，`versionName=0.2.1-alpha.6`，`versionCode=1022`。
- `Norr_0.2.1-alpha.6_android-arm64.apk` 的 SHA-256 为 `409e83209bbaa8f0862883fbdde5d790b95c2069e51382b0db99fb90d67305c3`，与 GitHub 附件摘要一致。
- 对该 APK 单独反编译 `NorrPlugin`，确认 `account()` 只接受 `polestar-china-session`、`polestar-china-signing-key`、`device-id`。

## 原因

中国区短信登录写入 `polestar-china-session`，该类型在白名单中，因此登录成功且能显示中国区授权有效期。

随后读取 P4 车况时，调用链为 `ChinaClient::refresh` → `geely::refresh` → `Api::grant` → `credentials::geely_session` → Android `readCredential`。P4 使用独立的 `polestar-geely-session`。旧 Android 插件在读取 SharedPreferences 和调用 AES-GCM 解密前，先通过 `require` 拒绝这个类型；外层 `catch (Exception)` 又把异常统一转成无法解密提示。P4 会话写入同样被拦截。本地 P4 配置备用入口 `polestar-geely-client-config` 也遗漏了，但包含构建配置的发布包不会先走这个备用入口。

这是 Android 桥接的确定性缺陷，与前一版 Android 目录/文件锁错误是不同阻断点。原包重新登录或重装仍会遇到相同白名单检查；不能据这条提示判断用户 Keystore、系统锁屏或真实 token 已损坏。

提取发布提交中未修改的 `account()` 函数，在宿主 Kotlin/JVM 运行六组固定名称：原有三项通过，P4 两项和未知类型被拒绝。该检查验证类型校验路径，不代表反馈手机的 Keystore 或实车接口已验证。本机复现产物保存在 `target/android-p4-credential-audit-20261124/`，没有读取用户凭据。

## 修复范围

- Android 凭据读写接受核心使用的五个固定名称；未知名称继续拒绝，并给出独立错误。沿用原偏好文件、密钥别名、IV/密文格式、AES-GCM 和凭据名 AAD，旧 P2 会话无需迁移。
- 将存储实现抽到 `NorrCredentialStore`，供插件和隔离 Android 仪器测试使用。测试使用独立的偏好文件、Keystore 别名和固定样本，结束后清理。
- Android 没有当前车辆快照时，小组件通过已有串行同步队列删除旧车记录并刷新空态；保留组件外观设置。其他平台的清除行为留在待办。
- 添加 Rust/Android 凭据名称契约检查，防止核心新增凭据类型而平台白名单遗漏。

## 验证与发布

Android 16 ARM64 隔离模拟器通过 11 项仪器测试：5 项凭据测试覆盖首次空存储、五种凭据的加密/重读/覆盖、旧 V1 格式、未知类型拒绝和跨类型密文认证失败；6 项组件测试覆盖清除记录、保留外观以及既有深浅主题和车图。

本次待发布源码单独导出后通过 28 项前端测试、41 项构建/发布脚本测试（Node 22，与 CI 一致）和前端生产构建。Playwright 配合模拟 IPC 验证 P2 切换 P4 后首次读取失败、连接返回空车库两种场景，组件最终收到清空指令。工作副本的 105 项 Rust 测试、严格 Clippy、Android ARM64 编译检查与差异格式检查通过；工作副本中尚未发布的 Apple 适配仍单独保留，不计入此次发布功能。

本机记录位于 `target/android-p4-credential-audit-20261124/`。真实短信登录、P4 会话交换/续期及实车读取仍需反馈手机或具备授权的设备验收；本次未发送真实短信或车辆控制命令。仅通过现有工作流的 `platform=android` 发布，最终版本和 APK 以 GitHub Release 为准。

Hard Gate PASS：使用固定样本，未输出密钥，明确真机与实车边界。
Purpose Gate PASS：只修复 Android 登录阻断和已有小组件的数据一致性。
Liveliness 不适用：沿用原有布局和空态，无新增视觉元素。
Craftsmanship PASS：发布源码检查、Android Keystore 运行时、旧格式兼容、模拟 IPC 和失败路径均有记录。
