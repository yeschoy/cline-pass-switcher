# `deepseek` 官方渠道在各模型上的可用性（实测）

采集时间：2026-11-05 03:40（Asia/Shanghai）。数据源：Vercel AI Gateway 公开端点
`GET https://ai-gateway.vercel.sh/v1/models/{model}/endpoints`，只读探测，未消耗额度。

> **2026-11-07 更新**：Cline 官方接口现已实测拒绝 `providerOptions` 路由，本项目默认使用上游自动路由。本文关于自动提升官方渠道、Magpie extra body 的说明，仅适用于已确认接受参数并开启 `gatewayRoutingEnabled` 的兼容网关；不能再直接用于当前官方接口。[403 排查与对照实测](provider-options-403.md)。

## 1. 结论摘要

1. **`deepseek` 官方渠道只覆盖 4 个模型**：`deepseek-v4-pro`、`deepseek-v4-pro-0813`、
   `deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`。
2. **`*-fast` 变体一个都没有官方端点**，且整个模型只有 `baseten` 一家提供服务。
   在 fast 变体上写 `only: ["deepseek"]` 必然失败（`only` 是硬过滤，不回退）。
3. `deepseek-v4.1-flash-1017` 与 `deepseek-v4.1-flash-1017-fast` **只差一个 `-fast` 后缀**，
   但一个是 24 家 provider、另一个是 1 家，行为完全相反。
4. 官方端点在这些模型上 **不是最便宜**：`v4.1-flash` 系最便宜的是 `morph`（0.022/M），
   仅为官方（0.15/M）的约 1/7，且 `morph` 的 `has_zdr` 为 `true` 而官方为 `null`（未声明）。
5. 所有被测模型的 `regions` 都只有 `us`，所以 `inferenceRegion` 的 `geoRegion` 只可能取 `us`。

## 2. 完整矩阵（2026-11-05 实测）

单价为网关返回的 `pricing.prompt`（美元 / token，换算成 /M 便于阅读）。

| 模型 | provider 数 | 有 `deepseek` 官方 | 官方 prompt /M | 官方 zdr | 最低价渠道 /M | `only:["deepseek"]` |
|---|---:|---|---:|---|---|---|
| `deepseek/deepseek-v4-pro` | 6 | ✅ | 0.66 | `null` | `deepseek` 0.66 | 可用，且正好最便宜 |
| `deepseek/deepseek-v4-pro-0813` | 10 | ✅ | 0.66 | `null` | `alibaba` 0.66（zdr ✅） | 可用 |
| `deepseek/deepseek-v4.1-flash` | 22 | ✅ | 0.15 | `null` | `morph` 0.022（zdr ✅） | 可用，但贵约 7 倍 |
| `deepseek/deepseek-v4.1-flash-1017` | 24 | ✅ | 0.15 | `null` | `morph` 0.022（zdr ✅） | 可用，但贵约 7 倍 |
| `deepseek/deepseek-v4.1-flash-1017-fast` | **1** | ❌ | — | — | `baseten` 0.6 | **必然失败** |
| `deepseek/deepseek-v4.1-flash-fast` | **1** | ❌ | — | — | `baseten` 0.6 | **必然失败** |
| `deepseek/deepseek-v4-flash` | 8 | ❌ | — | — | `deepinfra` 0.06（zdr ❌） | **必然失败** |
| `deepseek/deepseek-v4-flash-0731` | 14 | ❌ | — | — | — | **必然失败** |
| `deepseek/deepseek-v3.2` / `-thinking` | 2 | ❌ | — | — | — | **必然失败** |
| `deepseek/deepseek-v3.1` / `deepseek-r1` | 1 | ❌ | — | — | — | **必然失败** |

`*-vision-exp` 等实验型号同样没有官方端点。

## 3. 怎么配置

### switcher（本仓库）

**仅在开启 `gatewayRoutingEnabled` 且上游支持路由参数时适用**。`server.js` 的 `withOfficialChannelFirst()` 已经实现通用规则：
模型名去掉 `cline-pass/` 前缀后以 `deepseek` 开头，且该模型本次候选渠道里**本来就有**
`deepseek` 时，自动把它提到 `gateway.only` / `gateway.order` 头部；候选里没有就完全不动。
因此上表中标 ❌ 的模型不会被这条规则影响，不会出现「无可用 provider」。

提升发生在 `exclude` / 硬隔离 / 冷却过滤**之前**，所以被排除的官方渠道不会被拉回。

### Magpie 等其他客户端直连网关

在「额外请求体」里写**优先**而不是**唯一**：

```json
{
  "providerOptions": {
    "gateway": {
      "order": ["deepseek", "alibaba", "baseten"]
    }
  }
}
```

Magpie 的 extra body 默认语义是「请求已有的字段保留，写 `"!name"` 才替换」。
用 `"!providerOptions"` 会整段覆盖客户端自己生成的 `providerOptions`，
如非必要不要加 `!`。

不建议写 `only`：一旦切到 `-fast` 或 `v4-flash` 系模型，请求会直接失败而不是回退。

### 附带修正

- `inferenceRegion.providers` 的键必须用**网关 provider slug**（如 `deepseek`），
  写 `openai-compatible-private` 这类 AI SDK 本地实例名会被静默忽略，不报错。
- `scope: "global"` 是默认值，写了等于没写；且本表所有模型只有 `us` 区域端点。
- `openaiCompatible.strictJsonSchema` 应写布尔 `false`，不是数字 `0`。

## 4. 局限

- 端点表是网关的公开声明，**不代表某个账号的实际路由结果**；`only`/`order` 是否被遵守
  只能用该账号真实请求验证（网关对部分 key 的 `only` 执行行为见 `gatewayHas` 相关记录）。
- 价格随网关调整，采集时间之后的数值可能变化；本文数字仅用于同一次采集内的相对比较。
- `has_zdr` 的 `null` 表示**未声明**，不能推断为「不留存」或「会留存」。
