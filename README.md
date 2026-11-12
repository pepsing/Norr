# Norr 北行

面向 Polestar 与 Volvo 车主的车辆管理应用，采用极星风格的界面，提供车辆状态、远程控制、充电管理和本地历史。

当前可运行版本为 React + TypeScript + Vite 交互预览，车辆读数、登录和命令均使用本地模拟。技术方向为共用 React 界面、Tauri 2 四端宿主和 Rust 本地车辆核心，鸿蒙使用独立 ArkTS + ArkWeb 宿主。

![Norr 车辆概览](docs/preview/norr-overview.jpg)

## 本地运行

使用 Node.js 22.12 或更新版本。安装了 nvm 时，可先运行 `nvm use`。

在仓库根目录执行以下命令。

```sh
npm ci
npm run dev
```

开发服务默认地址为 `http://127.0.0.1:5173`。启动前检查端口占用。

```sh
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

端口已占用时，可指定其他空闲端口。

```sh
npm run dev -- --port 5174
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动共用前端 |
| `npm run typecheck` | 检查 TypeScript 类型 |
| `npm run build` | 类型检查并生成 `apps/web/dist` |
| `npm run preview` | 预览已构建的前端 |

依赖由根目录 `package-lock.json` 统一锁定。

## 目录与实现状态

| 路径 | 内容与状态 |
| --- | --- |
| `apps/web/` | 可运行的共用 React 界面、演示状态与车型素材 |
| `apps/native/` | Tauri 2 宿主位置，已写入接入说明，工程待实现 |
| `apps/harmonyos/` | ArkTS + ArkWeb 宿主位置，已写入接入说明，工程待实现 |
| `crates/vehicle-core/` | Rust 车辆核心位置，已写入状态与协议约束，实现待开始 |
| `docs/research/` | 技术栈与极星视觉研究 |
| `docs/preview/` | 已完成界面的截图 |
| `licenses/` | 随项目保留的字体与图标许可 |

## 当前界面

- 车库、车型与外观选择，内置 Polestar 2 / 4 的 176 张官方来源图片。
- 车辆概览、空调与车身控制、能力与账号权限提示。
- 充电状态、计划、地点、费用与优化演示。
- 行程与充电记录、导出、备份恢复和隐私设置。
- 服务处理进度、独立回读结果和定时读取状态。
- 手机与桌面布局，浅色与深色主题。

中国区 Polestar 2 的核心控制和定时可在演示中操作。中国区 Polestar 4 的能力适配待验证。原生厂商接入的历史进展和后续验证顺序见研究记录。

## 开发资料

- [界面范围与既有验证记录](apps/web/README.md)
- [已确认的设计方向](DESIGN.md)
- [技术栈研究](docs/research/web-pwa-native-stack-2026-11-12.md)
- [极星视觉研究](docs/research/polestar-visual-direction-2026-11-12.md)
- [研究记录的迁入说明](docs/research/README.md)
- [车型素材清单与来源](apps/web/public/images/vehicles/README.md)

## 来源与许可

初始界面从 Hisingen 工作区迁入，随项目保留其 MIT 许可与版权声明。第三方字体、图标和车辆图片各有对应的权利说明。

Polestar 图片的公开分发授权状态仍待确认，来源及文件摘要已记录在素材清单中。[代码许可](LICENSE) · [第三方说明](THIRD_PARTY_NOTICES.md)

## 独立工程初始化验证

- Hard Gate PASS。浏览器首页与车型图片正常加载，控制台错误列表为空。图片许可状态在素材说明中标明。
- Purpose Gate PASS。目录按共用界面、平台宿主和车辆核心职责组织，每个预留目录记录接入范围。
- Liveliness PASS。界面源码与已确认的 Norr 预览逐文件一致，使用 ENERGY 2 / RHYTHM 2 / MOTION 1。
- Craftsmanship PASS。独立执行 `npm ci` 和 `npm run build` 成功，176 张车型图片的 SHA-256 与大小校验通过，10 份迁入或新增文档的本地链接有效，77 个原锁文件依赖项的版本与摘要一致。
