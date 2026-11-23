# Windows P4 构建与验证

2026-11-23，Windows P4 包改用 `polestar4-test`，复用 macOS / iOS 已实现的 21 项 xchanger 控制、车辆回读、定位和诊断日志。旧 `p4-field-test` 入口仍保留，但不再是 `build:windows:p4` 的构建目标。

## 本次安装包

- 文件：[Norr-P4-controls_0.1.0_windows-x64-no-hello-setup.exe](../target/packages/Norr-P4-controls_0.1.0_windows-x64-no-hello-setup.exe)，29,225,056 字节，Windows 10/11 x64。此包为同日移除 Windows Hello 限制的更新。
- SHA-256：`a6c9f32be4f1986b5fd8b6ae7709bd97514c64627be12c30bf4ca9e1dd6278c6`。
- NSIS 按当前用户安装，包含 WebView2 安装引导程序；缺少运行环境时仍需联网下载。
- 产品名 `Norr P4 Test`、应用标识 `app.norr.windows.p4test`，沿用旧 P4 测试包身份，与普通 Norr 包独立。
- 使用用户根目录 `.env.secrets` 的两项配置构建；验证程序只输出配置匹配与否，未显示密钥值。未触发 GitHub 构建或发布。
- 本包未做 Windows Authenticode 签名。

## 功能与测试入口

登录后选择车辆，使用「车辆」「控制」「充电」「记录」「设置」页面。控制范围和参数见 [P4 控制接入](polestar4-controls.md)。方向盘加热位于「车辆 → 空调 → 座椅」；座椅加热和通风也在此处选择。功能是否可用按当前账号、车辆和服务返回能力判断，共享账号不会仅因不是主账号而被禁用。

控制需要界面确认，再经 xchanger 签名发出请求。服务受理和车辆实际执行分开显示，结果不明时先查看车辆回读。新版已按用户要求移除 Windows Hello 强制验证，解锁、开窗、尾门解锁、充电口盖与鸣笛无需配置 PIN 或生物识别；账号授权、能力判断、单次发送与回读核对继续生效。

定位沿用车辆位置接口。只有服务确认允许上报且返回有效坐标时显示位置；未授权、无有效坐标或读数过旧时照实提示，不能把接口受理视为获取了实时位置。

诊断日志操作：

1. 进入「设置 → 隐私与数据 → P4 诊断日志」，点击「开始记录」。
2. 返回车辆或控制页面，执行计划测试的动作，核对服务回执、车辆上报时间和实际变化。
3. 回到日志页面，点击「完成记录」，随后「导出日志」，通过 Windows 保存对话框保存 JSON。
4. 取消导出不会删除本机记录；多轮记录可按开始时间选择。最后一次读取失败仍可完成并导出已采集内容。

登录会话由当前 Windows 用户 DPAPI 加密，位于 `%LOCALAPPDATA%\app.norr.windows.p4test\credentials`。车辆历史与日志位于同一应用目录下，按账号隔离。诊断导出保留动作、服务受理和回读信息，不包含密钥、令牌、账号、完整 VIN 或位置坐标；沿用既有日志格式。

## 实际验证

移除 Hello 限制后，重新通过 P4 的 89 项测试、普通原生的 64 项测试、Windows P4 严格 Clippy 与测试目标编译、TypeScript、生产构建和安装包校验。Windows 构建不再编译车控系统认证分支，其他平台沿用原处理。拆包对比确认旧包含 `UserConsentVerifier` 和配置提示，新包均不含；两项原生配置匹配，276 个前端文件不含配置值。新包校验记录见 `target/p4-validation/windows-no-hello-20261123/package-verification.json`。

本次没有修改前端界面，下面的构建配置、前端回归、模拟交互和布局结果沿用同日首包验证。

| 检查 | 结果 |
| --- | --- |
| 构建配置测试 | 6 项通过；Windows feature、配置、界面入口和两项配置传递使用固定样本验证 |
| 前端回归 | 28 项通过；TypeScript 与生产构建通过 |
| P4 Rust 工作区测试 | macOS 上 89 项通过，原生 28、核心 61；包含全部 21 项请求参数、签名、服务回执与回读测试 |
| 普通原生回归 | `npm run check:native`，64 项通过 |
| Windows 编译 | P4 x64 Clippy `-D warnings` 和测试目标编译通过；Windows 测试未在设备上执行 |
| 打包 | `npm run build:windows:p4` 通过，NSIS 完整性、x64 PE 主程序和应用标识通过 |
| 产物核对 | 安装包主程序与构建结果一致，仅有 Tauri 规定的 NSIS 类型标记替换；两项原生配置匹配；276 个前端文件不含配置值；未打包 `.env` 文件 |
| Windows 界面模拟 | 日志开始、跨页保留、完成、导出取消后重试、读取失败后完成并导出通过；两轮导出选对记录 |
| 控制界面模拟 | 方向盘开启经过单层确认，仅调用一次 `steeringWheelHeat=1`；受理后仍等待车辆上报，不改写旧状态 |
| 布局 | 580、820、1280 像素，浅深主题共六组无横向溢出；人工检查最小宽度浅色与默认宽度深色截图 |

模拟界面使用虚构车辆和 IPC，不发送真实车辆请求。截图位于 `output/playwright/p4-windows-log-{light,dark}-{580,820,1280}.png`。安装包校验记录位于 `target/p4-validation/windows-controls-20261123/package-verification.json`。

Windows 实机安装与升级、首次登录滑块、DPAPI 实际读写、原生保存框、通知与托盘，以及实车请求受理和执行仍待设备验证。本机交叉编译与浏览器模拟不能替代这些结果。

## 交付检查

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| Hard Gate | PASS | 按用户要求移除 Windows Hello 限制，保留应用内确认；新包验证类与提示均已移除；无新增素材 |
| Purpose Gate | PASS | 未配置 Hello 的 Windows 用户可在应用内确认后继续提交车控，仍按服务授权和车辆能力判断 |
| Liveliness | PASS | 本次界面未改动；沿用 DESIGN.md 的 ENERGY 2 / RHYTHM 2 / MOTION 1、Norr 字标、字体和主题，以及首包六组尺寸主题验证 |
| Craftsmanship | PASS | P4 与普通原生回归、Windows 严格编译和新包校验通过；应用内确认和日志界面沿用首包模拟验证；Windows 实机与实车待验证 |
