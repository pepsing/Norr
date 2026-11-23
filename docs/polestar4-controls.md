# P4 控制接入

2026-11-23，macOS、Windows、Android 与 iOS 标准构建的 `polestar4` 特性通过 `send_command` IPC 接入 21 个 xchanger 控制动作。界面确认后，ChinaClient 核对当前账号、车辆与能力，计算 HMAC-SHA1 签名并发送 HTTP PUT，记录服务回执，再独立回读车辆状态。控制接入验证使用固定样本，没有执行真实车辆操作或发送短信；后续 macOS 定位查询沿用用户授权，单独记录只读接口结果。

## 范围与参数

全部动作使用 `PUT https://device-api.xchanger.cn/remote-control/vehicle/telematics/{vin}`。参数与官方 Android 4.25.0 解包逐项对照，证据见 [参数对照](polestar4-control-parameters.md)，签名见 [xchanger 签名与接口](polestar4-xchanger-signing.md)。

| 功能 | Norr 参数与实际请求 |
| --- | --- |
| 空调启停 | `RCE_2`；开启 16–28 °C 整数，默认 22，`rce.conditioner=1`、`rce.temp`、duration=180；关闭只发 `rce.conditioner=1`、stop、duration=0 |
| 方向盘加热 | `steeringWheelHeat`，0 关闭、1 开启；`RCE_2`、`rce.heat=steering_wheel`，不发送温度和档位，启停均 duration=60 |
| 前排座椅加热 | `driverSeatHeat` / `passengerSeatHeat`，0 关闭、1–3 档；`RCE_2`、`rce.heat=front-left/front-right`、`rce.level` 字符串；0 使用 stop，启停均 duration=60 |
| 前排座椅通风 | `driverSeatVent` / `passengerSeatVent`，同样 0–3 档；参数键改为 `rce.ventilation`，使用手机版启停分支 |
| 门锁与尾门解锁 | `RDL_2` / `RDU_2`，门锁只带 `door=all`；尾门解锁为 `RDU_2`、`target=trunk` |
| 车窗开闭与通风 | `RWS_2`、`target=window`，start / stop；通风为 start，另带 `pos=15` |
| 闪灯、鸣笛、鸣笛并闪灯 | `RHL/start`，`rhl=light-flash/horn/horn-light-flash` |
| 空气预清洁启停 | `RCC_2`、`rcc.ventilation=cabin`，start / stop |
| 充电口盖开闭 | `RDO` / `RDC`（没有 `_2` 后缀）、start、`target=front-charge-lid` |
| 充电上限 | 40–100% 整数；`RCS/start`、`operation=4`、`rcs.setting=1`、`soc=百分比×10` |

除表内特例外使用 SDK 默认调度：duration=0、interval=0、occurs=1、recurrentOperation=false。充电上限保留此前 iOS 样本的 latest=false、duration=60、occurs=0、recurrentOperation=true，不能称为与 Android 通用调度逐字段一致。

