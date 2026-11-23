# 中国区 Polestar 4 API 验证

2026-11-20，使用用户已登录的独立 Norr P4 账号，对照官方 Android App 4.25.0 的本机解包资料完成认证与只读接口验证。Geely 车库返回一辆 Polestar 4；本轮没有发送车锁、空调、充电、寻车或数字钥匙操作。

**本机 Norr P4 已接入只读车况。** 已安装应用可恢复登录并读取 P2 的 14 组及 P4 的 8 组数据。车况与充电预约的实测范围见[安装与验证](polestar4-macos-testing.md)。

## 实际结果

所有请求保留 TLS 校验。表中 `{vin}` 来自当前账号的车辆列表，文档和日志不保存 VIN、手机号、坐标、账号标识或令牌值。

| 用途 | 方法、主机、路径 | 本轮结果 |
| --- | --- | --- |
| 换取 Geely 会话 | `POST user-api.xchanger.cn/auth-center/account/session` | HTTP 200，返回 accessToken、refreshToken、userId、clientId、expiresIn；已保存 |
| Geely 续期 | `PUT user-api.xchanger.cn/auth/account/session/secure` | HTTP 200；新访问令牌已保存，随后车辆读取成功；再次续期也成功 |
| 车库 | `GET device-api.xchanger.cn/device-platform/user/vehicle/secure` | HTTP 200，`serviceResult.operationResult=0`，一辆 Polestar 4 |
| 综合车况 | `GET device-api.xchanger.cn/remote-control/vehicle/status/{vin}` | HTTP 200，返回 `vehicleStatus`；`latest=true` 和 `false` 均已验证。部分响应为 `operationResult=1`，须保留等待车辆更新的状态 |
| 车辆模式 | `GET device-api.xchanger.cn/remote-control/vehicle/status/state/{vin}` | HTTP 200，返回 powerMode、engineState、驻车/露营等模式字段 |
| 能力配置 | `GET api.xchanger.cn/geelyTCAccess/tcservices/capability/{vin}` | HTTP 200，业务码字符串 `"1000"`，56 项配置，56 项 `valueEnable=true` |
| 充电设置读取 | `GET api.xchanger.cn/charge-server/ecarx_charge_set/{vin}` | HTTP 200，返回 btActive、cwSwitch、bizType、btTempActive 等字段 |
| 充电状态 | `GET api.xchanger.cn/charge-server/charge_status/{vin}` | HTTP 200，返回 soc、chargeSts、remainingTime、statusOfChargerConnection |

能力配置代表服务端声明的能力，不等于控制命令已实车验证。已安装应用补验了充电预约列表，返回成功且列表为空。有计划的车辆、预约编辑、云端行程、OTA 和数字钥匙仍待后续验证。

综合车况中的 `additionalVehicleStatus` 返回 9 个分组，包括电驱与充电、保养、空调、驾驶安全、运行和空气质量；数值主要以字符串返回。末轮电量、续航、里程均通过数值范围检查，观测时间约在请求前 0.4 小时，不能当作实时车况。后续适配需逐项处理单位、枚举、空值和无效值。

| Norr 需要的信息 | 已观测的字段路径（相对于 `vehicleStatus`） |
| --- | --- |
| 电量、续航、充电 | `additionalVehicleStatus.electricVehicleStatus.chargeLevel`、`distanceToEmptyOnBatteryOnly`、`chargeSts`、`statusOfChargerConnection` |
| 里程、保养、胎压相关状态 | `additionalVehicleStatus.maintenanceStatus.odometer`、`distanceToService`、`tyreStatus*`、`tyrePreWarning*` |
| 门锁、车门、后备箱 | `additionalVehicleStatus.drivingSafetyStatus.centralLockingStatus`、`doorLockStatus*`、`doorOpenStatus*`、`trunkOpenStatus` |
| 温度、车窗、空调 | `additionalVehicleStatus.climateStatus.interiorTemp`、`exteriorTemp`、`winStatus*`、`preClimateActive` |
| 位置及可信标记 | `basicVehicleStatus.position`；本轮不输出坐标值 |
| 观测时间 | `updateTime`，不可用本机请求完成时间替代 |

`result.serviceResult.operationResult=1` 在 SDK 中定义为 SUBMIT。即使响应同时包含完整车况，也只能证明服务端返回了已有数据，不能据此宣称车辆刚完成回读。验证工具保留 `freshnessPending=true`，不会把该状态当作控制完成。

## 无官方 App 会话时的交叉核对

