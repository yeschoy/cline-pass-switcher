# Implementation Plan

## 0. Baseline and guardrails

- [ ] Snapshot `git status`; keep the pre-existing untracked `pnpm-lock.yaml` out of task commits.
- [ ] Run `node --check server.js` and the relevant baseline integration suite before mutation.
- [ ] Confirm task context includes backend persistence/quality/logging, frontend state/quality, and research artifacts.

## 1. Provider attempt planning

- [ ] Refactor `buildAttempts()` into one health-aware plan owner that distinguishes configured, discovered, all-excluded, and auto/unattributed sources.
- [ ] Preserve artificial provider priority as authoritative among all non-cooling channels; health labels must not reorder eligible configured providers.
- [ ] Filter active cooldowns, restore expired channels for half-open use, and implement one-channel fail-open when all are cooling.
- [ ] Apply `maxRetries` only after health ordering.
- [ ] Change `injectPrefs()` so every named attempt injects exactly one provider through `only`; remove multi-provider `order` injection while retaining both planner/direct shapes for unknown pipelines.
- [ ] Preserve `pinMode` round-trip and update comments to define preferred as switcher-managed outer fallback.

Validation checkpoint:

- [ ] Add assertions that preferred/strict attempts contain one-element `only`, contain no `order`, preserve configured order after removing only active-cooldown providers, and keep the same Authorization within an account.
- [ ] Assert discovered-provider auto routing is named and health-aware, unknown-provider auto remains one unattributed attempt, and all-excluded never bypasses exclusion.

## 2. Failure classification and account-action gating

- [ ] Add bounded `Retry-After` parsing for delta-seconds and HTTP-date.
- [ ] Create one classifier that returns scope, evidence enum, failure class, and retry delay from normalized attempt facts.
- [ ] Add conservative account-429 evidence from explicit structured account/quota semantics and fresh 100% account quota snapshots.
- [ ] Classify non-JSON/ambiguous 429 as unknown and execute it as non-account for retry purposes.
- [ ] Gate `accountErrorRules[429]` so only account-scoped 429 can cool/ban/switch an account; preserve configured `ignore` semantics.
- [ ] Ensure replacement accounts restart from their own health-ordered first provider and the two-account cap remains unchanged.

Validation checkpoint:

- [ ] Unknown/provider 429 stays on the same Authorization and advances provider without writing account cooldown.
- [ ] Explicit account 429 stops the provider chain, writes configured account cooldown, switches once, and does not penalize provider health.
- [ ] A second account action still cannot select a third account.

## 3. Model × provider health persistence

- [ ] Extend `META.models[model].upstreamStatus[provider]` with bounded timestamps, failure count/class, and cooldown fields while tolerating legacy entries.
- [ ] Centralize success/failure health updates; remove divergent ad-hoc error-only learning from stream/non-stream branches.
- [ ] Implement provider 429 cooldown using valid Retry-After or a 60-second exponential base capped at 30 minutes.
- [ ] Implement 5xx/network/proxy/timeout cooldown using a 15-second exponential base capped at 2 minutes; unsupported channels cool for one hour.
- [ ] Exclude account/auth/request/client-disconnect outcomes from provider health.
- [ ] Update stream finalization: no replay after start, success recovery only on clean completion, late upstream error affects future health.
- [ ] Reuse existing request-finalization metadata save rather than adding another synchronous save per attempt.

Validation checkpoint:

- [ ] Prove model isolation, failure degradation, cooldown routing, expiry/half-open success recovery, all-cooling fail-open, and restart persistence.
- [ ] Prove account-scoped errors do not mutate provider health.

## 4. Diagnostics and console projection

- [ ] Extend trace/request/error projections with bounded scope/evidence/failure/health-action facts plus safe content type/byte count where available.
- [ ] Do not persist raw HTML/JSON response bodies or request content; keep existing redaction boundaries.
- [ ] Update `/api/models` metadata projection and console tags/tooltips for degraded/cooling states.
- [ ] Update the “优先+回退” help text to state that switcher sends one provider per outer attempt.
- [ ] Keep `X-Cline-Target-Upstream`, `X-Cline-Attempts`, and `X-Cline-Actual-Upstream` semantics documented and rely on logs for full attempt paths.

Validation checkpoint:

- [ ] Log tests verify unknown 429 evidence is visible without raw body or secrets.
- [ ] UI contract tests verify the preferred-mode wording and escaped health metadata.

## 5. Documentation and executable contracts

- [ ] Update README routing description: preferred is outer sequential fallback with single-provider attempts.
- [ ] Update backend quality, persistence, and logging specs with classification, provider-health state, fail-open and projection contracts.
- [ ] Update frontend state/quality specs if the rendered provider state or wording changes.
- [ ] Preserve the original request diagnosis in task research and document why two attempts meant two accounts rather than two providers.

## 6. Final verification

Run:

```bash
node --check server.js
npm test
git diff --check
git status --short
```

Manual review:

- [ ] Inspect one preferred planner payload and one direct payload: each has only one provider and no order.
- [ ] Inspect metadata after provider 429 and after account 429; confirm only the intended state changed.
- [ ] Inspect request/error log JSON for path/scope clarity and sensitive-data absence.
- [ ] Inspect console provider rows at desktop and narrow width if UI layout changes beyond wording/tag content.

## 7. Rollback points

- Attempt planning/injection can be reverted independently before persistence fields are relied on.
- New health fields are additive inside existing metadata entries and must remain ignorable by the prior version.
- If classification proves too broad, roll back account-evidence patterns first; unknown defaults safely remain non-account.
- Never roll back by re-enabling raw response-body persistence or gateway-internal multi-provider order.
