# 军师 · 补话（followup）手机脚本交接 v243

> 给手机端脚本维护方（DSH）。这份文档自包含，按它改即可。
> **协议在 v242 已经从"一次轮询直接拿文案"改成两阶段，v243 又加了主线门控、发送回执、退出清空。旧实现必须按本文改。**

## 一句话

主线那一轮跑完、**确认没有当前可回的消息**时，才去问云端"该给谁补一句"；拿到目标后打开她的聊天页，**进去了才生成**文案；发成功打个回执，发失败撤回；脚本退出立刻停止并清空排队。

## 为什么这么设计（上一版的实际事故）

v241 是"轮询 → 云端直接生成一段话 → 脚本去发"。线上结果：**云端生成 18 条，微信里 0 条**。
脚本没发出去，云端不知道，于是 token 白花、那 3 个好友当天 3 次额度全被占掉、直连上下文里还多了 18 句"我根本没说过的话"。

现在：没打开聊天页 = 不生成 = 不花钱；生成未确认 = 30 分钟后自动作废；退出 = 全部清空。

---

## 接口

```
POST https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/ima-proxy
Content-Type: application/json
```

| # | 场景 | 请求体 | 要不要 main_idle |
|---|---|---|---|
| 1 | 脚本启动（必调一次） | `{"mode":"followup","api_key":"<KEY>","online":true}` | 不要 |
| 2 | 主线空闲时轮询 | `{"mode":"followup","api_key":"<KEY>","main_idle":true}` | **必须 true** |
| 3 | 已进入该好友聊天页 | `{"mode":"followup","api_key":"<KEY>","session_id":"<目标id>"}` | 不要 |
| 4 | 发送成功 | `{"mode":"followup","api_key":"<KEY>","session_id":"<id>","action":"sent"}` | 不要 |
| 5 | 发送失败 | `{"mode":"followup","api_key":"<KEY>","session_id":"<id>","action":"fail"}` | 不要 |
| 6 | 脚本退出 / 暂停 | `{"mode":"followup","api_key":"<KEY>","action":"stop"}` | 不要 |

`"action":"start"` 与 `"online":true` 等价。

---

## 阶段一：主线空闲才轮询（调用 2）

`main_idle` 是这套机制的**总闸门**：只有脚本主线这一轮已经跑完、确认当前没有任何"她刚发来还没回"的消息时，才能带 `main_idle:true`。主线还在处理消息时不要调，云端也会拒绝。

```json
{
  "phase": "scan",
  "targets": [
    { "session_id": "9f2c…", "friend_name": "小美", "note": "", "search_key": "小美",
      "waited_min": 7, "used_today": 0 }
  ],
  "followup": [],
  "skipped": [],
  "window": "09:00-23:00",
  "session_cap": 3,
  "online": true
}
```

- 不带 `main_idle:true` → 返回 `{"phase":"wait_main","reason":"main_busy","targets":[]}`，什么都不做。
- `targets` 为空 = 这轮没事，**正常**，不要报错。
- 一次最多 3 个，等得最久的排前面。
- 这里**没有文案**，不要拿它去发。

**定位微信会话的顺序**：`note`（微信备注，为空则跳过）→ `search_key` → `friend_name`。
`search_key` 是云端把昵称里的 emoji/颜文字/空格剥掉的纯文本（`Iclyn ❄️` → `Iclyn`、`ღ᭄余生🍒安好💖` → `余生安好`）。**带 emoji 的整串昵称搜不到**，这是上一版发不出去的高概率原因。

---

## 阶段二：进去了才要文案（调用 3）

```json
{
  "phase": "generate",
  "followup": [
    { "session_id": "9f2c…", "text": "正事就是改天当面把那顿饭赢回来",
      "shape": "延续", "waited_min": 7, "used_today": 1 }
  ]
}
```

- `text` 是最终话术：**原样发出，不改写、不加标点、不加称呼、不补表情**。
- 云端是"接着刚才的聊天上下文往下说"，不预设策略、不换话题（用户明确要求）。
- `followup` 空 + `skipped:[{"reason":"target_not_eligible"}]` = 期间她回了 / 已超 60 分钟 / 额度用完 → **放弃，什么都别发**。

