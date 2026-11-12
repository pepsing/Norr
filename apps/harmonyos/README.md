# Norr 鸿蒙宿主

此目录用于原生 HarmonyOS 的 ArkTS + ArkWeb 工程。当前阶段已准备目录与接入说明，DevEco Studio 工程待初始化。

宿主将加载 `../web` 的共用界面，并实现验证码桥接、会话安全存储、原生网络和系统集成。ArkWeb 页面行为、协议支持与前后台恢复需要在目标设备验证。

## 开发与验证顺序

可以先用模拟器开展开发。首轮加载共用页面，接入 ArkTS 与 Web 双向通信，配置 Rust 核心交叉编译，再验证 TLS、HTTP/2、gRPC 和官方短信验证页面。模拟器上的网络与验证码兼容性以实际运行结果记录。

真机用于后续验收安全存储、设备身份确认、通知、前后台恢复和实际车辆控制。首版范围对齐当前中国区 P2 能力，P4 HUANFU 服务接入列在共用核心待办中。

## 环境准备

2026-11-13 检查的开发机为 Apple Silicon Mac，已有 Node.js、npm、Rust 和 Cargo。常用应用与 SDK 目录中尚未发现 DevEco Studio 或鸿蒙 SDK，`hdc`、`ohpm`、`hvigorw` 未在 PATH 中发现。

后续配置 DevEco Studio、对应 HarmonyOS SDK、Native 编译工具与模拟器镜像，并配置 Rust OHOS 目标及链接器。真机调试阶段准备华为开发者账号与设备签名，首轮评估自动签名。账号登录及实名认证由用户完成。

工具链安装、工程初始化和鸿蒙运行验证均待开展。[官方安装说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-software-install/) · [Rust OHOS 配置](https://doc.rust-lang.org/rustc/platform-support/openharmony.html) · [自动签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto/)

[开发进展](../../docs/PROGRESS.md)记录最新测试包、实际验证范围与下一步工作。

[鸿蒙适配研究](../../docs/research/web-pwa-native-stack-2026-11-12.md#原生鸿蒙适配)
