# 详细日志扫描优化执行计划

## 1. Freeze ownership and baselines

- [ ] Re-read backend logging, quality and deployment contracts before editing.
- [ ] Record the current branch/HEAD and unrelated dirty paths; never stage or alter them.
- [ ] Verify local committed application files still match the deployed source baseline before mitigation.
- [ ] Record production container image/health/restart/OOM, safe detailed setting, config hash, detailed corpus counts/bytes and a bounded CPU sample.

Rollback point: read-only; no local code or production mutation.

## 2. Apply temporary production mitigation

- [ ] Through an authenticated loopback request whose key stays in remote-process memory, POST `detailedLogging=false`.
- [ ] Verify API state is false and the persisted configuration differs semantically only in `detailedLogging`.
- [ ] Verify container remains healthy and existing detailed-log counts/bytes are unchanged.
- [ ] Save only safe hashes/status/counts as task research evidence.

Failure action: if the API or semantic/hash gate is ambiguous, stop without direct config editing. If the setting changed but verification fails, use the same API path to restore the captured original value and verify.

## 3. Add regression coverage first

- [ ] Extend `test/detailed-log-store.test.js` with an instrumented seeded-corpus case that counts root `opendir`, manifest reads and body reads after startup.
- [ ] Assert normal publication, metadata query and indexed minute expiry do not scan pre-existing corpus files.
- [ ] Assert explicit reconciliation rebuilds the inventory and discovers safe on-disk state.
- [ ] Add focused cases for byte replacement, unknown/corrupt admission blocking, failed temporary cleanup recovery and direct removal/index consistency where existing tests do not already prove them.
- [ ] Run the focused test against the old implementation and confirm the performance regression assertion fails for the expected reason.

## 4. Implement the in-memory inventory

- [ ] Add the minimal inventory/accounting fields and helpers inside `DetailedLogStore`; do not add dependencies or another module.
- [ ] Implement startup/full reconciliation with atomic snapshot replacement and existing safe recovery rules.
- [ ] Convert age expiry and capacity admission to indexed operations.
- [ ] Update publication only after successful atomic rename; preserve late-completion eviction behavior.
- [ ] Serve metadata query from the validated inventory while keeping direct detail/body filesystem checks.
- [ ] Keep explicit clear enumeration and reset inventory only on successful completion.
- [ ] Track failed store-owned temporary cleanup without a per-operation corpus walk.
- [ ] Change production full reconciliation cadence to at most hourly while retaining minute-level indexed expiry.

Rollback point: revert only this task’s source/test changes; production remains mitigated with detailed capture off.

## 5. Focused and full verification

Run in order:

```bash
node --check lib/detailed-log-store.js
node --test test/detailed-log-store.test.js
node --test test/detailed-log-capture.test.js
node --test test/integration.test.js
node --check server.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] Inspect the complete detailed store call flow and every caller.
- [ ] Confirm no ordinary logging, redaction, request lifecycle, API schema or UI behavior changed.
- [ ] Run a local synthetic corpus benchmark/call-count check without retaining production data.
- [ ] Run Trellis quality review and address all relevant findings.

## 6. Commit only owned changes

- [ ] Update the logging spec with the executable incremental-index/reconciliation contract.
- [ ] Stage only `lib/detailed-log-store.js`, its focused tests, required spec update and this task’s Trellis artifacts/journal.
- [ ] Confirm `untitled.md`, `.pi/subagents/` and other task directories remain unstaged and unchanged.
- [ ] Commit and record the exact source commit and application-file hashes.

## 7. Production preflight and immutable release

- [ ] Verify the exact repository SSH identity path is a 0600 gitignored regular file without reading it.
- [ ] Create the production archive from committed `HEAD` and the deployment allowlist; verify members and hashes.
- [ ] Repeat production preflight: disk, current exact image, health/restart/OOM, compose/deployment/config/metadata hashes, safe APIs, internal alias and public DNS status.
- [ ] Create unique release/verification/candidate paths and prove they do not exist.
- [ ] Upload and verify the archive; install an immutable release.
- [ ] Build the exact Compose candidate and record image ID without switching.
- [ ] Back up compose, deployment, config and metadata with rollback evidence.

Stop before switch on any identity, source, hash, space, helper, API, health or state-drift failure.

## 8. Switch, gates and rollback

- [ ] Prove candidate Compose differs only in image and build context.
- [ ] Atomically install candidate and start the prebuilt image.
- [ ] Require exact image, running/healthy, restart=0, OOM=false and bounded clean startup logs.
- [ ] Require mitigated config hash unchanged across deployment.
- [ ] Validate local meta, authenticated models/statistics/request logs/detailed settings, invalid quota-refresh rejection and `ai-internal` alias.
- [ ] Apply public endpoint policy from the deployment spec.
- [ ] Repeat stability gates after 90 seconds.

Failure action: restore backed-up config/compose/deployment, start the previous exact image without rebuilding, require old health/API/config gates, keep detailed logging off, retain evidence and stop.

## 9. Restore detailed logging and observe

- [ ] Through the authenticated loopback API, restore the captured original `detailedLogging=true` value.
- [ ] Verify the final config differs from the original pre-mitigation config only by any explicitly approved deployment metadata outside config (normally config hash returns to its original value).
- [ ] Verify existing details remain queryable and new traffic can publish details without changing client behavior.
- [ ] Observe at least five minutes of `pidstat`/container CPU, memory, restart, OOM and bounded application logs.
- [ ] Confirm the old once-per-minute full-corpus spike pattern is absent and no heap OOM occurs.
- [ ] Record safe before/after metrics, release/image/commit, gates and rollback paths in the task research/deployment report.

## 10. Final quality and task closure

- [ ] Run final Trellis check against code, tests, spec and deployment evidence.
- [ ] Record journal progress and archive the completed source task only after all gates pass.
- [ ] Update the OVH operational task with the source task/release/result.
- [ ] Ask the user before deleting any non-business temporary local artifact; do not delete release, image, production backup, logs or verification evidence.
