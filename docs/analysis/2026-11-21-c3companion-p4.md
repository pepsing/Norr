# C3Companion 0.2.0-beta07 逆向记录与 P4 接口移植

> 对象：`C3Companion-0.2.0-beta07.apk`（SHA-256 `1122866e…b1b5c8c2`，2.0 MB）
> 方法：apktool 3.0.2 + jadx 1.5.5（JDK 17）反编译，静态阅读；未运行 APK，未连接真实车辆。
> 结论先行：**这个 APK 里没有 Polestar 4 专用代码**，它自己写着 P4「未完成实车验证」。它有价值的地方是**一套不按平台分流的通用 C3 调用方式**——这才是本次移植的内容。

---

## 1. APK 基本信息

| 项 | 值 |
| --- | --- |
| 包名 | `app.c3companion.android` |
| 版本 | `0.2.0-beta07` |
| 应用名 | C3 车伴·测试 |
| compileSdk | 36（Android 16） |
| 权限 | 仅 `INTERNET` |
| 组件 | 1 个 Activity、3 个 AppWidget、1 个 `PinReceiver` |
| 原生库 | **无**（纯 Java/Kotlin + gRPC OkHttp） |
| 网络 | 禁止明文；仅访问 `gw.app.polestar-auto.com`、`cnepmob.volvocars.com.cn`、`*.volvocars.com.cn` |
| 代码量 | 反编译 2,226 个 Java 文件（含 gRPC/Guava/Kotlin），业务代码约 20 个类 |

业务类集中在 `app/c3companion/android/`：

- `ChinaApi.java`：HTTP、签名、服务发现、车队、gRPC 裸字节调用
- `LiveManager.java`：读取/控制/日程/位置/软件、会话持久化
- `StateFields.java` / `HealthFields.java`：字段解码
- `SecureStore.java`：Android Keystore AES-GCM
- `MainActivity` / `LiveUi` / `SimpleUi`：界面
- `ClientProtocolConstant.java`：内置签名 key（**本文不复制明文**，需要时在反编译目录自行查看）

---

## 2. 它到底支持什么

`MainActivity.compat()` 的原文：

> 「中国区极星 4 · 2023 / 2024 / 2025款：**三个年款均未完成实车验证**。参考 APK 与开源项目存在接口线索，**不等于本程序已支持**。」

dex 里也没有 `HUANFU`、`Polestar 4`、`geely`、`remoteControlType` 等任何 P4/平台判断字符串。它**不做平台分流**：只要账号车队里有这辆 VIN，就用同一套 C3 服务去调用。P4 如果碰巧能通，靠的是"通用格式碰对了"，不是代码里有 P4 适配。

这恰好是最值得移植的部分：Norr 在 `ChinaClient::vehicle()` 里硬性只放行 `ICUP` / `AccountLinking`，P4 在第一步就被挡住。

### 2.1 读取：6 项，VIN-only 请求体

```java
READS = { battery, exterior, climate, air, health, odometer }
// 请求体统一是 Proto.str(2, vin) —— 只有字段 2，没有 UUID
```

| 模块 | 方法 |
| --- | --- |
| battery | `services.vehiclestates.battery.BatteryService/GetLatestBattery` |
| exterior | `...exterior.ExteriorService/GetLatestExterior` |
| climate | `...parkingclimatization.ParkingClimatizationService/GetLatestParkingClimatization` |
| air | `...precleaning.PreCleaningService/GetLatestPreCleaning` |
| health | `...health.HealthService/GetLatestHealth` |
| odometer | `...odometer.OdometerService/GetLatestOdometer` |

对比 Norr：`GetHealth` / `GetOdometer` / `GetPreCleaning`（没有 `Latest`），且 battery/exterior/climate 的请求体是 `{1: uuid, 2: VIN}`（`state_request`）。**这两个差异是 P4 兼容性最可疑的两点。**

### 2.2 控制：15 个动作，同一套 Invocation

```java
controlBody = {1: {1: VIN}} + {2: env}
// invocation.InvocationService/{method}
```

