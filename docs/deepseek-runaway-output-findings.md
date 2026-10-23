# deepseek-v4.1-flash 思维链/输出跑飞：排查记录

排查日期：2026-10-21 ～ 2026-10-22　　模型：`pc/deepseek-v4.1-flash`（实际 `cline-pass/deepseek-v4.1-flash`）

## 1. 现象

NewAPI 用户 628、746 通过 Codex 使用该模型时，出现两类异常（用户截图）：

- 正文复读：`结束。收尾。完成。结。完毕。到此。收。好。完。…` 无限重复，停不下来。
- 思维链复读：`Let me write. / Go. / Here. / OK. / Writing. / Output.` 循环，界面显示"深度求索中，用时 13 分 5 秒"。

## 2. 结论摘要

1. **没有找到根因，也没有发现控制台自身出错。** 异常请求上游均返回 200，是模型自己停不下来，用户点停止后控制台记 499 `client_cancelled`。
2. **与用户、账号、Provider、输入长度都无关。** 近 4 天 NewAPI 同模型请求里，输出 > 8000 token 的占比：628 约 0.2%、746 约 0.2%，低于用户 20（4.8%）、67（2.05%）、17（1.5%）；控制台全量 31116 条里 deepseek 官方与 openai-compatible-private 两个 Provider 都约 0.9%，各账号、输入长度档位、是否命中缓存均无明显集中。
3. **"NewAPI 丢了思维链导致跑飞"的猜测未得到支持。** 两轮对照实验见第 4 节：随机代码题上缺思维链确实更难收敛，但那是造题造成的假象；换成真实代码和真实任务后，缺失与完整两组都 30/30 正常结束。
4. **没有复现复读循环。** 合成请求下整体只出现 1 例循环判定。生产里约 0.9% 的比例用 60 次样本撞不上并不矛盾（真实比例 1% 时，60 次一次都不出现的概率约 55%）。

## 3. 生产日志证据

### 3.1 两条被中止的请求（对应截图）

NewAPI 日志里决策为 `stream_not_success`，控制台记 499。按时间与 token 数可精确关联（NewAPI 与控制台的 token 数一致，如 8041、9391）。

| 用户 | 时间(UTC+8) | 入站协议 | 持续 | 输出 | 上游流量 | Provider / 账号 |
|---|---|---|---|---|---|---|
| 628 | 10-21 23:41:54 | Responses | 184 秒 | 37861（NewAPI 估算） | 12.4MB | deepseek / vr3c74s49g |
| 746 | 10-21 23:46:58 | chat | 317 秒 | 89882（NewAPI 估算） | 27MB | deepseek / wxsuntnkue |

输出量超过 32000 是因为被中止时上游没来得及返回 usage，NewAPI 本地估算。

### 3.2 控制台日志里的统计口径

- 请求日志在 `DATA_DIR/logs/requests-*.jsonl`；成功请求没有正文，`detailedLogging`/`rawBodyLogging` 关闭，`errorDetailLogging` 只留错误，499 不在其内，因此**这两条请求没有任何正文留存**。
- 入站协议占比：chat 253/28682 = 0.9%，responses 2/1055 = 0.2%（后者样本小，仅作提示）。
- 输出封顶值分布：deepseek 最大 32000，openai-compatible-private 最大 65536，说明跑飞时会一路打满上游上限。

### 3.3 代码事实（会影响后续判断）

- `applyReasoningReplay`（缺思维链时给 DeepSeek 工具调用回合补 `reasoning_content: ' '`）只在 Responses 与 Anthropic 适配器里调用（[lib/responses-adapter.js:368](../lib/responses-adapter.js#L368)、[lib/anthropic-adapter.js:204](../lib/anthropic-adapter.js#L204)）。
- **原生 chat 入站（NewAPI 走的主路径）对 messages 完全透传，server.js 里没有任何 `reasoning_content` 处理。** NewAPI 若丢字段，上游收到的是字段缺失，而不是占位。
- Responses 的 `reasoning.effort` 原样映射为 `reasoning_effort`（Codex 的"高"= `high`）。

## 4. 对照实验

脚本：[docs/deepseek-runaway-experiment/](deepseek-runaway-experiment/)（`loop_experiment.py` 第一版，`loop_experiment2.py` 第二版；密钥从环境变量 `CPS_KEY` 读取，不落盘）。经本机控制台 `127.0.0.1:3124` 调用，用专门建的测试客户端密钥。

方法：构造 Codex 风格多轮工具历史（shell 读文件，每轮助手回合带 `reasoning_content`），最后要求用 apply_patch 写一个大文件；流式接收，累计字符过大或最近 3000 字符压缩比 < 0.12 即中断并判定。

### 4.1 第一版：随机生成的代码（有缺陷，仅作对照参考）

3 种历史（完整 / 缺失 / 空格占位）× 2 档（medium / high）× 30 次，`max_tokens=8000`，输入约 2.4 万 token。"跑飞"= 输出打满 8000 仍未结束：

| 历史里的思维链 | medium | high |
|---|---|---|
| 完整 | 11/30 | 19/30 |
| 缺失 | 26/30 | 29/30 |
| 空格占位 | 27/30 | 29/30 |

打满的样本思考占比 100%、正文为 0，模型是在思考里反复"重新数一遍几百个随机函数名"，并非复读。**这是随机造题造成的，绝对数字不可当真实比例。** 另外占位与缺失无差别，说明 Responses 路径补空格占位对此没有帮助。

### 4.2 第二版：真实代码 + 真实任务

历史来自本仓库 `lib/*.js`（22 轮、每轮 100 行，输入约 4 万 token，接近真实请求体量），任务是写 `docs/ARCHITECTURE.md`；只比较完整 / 缺失，high 档，`max_tokens=32000`，各 30 次：

| 历史里的思维链 | 正常结束 | 输出 token 中位数 | 最大 | 思考 token 中位数 |
|---|---|---|---|---|
| 完整 | 30/30 | 6320 | 8980 | 2378 |
| 缺失 | 30/30 | 5615 | 12504 | 1644 |

两组无显著差异，无循环、无触顶。

## 5. 未解决与后续

- **未排除的可能**：模型对特定输入的退化（例如要写超长文件、某类特殊内容）；NewAPI 渠道（71/121/75）可能存在的参数覆盖（如 temperature）——本次查渠道表被权限拦截，未核实。
- **取证办法（需用户同意，会记录请求正文）**：临时对相关客户端密钥开 `detailedLogging`，等下一次循环出现后查看该请求的完整 messages 与实际输出；或让用户在出现时记录时间，据此对上控制台 `requestId`。
- **可选的防护（未实现）**：在流式转发里加重复检测并主动截断（返回 `finish_reason: length`），并给未带 `max_tokens` 的请求设上限，避免用户空等十几分钟、白烧 token。需要时另开 Trellis 任务。
