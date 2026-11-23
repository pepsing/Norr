# 中国区 Polestar 4 xchanger 签名与接口

中国区 Polestar 4（平台 `HUANFU`）的车况与车控走 ECARX xchanger REST 服务，不走 P2 使用的 c3 gRPC。c3 `InvocationService` 对 HUANFU 指令返回 `1527`。xchanger 每个请求都要带 HMAC-SHA1 签名，与中国区网关的 MD5 query 签名（`NORR_POLESTAR_CN_SIGNING_KEY`）是两套独立机制。

本文依据官方 Android App 4.25.0 的反编译源码、Norr 本地 P4 只读验证（[API 验证记录](polestar4-api-verification.md)）和 PR #3（qicents，`feat/p4-xchanger`）的 iOS 抓包比对整理。文中不包含密钥、令牌、VIN、账号标识或坐标。

## 两套签名的区别

| | 中国区网关 | xchanger |
| --- | --- | --- |
| 主机 | `*.polestar-auto.com` 网关 | `user-api`、`device-api`、`api` `.xchanger.cn` |
| 用途 | 登录、短信、令牌刷新、车辆列表 | P4 会话、车库、车况、能力、充电、车控 |
| 签名位置 | query 参数 `sign` | 请求头 `X-SIGNATURE` |
| 算法 | `hex(MD5(S + 排序 query + S))` | `Base64(HMAC-SHA1(appSecret, 规范串))` |
| 覆盖范围 | 只签 query | Accept、签名头、query、body 摘要、时间戳、方法、路径 |
| Norr 配置 | `NORR_POLESTAR_CN_SIGNING_KEY` | `NORR_XCHANGER_APP_SECRET` |

## 签名算法

实现位于 `com/baselinelibrary/sign/SignUtil.java:203`，调用方是同目录的 `SignInterceptor.java:39`。

```text
X-SIGNATURE = Base64(HMAC-SHA1(key = UTF8(appSecret), data = UTF8(规范串)))
```

规范串按以下顺序拼接，`\n` 为换行：

```text
<Accept 头值>\n
x-api-signature-nonce:<nonce>\n
x-api-signature-version:1.0\n
\n
<规范 query>\n
<Base64(MD5(body))>\n
<毫秒时间戳>\n
<HTTP 方法>\n
<路径>
```

各段规则：

1. **头部段**（`getHeaders`）：先写名为 `Accept` 的头的值。然后取名称以 `X-api` 开头的所有头，按名称排序，每行写成 `小写名称:去首尾空白的值`。当前只有 `X-api-signature-nonce` 和 `X-api-signature-version` 两个。每行以 `\n` 结尾。头部段之后再接一个 `\n`，形成空行。
2. **query 段**（`getParam`）：从完整 URL 的 `?` 之后按 `&`、`=` 切分，放入 `TreeMap` 按 key 排序，用 `&` 连接 `key=value`。值是 URL 中已编码的文本，再做 `+`→`%20`、`*`→`%2A`、`%7E`→`~`、`,`→`%2C` 替换。没有 query 时为空串，该行只剩换行。
3. **body 摘要**（`getMD5`）：对 body 的 UTF-8 字节求 MD5，用 Android `Base64.DEFAULT` 编码。DEFAULT 会在结果末尾加 `\n`，所以摘要与时间戳之间只有这一个换行，源码里没有额外拼接。空 body 的摘要是 `1B2M2Y8AsgTpgAmY7PhCfg==`。multipart 请求改为对文件内容求十六进制 MD5，Norr 不使用。
4. **时间戳**：`System.currentTimeMillis()`，与 `X-TIMESTAMP` 头同值。
5. **方法**：大写，如 `GET`、`PUT`。
6. **路径**（`getUrl`）：去掉协议、主机和 query 后的路径，以 `/` 开头。

签名串只覆盖 Accept 和 `X-api-*` 头。`X-APP-ID`、`Authorization`、`X-CLIENT-ID` 等头不参与签名，但服务端会单独校验。

### 固定样本

PR #3 用真实 iOS 请求离线比对，确认了下面的规范串（VIN 与 userId 已替换）。Norr 的签名实现应以此为单元测试样本：

```text
application/json;responseformat=3
x-api-signature-nonce:D06E68FE-6137-4DF1-8DBF-29329337EBA5
x-api-signature-version:1.0

latest=False&target=basic%2Cmore&userId=1
1B2M2Y8AsgTpgAmY7PhCfg==
1795237503850
GET
/remote-control/vehicle/status/PLACEHOLDER000000
```

### 常见错误