| 动作 | method | env |
| --- | --- | --- |
| lock / unlock | Lock / Unlock | 0 |
| flash | HonkFlash | 2 |
| honk | HonkFlash | 1 |
| honk_flash | HonkFlash | 0 |
| unlock_trunk | Unlock | 1 |
| lock_trunk | Lock | 1 |
| trunk_open / close | TailgateControl | 1 / 2 |
| windows_open / close | WindowControl | 1 / 2 |
| air_start / stop | PreCleaning | 1 / 0 |
| climate_start | ClimatizationStart | 1 + `float(3, 16–28 ℃)` |
| climate_stop | ClimatizationStop | — |

与 Norr 的 `command_request` 基本一致，只有两点差别：空调温度上限 APK 用 28 ℃（Norr 用车辆 `*MaxLimit`，夹到 30）；它不发送 `lock` 的 `{2:0}` 之外的字段（Norr 也发 0）。

### 2.3 Chronos（日程/预约）

```java
chronos = {1: uuid, 2: VIN, 3: "PolestarApp", 4: {1: 时区分钟}}
```

- 读取：`ParkingClimateTimerService/GetLatestTimers`（Norr 用 `GetTimers`）
- 写入：`SetTimers`，外层 `{1: chronos}` + `{2: timer}`
- 删除：`DeleteTimer`，`{1: chronos}` + `{2: id}`
- 时区：设备当前 offset / 60000（分钟）

Norr 的 chronos 结构相同，但第 3 字段是 `"RCS"`。APK 用 `"PolestarApp"`。

### 2.4 其它

- 位置：`dtlinternet.DtlInternetService/GetLastParkedLocation`，响应 `nested(2)` 里 `1=经度, 2=纬度`（Norr 用 `GetLastKnownLocation`，解析逻辑更复杂，能兼容这种 wrapped 形状）。
- 软件：`GetSoftwareInfo`，**server-streaming**，只取第一帧；字段未解码，界面明确写「不能据此执行 OTA」。
- 会话：只支持密码登录 / 导入 access token；没有短信、没有滑块。
- 存储：Keystore AES-GCM + SharedPreferences，AAD 为键名；`allowBackup=false`。
- 控后核对：3 次 × 2.5 s 重读对应模块，命中目标状态也只提示「服务端缓存可能滞后，不能证明由本次指令导致」。这个谨慎程度和 Norr 的 `confirmation.rs` 一致。

---

## 3. 移植到 Norr 的内容

代码改动（`cargo test -p norr-vehicle-core` 28 项通过、严格 Clippy 通过、`cargo check -p norr` 通过、前端 21 项测试与 `npm run build` 通过）：

| 文件 | 改动 |
| --- | --- |
| `crates/vehicle-core/src/china.rs` | 新增 `Protocol::{Verified, Generic}`；`protocol_for()`；`parse_fleet()` 递归解析；`read_path()` / `read_request()`；`chronos_request_with()`；`probe()` + `ProbeReport` |
| `apps/native/src-tauri/src/lib.rs` | `Settings.experimentalP4`；`set_experimental_p4`；`probe_vehicle`；启动/登录/导入时同步开关 |
| `apps/native/src-tauri/src/login.rs` | 登录后新建客户端时继承实验开关 |
| `apps/harmonyos/native/src/lib.rs` | 同一套 `Settings` 字段、`set_experimental_p4`、`probe_vehicle` |
| `apps/harmonyos/entry/src/main/ets/NativeBridge.ets` | 新命令加入桥接白名单 |
| `apps/web/src/native/client.ts` | `ProbeReport` 类型；`setExperimentalP4` / `probeVehicle`；`unavailableReason` 增加 `experimental` 参数 |
| `apps/web/src/native/NativeApp.tsx` | 设置页「未验证平台（实验）」、兼容性探测结果、指令弹窗风险提示 |
| `apps/web/src/native/NativeControls.tsx`、`SchedulePanel.tsx` | 透传 `experimental` |
| `apps/web/tests/native-client.test.mjs` | 更新平台门禁测试 |

### 3.1 协议选择规则

```
platform ∈ {ICUP, AccountLinking}  →  Verified（原 P2 路径，完全不变）
其它 / 缺失                        →  Generic（C3Companion 路径）
```

Generic 的差异：

