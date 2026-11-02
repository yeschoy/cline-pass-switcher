# `deepseek-v4.1-flash-1017` 视觉请求 500 `empty response content` 排查结论

排查时间：2026-11-02 18:07–18:55（Asia/Shanghai）。远程目标 `ubuntu@167.114.158.4:49555:/opt/cline-pass-switcher`。

全程只做只读排查，并**只转发既有请求体（换用账号自身 key）**做上游复现；未改配置、未重启容器、未改数据、未提审。Key、Authorization、完整请求体与图片内容均未输出。

## 1. 结论

**这不是 Switcher 的 bug，也不是 `max_tokens` 太低。是上游 Cline 网关在「推理跑飞」时把 500 包成 `empty response content`。**

具体链路：

1. 客户端发的是**非流式**视觉请求：1 条 user 消息、`reasoning_effort: high`、`max_tokens: 8192`、正文 380 字 + 一张约 900KB 的 **16 格照片拼图**（`data:image/png;base64`）。
2. 任务要求逐格判定 16 个格子，模型进入**极长且无界**的推理：同一个请求体重复 40 次，`reasoning_tokens` 从 706 波动到 **8,090**（占 8,192 预算的 **98.8%**）。
3. 约有 **10%** 的采样会一路写到推理预算耗尽，**没产出任何可见 content**。上游此时不是返回长度截断（`finish_reason: length`），而是直接 `500 {"error":"empty response content","success":false}`（51 字节）。
4. Switcher 侧 `errorRules[9] = 500-empty-resp`（`statuses:[500]` + `body_contains:"empty response content"`，`action: ignore`）正确识别为**账号无关的上游行为**，不做账号冷却；`retryRules[1] = empty-response`（`decision: stop`）不做重试。所以错误原样透出为 500。

Switcher 这两条规则的判断是**正确**的：41 次失败全部在 5 分钟内由同模型后续请求成功（41/41 抽样验证），账号和渠道本身是健康的。

## 2. 复现证据

使用**原始请求体原文**（取自 `data/detailed-logs/b5dda008-…/1b6cb6e8-…txt`，仅把模型名改回 `cline-pass/…`，因为直连上游不接受 `pc/` 别名）直连 `https://api.cline.bot/api/v1/chat/completions`：

| 实验 | `max_tokens` | 样本 | 失败数 | 失败耗时 | 成功时 completion 峰值 |
|---|---|---:|---:|---|---:|
| 生产设置 | 8192 | 40 | **4 (10%)** | 32–39s | **8,090 / 8,192 (98.8%)** |
| 抬高 | 16384 | 15 | 2 (13%) | 71–74s | 5,424 |
| 抬高 | 32768 | 15 | 2 (13%) | 123s | 3,150 |
| 抬高 | 65536 | 6+ | 1 | **260s** | 1,748 |

失败样本的响应体与生产完全一致：`{"error":"empty response content","success":false}`、51 字节。

**关键排除项：**

- **不是 `max_tokens` 太低**：抬到 65536 仍然失败，只是失败来得更慢（260s）。历史上的 09-21 结论（tool continuation 设 `max_tokens: 16`）不适用于本例——这里是 8192。
- **不是图片太大**：930KB、1.4MB、2.5MB、5.7MB 的图片全部 200。
- **不是这个模型不支持视觉**：小图和噪声大图都 200，返回内容正确。
- **不是账号问题**：10 次生产失败横跨 4 个账号（`tao3hbn2qx`、`mkuq3sme5n`、`z5sjts4ba6`、`krlutbgkl5`）。
- **不是 Switcher 改写请求**：Switcher 只做模型别名解析与 `gateway` 注入，`max_tokens`/`reasoning_effort`/消息体原样转发（manifest 与上游请求体逐字段核对一致）。

**决定性对照实验（锁死「是图片内容而非提示词」）：**

同一段「16 格逐格判定」提示词，把真实拼图换成**同尺寸随机噪声图**，12 次全部 200，`reasoning_tokens` 只有 **161–380**。换成真实拼图后推理量放大 **20 倍以上**并开始偶发跑飞。

→ 根因是**图片内容驱动的推理无界增长**，提示词只提供触发条件，不构成充分条件。

## 3. 生产影响面

当前日志窗口（`requests-*.jsonl`）：716 成功 / 43 失败 / 9 客户端取消（样本仍在增长）。

