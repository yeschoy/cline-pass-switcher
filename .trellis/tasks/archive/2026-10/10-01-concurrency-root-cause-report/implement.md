# Investigation plan

- [x] Read relevant Trellis indexes, deployment safety, prior benchmark reports and memory pointers.
- [x] Acquire current production safe projection; capture actual version/config hash and persistent eligibility, keeping runtime-only state unknown.
- [x] Recompute historical workflow stages and independently validate two-egress and per-account-six records, with source hashes.
- [x] Trace current workflow/cache membership, lease admission, transport socket defaults and 429 classification/replacement.
- [x] Write Chinese detailed report with a concise verdict, evidence tables, capacity examples, uncertainties and ranked suggestions.
- [x] Run focused offline evidence checks and relevant existing scheduler tests; no full application gate is required for document/diagnostic-only changes.
- [x] Verify safe artifact schema, report references and git diff; work commit/archive/journal are recorded by the completion workflow.

Rollback: production is not mutated. Local investigation files can be reverted with the task commit; no external operational rollback is needed.
