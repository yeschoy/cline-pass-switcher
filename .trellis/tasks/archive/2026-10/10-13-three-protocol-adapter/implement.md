# 三协议入站适配 — 执行计划

## 前置

- 工作区有用户未提交改动：`public/index.html`、`server.js`、`test/workflow-integration.test.js`（配置保存相关）。不得回退或混入本任务提交；实现前先确认这些改动已由用户提交或单独处理。
- 阅读 `prd.md`、`design.md`，以及 `implement.jsonl` 中的 spec。

## 步骤

1. **公共模块** `lib/protocol-common.js`
   - `AdapterError`、ID 生成、推理令牌编解码、Chat SSE 增量解析器、Chat 流聚合器、`estimateTokens`。
   - 单测 `test/protocol-common.test.js`：SSE 跨 chunk / 跨 UTF-8 边界、`{data:…}` 外壳、`[DONE]`、多工具 index 交错聚合、令牌往返与非法令牌。
2. **Responses 适配** `lib/responses-adapter.js` + `test/responses-adapter.test.js`
   - 请求转换全部映射与拒绝清单（design §3），断言产出的 Chat body。
   - 非流式与流式编码：文本、推理、function、custom、local_shell、混合、length、无 usage、失败；断言事件序列、`sequence_number`、completed.output。
   - Codex 真实请求样例夹具（instructions + 多轮 function_call / output + reasoning 项 + custom apply_patch + local_shell）。
3. **Anthropic 适配** `lib/anthropic-adapter.js` + `test/anthropic-adapter.test.js`
   - 请求转换（tool_result 拆分顺序、图片、thinking 当前循环判定、server tool 拒绝）。
   - 非流式与流式编码、错误类型映射、usage 换算。
   - Claude Code 真实请求样例夹具（system 块数组 + cache_control、metadata.user_id、tools、多轮 tool_use / tool_result、thinking）。
4. **server.js 接入**（design §2 的 1–8 项）
   - 先接非流式，再接流式；Chat 分支不改。
   - `x-api-key` 鉴权、`sendJSON` / `sendBusy` 协议错误转换、`count_tokens` 分支、普通日志 `inboundProtocol` 字段与投影、详细日志路由。
5. **集成测试** `test/protocol-integration.test.js`（沿用 `test/integration.test.js` 的本地假上游模式）
   - 三协议 × 流式 / 非流式成功路径；首包前 429 / 5xx 重试与换号；输出后错误；客户端断开；拒绝类请求零上游调用；401 / 429 协议格式；`x-api-key`；count_tokens 无上游请求；统计 / 日志各一次且带 `inboundProtocol`。
   - 确认现有 `test/integration.test.js` 中 `/v1/responses` 501 断言更新为新行为（这是唯一允许修改的旧断言）。
6. **文档**：README 端点表、支持子集 / 拒绝清单、Codex `config.toml` 与 Claude Code 环境变量示例；删除"不提供 Responses API"与 501 表述。

## 验证命令

```bash
node --check server.js lib/protocol-common.js lib/responses-adapter.js lib/anthropic-adapter.js
node --test test/protocol-common.test.js test/responses-adapter.test.js test/anthropic-adapter.test.js test/protocol-integration.test.js
env -u CLINE_UPSTREAM_BASE npm test
git diff --check
```

## 风险文件与回滚点

- `server.js` 的 `handleChat` 流式分支（5472–5591）与 `dispatch`：改动集中、独立提交，便于回退。
- 回滚：还原 `server.js` 路由与 `handleChat` adapter 分支；新 lib 文件不被引用即无影响。

## 审查关卡

- 步骤 1–3 完成后跑适配器单测再接入 server。
- 步骤 5 完成后执行 trellis-check 全量检查。
- 部署后用真实 Codex CLI 与 Claude Code 做 AC11 手工验收（不在本地用生产凭据测试）。
