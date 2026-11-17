# Watch 离线测试

使用项目要求的 Node.js 和可从命令行调用的 `swiftc`。macOS 可使用 Xcode 提供的 Swift 编译器。

在仓库根目录运行。

```sh
node apps/native/scripts/check-watch.mjs
```

脚本直接编译生产代码 `WatchWire.swift`、`WatchSnapshot.swift`、手机端 `WatchSyncPolicy.swift` 和测试入口 `main.swift`，在系统临时目录运行后清理产物。编译失败或断言失败会返回非零退出码。编译保留断言检查。

测试使用本地构造的协议数据及登录态，覆盖以下行为。

- Protobuf 数字、浮点数、嵌套消息、时间戳及旧版锁定字段。
- 截断、超长消息、整数溢出、无效字段和 NaN。
- 新鲜且匹配的车辆回读确认操作，过期、车辆不匹配、状态不匹配及缺少时间戳时保持待核对。
- 登录态编码与恢复、清除登录态后恢复为空、无效 VIN 拒绝恢复。
- 待核对操作按账号与车辆隔离，切车后切回、授权续期、清除当前账号、重启恢复及旧版单条记录迁移。

- 自动同步首次发送、相同授权去重（忽略版本）、账号 / VIN / token / 有效期变化、暂停、清除与恢复、手动强制重试。

真实网络、WatchConnectivity 传输、Keychain 存取及系统 UI 需要通过配对设备另行验证。