| 现象 | 原因 |
| --- | --- |
| `1445 验签签名错误`，令牌已被接受 | 规范串顺序错误。早期尝试把方法放在时间戳之前，或少算头部段后的空行 |
| 签名始终不匹配 | MD5 的 Base64 结果后缺少 `\n`。Java/Rust/Python 标准库的 Base64 不加换行，需手动补，或像 PR #3 那样在格式串里写 `{md5}\n` |
| query 含逗号时失败 | 逗号必须编码成 `%2C`，例如 `target=basic%2Cmore` |
| Accept 不一致 | 签名用的 Accept 必须与实际发送的头相同。`application/json`（本地验证）和 `application/json;responseformat=3`（iOS 抓包）都已通过 |

APK 的 `BaseTokenInterceptor` 把 `1440`、`1442`、`1443`、`1445`、`1446` 归为验签异常，会打印签名参数，不会重试。

## 密钥与固定参数

| 参数 | 值或来源 |
| --- | --- |
| `X-APP-ID` | `polestar-app`。来自 `RCSClient.java:269` 的 `new p7.clifor(appId, appSecret, license, …)` 第一个参数，与 xchanger JWT 中的 `appId` 一致 |
| `appSecret` | 同一构造调用的第二个参数，经 `geelysdkadapter/core/cliif.java:91` 的 `setSignSecret()` 传入 SDK。**不写入仓库** |
| `X-OPERATOR-CODE` | `POLESTAR`，`geelysdkadapter/core/cliif.java:107` 硬编码 |
| `X-ENV-TYPE` | `production` |
| `x-api-signature-version` | `1.0` |
| `x-api-signature-nonce` | APK 用 `UUID + 7 位大写字母数字 + 毫秒时间戳` 截取末尾 36 位（`ComUtils.getNonce(String)`）。iOS 使用大写 UUID。服务端两种都接受 |

### Norr 中的密钥位置

| 位置 | 用途 |
| --- | --- |
| 环境变量或根目录 `.env.secrets` 的 `NORR_XCHANGER_APP_SECRET` | 构建脚本逐项读取并传入 Rust；macOS P4 的 `credentials::geely_signing_key` 通过 `option_env!` 使用。文件已被 `.gitignore` 的 `.env.*` 规则忽略 |
| macOS 钥匙串 `service=app.norr.mac.polestar4`、`account=polestar-geely-client-config` | 未编入 xchanger 配置的开发构建继续使用，随包配置存在时不读取此条目 |
| 解包目录 `jadx/sources/com/polestar/explore/core/carcontrol/RCSClient.java:269` | 原始来源，`scripts/polestar4-probe.py` 运行时从这里读取 |

2026-11-22 核对过，三处值的 SHA-256 一致。2026-11-23 已从本地配置通过标准输入设置 `pepsing/Norr` 的 `NORR_XCHANGER_APP_SECRET` Actions Secret，并核对 Secret 名称元数据，未输出值。本地工作流已补齐桌面、Android、iOS 打包步骤的注入；iOS 还将配置传入 Xcode 的 Rust 构建子进程。工作流改动仍需提交后才能在 GitHub 执行。注入配置不会自动启用其他平台的 P4 适配。

## 请求头

APK 在 `com/baselinelibrary/net/CustomOkHttpClientUtil.java` 为每个请求添加以下头：

| 头 | 取值 |
| --- | --- |
| `Accept` | JNI 返回的默认值。iOS 抓包为 `application/json;responseformat=3` |
| `Content-Type` | `application/json; charset=utf-8` |
| `X-APP-ID`、`X-OPERATOR-CODE`、`X-ENV-TYPE` | 见上表 |
| `X-AGENT-TYPE` | `android` 或 `iOS` |
| `X-DEVICE-TYPE` | `mobile` |
| `X-DEVICE-IDENTIFIER` | 设备 ID 的十六进制。Norr 使用每台设备自己保存的 UUID，不同用户不应共用 |
| `X-VERSION` | `polestarNew`（Android） |
| `PLATFORM` | `NON-CMA` |
| `Accept-Language` | `zh-CN` |
| `X-api-signature-version`、`X-api-signature-nonce` | 参与签名 |
| `X-TIMESTAMP`、`X-SIGNATURE` | 签名后添加 |
| `Authorization` | xchanger accessToken 原值，**不加** `Bearer ` 前缀 |
| `X-CLIENT-ID` | 会话返回的 `clientId` |

未登录的会话交换请求不带 `Authorization`，额外携带 `X-DEVICE-MANUFACTURE`、`X-DEVICE-BRAND`、`X-DEVICE-MODEL`、`X-DEVICE-RELEASE-DATE`、`X-AGENT-VERSION`。

## 认证流程