从钥匙串恢复 Norr P4 会话后，车库、缓存车况和充电状态再次读取成功。缓存响应仍包含车辆上报时间和 `operationResult=1`。脱敏结果保存在 `target/polestar4-probe/readonly-followup.jsonl`。官方 App 的同屏读数对照和车辆上报时间随状态变化的样本仍待采集。

- 电量与续航来自 `chargeLevel` 和 `distanceToEmptyOnBatteryOnly`，官方转换见 `jadx/sources/u7/clicatch.java`，本轮实测两者均可解析为有效数值。官方 `jadx/sources/com/polestar/carcontrol/ui/status/CarLogFragment.java` 以公里展示 `odometer`。
- 中控锁值 `0` 表示解锁、`1` 和 `2` 表示锁定、`7` 表示未知。定义见 `jadx/sources/com/polestar/geelysdkadapter/data/LockStatus.java`，转换见 `jadx/sources/y7/clibreak.java`。车门开闭使用独立字段。
- 官方车况转换按 `chargerState`、`statusOfChargerConnection`、`chargeSts` 和 `timeToFullyCharged` 的组合区分充电中、初始化、暂停、中断、已充满和预约等状态，见 `jadx/sources/u7/cliclass.java`。独立充电状态接口的字段较少，其完整显示规则仍待核对。

## 11 月 20 日第二轮只读补证

以下时间均为雅加达时间（UTC+7）。13:36:24 至 13:54:05，测试包保存了 10 次 P4 快照。这段时间电池与综合车况沿用同一个车辆上报时间。每次独立读取的车辆模式均为同一组值，10 次预约查询均成功且列表为空。重复采集覆盖了缓存场景，状态切换仍缺对照。