**顺序必须是：打开聊天页 → 调 3 → 发。** 云端只在这时候才调模型。

### 可选：把屏幕上看到的最新内容传上去

```json
{ "mode":"followup", "api_key":"<KEY>", "session_id":"<id>",
  "screen_context": "她 20:31 回：今天加班到九点" }
```

云端当可信事实用（≤600 字），补出来的话更接得上。不传也能用。

---

## 阶段三：发完必须回执（调用 4 / 5）

| 结果 | 调用 | 云端动作 |
|---|---|---|
| 发出去了 | `action:"sent"` | 打 `followup_sent=true`，这条坐实 |
| 没发出去 | `action:"fail"` | 删掉这条、清 `followup_at`、不计当日次数，下一轮可重来 |
| 什么都不调 | — | 30 分钟后自动当失败清掉（浪费的那次 token 追不回，但不会占额度） |

发失败却调了 `sent`（或调反）不会有严重后果，但统计就失真了。宁可调 `fail` 让它重来。

---

## 脚本退出 / 暂停（调用 6）

```json
{ "mode":"followup", "api_key":"<KEY>", "action":"stop" }
// 返回
{ "stopped": true, "online": false, "purged_unsent": 2 }
```

一次做三件事：
1. 标记脚本下线，之后**任何调用**都返回 `{"offline":true,"reason":"script_offline"}`；
2. **清空补话排队任务**：删掉所有"已生成但没确认发出"的补话（`purged_unsent` 是清掉的条数）；
3. 会话的 `followup_at` 复位。

重启必须带 `"online":true`（或 `action:start`），不带就一直是下线。

---

## 绝不能做

1. 不要拿 `targets` 去发消息——那里没有文案。
2. 不要在自己生成或润色文案；不要换话题、不要加"在吗/忙完了吗"这类追问。
3. 不要重试同一条。发失败就 `fail` 撤回，等下一轮重新生成。
4. 不要和主链路混用。主链路 `{query,api_key,friend_name}` 消耗账号配额；followup 不消耗。
5. 不要再用 `mode=wake`（已下线，只返回 `retired:true`）。
6. **主线还在跑就不要调调用 2**。她会觉得你在自说自话。

---

## 失败处理

| 情况 | 处理 |
|---|---|
| HTTP 非 200 / 超时 | 本轮跳过，60–90 秒后再试，**不要立即重试** |
| `401 invalid_api_key` | Key 失效，停止轮询并提示用户重新生成 |
| `{"error":"followup_targets_failed"}` | 云端缺迁移（035），停止并报告 |
| `{"offline":true}` | 补一次 `"online":true` 后恢复 |
| `phase:"wait_main"` | 主线没确认空闲，正常，下一轮再试 |
| `target_not_eligible` | 正常，丢掉这条 |

---

## 判定规则（云端已做，脚本不用判断）

- 你上一条消息发出去 **≥5 分钟**没人回，且**不超过 60 分钟**
- 关系阶段是 **吸引 / 舒适 / 恋爱**（"陌生"不补）
- 北京时间 **09:00–23:00**
- **每个会话每天最多补 3 次**，每次沉默期只补 1 条（她回了才重新计时）
- 单轮最多 3 个目标（等得久的优先）

## 一个必须保证的前提

**她的回复必须落库成 `user` 消息**（现有主链路调用已在做）。
如果收消息那段没走主链路落库，云端会一直认为"她没回"，会一路补到每会话 3 次上限。

---

## 自测清单

1. 不带 `main_idle` 轮询 → `phase:"wait_main"`、`targets` 空
2. 带 `main_idle:true` → `phase:"scan"`，有目标也只给 id，没有文案
3. 打开聊天页后调调用 3 → 拿到 `text`
4. 发出去了 → 调 4，返回 `confirmed:true`
5. 故意不点发送 → 调 5，返回 `rolled_back:true`
6. 调 6 退出 → 再轮询得到 `offline:true`，且 `purged_unsent` 有数（如果有排队的）
7. 微信里能真实看到那句补话，同时直连上下文里也有
