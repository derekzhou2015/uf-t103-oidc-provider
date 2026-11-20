# uf-t103 交付说明：设备码确认中断后的重入卡死

## 一、卡死的来路（根因）

设备码授权的用户侧入口是 `POST /device`（`lib/actions/code_verification.js` 的
`loadDeviceCodeByUserInput`）。用户提交 confirm 后，流程分两段：

1. **确认段**：`code.inFlight = true` 落库（这是对同一码并发确认的既有防护），随后进入授权栈。
2. **定局段**：授权栈要么同步完成（`deviceVerificationResponse` 给码写入 `accountId` 等，
   终态-成功），要么创建 Interaction 会话把用户 303 到交互页（登录/同意），交互完成后经
   `GET /device/:uid`（device_resume）回到授权栈定局。

缺陷在于：进入定局段后、到达终态前，码的唯一状态标记就是已落库的 `inFlight=true`。
用户中途离开时这个标记**永远不会被清除**，而重入检查是

```js
if (code.error || code.accountId || code.inFlight) throw new AlreadyUsedError(userCode);
```

于是重入被 `AlreadyUsedError` 挡死，默认文案渲染为 "The code you entered is incorrect.
Try again"（即用户看到的"码不正确"——与真实状态完全不符）。同时码上既没有 `accountId`
也没有 `error`，设备端轮询永远得到 `authorization_pending`，直到码过期作废（`expired_token`）。
一次眼看要完成的授权就这样被卡死。

## 二、确认动作发生后直到授权定局的走向账

下表覆盖 confirm 提交后每一种可能走向，以及码与记录各自的归宿（修复后行为）：

| # | 走向 | 码的归宿 | Interaction 记录的归宿 | 设备端轮询结果 | 同码重入的结果 |
|---|------|----------|------------------------|----------------|----------------|
| A | confirm 后无需交互（会话与授权充分） | 同步写入 `accountId/grantId/scope`，终态-成功 | 不创建 | 下次轮询得令牌，码被 consume | `AlreadyUsedError`（终态拒绝，原行为保留） |
| B | confirm → 建交互 → 用户完成登录/同意 → resume | resume 时写入 `accountId` 等，终态-成功 | resume 时 `destroy()` | 下次轮询得令牌 | `AlreadyUsedError`（终态拒绝，原行为保留） |
| C | confirm → 交互以拒绝/错误收场（含授权栈抛 `AccessDenied`） | `deviceUserFlowErrors` 写入 `error/errorDescription`，终态-拒绝 | resume 时 `destroy()` | 下次轮询得到该错误（如 `access_denied`） | `AlreadyUsedError`（终态拒绝，原行为保留） |
| D | confirm → 用户中途离开，交互仍存活（**本次修复的场景**） | 保持 `inFlight=true` + `interactionUid` 指向存活交互 | 存活，等待用户回来 | `authorization_pending`（等待是合法的） | **303 到 `/device/:uid` 续走原流程**；若交互结果已提交则直接定局成功 |
| E | confirm → 用户中途离开，随后交互过期/被销毁 | 重入时释放 `inFlight`/`interactionUid`，码回到"未确认" | 已不存在（TTL 到期） | 重入前仍是 `authorization_pending` | **释放后按新鲜码处理**：重渲染确认页，可重新 confirm（开新交互）或 abort |
| F | confirm → 请求在建交互前死亡（进程崩溃等，错误处理都来不及写 `error`） | 残留的 `inFlight` 无 `interactionUid`，重入时按 E 释放 | 从未创建 | 同上 | 同 E，可重新走完流程 |
| G | confirm → 交互期间码过期 | 过期（`isExpired` 检查优先于一切） | 可能仍存活但已无用 | `expired_token` | `ExpiredError`（原行为保留） |
| H | 确认页提交 abort（含中断后重入再 abort） | 写入 `error=access_denied`，终态-拒绝 | 不变（存活交互稍后 resume 时会被终态检查拦下） | 下次轮询得 `access_denied` | `AlreadyUsedError`（终态拒绝） |
| I | 并发 confirm（双击/多标签同时提交） | 先到者置 `inFlight` 并建交互；后到者被 303 汇入同一交互 | 只有一个 | 等待唯一在途流程定局 | 见"三、并发防护论证" |
| J | 定局后设备轮询成功 | 码被 `consume` | 已销毁 | 得令牌 | 视适配器：`NotFoundError` 或 `AlreadyUsedError`（均为终态语义，原行为保留） |

## 三、并发确认防护未失去约束力的论证

库既有的防护是 `inFlight` 标记：**同一码任意时刻至多一个在途授权流水线**——第二个
confirm 不得在第一个仍在途时另起授权。修复后该防护的约束力如下保持：

1. **在途期间，一切请求汇入唯一流水线。** 码处于 `inFlight` 且其 `interactionUid`
   指向的 Interaction 仍存活时，任何请求——包括重复的 confirm 提交——都被 303 引到
   该唯一在途流程的 resume 地址，**不会**创建第二个授权流水线。防护对象（并发确认
   导致同一码跑出两条授权）在语义上被完整保留：不是"拒绝第二个请求"，而是"第二个
   请求被并回第一个流程"，任一时刻仍只有一条流水线。
