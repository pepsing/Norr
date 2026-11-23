# P4 控制参数：Android 解包对照

2026-11-23，对照本机中国区官方 Android App 4.25.0 解包源码。方向盘加热、前排座椅加热和通风的写入参数已找到，并据此扩展 Norr 控制实现，范围见 [控制接入](polestar4-controls.md)。本文记录客户端请求构造证据，不代表当前账号获准使用或实车执行已验证。解包对照没有向车辆服务发请求。

源码根目录：`/Users/manjiang/code/gitpub/Hisingen/docs/research/polestar-cn-apk/4.25.0/jadx/sources`。下文路径、行号相对此目录。

## 共用请求

手机版 P4 座舱页面调用链已闭合：

```text
phone/page/climate/ps4/AirSeatFragment
  → Ps4ViewModel 的方向盘 / 加热 / 通风方法
  → 对应协程构造 RemoteControlRequest
  → TspEdgeIOVSDK.iovVehicleControl(vin, request)
  → com/ecarx/open/unify/iov/i.java:972
  → com/ecarx/open/http/j.java:888
  → com/ecarx/open/http/clifor.java:479
  → PUT device-api /remote-control/vehicle/telematics/{vin}
```

该请求继续使用现有 xchanger 签名。`RemoteControlRequest.java:82` 的默认值为 `command="start"`、`creator="tc"`、毫秒时间戳字符串；调用者填当前 xchanger `userId`。`ServiceParameter.java:138`、`:170` 将枚举转换成实际字符串，因此 JSON 中应使用下表右侧字符串，不能发送 Java 枚举名称。

`OperationScheduling.java:27` 的默认值为 `occurs=1`，其余数值字段为 0、`recurrentOperation=false`、`scheduledTime=null`。以下三个座舱功能均把 `duration` 设置为 **60**，包括手机版的关闭请求。这里只确认字段数值，不据此声称实际运行 60 分钟或 60 秒。

## 方向盘与前排座椅

以下均为 `serviceId="RCE_2"`，参数的值都是字符串。

| 操作 | command | serviceParameters | duration |
| --- | --- | --- | --- |
| 开启方向盘加热 | `start` | `rce.heat=steering_wheel` | 60 |
| 关闭方向盘加热 | `stop` | `rce.heat=steering_wheel` | 60 |
| 主驾座椅加热 1–3 档 | `start` | `rce.heat=front-left`、`rce.level=1/2/3` | 60 |
| 副驾座椅加热 1–3 档 | `start` | `rce.heat=front-right`、`rce.level=1/2/3` | 60 |
| 关闭对应座椅加热 | `stop` | 同一 `rce.heat` 座位、`rce.level=0` | 60 |
| 主驾座椅通风 1–3 档 | `start` | `rce.ventilation=front-left`、`rce.level=1/2/3` | 60 |
| 副驾座椅通风 1–3 档 | `start` | `rce.ventilation=front-right`、`rce.level=1/2/3` | 60 |
| 关闭对应座椅通风 | `stop` | 同一 `rce.ventilation` 座位、`rce.level=0` | 60 |

依据：

| 源码位置 | 已核对内容 |
| --- | --- |
| `com/polestar/carcontrol/vm/Ps4ViewModel$warmSteeringWheel$1.java:107` | 方向盘开启：RCE_2、heat=steering_wheel、start、duration=60 |
| `com/polestar/carcontrol/vm/Ps4ViewModel$stopSteeringWheel$1.java:106` | 方向盘关闭：stop，仍使用 duration=60 |
| `com/polestar/carcontrol/vm/Ps4ViewModel$warmZuoyi$3.java:121` | 座位映射、heat、level，0 档改为 stop |
| `com/polestar/carcontrol/vm/Ps4ViewModel$seatVentilation$3.java:121` | 座位映射、ventilation、level，0 档改为 stop |
| `com/polestar/carcontrol/phone/page/climate/ps4/AirSeatFragment.java:695` | 加热档位按 0 → 3 → 2 → 1 → 0 切换 |
| 同文件 `:728` | 通风档位使用相同的 0–3 范围 |
| `com/ecarx/open/http/request/ServiceParameter.java:45`、`:87` | 实际参数名、座位和方向盘字符串 |
| `cliprotected/cliint.java:51` | `setStopCommand()` 引用的常量确实为 `stop` |

例如关闭主驾座椅加热的请求体如下，身份与时间使用占位值：

```json
{
  "command": "stop",
  "creator": "tc",
  "serviceId": "RCE_2",
  "userId": "<当前 xchanger userId>",
  "timestamp": "<毫秒时间戳>",
  "serviceParameters": [
    {"key": "rce.heat", "value": "front-left"},
    {"key": "rce.level", "value": "0"}
  ],
  "operationScheduling": {
    "duration": 60,
    "interval": 0,
    "occurs": 1,
    "recurrentOperation": false
  }
}
```

这些请求不附带 `rce.conditioner=1` 或 `rce.temp`。方向盘只构造开关参数，没有 `rce.level`。SDK 枚举虽包含后排座位，已追踪的 P4 手机页面仅选主驾、副驾，不能据此开放后排控制。

### 两条加热路径的差异

`v7/clisuper.java:272` 是通用 `GeelyClimateController`，与手机版 `Ps4ViewModel` 同时存在：