43 次失败**全部**是 `rule:500-empty-resp`，且**全部是非流式**（`stream: false`），耗时高度集中在 51–56s：

```
1× 16s  4× 18s  1× 19s  1× 24s  1× 45s  3× 51s  3× 52s
3× 53s  13× 54s  6× 55s  5× 56s
```

按 `stream` 与 `result` 交叉统计（同一日志，样本后续仍在增长）：

| | 失败 | 成功 | 失败率 |
|---|---:|---:|---:|
| `stream: false` | 43 | 181 | **≈19%** |
| `stream: true` | 0 | 535 | **0%** |

**所有失败都出现在非流式请求上，流式 535 次零失败。** 非流式整体失败率约 19%（早期较小窗口曾观察到 41/(41+47)≈47%，样本增大后回落到 ~19%，两者都指向「失败只发生在非流式」这一定性结论）。这条差异是下面给出方案的关键依据。

## 4. 建议（按性价比排序，均未实施，待决策）

1. **客户端改流式**（最有效、零风险）。生产数据里流式 110/110 成功。`reasoning_effort: high` + 长推理 + 非流式是最差组合；流式下上游按 chunk 输出，不会走到「无 content 才返回」的分支。
2. **客户端 `reasoning_effort` 从 `high` 降到 `medium`/`low`**，或对这类逐格标注任务关掉推理。本例真正需要的输出只有 124 字符，推理却烧掉 8,090 token —— 推理预算被浪费在这里。
3. **合并格子、减少单次判定量**（如 16 格 → 4 格×4 次），直接压缩推理长度分布。
4. **客户端加重试**。既然抽样验证中 41/41 都在 5 分钟内由后续请求成功，且是 ~10% 的独立随机事件，重试 1–2 次即可把残留失败率压到 ~1% 以下。注意这是**客户端的**重试；Switcher 侧 `retryRules` 保持 `stop` 是对的（它的重试是按账号/渠道切换语义，不适用于「同请求同账号重放」）。
5. **不建议** Switcher 主动抬高 `max_tokens` 或自动重放：会改变调用方成本/延迟契约，且实测抬高无效，只是把 40s 的失败拖成 260s 的失败。

## 5. 可选的 Switcher 侧改进（低优先，仅诊断友好度）

现状把上游 500 原样透出，客户端只看到 `empty response content`，很难判断是自己请求的问题。可考虑：

- 在响应里补一个可识别的提示（如 `type: "upstream_reasoning_exhausted"` 或中文 hint「上游推理耗尽预算未产出正文，建议改用流式或降低 reasoning_effort」），但**保持 HTTP 500 与错误文本不变**，避免破坏客户端既有匹配。
- 在错误明细里附带 `reasoning_tokens` / `finish_reason` 等便于定位的字段。

这两项属于产品决策，需先确认客户端不会因为错误结构变化而行为异常。

## 6. 证据保存位置（远程，只读）

- 原始失败请求明细：`data/detailed-logs/b5dda008-d3cb-4234-8ec0-6e876b124f99/`
  - `manifest.json`（URL `https://api.cline.bot/api/v1/chat/completions`、`x-request-id: bnVNCOIYAkmikTqGmYwhlSBZXfxKRUVh`、耗时 51,362ms）
  - `1b6cb6e8-…txt`（请求体 900,766 字节：380 字文本 + 899,682 字节 base64 PNG）
  - `9ca3a814-…txt`（响应 51 字节）
- 请求/错误日志：`data/logs/requests-*.jsonl`、`errors-*.jsonl`
- 复现脚本：远程 `/tmp/probe6.py`、`/tmp/probe7.py`、`/tmp/probe8.py`、`/tmp/probe9.py`、`/tmp/probe10.py`（临时文件，重启即失；结论已固化在本文件）

## 7. 限制

- 采样为 40+15+15+6 次量级，失败率估计（~10%）有置信区间，不应视为精确值。
- 未对「推理耗尽」到「上游返回 500 而非 `finish_reason: length`」做上游内部归因——那是 Cline 网关的私有行为，无法从外部证实，只能观察到该现象稳定复现。
- 真实图片内容未落盘分析，仅作为「同一等价类」用于 A/B，未判断 16 张图里具体哪张诱发了跑飞。
- 未验证改流式后在**生产链路**（经 Switcher）下的失败率，仅验证了直连上游；建议客户端切流式后继续观察一个窗口。
