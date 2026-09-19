# Merge conflict inventory

## Revisions

- Target: `feat/quota-forecast-panel@1da42d0dbdbf912571c00e33a1befede5f31db7c`
- Feature: `feat/upstream-session-affinity@827fdefabcff7e483f6561e82cfd6935eed5a1eb`
- Merge base: `74913e0cb691c208c4d9ebc54042d0e345acf858`

## Text conflicts reported by `git merge-tree --write-tree --name-only`

1. `.trellis/spec/backend/database-guidelines.md`
2. `.trellis/spec/backend/quality-guidelines.md`
3. `.trellis/spec/frontend/quality-guidelines.md`
4. `.trellis/workspace/tanggod/index.md`
5. `README.md`
6. `server.js`
7. `test/integration.test.js`

## Changed on both sides but auto-merged by Git

- `.trellis/spec/frontend/state-management.md`
- `.trellis/workspace/tanggod/journal-1.md`
- `config.example.json`
- `public/index.html`
- `test/account-draft.test.js`
- `test/ui-contract.test.js`

These still require semantic review because both branches changed the same owner/contracts.

## Resolution ownership

- `server.js`: keep target content-rule normalization/matching/API/UI owners, then integrate affinity extraction, upstream prompt key, provider validation/circuit state, statistics v3 and diagnostics.
- `test/integration.test.js`: keep all target content-rule tests and all feature affinity/provider/migration tests; adjust fixtures only where the merged schema requires it.
- Backend/frontend specs and README: combine contracts, never choose a whole side.
- Workspace `index.md`: choose target/ours per Trellis worktree journal guidance; task state remains in task JSON. Verify auto-merged `journal-1.md` includes both target and feature session entries.
- Auto-merged code/UI/tests: inspect diff against both parent trees and run targeted tests before the full gate.

## Dirty target worktree boundary

Preflight found no path intersection between target worktree dirty paths and feature-only changed paths. The target dirty set remains operator/parallel-task owned. Actual conflict resolution happens only in the clean integration worktree; final target update must be fast-forward-only after rechecking this non-overlap.
