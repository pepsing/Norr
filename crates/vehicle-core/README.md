# Norr 本地车辆核心

Rust crate `norr-vehicle-core` 供 macOS、Windows、Android 与 iOS 宿主共用，适配中国区 Polestar 2 的 ICUP / AccountLinking 服务。

| 模块 | 职责 |
| --- | --- |
| `credentials.rs` | macOS/iOS 钥匙串、Windows DPAPI、Android 安全存储桥接、Swift 日期兼容、授权与签名配置 |
| `auth.rs` | 手机号短信登录、验证结果校验、发送冷却及登录会话保存重试 |
| `china.rs` | global 续期、厂商服务发现、车辆列表、14 类状态读取、23 类命令的能力校验与协议调用 |
| `transport.rs` | TLS、原生 HTTP/2 gRPC、trailer 状态、流式消息及超时 |
| `wire.rs` | 有界 protobuf 解码、字段存在性、请求编码和 VIN 核验 |
| `models.rs` | 车辆能力、端点读数、快照、命令与回执 |
| `schedules.rs` | 空调日程、全局充电窗口、充电地点的解码和日程编码 |
| `telemetry.rs` | 健康、空气质量、位置和软件信息解码 |
| `confirmation.rs` | 指令后的独立回读、时间校验和日程身份核对 |

前端只收到业务对象。Tauri 宿主负责请求串行化、进程锁、历史持久化和指令回读记录。单个失败端点保留失败原因，其余端点可完成读取。能力缺失与明确 false 均保留原始区别。

```sh
cargo test --workspace
```

系统凭据分别使用 macOS/iOS 钥匙串、Windows 当前用户 DPAPI 和 Android Keystore AES-GCM 存储。中国大陆手机号登录已接入，官方滑块由各宿主的原生 WebView 展示。Android 真实短信登录与重启恢复已通过，macOS、Windows 与 iOS 的新账号短信端到端仍待验证。其他区域与品牌适配、P4 HUANFU / Geely 服务及完整状态订阅仍待迁移。日程写入在发送前重新读取列表，创建回读要求新增 ID，编辑保留 ID 与 index，删除依据完整列表核对。只读请求遇到授权失效时刷新 grant 并重试一次。

[宿主使用与验证记录](../../apps/native/README.md)
