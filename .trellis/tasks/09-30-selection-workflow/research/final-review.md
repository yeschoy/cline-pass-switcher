# Final branch review

Independent read-only reviewer: workflow_final_review, GPT-6 Astra high. Reviewed e16db146..849cc245 against the plan/spec/progress rulings, without production access or browser use. Initial suite408/408 green. Final verdict on that revision: not ready until Important findings fixed. No second reviewer was dispatched; fixes are verified by reproductions and regression tests.

| Finding | Initial grade | Resolution |
| --- | --- | --- |
| env-only CLINE_PASS_KEY account count pruned before injected ID is retained | Important/P2 | RED restart changed count2 to empty. Use the env-inclusive valid-ID set. Integration GREEN. |
| each new lease serializes/writes potentially large bulk META | Important/P2 | Small authoritative selection-counters.json snapshot under existing server/atomic writer. Pre-completion persistence test GREEN, no bulk metadata rewrite; large-file cost report included. |
| reset pending button reenabled by workflow redraw | Important/P2 | RED then dedicated reset pending flag plus entry guard. UI GREEN. |
| clean refresh interpreted as unsaved conflict | Minor/P3 | Regraded Important because normal refresh can block save; pass pre-read dirty state to hydration. RED→GREEN. |
| owner reset cannot recover exhausted global safe-integer tie sequence | Minor/P3 | Deferred: natural exhaustion is impractical. Manually seeded extreme state needs offline repair preserving counts. |

Strengths: no await between rank/lease/count; explicit owner/hard-state admission; admin/CSRF management protection; strict contracts/revision conflict checks; pure preview; bounded secret-free diagnostics; real local258 leases with256 socket queue.

Scope rulings: existing incomplete-SSE success accounting and bulk-config/meta transaction ordering were not introduced here and remain separate tasks. General429 and direct socket defaults are unchanged. No local test proves production limits or exact IP limit scope. Browser mouse drag/narrow/confirm cancellation were blocked by locked Mac; prior keyboard/save/reload/counter/trace checks are actual browser evidence. Performance figures isolate local persistence cost, not full end-to-end latency or physical-disk crash durability.
