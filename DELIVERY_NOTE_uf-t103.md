# 修复说明：设备码确认中断后重入（uf-t103）

## 问题根因

设备配网走设备码（RFC 8628 Device Authorization Grant）。用户在确认页点击同意后，
处理链路会先把设备码标记为 `inFlight`（这是历史上为防止并发双确认而引入的锁），
随后才执行授权结果落库与成功页渲染。若用户在这两步之间关闭页面（浏览器关闭、
进程崩溃、断网），记录就永久停留在 `inFlight` 中间态，直到设备码自身过期。

之后用户用同一个 user_code 重新进入确认页时，`code_verification` 中间件把
`inFlight` 与"已使用/已拒绝"混在同一分支，统一抛 `AlreadyUsedError`，而默认页面
文案又把 NotFound / Expired / AlreadyUsed 三种状态共用一句"The code you entered
is incorrect"。于是用户看到的是"码不正确"，设备端只能一直等待到码过期作废。

此外，成功落库时 `inFlight` 标志不会被清除，会和最终的 `accountId` 一起持久化，
留下中间态痕迹。

## 修复方案

### 1. 给确认锁加上有界时间戳，支持中断恢复

- `DeviceCode` 持久化新增 `inFlightAt`（写入锁的 epoch 秒）。
- 新 helper `lib/helpers/device_in_flight.js` 提供 `isInFlightStale()`：
  - 锁年轻于宽限时间盒 → 视为**存活的并发确认**，锁保持排他；
  - 锁老于宽限时间盒 → 只能属于一个中途死掉的请求，允许新确认接管；
  - 对历史无 `inFlightAt` 的旧记录（升级前写入）按 stale 处理，不会把码锁死到 TTL 结束。

### 2. user_code 入口（`code_verification` POST）按真实状态分流

- `error` / `accountId` 仍抛 `AlreadyUsedError`（终态，不可再确认）；
- `inFlight` 且锁存活 → 抛新的 `PendingConfirmationError`，明确提示"确认仍在处理中"，
  **不再报码不正确**；
- `inFlight` 且锁过期 → 清除锁，允许重新确认/中止，流程可继续完成。

### 3. 中间态收敛，不留痕迹

- 成功路径 `deviceVerificationResponse` 在写入 `accountId` 等最终结果前清除
  `inFlight` / `inFlightAt`，最终记录不含任何中间态字段；
- 失败路径 `deviceUserFlowErrors` 在写入 `error` 前同样清除锁，异常终止也不残留。

### 4. 文案按实际状态区分，不再三种状态共用一句

默认 `userCodeInputSource` 的红色提示现在区分：

| 状态 | 文案 |
| --- | --- |
| 码不存在 / 未输入（NotFound / NoCode） | The code you entered is incorrect. Try again |
| 已过期（Expired） | This code has expired. Start the sign-in again on your device |
| 已使用/已拒绝（AlreadyUsed） | This code has already been used and cannot be confirmed again |
| 确认处理中（PendingConfirmation） | Your confirmation is still being processed. Wait a moment and enter the code again |
| 已中止（Aborted） | The Sign-in request was interrupted |
| 其他处理错误 | There was an error processing your request |

状态专属文案只作用于用户主动提交 user_code 的 `code_verification` 表单路由；
`device_resume` 路由不携带 user_code（其错误渲染无码字段），保持通用处理文案，
不臆测用户意图。

## 宽限时间盒取值与理由

取值：**30 秒**（`DEVICE_CODE_IN_FLIGHT_GRACE = 30`，常量集中在
`lib/helpers/device_in_flight.js`，便于后续调整）。

理由：

1. **它界定的是单个 HTTP 请求的寿命，不是整个用户交互的寿命**，因此刻意与设备码
   自身的 10 分钟 TTL 解耦。确认请求的实际工作只是若干次本地 adapter 读写加页面渲染，
   正常情况下远低于 1 秒即可完成；30 秒为慢存储、GC/多租户暂停、网络抖动留足余量。
2. **对重入用户足够友好**：中断后重新进入，最坏只需等待该时间盒的剩余部分即可接管
   并完成流程，而不是干等到设备码过期（原本最长 10 分钟）。