```text
中国区短信/密码登录
  → 登录响应顶层 accessToken（外层网关令牌，不是 globleToken）
  → POST user-api /auth-center/account/session
  → xchanger accessToken、refreshToken、userId、clientId、expiresIn
  → 后续请求携带 Authorization + X-CLIENT-ID
  → 到期前 PUT user-api /auth/account/session/secure 续期
```

- 交换请求体：`{"identityType":"polestar","accessToken":"<外层令牌>"}`。`identityType` 放在 body 里。
- 续期请求体：`{"refreshToken":"<refreshToken>"}`。响应只返回新的 accessToken、expiresIn、refreshFailureTime，**不返回新 refreshToken**。合并时必须保留原 refreshToken、userId、clientId。
- 实测 `expiresIn` 为 7200 秒，`refreshFailureTime` 约 30 天后。
- 响应码 `1402` 表示访问令牌无效。APK 收到 1402 后先续期再重放请求。`1403`、`1404`、`1408` 触发 SDK 重新登录；管理器重新初始化会用中国区外层 token 再交换会话。Norr 对只读请求恢复一次；续期授权被拒绝时重新交换，失败后限频 60 秒，迁移旧版永久失败标记。签名错误与网络 / 5xx 异常单独报告，保留凭据和实际 HTTP / 业务码。详见 [token 续期对照](polestar4-token-refresh-audit.md)。

## 接口

主机按 Retrofit 的 `urlname` 头选择，前缀加 `.xchanger.cn`（`resources/assets/host.txt` 的 CN 配置）。接口定义在 `com/ecarx/open/http/clifor.java` 和 `clishort/cliint.java`。

状态一栏记录 Norr 已完成的验证。"本地"指本地 `geely.rs` 与 `scripts/polestar4-probe.py` 的只读验证（2026-11-20），"PR #3"指 qicents 在 2023 款 P4 上的实车验证（2026-11-21）。

### 认证

| 方法 | 主机 | 路径 | 状态 |
| --- | --- | --- | --- |
| POST | user-api | `/auth-center/account/session` | 本地、PR #3 已验证 |
| PUT | user-api | `/auth/account/session/secure` | 本地已验证，连续续期和跨进程恢复均通过 |
| DELETE | user-api | `/auth/account/session/secure` | 未使用，APK 中为退出登录 |

### 读取

| 方法 | 主机 | 路径与参数 | 状态 |
| --- | --- | --- | --- |
| GET | device-api | `/device-platform/user/vehicle/secure?userId=&needSharedCar=1` | 本地已验证，返回车库与 `vehicleType` |
| GET | device-api | `/remote-control/vehicle/status/{vin}?userId=&latest=&target=` | 本地用 `target=` 空串验证，PR #3 用 `target=basic,more` 验证 |
| GET | device-api | `/remote-control/vehicle/status/state/{vin}?userId=` | 本地已验证，车辆模式 |
| GET | api | `/geelyTCAccess/tcservices/capability/{vin}?pageSize=2000&pageIndex=1&vehicleType=&sortField=&direction=` | 本地已验证，56 项能力 |
| GET | api | `/charge-server/charge_status/{vin}` | 本地已验证 |
| GET | api | `/remote-control/vehicle/status/soc/{vin}?setting=charging` | 本地、PR #3 已验证。`soc` 单位为 0.1%，`"1000"` 即 100% |
| GET | api | `/charge-server/ecarx_charge_set/{vin}?bizType=2` | 本地已验证，充电预约 |

查询参数名是 `userId`。APK 常量 `KEY_uid` 的实际值是 `userId`，传 `uid` 会得到业务码 `1400`。

### 车控

方向盘加热、前排座椅加热/通风及其他即时控制的 Android 4.25.0 参数和调用链已逐项整理，见 [解包参数对照](polestar4-control-parameters.md)。该文区分手机版页面、通用适配器与现有 iOS 样本的差异，不代表这些动作已在 Norr 开放。

两种指令共用同一个接口：

```text
PUT device-api /remote-control/vehicle/telematics/{vin}
```

| 动作 | serviceId | 关键参数 | 状态 |
| --- | --- | --- | --- |
| 驻车空调开、关 | `RCE_2` | `command=start/stop`，`rce.conditioner=1`，`rce.temp=<16–28>`，start 时 `duration=180` | PR #3 实车验证，回读 `preClimateActive` 与 `updateTime` 变化 |
| 充电上限 | `RCS` | `command=start`，`operation=4`，`rcs.setting=1`，`soc=<百分比×10>` | PR #3 实车验证，90 → 100，回读 100 |

请求体结构（空调）：