- 方向盘分支的 serviceId、参数与启停一致；此适配器同样设置 duration=60。
- 座椅加热分支把 `HeatingIntensity.Off` 转为 `rce.level="0"`，但未调用 `setStopCommand()`，因此保留构造器默认 `command="start"`。档位转换见 `r7/clido.java:39`。
- 手机版协程对 0 档显式发送 `stop`。后续实现建议以已追踪到当前手机版页面的请求为依据，分别保存关闭请求样本；不能把两条路径拼成一个所谓“唯一协议”。服务端是否兼容二者尚未验证。

## 能力与独立回读

解包中没有找到可将 `remote_climate_control_2=true` 直接等同于方向盘和所有座椅权限的调用证据。后续 Norr 接入使用空调能力、硬件状态及已返回的细项能力组合判断，明确拒绝优先；这是待实车验证的接入策略，详见 [能力判断](polestar4-controls.md#能力判断)。

- SDK `Capability.java:419`、`:423` 分别定义 `remote_seat_preheat_switch`、`remote_seat_ventilating_switch` 的判断；`:146`、`:150` 还读取座位枚举和加热档位范围。这是 SDK 通用能力，尚未证明当前 P4 车库会返回这些字段。
- 手机版通风入口还查询目录项 `supportVentilation`（`DirectoryConfigRepo.java:428`），将其 content 转为布尔值；`AirSeatFragment.java:510` 同时检查左右 `VentSts` 非 0 才显示通风。目录开关不是账号车控授权。
- `AirSeatFragment.java:519`、`:605` 有加热与通风互斥处理：另一模式在运行时先走其关闭路径。Norr 后续应先取得可靠状态，避免未经确认就连发两条命令。
- 方向盘回读 `steerWhlHeatingSts`；座椅加热回读 `drvHeatDetail + drvHeatSts`、`passHeatingDetail + passHeatingSts`；通风回读 `drvVentSts + drvVentDetail`、`passVentSts + passVentDetail`。Norr 已有这些读取字段，仍需加入各动作的独立确认规则。

## 其他即时控制参数

下表为已核对的请求构造，使用上述默认调度字段（duration=0），除表中特别说明外 command 都为 `start`。实际车辆可用性及 Norr 接入仍需分别判断。

| 动作 | serviceId | 参数与 command | 来源 |
| --- | --- | --- | --- |
| 锁车 | `RDL_2` | `door=all` | `y7/clivoid.java:111` |
| 解锁 | `RDU_2` | `door=all` | 同文件 `:204` |
| 尾门解锁 | `RDU_2` | `target=trunk` | 同文件 `:218`，由 `unlockTrunk()` 调用 |
| 车窗打开 / 关闭 | `RWS_2` | `target=window`；分别 `start` / `stop` | 同文件 `:151`、`:93` |
| 车窗部分打开 | `RWS_2` | `target=window`、`pos=15` | 同文件 `:231`；未据此推断实际开度单位 |
| 充电口盖打开 / 关闭 | `RDO` / `RDC` | `target=front-charge-lid` | 同文件 `:138`、`:80`；枚举名虽带 `_2`，实际 serviceId 不带 |
| 单独鸣笛 / 闪灯 / 两者一起 | `RHL` | `rhl=horn` / `light-flash` / `horn-light-flash` | `z7/clitry.java:153` |
| 空气预清洁开启 / 关闭 | `RCC_2` | `rcc.ventilation=cabin`；分别 `start` / `stop` | `v7/clisuper.java:259`、`:325` |

锁车与解锁的构造方法先创建了含 `target=trunk` 的列表，随后又调用 `setServiceParameters(serviceParameter)` 覆盖列表。最终只有 `door=all`，不能把中间赋值也当成最终请求参数。电动尾门升降仍走既有默认未支持路径，不能用尾门解锁冒充。

## 与 Norr 当前写入的比较

| 项目 | 对照结果 |
| --- | --- |
| 空调开启 | `RCE_2/start`、`rce.conditioner=1`、`rce.temp` 和 duration=180 与 `v7/clisuper.java:245`、`:314` 一致 |
| 空调关闭 | Android `v7/clisuper.java:337` 仅带 `rce.conditioner=1`、stop、默认 duration=0；Norr 已删除此前 PR #3 样本多带的 `rce.temp=22`，与此路径一致 |
| 充电上限 | `RCS/start`、`operation=4`、`rcs.setting=1`、`soc=百分比×10` 与 `u7/clibreak.java:209` 一致 |
| 充电上限附加字段 | Android 通用适配器使用默认调度；Norr 的 `latest=false`、duration=60、occurs=0、recurrentOperation=true 来自此前 iOS 抓包验证，不能称为与本 Android 路径逐字段一致 |
| 方向盘 / 座椅 | 已接入前端选档、单层确认、能力判断、签名 PUT 和独立回读；停止请求保留 duration=60，座椅档位 0 使用手机版 stop 分支 |

解包对照阶段 46 项离线断言通过，覆盖参数枚举、请求类默认值、手机版启停分支、SDK 路由和本文 JSON 示例。后续代码实现与打包验证另见 [控制接入](polestar4-controls.md#验证记录)。

文档适用项检查：Hard Gate PASS（请求证据可定位，未知权限与实车结果明确保留）；Purpose Gate PASS（按操作比较字段，并单列不同调用路径）；Craftsmanship PASS（46 项源码断言及 JSON 校验）。Liveliness 不适用，本轮未修改界面或视觉。
