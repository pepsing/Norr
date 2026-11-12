# Norr 原生宿主

此目录用于 Tauri 2 宿主，目标平台为 iOS、Android、macOS 和 Windows。当前阶段已准备目录与接入约束，原生工程待初始化。

共用界面位于 `../web`，本地车辆核心规划在 `../../crates/vehicle-core`。宿主将负责验证码 WebView、原生桥接、系统安全存储、通知、桌面菜单栏或托盘。

首个验证目标为 iOS 和 Android 完整登录流程，包括验证页面来源、取消处理、重复回调及会话恢复。Tauri 配置、应用标识、平台插件和签名配置在实际接入时确定。

[技术栈研究与验证顺序](../../docs/research/web-pwa-native-stack-2026-11-12.md)