```json
{
  "command": "start",
  "creator": "tc",
  "serviceId": "RCE_2",
  "serviceParameters": [
    {"key": "rce.conditioner", "value": "1"},
    {"key": "rce.temp", "value": "22"}
  ],
  "timestamp": "<毫秒>",
  "userId": "<userId>",
  "operationScheduling": {"duration": 180, "interval": 0, "occurs": 1, "recurrentOperation": false}
}
```

充电上限另加 `"latest": false`，`operationScheduling` 为 `{"scheduledTime": null, "interval": 0, "occurs": 0, "recurrentOperation": true, "duration": 60}`。

body 原样参与 MD5，签名用的字节必须和发送的字节完全一致。

锁车、车窗、尾门、寻车等其他 serviceId 尚无抓包。这辆 P4 的能力目录只有空气质量查询 `remote_PM25_query_2`，用 `remote_purification`、`RCE_3` 发送 start 均返回 `8500`，所以没有添加净化开关。

## 响应语义

- 业务码在 `code` 字段，可能是字符串 `"1000"` 或数字 `1000`，两种都要接受。HTTP 200 不代表业务成功。
- 认证、车库和部分状态接口直接返回数据，不包 `code/data`。
- `serviceResult.operationResult=1` 是 SUBMIT：服务端已接收，或返回的是缓存。即使同时带回完整车况，也不能当作车辆已完成回读。车控结果以 `updateTime` 之后的独立回读为准。
- 位置 `basicVehicleStatus.position` 的经纬度单位为毫弧秒（度 × 3,600,000）。`marsCoordinates=false` 表示 WGS-84，`true` 表示 GCJ-02。任一轴为 0 时视为无效点。

## Norr 实现对照

| 项目 | 本地 `crates/vehicle-core/src/geely.rs` | PR #3 `crates/vehicle-core/src/xchanger.rs` |
| --- | --- | --- |
| 编译范围 | macOS + `polestar4-test` feature | 四端，无 feature 门控 |
| 密钥 | 编译期 `NORR_XCHANGER_APP_SECRET`，未编入时回退到原钥匙串条目 | 编译期 `NORR_XCHANGER_APP_SECRET` |
| Accept | `application/json` | `application/json;responseformat=3` |
| 设备标识 | 每台设备独立 | 写死同一个 UUID 和回退 clientId |
| 续期 | 主动续期，校验账号一致；读取授权失效时续期或重新交换后重试一次，失败限频，写入不重放 | 收到 1402 后重新交换 |
| 能力 | 读取、空调启停与充电上限写入；发送前核对当前车库与能力 | 读取，加空调与充电上限写入 |

2026-11-23，本地 macOS P4 测试适配器已接入上述两类车控，使用同一个签名实现发送真实 HTTP PUT。固定样本与本机 HTTP 服务验证了请求、签名、回执及独立回读，当前修改尚未做实车写入验证。实现范围与验收见 [P4 控制接入](polestar4-controls.md)。

query 编码：

- PR #3 的 `encode_query` 先替换空格再替换 `%`，空格会变成 `%2520`。
- 本地 `geely/signing.rs` 已在 URL 编码后统一处理 `+`→`%20`、`*`→`%2A`、`%7E`→`~` 与逗号编码。签名和实际发送使用相同 query，原值中的百分号与分隔符只编码一次。

本地固定样本测试覆盖空格、字面加号、百分号、逗号、分隔符、中文与空参数，并对照独立 Node/Python HMAC 样本。测试只用虚构 key，不读取生产配置。

## 源码索引

路径相对于 `/Users/manjiang/code/gitpub/Hisingen/docs/research/polestar-cn-apk/4.25.0/jadx/sources`。

| 内容 | 文件 |
| --- | --- |
| 签名算法 | `com/baselinelibrary/sign/SignUtil.java` |
| 签名拦截器 | `com/baselinelibrary/sign/SignInterceptor.java` |
| 公共请求头 | `com/baselinelibrary/net/CustomOkHttpClientUtil.java` |
| nonce 生成 | `com/baselinelibrary/utils/ComUtils.java` |
| 令牌错误码处理 | `com/baselinelibrary/net/BaseTokenInterceptor.java` |
| appId、appSecret | `com/polestar/explore/core/carcontrol/RCSClient.java:269` |
| 签名配置与 operator | `com/polestar/geelysdkadapter/core/cliif.java:91` |
| HUANFU 分支 | `com/polestar/geelysdkadapter/GeelyCarPlatformAdapter.java` |
| 车况、车控、充电接口 | `com/ecarx/open/http/clifor.java` |
| 会话交换接口 | `clishort/cliint.java:49` |
| 主机配置 | `../../resources/assets/host.txt` |