1. 读取请求体 `{2: VIN}`（不再带 UUID）；
2. `GetLatestHealth` / `GetLatestOdometer` / `GetLatestPreCleaning` / `GetLatestTimers`；
3. 位置 `GetLastParkedLocation`；
4. chronos 客户端标识 `PolestarApp`。

### 3.2 安全边界

- **读取**：任何车队内车辆都可读，只读、无副作用；用于探测。
- **写入**：`vehicle()` 对 Generic 平台返回错误，除非设置里开启「允许未验证平台控制」。开启后仍需车辆 `supports*` 能力位为 `true`，仍需系统身份验证（解锁/尾门/车窗/OTA 等），仍走回读确认。
- 设置页明确写「仅在你理解风险、并会在车旁逐项核对时开启」；指令弹窗再次提示「按通用格式发送」。
- 失败不会自动重发；`confirmation.rs` 的 10 分钟回读窗口与字段匹配保持不变。

### 3.3 兼容性探测

设置 → 偏好 → 未验证平台 → 「运行兼容性探测」：

- 依次读 14 个 endpoint，先用该平台的主协议；
- 若失败或字段全空，自动用另一种协议重试一次，结果标记「回退」；
- 返回 `kind / status / fields / protocol / fallback`，只读，不发指令。

探测结果会给出每个 endpoint 实际使用的协议；若某种协议明显更有效（且原平台是未验证平台），客户端会在本次会话内记住该 VIN 的协议偏好，后续读取与指令都改用它。已验证的 P2 路径不会被探测结果改写。

这是在没有 P4 实车的情况下，唯一能给出可复核证据的入口。

---

## 3.4 实车验证记录（2026-11-21，中国区 Polestar 4 2023 / HUANFU）

用本机已有会话续期后，以 `crates/vehicle-core/examples/probe.rs` 对一辆真实 P4 做了只读探测。

**车队返回值**：`model=Polestar 4`、`modelYear=2023`、`platform=HUANFU`、`owner=true`；能力位包含
`supportsLock/Unlock/DirectUnlock`、`supportsFlash`、`supportsHonk/HonkAndFlash`、
`supportsParkingClimatization`（含座椅/方向盘/降温/直接启动/重复日程）、
`supportsChargingFunctions`、`supportsGlobalChargeTimer`、`supportsTargetChargeLevelSetting`；
**不包含** `supportsRemoteWindowControl`、`supportsRemoteTrunkControl`、`supportsAirPurification`、
`supportsRemoteOtaInstallSchedule`。

**探测结果：9/14 项成功，全部走通用协议（VIN-only + `GetLatest*`），单轮约 7 秒。**

| endpoint | 结果 | 说明 |
| --- | --- | --- |
| battery | ✅ 6 字段 | 49%、227 km、chargeState=2、connection=2；字段 12 为 35.7（含义待定） |
| exterior | ✅ 2 字段 | 锁=2（已锁），3–14 全为 2（关闭），新增字段 15=1、16=2 |
| climate | ✅ 2 字段 | activity=idle、车内 27.5 ℃；未运行时无目标温度 |
| odometer | ✅ 4 字段 | 约 4.8 万 km、trip 约 740 km、字段 6=22 |
| target | ✅ 1 字段 | **90%**；数据在外层字段 4，不是字段 3 |
| health | ✅ 4 字段 | 保养 9 天 / 14,607 km、四轮胎压 244.4/249.9/252.6/249.9 kPa；新增 46/47 子结构 |
| software | ✅ 4 字段 | 版本 4.2.11、state=9 |
| softwareSchedule | ✅ 1 字段 | status=1，无计划 |
| climateTimers | ✅ 1 字段 | 空列表（`timers=[]`） |
| chargeTimer | ✅ 0 字段 | 响应为空，无全局窗口 |
| amperage | ❌ Unimplemented | P4 无此服务（能力位也不含电流上限） |
| airQuality | ❌ 无数据 | 响应只有 VIN，P4 不返回 PreCleaning |
| chargeLocations | ❌ InvalidArgument | 能力位不含充电地点 |
| location | ❌ NotFound | 两种方法都未返回；可能 P4 不提供或需不同请求体 |

**由此确认的解析差异（已修）**：HUANFU 的 chronos 读取把 payload 放在外层 **字段 4**，P2 在字段 3；`wire::payload_from` 现在按协议尝试 3/4。电池百分比是 **fixed64**，原解析器已能处理。其余字段与 P2 语义一致。

