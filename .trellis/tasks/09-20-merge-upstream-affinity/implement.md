# 合并实施计划

## 1. Freeze evidence

- [x] Record target/feature/base hashes and worktrees.
- [x] Record target dirty paths and prove no overlap with feature changed paths.
- [x] Run `git merge-tree` and persist conflict inventory.
- [ ] Validate planning artifacts and activate this task.

## 2. Perform merge only in integration worktree

```bash
git merge --no-ff feat/upstream-session-affinity
```

- [ ] Confirm merge enters only the expected 7 text conflicts.
- [ ] Keep auto-merged files staged but inspect each changed-on-both file semantically.
- [ ] Resolve workspace index with target/ours; verify journal contains both histories.

## 3. Resolve code and contract conflicts

Order:

1. `server.js`
2. `test/integration.test.js`
3. `public/index.html` and auto-merged UI tests
4. backend/frontend specs
5. README/config example
6. Trellis workspace metadata

For `server.js`:

- [ ] Combine content error rules with affinity/provider circuit/statistics v3.
- [ ] Ensure route normalizer contains `providerCooldownMs` and account saves retain content rules.
- [ ] Ensure account/proxy/provider failure classification has one owner per dimension.
- [ ] Preserve cancellation, first-SSE-event and no-replay semantics.
- [ ] Preserve strict logging projection and details fail-open behavior.

For tests:

- [ ] Keep all target content-rule scenarios.
- [ ] Keep all feature affinity, account-scoped validation, circuit, migration and UI setup scenarios.
- [ ] Update shared fixtures for the combined config/statistics schema without weakening assertions.

## 4. Focused validation

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs";import vm from "node:vm";const html=fs.readFileSync("public/index.html","utf8");new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test --test-name-pattern='content rule|Chat affinity|provider cooldown|account routing|statistics' test/integration.test.js
node --test test/ui-contract.test.js test/account-draft.test.js
```

- [ ] Fix only merged-contract defects; do not expand product scope.

## 5. Full gate and merge commit

```bash
for file in lib/*.js; do node --check "$file"; done
node -e 'JSON.parse(require("fs").readFileSync("config.example.json","utf8"))'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
git status --short
```

- [ ] Full gate passes.
- [ ] Commit merge with both expected parents.
- [ ] Integration worktree is clean.

## 6. Fast-forward target without touching dirty work

- [ ] Re-snapshot target dirty status and content hashes.
- [ ] Recompute overlap between dirty paths and `target..integration`; stop if non-empty.
- [ ] In target worktree run:

```bash
git merge --ff-only integration/upstream-affinity-into-quota
```

- [ ] Confirm target HEAD equals integration merge commit.
- [ ] Confirm all pre-existing dirty paths remain dirty/unchanged and none were staged.
- [ ] Do not push or deploy.

## 7. Trellis finish

- [ ] Record verification evidence in this task.
- [ ] Commit task artifacts if not already included in the merge commit.
- [ ] Archive merge task and record journal only after target fast-forward succeeds.
- [ ] Leave integration and feature worktrees for owner review unless cleanup is explicitly approved.

## Completion status

- Merge commit `ca3becd` has parents `1da42d0` and `827fdef`.
- All seven conflicts were resolved and the complete merged test suite passed 165/165.
- `feat/quota-forecast-panel` fast-forwarded to `ca3becd`.
- All 52 pre-existing dirty target entries remained status/SHA-256 identical.
- No push, deployment, production access, stash, reset or unrelated cleanup occurred.
