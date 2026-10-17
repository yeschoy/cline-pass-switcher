# Magpie 三协议边角能力（面向 Chat 上游）

源：https://github.com/yetone/magpie `internal/gateway/`（调研日 2026-10-18）

## 结论

对「Chat 上游网关」：P0 是 tool pairing / call_id 卫生 / reasoning 回放 / 流式错误形态 / Claude thinking 字段完整性。  
`encrypted_content` / `redacted_thinking` 同协议原样回传是 Responses↔Responses、Anthropic↔Anthropic 能力，经 Chat 上游必然有损。Affinity / foreign_seal / Claude subscription bridge 属多上游路由层。

## 能力簇（文件入口）

| 簇 | 关键文件 | Chat 上游相关性 |
|---|---|---|
| IR + Sealed | `ir.go` | 跨协议只传可见 text；Chat 丢 Sealed |
| Tool pairing | `chat.go` `pairToolMessages`；`responses.go` `pairToolItems`/`joinToolRuns`；`anthropic.go` `pairToolBlocks` | **必做** |
| call_id | `chat_call_ids.go`；`codex_backend.go` `boundCallIDs`/`callItemIDs`；`anthropicOutID` | **必做** |
| Custom tools | `custom_tool.go`；`codex_custom_tools_test.go` | 本仓库已有 custom/local_shell；magpie 另有 `tool_search` |
| Reasoning replay | `reasoning_replay_test.go`；DeepSeek `reasonFirst` | Cline 上游多为 reasoning_content 厂商 → **高相关** |
| Stream errors | `stream_error_*_test.go`；空 `response.completed` ≠ 成功 | **必做** |
| Cache | `prompt_cache_test.go`；`claude_cache.go` | key 透传本仓库已有；自动 cache_control 断点可选 |
| Affinity / foreign_seal | `affinity.go` | 多上游；本仓库已有 sticky，可不照搬 seal 重试 |

## Codex / Claude 会撞的边角（摘要）

见同目录 `parity-gap-matrix.md`。

## 深读入口

```
internal/gateway/ir.go
internal/gateway/chat.go
internal/gateway/chat_call_ids.go
internal/gateway/responses.go
internal/gateway/anthropic.go
internal/gateway/custom_tool.go
internal/gateway/codex_backend.go
internal/gateway/whole_stream.go
```