2. **释放只发生在旧流水线确已死亡时。** 仅当 `interactionUid` 缺失（请求在建交互前
   已死亡）或指向的 Interaction 已不存在（TTL 到期/已销毁）时才清除 `inFlight`。
   此时旧流水线不可能再到达终局（resume 入口已随交互一起消失），允许新确认是"接替
   死掉的流水线"，不构成并发。
3. **攻击面没有扩大。** 若改为"重入即无条件清 `inFlight`"，则任何持有 user_code 的人
   （如瞥见设备屏上码的旁观者）都能在受害者确认仍在途时解锁并抢注自己的会话——
   那才是让防护失去约束力。本方案下，存活交互一天不消失，标记一天不可被第三方清除；
   旁观者重入只会被引向他无法继续的 resume 地址（没有 resume cookie，得到
   `SessionNotFound` 错误页，且 `deviceUserFlowErrors` 在 Interaction 未加载时不会
   写码，码状态不受污染）。
4. **残留竞态与上游同级。** `inFlight` 的检查-置位在存储层从来不是原子的：上游同样
   存在"两个同时到达的 confirm 都通过检查"的窗口。本方案新增的窗口（`inFlight` 已
   落库、`interactionUid` 尚未写入的毫秒级间隙内，重入会把在途流程误判为已死）与
   上游既有窗口同类同级，未扩大实际暴露面。彻底闭合需要适配器层提供
   compare-and-swap，超出本次修复范围。

## 四、恢复处置形态与边界的依据

- **形态：能续则续（303 回存活交互），不能续则释放重来（清标记、重渲染确认页）。**
  依据：报告中的主场景是同浏览器中途离开后拿原码回来，303 续走是唯一"零摩擦"形态；
  交互已逝时释放标记是让用户"能继续走完流程"的唯一办法。
- **不渲染静态状态页替代 303**：静态告知满足"明确告知"，但把主场景用户挡在了一步
  之外；303 在同浏览器下直接续走，跨浏览器下退化为 `SessionNotFound` 错误页（码状态
  不受污染，属可接受的边缘体验）。
- **边界一：终态不放行。** `accountId`/`error` 已落库的码一律 `AlreadyUsedError`，
  与设备端已消费或即将消费该定局的事实一致。
- **边界二：过期优先。** `isExpired` 检查在 `inFlight` 处理之前，过期码一律
  `ExpiredError`，不做任何释放或续走。
- **边界三：abort 只在原流程已死时生效。** 存活交互期间 abort 请求同样被 303 引回
  在途流程，防止持码第三方掐断受害者的在途授权。
- **设备端契约不变。** 轮询侧的 `authorization_pending` / `expired_token` / 终态错误
  行为逐字未动，设备无需任何配合改动。

## 五、改动清单

- `lib/actions/code_verification.js`：重入处理——终态检查（`error`/`accountId`）保持
  `AlreadyUsedError`；`inFlight` 时按 `interactionUid` 查活交互，存活则 303 续走，
  已逝则释放标记后按新鲜码继续（可 confirm/abort/重渲染）。
- `lib/actions/authorization/interactions.js`：创建 Interaction 会话时把其 uid 写到
  设备码的 `interactionUid` 字段（CV/DR 路由均覆盖，含 resume 后交互轮换的场景）。
- `lib/models/device_code.js`：`IN_PAYLOAD` 增加 `interactionUid`。
- `types/index.d.ts`、`types/configuration.d.ts`、`example/my_adapter.js`：同步新字段的
  类型与适配器文档。
- `test/helpers/model_api.test.js`：DeviceCode 载荷清单同步。
- `test/device_code/code_verification_endpoint.test.js`：新增 9 个确定性回归用例，
  逐条对应第二节的账：
  1. 重入且交互存活 → 303 到 `/device/:uid`，标记不释放（走向 D）；
  2. 存活期间重复 confirm → 同样 303 汇入，未发生第二次授权（走向 I，防护用例）；
  3. 交互已逝 → 释放标记并重渲染确认页（走向 E）；
  4. 无 `interactionUid` 的孤儿 `inFlight` → 释放（走向 F）；
  5. 释放后 confirm 放行并建立新交互（走向 E 的续走）；
  6. 释放后 abort 生效，码落 `access_denied`（走向 H）；
  7. 终态（`error`）仍 `AlreadyUsedError`（走向 C 的终态锁定）；
  8. 过期 in-flight 码仍报 `ExpiredError`（走向 G）；
  9. 端到端复现报告场景：confirm → 离开 → 设备轮询 `authorization_pending` →
     同码重入被引回原流程 → 完成登录/同意 → resume 成功 → 设备轮询得令牌（走向 D→B）。

## 六、验收

- 新增 9 个回归用例全部通过，逐条对应走向账（见上）。
- `test/device_code/` 全目录 64 个用例通过。
- 库存测试矩阵（`node ./test/run`，node 自带 runner 全量套件）全数通过。
