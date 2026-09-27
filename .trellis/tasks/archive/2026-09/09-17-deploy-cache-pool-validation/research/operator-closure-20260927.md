# Operator-requested administrative closure — 2026-09-27 UTC

The operator requested that all remaining Trellis tasks be marked complete after being told that this task still lacked its observation-window acceptance. Archiving is an administrative closure, **not** a claim that its original acceptance criteria passed. Leave the unchecked PRD acceptance boxes unchanged.

- The original two-active-account / 5,000 ms experiment was not validated. The last recorded production policy was a five-account sticky pool with a 1,000 ms normal wait, and the later code deployment restarted the service; see `version-boundary-20260927-load-health-code.md`.
- No uninterrupted post-release warmup plus 24-hour observation with at least 1,000 known-cache samples and all latency, failure, token-share, overflow and health guardrails has been accepted. Historical rolling statistics cannot substitute for that window.
- This closure made no production configuration or account changes, did not measure a new window and did not authorize an automatic rollback. Any future validation or policy change needs its own explicit scope and evidence.
