# P4 token 续期对照检查

2026-11-23。检查对象为发布提交 `94226505c32703da9adad2f9f96d2ccbccbd8892`（TestFlight 0.2.1 / 1020），对照中国区官方 Android App 4.25.0 的本机反编译源码。下文保留该发布版本的缺陷证据，修复实现与验证见文末。

结论：续期接口与主要字段已正确接入，但续期失败后的恢复机制与官方不同。Norr 会把一次续期拒绝持久化为当前登录不可恢复；重新连接和重启应用都无法解除。错误码解析还漏掉了官方支持的嵌套格式，并把业务码 1402 错写成 HTTP 401。

截图可以证明页面进入了这个错误分支，不能单凭截图确定服务端最初为什么拒绝续期。该提示也可能来自之前已保存的失败标记，并不代表每次显示时都重新发送过续期请求。

| 项目 | 官方 Android 4.25.0 | Norr build 1020 | 结果 |
| --- | --- | --- | --- |
| 车辆会话交换 | POST `user-api.xchanger.cn/auth-center/account/session`，使用中国区外层 token、`identityType=polestar` | 相同；与 `globleToken` 分开 | 一致 |
| xchanger 续期 | PUT `/auth/account/session/secure`，body 为 `refreshToken` | 相同 | 一致 |
| 续期请求头 | 原始 access token 放入 Authorization，不加 Bearer；携带 X-CLIENT-ID | 相同 | 一致 |
| 成功后保存 | 更新 access token；同步续期回调不要求返回新 refresh token | 合并返回字段，缺失 refreshToken 时保留旧值 | 缺字段场景正确，已复现 |
| 续期时机 | 本次核对的拦截器在业务码 1402 时触发 | 到期前 60 秒主动续期；只读请求遇到 401 / 顶层 1402 再续期一次 | Norr 有主动续期；没有“完全未实现刷新” |
| 错误信封 | 顶层 code；不存在或为 0 时读取 error.code | 只识别顶层 1402；嵌套错误落入普通失败 | 有缺口 |
| 错误类别 | 1402 续期；1403/1404/1408 要求恢复登录；1440/1442/1443/1445/1446 为签名错误 | HTTP 401 / 顶层 1402 合并为同一字符串，其他码被概括 | 分类与诊断信息不足 |
| 续期失败后重开 | SDK 清空 access token，广播 action_relogin；接收器提示关闭重开，管理器重新初始化时走 token 交换 | 保存 reloginIssuedAt；同一次中国区登录下直接拒绝后续 grant | 主要恢复缺陷 |
| 并发与重放 | 同步锁串行刷新；成功后一分钟内复用结果，再重放原请求 | 文件锁与同轮 OnceCell 合并续期；只读重试一次，写入不自动重放 | 写入差异保留，避免重复车控 |

