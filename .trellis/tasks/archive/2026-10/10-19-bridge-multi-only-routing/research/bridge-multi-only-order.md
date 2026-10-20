# Research: Bridge multi only/order outbound routing

- **Query**: How ClinePassBridge builds outbound `provider.only` / `provider.order` / gateway equivalents when multiple providers are configured; local retry vs single multi-only request
- **Scope**: mixed (Bridge clone under `.trellis/tasks/_scratch/ClinePassBridge`, Bridge docs)
- **Date**: 2026-10-19
- **Bridge revision**: `776ac0cef57789d693a828f0d6f643cd9fd53aec` (`origin/main`)

## Findings

### Files Found

| File Path | Description |
|---|---|
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/executor.go` | `prepare` → `applyProviderRouting`; single upstream POST body |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/types.go` | `pinnedProviders`, `ProviderPolicy*`, model `Providers []string` |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/provider_routing_test.go` | Contract tests for multi `only`+`order`, policy, folding |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/reasoning_forwarding_test.go` | Preserves other `providerOptions` namespaces while rewriting gateway |
| `.trellis/tasks/_scratch/ClinePassBridge/docs/configuration.md` | Operator-facing: allow-list + order hint; config vs client policy |

### Code Patterns

#### Single outbound request with multi-provider gateway hint

Bridge does **not** walk providers locally. Configured `models[].providers` become both `only` and `order` on **one** upstream Chat Completions body. Gateway (Vercel AI Gateway via Cline) is expected to honor the allow-list and priority.

Key function: `(*Service).applyProviderRouting` in `executor.go`:

```61:108:.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/executor.go
func (s *Service) applyProviderRouting(j map[string]any, alias string) {
	cfg := s.config()
	pinned := cfg.pinnedProviders(alias)
	// Chat Completions accepts a top-level provider shorthand for the same
	// fields. Fold it into providerOptions.gateway so there is one channel to
	// reason about, and so the copy below cannot disagree with itself.
	gateway := map[string]any{}
	for k, v := range object(object(j["providerOptions"])["gateway"]) {
		gateway[k] = v
	}
	for k, v := range object(j["provider"]) {
		if _, ok := gateway[k]; !ok {
			gateway[k] = v
		}
	}
	delete(j, "provider")
	if cfg.ProviderPolicy == ProviderPolicyConfig {
		gateway = map[string]any{}
	}
	if _, ok := gateway["only"]; !ok && len(pinned) > 0 {
		gateway["only"] = pinned
	}
	if _, ok := gateway["order"]; !ok && len(pinned) > 0 {
		gateway["order"] = pinned
	}
	// ... write opts["gateway"] = gateway; delete empty providerOptions
}
```

Called from `prepareWithCredential` after model resolve (`j["model"] = up`), before `request()`.

`pinnedProviders` preserves configured list order:

```267:276:.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/types.go
func (c Config) pinnedProviders(alias string) []string {
	for _, m := range c.Models {
		if m.ID == alias {
			return append([]string{}, m.Providers...)
		}
	}
	return nil
}
```

#### Outbound body shape

**Canonical shape Bridge sends upstream:**

```json
{
  "model": "<resolved upstream id>",
  "messages": [...],
  "stream": true,
  "providerOptions": {
    "gateway": {
      "only": ["deepseek", "wafer"],
      "order": ["deepseek", "wafer"]
    }
  }
}
```

Notes from code + tests:

- Top-level `provider` is **folded into** `providerOptions.gateway` then **deleted** from the body (`TestTopLevelProviderShorthandFoldsIntoGateway`).
- Empty/cleared `providers: []` → no `providerOptions` injected (`TestModelWithClearedProvidersKeepsAutomaticRouting`).
- Other namespaces under `providerOptions` (e.g. `anthropic`, `deepseek`) survive; only `gateway` is rewritten (`TestProviderRoutingPreservesModelOptions`).
- Max 8 unique slugs; normalized lowercase on save (`TestProviderConfigValidation`, `TestProvidersAreNormalisedOnSave`).
- DeepSeek aliases default-seed `["deepseek"]`; other models default unpinned (`defaultProvidersFor`).

#### Provider policy

| Policy | Behavior |
|---|---|
| `config` (default if missing) | Drop client gateway/provider hints; inject configured `only`+`order` only |
| `client` | Client wins key-by-key; config fills missing `only`/`order` |

Example (`client`): client sends `only: ["alibaba"]`, config has `[deepseek, wafer]` → outbound `only: ["alibaba"]`, `order: ["deepseek","wafer"]` (`TestClientProviderOverridesConfiguredSetKeyByKey`).

Docs (`docs/configuration.md`): `providerOptions.gateway.only` is the allow-list; `order` is only a priority hint.

#### Local retry vs multi-only

| Mechanism | Provider multi-retry? | What it is |
|---|---|---|
| Multi `only`/`order` | **No** | One HTTP attempt; gateway may fallback among listed providers |
| `nonstream_mode: native-fallback` | **No** (same body) | Optional second attempt: native empty-content error → stream-aggregate with same prepared JSON |
| Credential / team rate / egress | N/A | Account/credential selection, not per-provider `only` walk |

`UpstreamAttempts` increments per host HTTP open (native then stream in fallback), not per configured provider slug.

### External References

- Bridge clone: https://github.com/xiao-qiu-qiu/ClinePassBridge @ `776ac0c`
- [Bridge configuration — 模型与上游选择](https://github.com/xiao-qiu-qiu/ClinePassBridge/blob/main/docs/configuration.md) — allow-list / order / policy wording

### Related Specs

- Local `.trellis/spec/backend/quality-guidelines.md` documents the **opposite** local contract (singleton `only`, delete `order`) — see `local-gaps.md`.

## Caveats / Not Found

- Bridge does not emit OpenRouter-style top-level `provider.only` for production traffic after folding; everything is `providerOptions.gateway`.
- No evidence of Bridge reading response headers for provider selection on the request path; routing is request-body + gateway.
- Exact gateway fallback semantics among `order` entries are upstream-owned; Bridge only injects the hint.
