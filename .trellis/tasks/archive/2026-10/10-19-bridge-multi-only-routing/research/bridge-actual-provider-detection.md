# Research: Bridge actual-provider detection from upstream responses

- **Query**: How ClinePassBridge determines the actual upstream channel/provider from the response (headers, body fields, SSE, fallbacks)
- **Scope**: mixed (Bridge clone + tests + docs)
- **Date**: 2026-10-19
- **Bridge revision**: `776ac0cef57789d693a828f0d6f643cd9fd53aec`

## Findings

### Files Found

| File Path | Description |
|---|---|
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/sse.go` | `observeMetadata` — live provider + usage from JSON/SSE frames |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/upstream_error.go` | `responseRoutingProvider`, `routingFacts`, error-text regex |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/model_providers.go` | Probe: `routingCandidates` / `servedByPattern` / `fallbacksAvailable` |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/response_fields_test.go` | Priority: final > resolved > top-level `provider` |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/provider_routing_test.go` | Structured block + nested error.message recovery |
| `.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/service_test.go` | `TestActualProviderRequiresResponseEvidence` |
| `.trellis/tasks/_scratch/ClinePassBridge/docs/configuration.md` | Logs: provider from upstream response or error; else 「未知」 |

### Code Patterns

#### Default when nothing reported

New log / attempt start as:

- `Provider: "unknown"`
- `ProviderSource: "not_reported"`

Configured `only`/`order` or intended pin **never** fills actual provider (`TestActualProviderRequiresResponseEvidence`, docs).

#### Structured routing lookup (`responseRoutingProvider`)

Exact field paths (first match wins within this helper; key order is final then resolved):

| Priority key | Namespace variants | Full path pattern |
|---|---|---|
| 1. `finalProvider` | `provider_metadata` **or** `providerMetadata` | `{namespace}.gateway.routing.finalProvider` |
| 2. `resolvedProvider` | same | `{namespace}.gateway.routing.resolvedProvider` |

```85:95:.trellis/tasks/_scratch/ClinePassBridge/internal/bridge/upstream_error.go
func responseRoutingProvider(body map[string]any) (string, string) {
	for _, key := range []string{"finalProvider", "resolvedProvider"} {
		for _, namespace := range []string{"provider_metadata", "providerMetadata"} {
			routing := object(object(object(body[namespace])["gateway"])["routing"])
			if p := str(routing[key]); p != "" {
				return p, namespace + ".gateway.routing." + key
			}
		}
	}
	return "", ""
}
```

Candidate lists (`fallbackProviders`, `fallbacksAvailable`) are **not** treated as actual provider.

#### Frame / location walk (`observeMetadata`)

Called per non-stream body and per SSE JSON object (`executor.go` consume paths).

Roots inspected:

1. Response root `j`
2. Each `choices[i].delta`
3. Each `choices[i].message`

For each root:

1. Top-level string `provider` → source path `"provider"` (weaker)
2. Then `responseRoutingProvider(root)` → source path `{prefix}{namespace}.gateway.routing.{key}`  
   where `prefix` is `""` or `choices[N].delta.` / `choices[N].message.`

**Stickiness / priority when updating an already-set provider** (`apply` inside `observeMetadata`):

1. Once source ends with `.finalProvider`, later non-`finalProvider` updates are ignored.
2. Once source ends with `.resolvedProvider`, a later bare top-level `provider` is ignored.
3. Otherwise later explicit routing facts overwrite.

Tests (`TestObserveMetadataProviderAliasesAndFinalPriority`):

- `finalProvider` beats `resolvedProvider` in same routing object
- `finalProvider` in an earlier frame beats later `resolvedProvider` / top-level `provider`
- Candidate-only routing leaves provider `"unknown"`

#### Error / failure path (`routingFacts`)

Used by `classifyUpstreamError` → attached to `upstreamError.Provider` / `ProviderSource`, then `logErrorDetails` fills log/attempt **only if** current value is empty or `"unknown"` (does not overwrite a successful frame’s provider).

Fallback after structured lookup:

1. Regex on `error.message` text: `"(finalProvider|resolvedProvider)"\s*:\s*"([^"]+)"`
2. Prefer `finalProvider` match, then `resolvedProvider`
3. Source recorded as `error.message.finalProvider` or `error.message.resolvedProvider`

Supports nested JSON stringified inside rate-limit / wrapper messages (`TestUpstreamErrorTextProviderAliasesAndSource`, `TestProviderIsRecoveredFromNestedErrorMessage`).

#### Probe-only candidate harvesting (not request actual)

`routingCandidates(raw string)` on raw upstream frames:

- Parse `"fallbacksAvailable":[...]` quoted slugs (lowercased, unique)
- Parse first `resolvedProvider` or `finalProvider` via `servedByPattern` as `served_by`
- If candidates nonempty and served not in list, append served
- Empty candidates + served only → private route; do not invent pinnable list

#### Headers

No provider-identity Header is read for actual-provider detection in these paths. `Retry-After` is used for rate-limit delay only.

#### Logging contract

`LogEntry.Provider` / `Attempt.Provider` + `ProviderSource` string path. Docs: unreported → 「未知」. Across native→stream fallback attempts, each attempt keeps its own provider; final entry uses the successful attempt’s evidence (`TestNativeFallbackRefreshesProviderAcrossAttempts`).

### Example source strings observed in tests

| Source | Meaning |
|---|---|
| `provider_metadata.gateway.routing.finalProvider` | Root snake_case metadata |
| `providerMetadata.gateway.routing.resolvedProvider` | Root camelCase metadata |
| `choices[0].delta.provider_metadata.gateway.routing.finalProvider` | SSE delta |
| `choices[0].message.providerMetadata.gateway.routing.finalProvider` | Message object |
| `provider` | Top-level display/name field |
| `error.message.finalProvider` | Regex from error text |
| `not_reported` | Never seen |

### External References

- Bridge docs: provider comes from upstream response or error text; otherwise unknown  
  https://github.com/xiao-qiu-qiu/ClinePassBridge/blob/main/docs/configuration.md

### Related Specs

- Local `.trellis/spec/backend/quality-guidelines.md` — `parseRouting()` / `actualProvider` must not invent from plan alone (aligned intent; field coverage differs — see `local-gaps.md`).

## Caveats / Not Found

- Bridge does not document or parse OpenRouter-only error fields like `metadata.available_providers` for **actual** provider (those appear in local harvest/probe flows).
- No Header-based actual provider (e.g. `X-Provider`) found in Bridge routing code.
- `servedByPattern` first-match in raw text does not encode final-vs-resolved priority the way `responseRoutingProvider` does; probe path is separate from live `observeMetadata`.