1. **P1：失败标记导致同一次登录下无法恢复。**

   [geely.rs:204](https://github.com/pepsing/Norr/blob/94226505c32703da9adad2f9f96d2ccbccbd8892/crates/vehicle-core/src/geely.rs#L204) 在续期返回统一的 UNAUTHORIZED 时保存 `reloginIssuedAt=session.issued_at`；[geely.rs:172](https://github.com/pepsing/Norr/blob/94226505c32703da9adad2f9f96d2ccbccbd8892/crates/vehicle-core/src/geely.rs#L172) 会在后续任何网络请求前返回同一错误。字段保存在安全存储中的 `polestar-geely-session`（[credentials.rs:193](https://github.com/pepsing/Norr/blob/94226505c32703da9adad2f9f96d2ccbccbd8892/crates/vehicle-core/src/credentials.rs#L193)），重启不清除。中国区 global token 的普通续期只更新 `global_issued_at`，也不会解除该标记。

   官方接收器提示“关闭应用后重新打开”；`GeelyManagerImpl` 新实例没有已初始化状态，会调用 `authLoginOneCloud`，使用已有中国区外层 token 再交换车辆会话。Norr 缺少对应的受控恢复路径。外层 token 本身若也失效，重新交换仍可能失败，不能承诺一定免短信。

2. **P2：漏掉嵌套 error.code，且 HTTP 状态显示不准确。**

   [geely.rs:126](https://github.com/pepsing/Norr/blob/94226505c32703da9adad2f9f96d2ccbccbd8892/crates/vehicle-core/src/geely.rs#L126) 只检查顶层 `code`。固定样本 `HTTP 200 + {error:{code:1402}}` 返回“P4 服务未接受请求”，不会进入只读续期分支；官方会识别为访问令牌失效。`HTTP 200 + {code:1402}` 却被 Norr 显示为“HTTP 401”。因此截图里的“HTTP 401”不是服务端实际 HTTP 状态的可靠证据。

   另外，1403/1404/1408 未被单独识别；401 响应中的业务码也被丢弃。需要保留 HTTP 状态、业务码、请求阶段，区分访问令牌到期、刷新授权失效、签名错误和连接异常。

3. **关联现象：回读停住和没有新锁车记录。**

   控制回读也必须经过 `Api::grant`。进入上述失败状态后，已受理的解锁指令无法得到新的车辆读数，历史记录会停在“等待车辆回读”。这是现有调用链能解释的现象，不代表车辆一定没执行。

   [send_command:611](https://github.com/pepsing/Norr/blob/94226505c32703da9adad2f9f96d2ccbccbd8892/apps/native/src-tauri/src/lib.rs#L611) 对同组未完成操作先回读；若此时续期失败，函数提前返回。新的操作准备也在落指令记录之前。因而“点击锁车但没有新记录”可能是本次请求根本没有进入发送阶段，不能据截图判断为记录被删除。若反馈指手动关门或车辆自行回锁，则它本来就不是 Norr 发出的指令，不应凭空生成一条 Norr 指令记录。

建议修复顺序：先补齐错误分类，再将不可恢复标记改成分阶段、限次的会话恢复；当前中国区账号有效时允许重新交换 xchanger 会话，成功后清除历史失败状态，校验账号和车辆归属后继续只读回读。明确失效仍提示重新登录，连接异常保留凭据。车控写入不自动重放。对发送前被拦截的操作另记“未发送”及原因，避免界面只有错误条而历史完全没有尝试记录。

官方证据根目录：`/Users/manjiang/code/gitpub/Hisingen/docs/research/polestar-cn-apk/4.25.0/jadx/sources`。

| 源码位置 | 证据 |
| --- | --- |
| `clishort/cliint.java:49–58`、`clishort/cliif.java:135–138` | 交换和续期路由、refreshToken body |
| `com/baselinelibrary/net/BaseOkHttpClientUtil.java:79–100` | POST 交换不带旧 Authorization；PUT 续期携带 access token 和 clientId |
| `com/baselinelibrary/net/BaseTokenInterceptor.java:73–126` | 续期自身不递归拦截；顶层/嵌套业务码；1402 与 1403/1404/1408 |
| `blldo/bllif/bllif/bllnew.java:31–74` | 同步续期、成功更新 token、失败广播及一分钟合并刷新 |
| `com/polestar/geelysdkadapter/receiver/GeelyReceiver.java:17–20` | 失败后提示关闭重开 |
| `com/polestar/geelysdkadapter/core/GeelyManagerImpl.java:334–345`、`:404–423`、`:494–506` | 初始化状态、使用外层 token 换取车辆会话 |
| `com/polestar/carcontrol/clibyte.java:58–62` | 中国区外层 token 提供方 |

验证使用 `target/p4-token-audit` 中的隔离测试工程。复制现有协议源码，安全存储替换为内存固定样本，HTTP 仅指向随机分配的本机回环端口。没有读取真实 token、修改钥匙串、发送短信或请求车辆服务。三项测试通过：

- 错误信封分类：顶层 1402、嵌套 1402、1403、HTTP 401 的实际分支。
- 续期成功：PUT 路径、原始 Authorization、X-CLIENT-ID、请求体，以及缺省 refreshToken 的保留。
- 续期拒绝：保存失败标记，新建客户端仍被拦截；只有改变登录时间后才走 POST 交换并移除标记。

运行命令：`cargo test --offline --manifest-path target/p4-token-audit/Cargo.toml audit_ -- --test-threads=1`。结果见 `target/p4-token-audit/results.log`。这些隔离测试用于复现 build 1020 的缺陷；安全存储的系统级行为和朋友设备的原始服务回包未在本轮实测。

验收：Hard Gate PASS（无真实凭据和实车操作）；Purpose Gate PASS（逐项对照原始请求、错误恢复与截图）；Liveliness 不适用（无界面改动）；现有功能的 Craftsmanship FAIL（恢复与错误分类缺陷已复现）。GitNexus 工具在本环境不可用，本次直接跟踪源码调用链。

## 修复与回归

修复版将错误解析放入 `geely/error.rs`，将持久化恢复放入 `geely/session.rs`：

- 同时识别顶层与嵌套业务码，保留真实 HTTP 状态；区分访问授权、会话授权、签名校验和服务异常。
- 续期被授权错误拒绝时，用当前中国区外层 access token 重新交换一次 xchanger 会话；不使用 global token。成功后恢复只读回读，写入不自动重放。
- 迁移旧 `reloginIssuedAt` 标记。恢复失败保存阶段与时间，60 秒内抑制重复交换，之后允许再试；新登录可立即重新交换。连接、签名或服务异常不会清空凭据。
- 校验账号范围与 userId。续期缺少或清空可选字段时保留旧 refreshToken / clientId / userId；访问令牌与有效期必须有效，返回其他账号时拒绝接续旧请求。
- 未增加“未发送”指令记录类型；本次修复恢复阻断回读的会话链路，不把车辆自行回锁当作应用发出的指令。

11 项新回归直接调用生产协议实现，使用本机 HTTP 固定样本与内存存储，覆盖上述恢复分支、跨客户端失败限频、并发只续期一次、只读重试上限，以及无效续期不覆盖凭据。`npm run check:native`、严格 release Clippy、前端测试与构建、原生和发布脚本测试为本地验收项；各平台包以发布工作流结果为准。

本轮未发送真实车控、未读取真实用户 token。系统安全存储、朋友设备原始拒绝回包和更新后的实车回读仍需真机验证；不能由模拟请求推断最初的服务端拒绝原因。

修复验收：Hard Gate PASS（固定样本、不输出密钥、不重放写入）；Purpose Gate PASS（解除永久阻断并对齐原始错误码）；Liveliness 不适用（未改界面）；Craftsmanship PASS（迁移旧缓存、限频、账号隔离及回归覆盖）。
