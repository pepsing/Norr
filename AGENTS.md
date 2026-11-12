# Norr 开发约定

Norr 北行使用 npm workspaces，当前可运行应用位于 `apps/web`。从仓库根目录安装和构建。

```sh
npm ci
npm run build
```

界面与文案工作先读 `DESIGN.md`，沿用项目的 antislop DURING 约定。使用当前环境提供的 antislop 核心和任务技能，交付时提供 Hard Gate、Purpose Gate、Liveliness、Craftsmanship 的适用项 PASS/FAIL 及验证依据。

- 先检查目标端口，再启动开发服务。
- 复用已有页面、组件和状态规则，兼容已有备份格式。
- 演示场景保持清楚标识。原生读取、写入和跨端验证状态以实际结果记录。
- 厂商能力按账号、区域和车辆返回值判断，保留能力缺失与明确不支持的差别。
- 命令结果不明时先核对车辆状态。凭据、账号响应、设备日志和签名文件保存在本机受控位置。
- 修改资源目录时同步 `manifest.json` 与来源记录。

`apps/native` 和 `crates/vehicle-core` 共用 macOS、Windows、Android 与 iOS 实现。运行 `npm run check:native` 验证协议和记录语义，运行 `npm run build:mac`、`npm run build:windows`、`npm run build:android` 或 `npm run build:ios` 构建对应应用。iOS 默认构建 Apple Silicon 模拟器版本。实机与实车验证状态、其他平台和适配范围见各目录说明。