以上是已实现的请求范围，不表示所有账号都会开放全部入口。电动尾门升降、后排座椅、充电电流、立即充电及恢复预约、预约写入、OTA 仍未启用。标准构建默认启用 P4 适配器，沿用原应用标识与凭据空间；独立 `polestar4-test` 包仍保留隔离标识。iOS 使用 `npm run build:ios:p4` 生成 Build 6 未签名控制包，支持日志开关与导出，见 [iOS 构建记录](ios-packaging.md#build-6-日志与验证)。Windows 使用 `npm run build:windows:p4` 生成相同控制范围的 x64 安装包，日志入口同为「设置 → 隐私与数据」，见 [Windows 构建与验证](polestar4-windows-testing.md)。

## 能力判断

每次准备都重新读取当前 xchanger 车库（包含共享车辆）、能力和状态。VIN 不在车库、能力明确为 false、能力或必要状态缺失时均不发送；不因共享账号 `owner=false` 一律拒绝。前端接收 `norrP4.<action>` 的 true / false / null，分别显示可操作、未开放、尚未确认。

| 功能 | 判断依据 |
| --- | --- |
| 空调、充电上限 | `remote_climate_control_2`、`remote_charge_2` |
| 方向盘 | 空调能力为 true，且车辆返回有效方向盘加热开关 |
| 座椅加热 | 空调能力为 true 且返回对应座位档位；若存在 `remote_seat_preheat_switch`，还必须明确为 true |
| 座椅通风 | 同上，使用 `remote_seat_ventilating_switch`；两侧通风状态均须表明支持，保留手机版双侧检查 |
| 锁车 / 解锁 | 优先 `remote_control_lock_2` / `remote_control_unlock_2`，其次对应无 `_2` 能力，再次 `door_lock_switch_control` |
| 尾门解锁 | `remote_trunk_unlock`，不以电动尾门能力代替 |
| 车窗 | 对应 `remote_window_open` / `remote_window_close` / `remote_window_ventilate`，缺少细项时用 `remote_control_window` |
| 寻车 | `honk_flash` |
| 预清洁 | `remote_purification`，缺少时用 `remote_open_PM2.5_purification` |
| 充电口盖 | SDK 通用 `remote_control_open` / `remote_control_close`，且返回有效口盖状态 |

细项明确为 false、格式不明或重复时，不用通用能力覆盖。刷新失败会清除旧能力。座椅在未返回细项能力时，使用同属 RCE_2 的空调能力与硬件状态组合；充电口盖使用 RDO/RDC 对应的通用开闭能力。这些是 Norr 的接入判定，**尚未由当前 P4 账号验证具体授权**，最终服务拒绝照实显示。官方 App 的 `supportVentilation` 目录开关未在 Norr 查询，该开关是入口配置，不能替代车辆授权。

## 互斥、回执与回读

- 座椅加热和通风切换时，需先关闭当前模式、等待回读，再开启另一模式。后端检查最近 10 分钟内的有效车辆上报；对侧模式开启、未知、时间缺失、未来时间或 freshnessPending 均阻止切换。关闭操作不要求先取得互斥状态。不会自动串发两个写入。
- 准备结果绑定账号，60 秒失效。未知平台不会进入 P2 的 C3 控制路径。macOS / iOS 的解锁、开窗、车窗通风、开充电口盖与鸣笛沿用系统身份确认；Windows 使用应用内操作确认，已按用户要求移除 Windows Hello 强制验证。
- 写入前先持久化待核对记录；每次写入只发送一次。超时、响应丢失、格式不明或服务故障记为结果未知，授权失效也不自动重放写入。只读请求可按既有规则续期一次。
- 服务受理仅记为 accepted。空调、座椅和方向盘回读 climate，车身回读 exterior，净化回读 airQuality，充电上限走独立 SOC 端点。事件触发局部刷新，不为每条指令重新读取全部车况。
- 只有操作后的有效车辆上报、目标字段与数值一致才确认。旧缓存、缺少时间、未来时间、freshnessPending 和缺少对应字段均不能确认。空调运行但缺少设定温度时只显示“空调已启动，设定温度待核对”，允许关闭。车窗通风只能回读留缝状态，显示“车窗已留缝，开度待核对”，不据此确认精确开度，并允许关窗。
- 同账号、VIN、控制对象在 10 分钟核对期内若结果不明，先回读；重复同值返回原记录，改值需等待确认。主驾、乘客、方向盘、空调分别跟踪，同一座位的加热和通风共用核对组。
- 鸣笛与闪灯没有可靠的持续状态回读，记录“结果请现场核对”，不会伪造执行成功；一分钟内不重复下发，之后仅可由用户再次确认发送。
- 新快照使用 `norrXchanger`，历史读取继续识别 `norrGeelyReadOnly`。备份格式不变，手动实测日志增加车窗通风和充电口盖项目。

## 配置与构建

`npm run build:mac:p4` 从环境或根目录 `.env.secrets` 注入 `NORR_POLESTAR_CN_SIGNING_KEY` 与 `NORR_XCHANGER_APP_SECRET`。密钥仅由程序读取，不打印、不放入前端资源。GitHub Actions 使用同名 Secrets；本轮未提交、推送或触发 GitHub 构建。

本轮交付包：`target/packages/Norr-P4-controls-expanded-macos-arm64-local.zip`，28,970,790 字节；SHA-256：`c844c27693443e6266c80e5ed619050e9aa0d099bdbb88c8ced9f776679d5338`。应用签名与 ZIP 完整性检查通过。未安装覆盖现有应用。旧的 `Norr-P4-controls-macos-arm64-local.zip` 只包含此前三项控制。

## 验证记录

- `cargo test --workspace --features polestar4-test --locked`：88 项通过（原生 27、核心 61）。21 个动作通过真实 reqwest 向本机临时 HTTP 服务发送，核对 PUT 路径、请求体、HMAC 签名、授权头和单次发送；覆盖受理、拒绝、401、500、格式未知和响应丢失。全部使用虚构凭据。
- `npm run check:native`：普通构建 63 项通过。P4 Clippy 使用 `-D warnings` 通过。
- 前端 28 项回归通过，覆盖共享账号、能力三态、旧标识、数值范围；生产构建通过。
- `npm run build:mac:p4` 完成，`codesign --verify --deep --strict` 与 ZIP 完整性检查通过。程序仅以 PASS 结果核对两项原生编译配置存在、276 个前端产物不含配置值。
- 浏览器模拟 IPC 点击覆盖全部 21 个动作：主副驾加热/通风及方向盘选档 → 单层确认 → 对应 action/value；车窗、尾门解锁、口盖、三种寻车、净化、门锁、空调逐项确认；充电上限提交 100%。取消和 Escape 不发送，服务受理后仍展示原车辆读数。
- 能力 false 与 null 分别禁用并解释，模拟服务拒绝与请求报错均显示。320、756、1280 像素的浅深两主题，座舱面板和选档确认框均无横向溢出。浏览器控制台错误、警告均为 0；模拟结果不作为实车证据。
- 人工查看截图：`output/playwright/p4-cabin-light-320.png`、`output/playwright/p4-seat-confirm-dark-1280.png`。其余宽度、主题截图在同目录。React 检查沿用现有组件、状态和语义控件；按钮有可访问名称、档位使用 aria-pressed、分组使用 fieldset/legend，未引入依赖或新素材。

真实账号能力、服务受理与车辆执行仍待实车验证；空调设定温度缺少独立回读时需在车机核对。

## 交付检查

| 检查 | 结果 | 依据 |
| --- | --- | --- |
| Hard Gate | PASS | 21 个动作逐项点击至模拟 IPC，确认只有一层；拒绝和未知能力明确禁用；没有新素材，实车验证单独标明 |
| Purpose Gate | PASS | 0–3 档与开关对应实际请求参数；新文案用于说明互斥、服务受理和回读限制 |
| Liveliness | PASS | 沿用 DESIGN.md 的 ENERGY 2 / RHYTHM 2 / MOTION 1、Polestar 座舱图、字体和暖橙状态色；未增加装饰 |
| Craftsmanship | PASS | 后端签名与回读检查、前端回归及 21 条操作路径通过；取消、错误、六种尺寸主题组合已验证；模拟与实车结果明确区分 |