### 3.5 控制测试（空调，2026-11-21）

用户同意后只测试了空调，未发送 `honk`/`honkFlash`/`flash`，也没有发过 `lock`/`unlock`。

1. `climateStart 22 ℃`（第一次，P2 的 f32 温度）：回执 `{1:{1:请求ID,2:VIN,4:"1527",5:时间戳}}`，`data.3` 缺失（protobuf 默认 0 = `UNKNOWN_ERROR`）；等待 45 s+ 后 `climate.activity` 仍为 `idle`。
2. 对照 [xiaowo-remote](https://github.com/melosbot/xiaowo-remote) 从沃尔沃官方 APK 5.68.0 提取的契约：
   `ClimatizationStartRequest.compartmentTemperatureCelsius` 是 **double（fixed64）**，不是 float。Norr 的 P2 路径一直发 f32，P4 会把它当未知字段丢弃。
3. 改为 Generic 协议发 `wire::double(3, 22.0)` 后重试：回执仍是 `4:"1527"`、`status` 缺失，`climate` 仍为 `idle`。
4. `climateStop` 同样返回 `4:"1527"`。
5. `availability`：`status=1`（available）、`usageMode=1`（abandoned）、`reason=null`，但 `reportedAt` 停留在**前一天 20:36**。
6. 所有读取（battery/climate/exterior）的 `reportedAt` 都在前一天 20:36 左右，说明云端是 16 小时前的缓存，车辆自那以后没有上报。

**结论（待用户现场确认）**：`1527` 很可能是车端拒绝码（离线/休眠/前置条件不满足），而不是客户端编码错误；但温度字段类型确实是一个独立缺陷，已修。下一步需要确认车辆当前是否真的在运行空调、官方 App 同时能否启动，才能区分"车端拒绝"与"请求体仍有差异"。

**未做的测试**：未发送鸣笛/闪灯；`lock` 仅 dry-run。

### 3.6 真正的 P4 后端：Geely ECARX xchanger（2026-11-21 晚）

用户提供了官方车辆状态响应与 URL：

```
GET https://device-api.xchanger.cn/remote-control/vehicle/status/<VIN>?latest=False&target=basic%2Cmore&userId=<uid>
```

响应形态为 `{"code":"1000","data":{"result":...,"vehicleStatus":{...}}}`，包含 `basicVehicleStatus.position`、`climateStatus`、`drivingSafetyStatus`、`electricVehicleStatus` 等。结论：

1. **P4（HUANFU）的官方 App 走 Geely ECARX xchanger REST，不走 c3 InvocationService。** 这解释了 `ClimatizationStart` 返回 `status=0 / msg="1527"`：c3 对该平台不是指令通道。
2. **位置编码**：`latitude=39.85°×3,600,000`、`longitude=116.30°×3,600,000` 是**毫弧秒**（度 × 3,600,000），即约 `39.85°N, 116.30°E`（示例坐标）。同 [`geely-connect`](https://github.com/YossiKon/geely-connect) 的 `ARC_MS_PER_DEGREE = 3_600_000` 一致；`marsCoordinates=false` 表示 WGS-84。
3. 现有 Polestar c3 access token 直接请求该接口返回 `401 / 1402 访问令牌无效`；xchanger 需要自己的 token 与 `x-operator-code` / `x-app-id` / HMAC-SHA1 `x-signature`（见 [`geely_galaxy_ha`](https://github.com/kooritea/geely_galaxy_ha) 的 xchanger 客户端，但其 operator 是 `geelygalaxy`，不能直接复用）。
4. 用户给出的状态里 `preClimateActive=false`、`airBlowerActive=false`、`updateTime=1795178196667`（前一天 20:36）、`temStatus.connectivityStatus=null`：空调未启动，车辆自昨晚未上报，可能处于休眠/离线。

**下一步阻塞点**：要接 xchanger，需要 Polestar 中国区官方 App 的 xchanger 配置（operator code、app id、签名 secret）或一份已签名的请求；仅有 URL 与 userId 不够。

### 3.8 签名破解与接入结果（2026-11-21 13:20）

用户提供了一份 iOS 官方 App 的已签名请求（仅 headers）。用已知的 status URL 离线枚举后，**签名完全匹配**：

```
application/json;responseformat=3
x-api-signature-nonce:<UUID>
x-api-signature-version:1.0
<空行>
latest=False&target=basic%2Cmore&userId=<userId>
base64(md5(body))
<timestamp>
GET
/remote-control/vehicle/status/<VIN>
```

HMAC-SHA1(appSecret) → Base64。匹配到的关键点：body MD5 行之后依次是 timestamp、method、path，`Accept` 行是 `application/json;responseformat=3`；此前的失败是空行数量差了一个。

**实车结果**：

| 操作 | 结果 |
| --- | --- |
| `GET /remote-control/vehicle/status/{vin}` | `code 1000`；位置 39.85 / 116.30（alt 约 60，mars=false）；电量约 47%、续航约 220 km |
| 空调状态 | 首次读到 `preClimateActive=true`、车内 19.9 ℃（此前 c3 的 climateStart 最终生效） |
| `PUT /remote-control/vehicle/telematics/{vin}`，`serviceId=RCE_2`，`command=stop` | `code 1000 / operationResult 1` |
| 回读 | `preClimateActive=false`、`updateTime` 刷新 |

**已落地到 Norr**：

- `crates/vehicle-core/src/xchanger.rs`：JWT 解析、签名、状态、指令、坐标解码（度/毫弧秒自适应），4 项单元测试。
- `credentials.rs`：`xchanger-token` 存入系统凭据（Keychain/Keystore/DPAPI）。
- `apps/native/src-tauri/src/lib.rs`：`set_xchanger_token` / `xchanger_status` / `xchanger_climate`。
- `apps/web/src/native/NativeApp.tsx`：设置 → 账号 → xchanger 令牌；车辆页 HUANFU 面板显示位置/电量/空调，并提供开/关空调。
- 官方 appSecret 不再写死源码：通过 `NORR_XCHANGER_APP_SECRET` 构建环境变量注入（与登录 key 同一策略）。

**验证**：`cargo test` 34 项、Clippy、`cargo check -p norr`、前端 21 项测试与构建全部通过；真实车辆上已用 Rust CLI 完成 status 与 stop。

### 3.9 自动换取 xchanger 授权（HAR 确认，2026-11-21 13:40）

用户提供了一份完整 HAR（登录 → 换令牌 → 车辆信息）。关键请求：

```
POST https://user-api.xchanger.cn/auth-center/account/session
body: {"accessToken": <Polestar 网关 accessToken>, "identityType": "polestar"}
→ data.accessToken (xchanger JWT) + refreshToken + userId
```

注意：`accessToken` 是登录响应的**顶层网关 token**（`polestar-app-ios`，约 568–573 字符），不是 `globleToken` 里的 Polestar ID token；`identityType` 是 8 字符的 `polestar`，放在 **body** 里，不是 query。响应 `code` 是数字 `1000`。

Norr 已接入：

- `XchangerClient::exchange()` 实现该交换；
- 登录成功后（`commit_session`）自动交换并保存，失败不阻塞 Polestar 登录；
- `xchanger_status`/`xchanger_climate` 在无令牌或收到 `1402` 时自动重新交换；
- 前端移除了手动令牌输入，设置页只保留「重新获取授权」。

### 3.12 目标电量修正（2026-11-21 14:25）

c3 `GetTargetSoc` 对 P4 返回 `90`，与官方 App 的 `100%` 不一致（疑似旧缓存/另一组预设）。HAR 显示 xchanger 有独立接口：

```
GET https://api.xchanger.cn/remote-control/vehicle/status/soc/{vin}?setting=charging
→ {"code":"1000","data":{"soc":"1000","socTime":"..."}}
```

`soc` 以 0.1% 为单位：`1000` = 100%。Norr 新增 `XchangerClient::target_soc()` 与 Tauri `xchanger_target_soc`，P4 的 `mergeXchangerSnapshot()` 用该值覆盖 c3 的 `target.percent`；实测返回 100%。

**写入（2026-11-21 14:32，HAR 确认）**：

```
PUT https://device-api.xchanger.cn/remote-control/vehicle/telematics/{vin}
{
  "latest": false, "serviceId": "RCS", "command": "start", "creator": "tc",
  "serviceParameters": [
    {"key": "operation", "value": "4"},
    {"key": "rcs.setting", "value": "1"},
    {"key": "soc", "value": "1000"}
  ],
  "userId": "...",
  "operationScheduling": {"scheduledTime": null, "interval": 0, "occurs": 0, "recurrentOperation": true, "duration": 60}
}
```

`soc` 同样以 0.1% 为单位。Rust 已实现 `set_target_soc()`，P4 的 `target` 动作在 `sendCommand` 中改走 xchanger 并轮询回读；实测 100% → `operationResult=1` → 回读 100%。

**仍缺**：锁车/充电等其它 serviceId、把 xchanger 状态更完整地并入快照、刷新令牌的主动续期。

### 3.10 P4 位置与中文地址（2026-11-21 14:10）

- c3 的 `dtlinternet` 位置服务对 P4 全部失败（`GetLastKnownLocation`/`GetLastParkedLocation` 均 gRPC 5），界面不应再显示这个错误。
- P4 位置改由 xchanger `basicVehicleStatus.position` 提供：经纬度为毫弧秒（度 × 3,600,000），`marsCoordinates=false` 为 WGS-84、`true` 为 GCJ-02；`updateTime` 作为观测时间。
- `VehicleMap` 增加 `position` 覆盖：P4 使用 xchanger 坐标，P2 继续用 c3；坐标按 `marsCoordinates` 选择坐标系。
- 中文地址：官方 App 的 AMap Android/iOS key 均为平台锁定（`USERKEY_PLAT_NOMATCH`），不能用于 Web 服务。改用 OSM Nominatim（`accept-language=zh-CN`，无 key），实测返回「北京市丰台区…」（已脱敏），与官方高德结果一致。新增 Tauri `reverse_geocode` 命令，只在位置变化时请求，符合 Nominatim 每秒 1 次的限制。
- 如需更高精度，可后续在设置中增加「高德 Web 服务 key」，走 `restapi.amap.com/v3/geocode/regeo`，与 Nominatim 做回退。

### 3.11 P4 空气质量与统一界面（2026-11-21 14:15）

- xchanger `additionalVehicleStatus.pollutionStatus` 提供 `interiorPM25`、`interiorPM25Level`、`exteriorPM25Level`、`relHumSts`；Norr 将其合并为 `airQuality` 读数（PM2.5、测量时间），不再显示 c3 的读取失败。
- `mergeXchangerSnapshot()` 同时把 `preClimateActive` 映射为 `climate.activity`，`interiorTemp` 映射为车内温度，使现有控制页、快捷控制与空气质量面板直接使用 xchanger 数据。
- 移除了车辆首页独立的「Polestar 4 远程（xchanger）」面板；P4 的空调启停并回原有「快捷控制 / 控制」按钮，`sendCommand` 对 HUANFU 的 `climateStart/Stop` 自动改走 xchanger，并沿用 15×3 秒回读确认；温度来自现有对话框（16–28 ℃，默认 22）。
- `unavailableReason` 对 HUANFU 的空调动作不再要求「未验证平台」开关，其它动作仍需显式开启。

- 空气质量沿用控制页与详情页的现有面板，展示 xchanger `pollutionStatus.interiorPM25` 与测量时间；首页不单独加卡片。
- 空气净化开关：这辆 P4 的 xchanger 能力目录只有 `remote_PM25_query_2`（查询），没有净化 functionId。尝试以 `remote_purification`、`RCE_3`、`remote_PM25_query_2` 作为 `serviceId` 发送 start，均返回 `8500 服务器端内部异常`。官方 App 的净化控制器是 C3 / PCCS / Vocmo 路径，不适用于 HUANFU。**在拿到官方 P4 净化动作的抓包前，不添加无法验证的开关。

### 3.7 官方 APK 分析（com.polestar.china.android 4.25.0，2026-08-10）

从用户手机 `192.168.0.35:35715` 通过 ADB 拉取官方 APK（130 MB，16 个 dex），jadx 反编译后确认：

- xchanger 主机：`https://api.xchanger.cn`（`user-api` / `device-api` 等子域由 `HOST_KEY` 决定）。
- `X-OPERATOR-CODE`：`POLESTAR`（`com.polestar.geelysdkadapter.core.cliif` 中硬编码）。
- `X-APP-ID`：`polestar-app`（`p7.clifor` 构造参数；与 token 的 `appId` 一致）。
- 签名密钥：`p7.clifor(appID, appSecret, license, ...)` 的 `appSecret`，写入 `NetworkConfig.setSignSecret()`；具体值已从 APK 提取，**不写入仓库**（本机分析目录）。
- 签名实现：`com.baselinelibrary.sign.SignUtil.sign()`：
  ```
  <Accept 头值>

  x-api-signature-nonce:<nonce>

  x-api-signature-version:1.0

  

  <按 key 排序的 query，逗号转 %2C>

  base64(md5(body))
  <METHOD>

  <timestamp>

  <path>
  ```
  用 **HMAC-SHA1**，密钥为 appSecret，结果 Base64 放 `X-SIGNATURE`；`X-TIMESTAMP` 为毫秒。
- 状态接口：`GET /remote-control/vehicle/status/{vin}?userId=&latest=&target=basic%2Cmore`，`@Headers({"urlname:device-api"})`。
- 用用户提供的 xchanger JWT 请求，网关返回 `1445 验签签名错误`（token 已被接受，签名未过），说明 token 有效、仅签名规范化串/密钥仍有差异。已尝试 SignUtil 与 galaxy 两种顺序、三种 query 编码、两种 Accept，均 1445；下一步需要一份**已签名的真实请求**做离线比对。

---

## 4. 如何验证（需要你的 P4）

1. 把签名 key 放进 `.env.secrets`（`NORR_POLESTAR_CN_SIGNING_KEY=...`）。APK 里的常量可作为来源；**不要提交到仓库**。
2. `npm ci && npm run build:mac`（或你用的平台），登录中国区账号，选择 P4。
3. 设置 → 偏好 → 「运行兼容性探测」。
4. 预期判读：
   - 多数 endpoint `success` 且 `fields > 0`：通用协议可用；再开启控制，先测 `lock`，看回读是否「回读一致」。
   - 全部 `failed`：P4 走的是另一套服务/主机，需要抓官方 App 的流量再补协议，当前移植不够。
   - 只有 `battery/exterior/climate` 成功、chronos 失败：常见于 c3Lbs 未下发或 P4 无该服务，属正常。
5. 无论结果如何，**不要把未验证的结论写成"已支持"**；按仓库习惯把实际结果写进 `docs/PROGRESS.md`。

---

## 5. 仍未解决的问题

1. **P4 字段映射**：battery/exterior/climate/odometer/health/target/software/timers 已用真实响应验证；location/airQuality 走 xchanger，不再依赖 c3；exterior 新增字段 15/16 的含义与 health 的 46/47 子结构仍未完全解读。
2. **服务主机**：c3 仍是 `*.volvocars.com.cn`；P4 的 xchanger 走 `device-api.xchanger.cn` / `user-api.xchanger.cn`，已单独校验主机。
3. **`GetLatest*` vs `Get*`**：未验证平台使用 `GetLatest*` 已实测可用；P2 继续使用 `Get*`。
4. **指令体**：HUANFU 的指令走 xchanger `PUT /remote-control/vehicle/telematics/{vin}`（`serviceId=RCE_2`），c3 Invocation 对该平台不可用。
5. **macOS 宿主构建**：本机沙箱不允许 SwiftPM 再嵌套 `sandbox-exec`，因此 `cargo check -p norr` 是在临时跳过 Widget Swift 链接后完成的；`npm run build:mac` 需要在你自己的终端里验证。
6. **签名 key / ToS**：内置 key 的分发与使用是否符合厂商条款，属于合规问题，不是代码问题。

---

## 6. 与 Norr 现有设计的衔接

- 没有改 `confirmation.rs`：回读证据链对任何平台都成立。
- 没有改 P2 的请求体/方法名：`Protocol::Verified` 分支逐字节保持原样。
- 没有把 APK 的密钥、账号、日志写进仓库。
- 新增的 `Protocol` 是显式枚举，不是 `if platform == "HUANFU"` 的散落分支；后续接 P4 专用协议时可以再加 `Protocol::Huanfu`，不影响现有两条路径。
