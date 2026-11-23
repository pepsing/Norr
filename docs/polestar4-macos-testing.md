# Polestar 4 的 macOS 账号测试

2026-11-19 已在本机安装独立应用 `/Applications/Norr P4.app`，窗口标题为「Norr 北行 · Polestar 4 测试」。2026-11-20 用户完成登录，已验证钥匙串持久保存与退出后免验证码恢复。

## 账号与数据

| 项目 | 原 Norr | Norr P4 |
| --- | --- | --- |
| 应用标识与钥匙串 service | `app.norr.mac` | `app.norr.mac.polestar4` |
| 钥匙串 account | `polestar-china-session` | `polestar-china-session` |
| 本机数据目录 | `~/Library/Application Support/app.norr.mac` | `~/Library/Application Support/app.norr.mac.polestar4` |

两个应用的会话、设备标识、历史和运行锁各自保存。P4 测试包不注册原应用的 `norr://` URL，也不安装或更新原应用的小组件。

在 Norr P4 的账号页完成一次短信登录后，应用把会话保存到自己的 macOS 钥匙串条目。正常退出应用会保留会话，下次启动按已有流程恢复；访问令牌需要续期时，应用使用 refresh token，并保存服务端轮换后的凭据。短信验证码和账号密码不作为长期凭据保存。

这是本机持久保存，不是永久有效的服务端授权。刷新授权过期、撤销或厂商要求重新验证时仍需登录。不要把 token 导出到文档、历史备份或聊天记录，也不要在多个实例中复用同一个会话副本。

## 构建

在仓库根目录使用已安装的固定代码签名证书：

```sh
APPLE_SIGNING_IDENTITY='<本机固定代码签名证书>' npm run build:mac:p4
```

构建需要环境变量或 `.env.secrets` 中的 `NORR_POLESTAR_CN_SIGNING_KEY` 和 `NORR_XCHANGER_APP_SECRET`，产物为 `target/release/bundle/macos/Norr P4.app`。构建脚本同时选择独立应用配置和 `polestar4-test` Cargo feature；GUI 启动时核对应用标识与凭据存储标识，拒绝配置不匹配的包。以后更新测试应用需保留相同应用标识和签名证书。

应用退出后，可检查会话存在性；输出不包含手机号、VIN 或 token，也不请求车辆服务：

```sh
'/Applications/Norr P4.app/Contents/MacOS/norr' --session-status
```

## 已验证与待验证

- 普通构建和 `polestar4-test` 构建各通过 46 项 Rust 测试；测试包含凭据命名空间、数据目录和运行锁的一致性。
- TypeScript 检查、前端构建、macOS release 构建、严格 Clippy 与应用签名校验通过。已安装二进制与构建产物一致。
- 原 Norr 的 9 个本机文件及安装二进制检查项摘要未变；原会话条目仍存在，钥匙串元数据未变。
- 2026-11-19 首次启动状态为 `hasSession=false`、`signingKeyPresent=true`。原生窗口已实际打开手机号短信登录页，空输入下获取验证码和登录按钮禁用。
- 2026-11-20 用户登录后，退出 GUI，再用已安装应用执行 `--session-status`，返回 `storageNamespace=app.norr.mac.polestar4 hasSession=true signingKeyPresent=true`。
- 同一新进程执行 `--verify-session`，返回 `sessionRestored=true vehicleCount=2`。车库包含 Polestar 2 和 Polestar 4；P2 的 14 类读取成功。命令随后因 P4 平台尚未适配而退出 1，不能把整条命令记为车辆读取全部通过。
- 重新打开 GUI 后自动连接车库，没有再次请求手机号或验证码。测试窗口已切回 Polestar 4，页面明确显示平台尚未适配，车控保持禁用。本轮未发送车辆控制命令。
- 2026-11-20 再次核对：原 Norr 会话条目仍存在，钥匙串元数据与此前基线一致，9 个原应用文件检查项摘要未变。
- 朋友账号的跨过期续期仍待验证；本次确认的是保存后从新进程恢复登录和读取车库。
- 2026-11-20 已用独立验证工具打通 Geely 会话交换、续期、车库、综合车况、能力配置、车辆模式和充电读取，详见 [P4 API 验证记录](polestar4-api-verification.md)。Geely 会话另存于同一 P4 service 的 `polestar-geely-session` 条目，已验证新进程恢复。
- 更新后的签名测试包在本机从钥匙串恢复，独立进程读取 P2 的 14 组与 P4 的 8 组均成功。P4 包含电池、车身、空调、里程、保养、空气质量、车辆模式和充电预约。本车返回 56 项功能声明，预约列表为空。
- 在安装后的窗口从 P2 切到 P4，核对首页四个快捷入口、寻车禁用原因、等待更新提示，并打开车锁详情查看分门、分窗。P4 快照及当前选车已写入测试账号的历史。充电预约的空列表、已有计划、读取失败由组件样本验证。此次未逐个手动走查五页。
- 本机测试依赖独立钥匙串的客户端配置。正式分发、跨到期恢复、另一辆有预约的 P4、轮胎告警枚举和地图坐标仍待验收。

