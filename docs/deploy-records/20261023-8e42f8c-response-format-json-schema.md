# 本机生产发布：Responses json_schema 转换修复（20261023-8e42f8c-response-format-json-schema）

状态：已部署。

- 源码：`main` = `8e42f8c`；白名单 `git archive 8e42f8c`，`server.js` sha256 `cb15c98d69f29ad528a0e5b7ea055f3679b8bb39917072ea8cc5fef1287ecc0f` 与提交一致。镜像 `sha256:2322c80ee7a86c3b261c98681e91e0b1885734280ccd612aa1e69c1e6ca1df22`。
- 上一版本 `20261022-f0a4898-upstream-error-shield`（`sha256:c297b897…`），镜像保留；`compose.yml` 备份为 `compose.yml.bak-before-20261023-8e42f8c-response-format-json-schema`。
- 起因（2026-10-23）：Codex Desktop 生成会话标题（`turn_trigger: thread_title`）时发 `/v1/responses`，带 `text.format: {type: json_schema, name, schema, strict}`。旧转换把 schema 本体当作 `response_format.json_schema`，缺 `name/schema/strict` 一层，上游 Vercel 返回 400 `Invalid input`（`param: response_format`）。该 400 被包在 HTTP 200 + SSE 错误事件 `stream_initialization_failed` 里，本服务按 502 返回，new-api 渠道 #71 记为上游失败并重试。
- 变更：① `text.format` json_schema 嵌套为 `{type: json_schema, json_schema: {name, schema, strict, ...}}`，缺 `name` 补 `response`，已是 Chat 形状的 `json_schema` 原样保留。② 包着的 400/422 判断改为基于推断状态：HTTP 200 错误信封、SSE 错误事件中包着的 `request failed with status 400|422` + `invalid_request_error` 也还原为 400，不触发 provider 冷却。
- 上游实测（发布前，直连 api.cline.bot，`cline-pass/deepseek-v4.1-flash-1017`）：正确嵌套 200 且按 schema 输出；旧错误形状稳定复现 400；`json_object` 200。
- 门禁：完整 `npm test` 660/660（首次运行 1 个用例偶发失败，复跑两次均全过）；新增 2 个测试（格式转换单测；SSE 包 400 → 400 且同模型下一请求 200）。
- 发布：配置 SHA-256 `5cf5ab9226db31258d23…` 切换前后不变；切换后 running/healthy、0 次重启、无 OOM；`CLINE_PASS_PROXY_MAX_SOCKETS=128` 保留。线上用 Codex 同形 json_schema Responses 请求验证，非流/流式均 200 且输出符合 schema；切换后首批 16 个真实请求全部成功，无 `response_format` 错误。
- 回滚：`compose.yml` 的 `image`/`build.context` 换回 `20261022-f0a4898-upstream-error-shield` 并 `docker compose up -d`。
