# 本机生产发布：Codex namespace 工具支持（20261023-a90d32c-namespace-tools）

状态：已部署。

- 源码：`main` = `a90d32c`；白名单 `git archive a90d32c`，`lib/responses-adapter.js` 与提交一致。镜像 `sha256:53c7b23dc24f4d20bdfb98c4eef8f0d94b00edeef0ccfcbfbc6e8c13834bb837`。
- 上一版本 `20261023-8e42f8c-response-format-json-schema`（`sha256:2322c80e…`），镜像保留；`compose.yml` 备份为 `compose.yml.bak-before-20261023-a90d32c-namespace-tools`。
- 起因：Codex Desktop 0.163 在 `/v1/responses` 的 `tools` 里带 `{type: namespace, name: image_gen, tools: [{type: function, name: imagegen, ...}]}`，旧适配器返回 400 `unsupported tool type namespace`（错误日志中 52 个请求）。Codex 期望调用以 `function_call {name, namespace}` 返回（见 codex-rs `ResponseItem::FunctionCall.namespace`）。
- 变更：namespace 成员展开为 Chat 函数 `<namespace>__<name>`（字符集外替换为 `_`，超 64 字符截断加哈希）；非流式、流式 `output_item.added`/`done` 把调用还原为 `{name, namespace}`；历史 `function_call`/`custom_tool_call` 与 `tool_choice` 中的 `namespace` 用同一规则映射。
- 门禁：完整 `npm test` 661/661；新增单测覆盖展开、历史映射、tool_choice、非流/流式还原；生产错误日志中 52 个带 namespace 的真实请求体本地转换全部成功。
- 发布：配置 SHA-256 `5cf5ab9226db31258d23…` 前后不变；running/healthy、0 次重启、无 OOM。线上用 `image_gen` namespace + `tool_choice: required` 验证，非流/流式均 200 并返回 `function_call {name: imagegen, namespace: image_gen}`；切换后首批真实请求全部 200。
- 回滚：`compose.yml` 的 `image`/`build.context` 换回 `20261023-8e42f8c-response-format-json-schema` 并 `docker compose up -d`。
- 同期排查（未改代码）：`/v1/chat/completions` 的 500 `empty response content` 来自一个 Go 客户端（`max_tokens: 4096` + `reasoning_effort: high` 的非流式请求）。流式重放确认 4096 个 completion token 全部是推理、正文为空、`finish_reason: length`，cline 上游在非流式下把它包成 500。已有 `500-empty-resp` 规则（ignore），不会冷却；需客户端调大 `max_tokens` 或降低 `reasoning_effort`。