## 第二轮实机复核

2026-11-20 已在安装后的 P4 窗口逐页打开车辆、控制、充电、记录和设置。控制页的解锁、开窗及尾门操作禁用；充电页可进入预约并显示成功读取的空列表；记录页显示电量和里程趋势；设置页显示当前 P4 的外观配置。结束时重新打开已安装应用，恢复至 P4 首页并连接成功。诊断使用单独的签名构建，已安装应用沿用原版本。该轮 49 项原生测试和严格 Clippy 通过。

Hard Gate PASS（全程只读），Purpose Gate PASS（补齐五页与字段核对），Craftsmanship PASS（签名构建、范围判断和脱敏测试通过）。本轮没有调整页面设计，Liveliness 不适用。字段级结论与取样时间见[第二轮只读补证](polestar4-api-verification.md#11-月-20-日第二轮只读补证)。

## 交付检查

- Hard Gate PASS。P4 在页面和原生命令准备阶段均受只读限制。验证期间仅使用车况和预约读取。
- Purpose Gate PASS。车锁、空调、尾门打开状态详情；待验证的寻车明确说明原因；充电页直接打开预约。
- Liveliness PASS。签名应用保留原有车辆图、能源主卡和五页导航，已在实机窗口核对 P4 首页。
- Craftsmanship PASS（本机只读范围）。普通和 P4 原生测试、界面组件测试、TypeScript 和 P4 Clippy 均通过。已验证安装包签名、安装前后二进制一致、原 Norr 九个文件及原凭据条目元数据与基线一致。


## P4 整数胎压

按用户指定的 kPa 口径，已安装的签名测试包在「健康与保养」显示左前 286、右前 280、左后 279、右后 276 kPa。快照保留原始精度，只有显示时取整。旧快照缺少压力时显示「未返回」，当前快照读取后自动更新。

Hard Gate PASS（实机核对四轮显示）；Purpose Gate PASS（压力与告警分列）；Liveliness PASS（沿用现有健康表格）；Craftsmanship PASS（24 项前端和 49 项原生测试通过，安装包签名校验通过）。


## P4 充电状态、车温与上报位置

2026-11-20，在已安装的签名 macOS 测试包中核对以下入口。

| 入口 | 本车结果 | 其他情况 |
| --- | --- | --- |
| 首页能源卡、充电详情 | 两处均显示「未插枪」，并保留车辆上报时间 | 优先显示已知充电状态。仅取得连接标志时显示「已插枪」或「未插枪」，两者均缺失时显示状态未知 |
| 空调详情 | 车内 21.5 °C、车外 14.7 °C | 两个入口使用同一温度组件。车外字段为 `climateStatus.exteriorTemp`，与车内温度独立解析。官方 4.25.0 的 `com/polestar/carcontrol/phone/page/climate/ps4/AirSettingFragment.java` 使用摄氏度显示两个字段及车况更新时间 |
| 车辆位置 | 本地显示上报坐标、车辆上报时间及「显示高德地图」按钮 | 仅接受允许上传、可信、明确属于 GPS 路径的有效非零坐标。点开地图才加载第三方页面。已用固定坐标验证转换与链接，车主实际停车点待独立对照 |

Hard Gate PASS（此次只读走查未向第三方地图提供本车坐标），Purpose Gate PASS（三项使用现有入口），Liveliness PASS（复用能源卡、详情行和地图组件），Craftsmanship PASS（普通构建 46 项、P4 构建 50 项原生测试，前端 26 项测试，P4 严格 Clippy 与安装包签名校验通过）。


## P4 首页温度

签名测试包更新后，首页车辆图下方同屏显示「车内 21.5 °C」「车外 14.7 °C」。两项取自与空调详情相同的车况记录。

Hard Gate PASS（实机首页核对），Purpose Gate PASS（直接查看车内外温度），Liveliness PASS（沿用车图下方信息行），Craftsmanship PASS（320、640、1100 像素宽的页脚布局样本均可见且无越界，26 项前端测试通过）。

## P4 控制入口对照

中国区官方 App 4.25.0 的逐项结果见[控制匹配表](plans/polestar4-compatibility.md#现有控制如何匹配)。已在更新后的独立 macOS 应用从首页打开「寻车」，确认「闪灯寻车」和「鸣笛并闪灯」都显示「官方 App 有此操作，Norr 尚未接入」。本轮仅检查入口，未下发实车指令。

| 交付检查 | 结果 |
| --- | --- |
| Hard Gate | PASS。实机核对寻车面板及两项操作的接入说明 |
| Purpose Gate | PASS（查看操作和接入状态）。实车控制仍缺少 Norr 可用的写入通道 |
| Liveliness | PASS。沿用首页快捷入口和现有操作面板 |
| Craftsmanship | PASS。26 项前端测试、46 项默认原生测试和 TypeScript 检查通过。已校验安装包签名及安装后二进制一致性 |

## 朋友实测与日志导出

在「设置 → 隐私与数据 → P4 测试日志」选择测试项目与观察结果。可先记「准备操作」，在车上或官方 App 检查后，再记「观察到预期变化」「操作报错」「未看到入口」或「结果未明」。观察时间取自按下记录按钮的时刻。记录只保存在这台设备，朋友在别处操作时需手动标记。

「导出测试日志」使用系统保存面板导出所选车辆最近 7 天的 JSON。文件将手动观察与 Norr 已保存的车况分开，时间为 Unix 毫秒。充电预约保留读取状态和返回的开始时间，空调预约缺少读取来源时记为 unavailable。手动标记不代表收到车控服务回执。

| 交付检查 | 本轮结果 |
| --- | --- |
| Hard Gate | PASS。实机 P4 控制页已隐藏 OTA，寻车第三项为单独鸣笛 |
| Purpose Gate | PASS（本机记录与导出）。实机经保存面板写出并解析 JSON，包含 46 条自动采集，手动标记为 0。实车写入接入仍未完成 |
| Liveliness | PASS。沿用控制页、寻车面板和设置页原有导航 |
| Craftsmanship | PASS。前端 26 项、默认原生 47 项、P4 原生 51 项以及 TypeScript 检查通过。测试覆盖标记跨数据库重开、车辆和时间范围隔离、过滤敏感字段及失败读取。安装后签名校验通过 |

## Mac 与 Windows 实测界面对照

Mac 独立测试包默认进入与 Windows 测试包共用的「Polestar 4 实测」页面。Mac 额外提供「查看车况」，可进入原车辆页刷新，再点「返回实测」。实测日志中的手动标记和车况读数沿用当前账号、当前车辆的历史库。

- Hard Gate PASS。覆盖安装前后应用签名要求一致，原钥匙串会话存在。更新后的应用自动恢复并显示「已开始记录」。
- Purpose Gate PASS。已在本机走通实测页、车辆页、返回实测和系统保存面板。导出的 JSON 包含 66 条车况与两条选车事件。
- Liveliness PASS。两端共用登录、项目选择、来源、结果和导出控件，Mac 保留已有车辆页。
- Craftsmanship PASS。26 项前端测试和 52 项 P4 原生测试通过，安装副本通过严格签名及二进制一致性校验。

## 核对解锁和驻车空调的日志

收到朋友分享的 JSON 后，可在 Norr 仓库根目录运行下列命令。脚本在本机读取文件，使用 Python 3 标准库，兼容 iPhone Build 4 的单轮记录和 Mac 的七天导出。

```sh
python3 scripts/polestar4-log-report.py "/实际位置/导出的日志.json"
```

官方中国区 Android App 4.25.0 的解锁、驻车空调启动与停止共用一个回调。SDK 区分服务已提交、已发往车端通信模块、操作成功和失败。三个动作的通用回调在外层业务码为 200 或 1000 且数据非空时向上层返回成功，此处没有检查内层操作结果。核对位置为解包目录下的 `com/polestar/geelysdkadapter/remotefunction/clifor.java` 第 93、152 行，空调启停见 `v7/clisuper.java` 第 486、441 行。

iPhone 记录能核对车库读取和人工标记。Mac 记录还可核对同车的门锁和空调上报。脚本显示「准备操作」前最后一次已采集的车辆上报，以及标记后十分钟内采集的新上报；同类下一次「准备操作」会提前结束核对。十分钟沿用 Norr 的回读时限。时间统一为 UTC，重复的车辆上报时间只计一次。人工看到官方 App 提示受理、SDK 的车控服务回执、车辆上报各有独立来源。当前两种导出格式均未采集车控服务回执。

## 2026-11-23 构建配置与签名检查

本轮接入 `.env.secrets` 中的 P4 xchanger 配置，统一四端构建入口和 iOS Xcode 子进程的读取规则。macOS P4 测试包优先使用编入配置，开发构建保留原钥匙串回退。配置注入本身不改变平台适配范围或车控权限。

- `npm run check:native`：59 项通过。
- `cargo test --workspace --features polestar4-test --locked`：71 项通过，包含签名固定样本、特殊 query 编码和配置回退测试。
- P4 严格 Clippy、`cargo fmt --all -- --check`、`actionlint .github/workflows/build.yml` 与 `git diff --check` 通过。修正已有 P4 测试代码的等价布尔表达式，并为共用归档模块补充明确路径，解决 HarmonyOS 引用时 rustfmt 找不到子模块的问题。
- 前端构建、前端测试、38 项原生构建与发布脚本测试通过。另以无 `NORR_*` 环境变量的模拟 Xcode 进程确认两项 key 从临时配置传入；只使用固定虚构值。
- macOS P4 release 包使用原固定证书构建并通过严格签名校验。程序内部检查两项 key 均已编入原生二进制，只输出通过状态。Git 可见源码、网页产物及配置日志未展示 key，网页资源不含 key，应用包不包含 `.env` 文件；本地 `.env.secrets` 权限保持 `0600`。
- 已配置 GitHub Actions Secret。工作流改动尚未提交或在 GitHub 运行；此次未构建其他平台，也未执行账号登录、实车读取或车控。

| 检查 | 结论与依据 |
| --- | --- |
| Hard Gate | PASS。配置值未展示；源码与网页资源扫描通过；功能范围、云端运行及实车验证边界分别记录 |
| Purpose Gate | 不适用。本轮未新增或修改界面技法 |
| Liveliness | 不适用。本轮未调整页面、素材或交互 |
| Craftsmanship | PASS。构建配置、签名样本、原生回归、CI 静态检查及 macOS 安装包校验通过 |