| 项目 | 本轮证据 | 可据此采用的结论与余项 |
| --- | --- | --- |
| 四轮数值 | 同一次缓存读取中，左前 285.584、右前 280.092、左后 278.719、右后 275.973，四个告警码都是 0。SDK 在 `MaintenanceStatus.java` 中分别用 Float 和 Integer 保存两组字段 | 按用户指定的 kPa 展示口径，四轮分别显示 286、280、279、276 kPa。快照保留原始精度，界面四舍五入取整。按用户指定的显示规则，告警码 0 显示“正常”，缺值和其他码显示“状态待核实”。车机的「我的汽车」视图可查看胎压监测信息。[极星 4 胎压监测手册](https://www.polestar.cn/zh-cn/manual/polestar-4/2025/article/47d2c97fd33effd3c0a8cc3718c999b7-07cc2040ce18cfd6c0a8b04a75f8edba-8664b2fa77a7e089c0a8296870d1a409/) |
| 露营、驻车舒适 | `VehicleState.java` 分别声明整数 `campingModeActive` 和 `parkComfortState`。样本持续返回 0、1。官方软件说明确认驻车舒适为独立功能 | 当前资料没有给出两组值到开关状态的对照。需车机显示某项状态时的同时间样本，单一组合不能定义整张枚举表。[极星 4 软件更新](https://www.polestar.cn/zh-cn/manual/polestar-4/2024/software-updates/) |
| 定位 | 官方 P4 分支 `z7/clitry.java` 取综合车况位置；`z7/clibyte.java` 将纬度、经度分别除以 3,600,000。`MapViewModel.java` 拒绝任一轴为零的车辆点，对有效点执行高德 `CoordType.GPS` 转换。本车 `posCanBeTrusted=true`、`carLocatorStatUploadEn=true`、`marsCoordinates=false`，两轴换算后均非零且在有效范围内 | 本样本与 GPS 输入路径一致。仍缺停车点独立对照，以及 `marsCoordinates=true` 时的样本。诊断仅输出标志与范围检查结果，未将本车坐标发送到地图服务。[高德坐标转换接口](https://a.amap.com/lbs/static/unzip/Android_Map_Doc/3D/com/amap/api/maps/CoordinateConverter.html) |
| 充电预约 | `ChargingResultBean.scheduleList` 的元素类型为 `ScheduleBean`，包含 `startTime`、`day`、`duration`、`cw`、`timerActivation` 五个字符串字段。实机充电页已打开「计划与地点」并显示「暂无充电预约」 | 空列表从读取到页面显示已验收。非空条目的时间格式、跨日、重复规则及启用状态仍需一条自然存在的预约和车机显示时间配对。 |
| 会话 | 11:50 左右的续期日志记录授权更新；13:50:00，独立 Geely 钥匙串条目修改，13:50:03 后持续成功读取。14:04 后再从新进程恢复并读取，GUI 重开仍直接连接 P4 | 与原生客户端在到期前 60 秒进入续期的规则一致，可确认连续使用跨过前一轮两小时窗口。现有证据无法断定刷新时旧访问令牌已经失效；完全退出应用超过访问令牌有效期后的冷启动，以及长期刷新授权失效仍待实测。 |

复核用签名构建的 `--verify-session` 在成功解析 P4 综合车况后输出 `p4FieldEvidence`，包含三个定位标志、两项范围判断和分轮原始数值。该轮脱敏输出在本机 `target/polestar4-probe/native-field-evidence.log`。普通 GUI 的历史格式、P2 读取和 P4 控制权限沿用此前实现。

## 认证与持久保存

中国区存在不同用途的授权：

1. 中国区登录响应的**外层** `login.accessToken` 用于 Geely 交换。请求体为 `{"identityType":"polestar","accessToken":"<外层令牌>"}`。
2. `login.globleToken` 用于现有 P2/Volvo 服务，不能代替上述外层令牌。
3. Geely 返回自己的 accessToken、refreshToken、userId 和 clientId；后续请求携带原始 `Authorization` 值与 `X-CLIENT-ID`，不添加 `Bearer ` 前缀。

Geely 凭据保存在 macOS 钥匙串 `service=app.norr.mac.polestar4`、`account=polestar-geely-session`。原中国区会话仍为同一 service 下的 `polestar-china-session`，原 Norr 仍使用 `app.norr.mac`。

保存内容包含账号作用域摘要和续期时间。账号改变时不复用旧 Geely 会话；验证进程互斥，避免同时轮换凭据。辅助程序只允许写入 P4 的 Geely 条目，不允许修改中国区登录条目或原 Norr 条目。

本轮 Geely `expiresIn` 为 7200 秒。续期响应只包含 accessToken、expiresIn、refreshFailureTime，**没有新的 refreshToken**：合并新字段并保留已有 refreshToken、userId、clientId，然后立即写回钥匙串。已经验证连续续期以及另一个进程从钥匙串恢复并读取车库、车况，全程未请求短信验证码。

本轮服务端返回的 refreshFailureTime 约为 30 天后。已验证的是主动续期和进程间恢复，尚未等待访问令牌自然过期或刷新授权到期；服务端撤销、过期或要求重新验证时仍可能需要短信登录。验证工具在运行时检查到期并续期，没有配置后台常驻任务。

## 请求细节与排错结论

- Retrofit 的 `@Query(CarKeyConstants.Params.BTCarKey.KEY_uid)` 实际展开为 **`userId`**，不是 `uid`。后者导致综合车况返回 HTTP 200 / 业务码 `1400` / 请求参数不合法。修正后 `latest=true`、`latest=false` 均能返回车况。
- 车辆列表使用 `userId` 和 `needSharedCar=1`；综合车况使用 `userId`、`latest` 和空字符串 `target`；车辆模式使用 `userId`。
- 能力查询使用 SDK 的 `pageSize=2000&pageIndex=1`，`vehicleType` 来自车辆列表，本次为 0；sortField、direction 为空字符串。
- 响应并非统一封装：认证、车库和部分状态直接返回数据；能力接口使用 `code/data`，且 code 是字符串。HTTP 200 本身不能代表业务成功。
- SDK 签名为 HMAC-SHA1。拼接内容包括 Accept、排序后的 X-api 签名头、排序并编码的查询参数、Base64(MD5(body))、时间戳、方法和路径。Android Base64.DEFAULT 给 MD5 结果添加的末尾换行必须保留。
- 本轮使用 `Accept: application/json` 已完成实测；APK 的默认 Accept 来自 native/JNI 解码，没有把此测试值冒充为已提取的 SDK 原值。设备标识使用 Norr P4 已保存 UUID 的 UTF-8 十六进制，保持验证工具自身的设备身份。
- 首次能力读取遇到一次响应体超时，后续成功。曾试探 SDK 的 GDPR 授权车况路径，收到 HTTP 404 且响应体未完整结束；最终工具只保留本轮所需的中国区读取路径。
- 开发验证工具时曾把“续期未返回 refreshToken”误判为失败，导致该次新访问令牌没有保存。已修复合并规则，并用仍有效的中国区外层令牌重新建立 Geely 会话；后续保存、连续续期和新进程恢复均通过。

## 官方 App 证据

本机资料目录：`/Users/manjiang/code/gitpub/Hisingen/docs/research/polestar-cn-apk/4.25.0`。这只是参考资料位置；实现与验证工具位于 **Norr** 项目。

APK 包名 `com.polestar.china.android`，versionName 4.25.0，versionCode 262。记录的 APK SHA-256 为 `99070211e99b374090ffbc3702ff7888b3d8d2cc811f4e52d1a6de4ded9074ef`。JADX 1.5.6 的整包提取记录有 552 项反编译错误；本轮逐项核对以下可读调用链，再用真实账号验证请求。

以下路径相对于解包目录：

| 证据 | 文件 |
| --- | --- |
| HUANFU 分支选择 | `jadx/sources/com/polestar/geelysdkadapter/GeelyCarPlatformAdapter.java` |
| 外层 key_token 的提供方 | `jadx/sources/com/polestar/carcontrol/clibyte.java` |
| 中国区 authLoginOneCloud、车辆列表参数 | `jadx/sources/com/polestar/geelysdkadapter/core/GeelyManagerImpl.java` |
| appID、签名配置、生产环境 | `jadx/sources/com/polestar/explore/core/carcontrol/RCSClient.java`、`com/polestar/geelysdkadapter/core/cliif.java` |
| 交换、续期、车库、能力接口 | `jadx/sources/clishort/cliint.java`、`clishort/cliif.java` |
| 车况、车辆模式、充电读取接口 | `jadx/sources/com/ecarx/open/http/clifor.java`、`com/ecarx/open/http/j.java` |
| userId 常量真实值 | `jadx/sources/com/meizu/mznfcpay/carkey/constants/CarKeyConstants.java` |
| 头字段与主机替换 | `jadx/sources/com/baselinelibrary/net/CustomOkHttpClientUtil.java`、`com/baselinelibrary/utils/ComUtils.java`、`resources/assets/host.txt` |
| 签名算法、刷新处理、结果语义 | `jadx/sources/com/baselinelibrary/sign/SignUtil.java`、`com/baselinelibrary/net/BaseTokenInterceptor.java`、`com/baselinelibrary/entity/ServiceResult.java` |

## 重复运行

工具只使用 Python 标准库和本机 Xcode/Swift、Security.framework。密钥在运行时从本机已有 APK 资料读取，不写入代码；会话只通过管道与钥匙串辅助程序交互，不放在进程参数中。

在 Norr 根目录首次构建辅助程序，并沿用固定签名证书：

```sh
mkdir -p target/polestar4-probe
xcrun swiftc scripts/polestar4-keychain.swift -o target/polestar4-probe/keychain
codesign --force --sign '<本机固定代码签名证书>' \
  --identifier app.norr.mac.polestar4.probe target/polestar4-probe/keychain
```

```sh
python3 scripts/polestar4-probe.py \
  --apk-dir /Users/manjiang/code/gitpub/Hisingen/docs/research/polestar-cn-apk/4.25.0 \
  --keychain-helper target/polestar4-probe/keychain
```

默认恢复会话，读取车库和五类 P4 数据。`--refresh` 主动验证续期；`--only vehicle_status_cached` 只读取缓存车况；`--schema` 输出字段名和类型，不输出原始车辆值。`--exchange` 仅在需要重新建立 Geely 会话时使用，与 `--refresh` 互斥。API 错误、缺少 P4 或读请求失败会使进程返回非零。

本轮脱敏日志位于 `target/polestar4-probe/`（Git 忽略）。最终读取结果见 `final-read.jsonl`，新进程缓存恢复见 `restored.jsonl`，续期过程见 `verified.jsonl`；后者保留了修正 SUBMIT 解析之前的一次非零退出，不能将其单独作为整组读取通过的证据。

离线检查：

```sh
python3 -m unittest discover -s scripts/tests -p 'test_polestar4_probe.py'
```

9 项测试覆盖签名固定样本、请求白名单、HTTP/业务错误区分、SUBMIT 缓存语义、刷新字段保留、失败不覆盖凭据、切换账号、userId 参数及部分失败退出。签名样本通过独立 Node crypto 计算核对。辅助程序拒绝写入中国区会话的检查通过。原 Norr 的 9 个文件摘要及钥匙串元数据与基线一致。

文档交付检查：Hard Gate PASS（实测与未验证项分开记录）；Purpose Gate PASS（工具用于重复验证及保存独立授权）；Craftsmanship PASS（离线测试、实测、持久保存和原账号保留检查）。本轮没有界面或视觉改动，Liveliness 不适用。