3. **与设备端轮询节奏匹配**：RFC 8628 设备端按 token 端点轮询，常见慢轮询间隔约为
   30 秒量级；把时间盒设为 30 秒，意味着一次中断大约在一个轮询周期内即可恢复，
   设备端通常下一轮就能拿到结果。
4. 该值同时是并发防护的窗口上界（见下节），30 秒是"用户可接受的恢复延迟"与
   "双确认窗口尽量小"之间的平衡。

## 并发双确认防护为何没有被重新打开（无界窗口论证）

历史上引入 `inFlight` 的动机是防止同一个设备码被并发确认两次。本修复**没有移除这把
锁，也没有让它变成无界**，而是把"永久锁"改成"有界锁"：

1. **存活窗口内仍然完全排他**。一个确认请求从设置 `inFlightAt` 起的 30 秒内，任何
   第二个并发确认都会在 user_code 入口被 `PendingConfirmationError` 拦下，无法接管、
   无法二次写入授权结果。测试 `keeps concurrent double confirmation locked while the
   first request is live` 专门固化这一点。
2. **窗口之外的接管只发生在原请求已不可能存活的前提下**。锁老于 30 秒，说明持有锁的
   请求早已超过任何合理请求寿命，必然已经死亡（关页/崩溃/断网）。此时不存在"两个活
   请求同时确认"的情形，接管不会造成双确认。
3. **终态不可变**。一旦记录进入 `accountId`（已授权）或 `error`（已拒绝）终态，
   入口无条件抛 `AlreadyUsedError`，与时间盒无关，终态记录永远不会被再次确认覆盖。
4. **防护面收敛在唯一可达入口**。仅凭一个 user_code 能触达确认逻辑的只有
   `code_verification` POST；`device_resume` 是受 interaction session/cookie 保护的
   交互恢复路径，其 `inFlight` 新鲜是"自己这次确认正在走 consent 往返"的正常现象，
   原本就不检查 `inFlight`，本修复保持该语义不变（曾误加检查导致 RAR consent 流程
   失败，已回退并由测试守护）。

综上，并发双确认窗口被严格限制在 30 秒有界区间内、且仅对"存活请求"有效；窗口外只
回收死锁，不接纳第二个活确认，因此没有重开无界双确认窗口。

## 改动文件

库代码：

- `lib/helpers/device_in_flight.js`（新增）：宽限常量与 `isInFlightStale()`。
- `lib/helpers/re_render_errors.js`：新增 `PendingConfirmationError`。
- `lib/models/device_code.js`：持久化字段增加 `inFlightAt`。
- `lib/actions/code_verification.js`：user_code 入口按状态分流、写入锁时间戳、宽限接管。
- `lib/actions/authorization/device.js`：成功/失败两条路径收敛中间态；补充 resume 语义注释。
- `lib/helpers/defaults.js`：默认文案按状态区分。

测试：

- `test/device_code/device_interrupted_reentry.test.js`（新增，10 个用例）：
  - 中断重入类：宽限内报处理中（非码不正确）、宽限后接管完成、宽限后重显确认页、
    宽限后仍可中止、并发双确认在存活窗口内被锁。
  - 完成收敛类：成功后记录无 `inFlight`/`inFlightAt` 痕迹。
  - 文案区分类：过期 / 已使用 / 不存在三种文案各自正确。
- 同步更新既有的 payload 字段清单与文案断言：
  `test/device_code/code_verification_endpoint.test.js`、
  `test/formats/opaque.test.js`、`test/helpers/model_api.test.js`。

## 验收

- 环境：Windows 原生 Node v24.21.0，依赖已安装，使用 Node 自带 test runner。
- `npm test` 全量套件：3712 项，0 失败（2 项既有 skipped）。
- `npm run test-ci` 多挂载矩阵（默认 + express/koa/hapi/fastify 挂载到 /oidc）：
  5 个套件全部 0 失败。
- `biome lint`：退出码 0，无 error；仅 3 条与该文件原有 `err && err.x` 写法一致的
  useOptionalChain 风格 warning（基线文件本身即存在同类 warning），未引入新问题类型。
