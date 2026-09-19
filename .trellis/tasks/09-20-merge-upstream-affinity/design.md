# 上游亲和分支集成设计

## 1. Integration topology

```text
feat/quota-forecast-panel (target, checked out with unrelated dirty files)
              \
               merge --no-ff in clean integration worktree
              /
feat/upstream-session-affinity (verified feature)
              |
              v
integration/upstream-affinity-into-quota (merge commit + full gate)
              |
              v
feat/quota-forecast-panel --ff-only
```

No conflict is resolved in the dirty target worktree. The feature branch/worktree remains retained after integration.

## 2. Conflict strategy

Run the real merge in the integration worktree. For every conflict:

1. Read base, target (`ours`) and feature (`theirs`) regions.
2. Identify the source owner and executable tests from each side.
3. Preserve target post-base behavior first.
4. Add feature behavior into the same owner rather than duplicating helpers/state.
5. Remove conflict markers and run the narrowest tests touching that owner.

Do not use whole-file `git checkout --ours/--theirs` except `.trellis/workspace/tanggod/index.md`, where target/ours is the documented safe choice.

## 3. Critical combined contracts

### Configuration and persistence

Merged route schema:

```js
{
  upstream, upstreams, exclude,
  pinMode, sort, maxRetries,
  providerCooldownMs
}
```

Merged global account configuration also retains:

```js
accountErrorRules
accountContentErrorRules
accountPipeline
```

Statistics schema must be v3: v1→v2 adds model maps/coverage, v2→v3 adds routing counters and `routingTrackingStartedMinute`. Existing v2 data from the target deployment remains valid migration input.

### Chat failure lifecycle

Combined request flow:

```text
parse body
  -> extract Codex/Claude/generic affinity
  -> preserve/derive Chat prompt key
  -> acquire account lease
  -> resolve account/global route
  -> provider circuit planning
  -> account-bound provider attempts
  -> normalize failure
  -> content rule first, status rule fallback
  -> at most one pre-stream account replacement
  -> exactly-once statistics/log finalization
```

Provider circuit failure classification must not replace account content/status rules. Circuit state reacts only to provider-scoped pre-output failures; account rules remain the only owner that cools/bans accounts.

### Ordinary diagnostics

One request record may include both families of safe fields:

- target content-rule result only through bounded account action/status facts; no keyword/matched text;
- affinity type/confidence/upstream-key source/applied/cacheHit;
- bounded provider circuit action in attempts;
- existing model/account/provider/pipeline facts.

Raw prompts, sessions, keys, fingerprints, rule keywords and raw responses remain forbidden.

### Browser state

`public/index.html` must retain:

- target unified visual/advanced status+content rule draft;
- target statistics/model/account UI;
- feature one-click provider setup modal and provider cooldown route field;
- feature request-log affinity/cache column;
- all existing stale generations and explicit save boundaries.

No second generic store, cursor or route draft is introduced.

## 4. Trellis metadata resolution

- Preserve both archived task trees.
- Accept auto-merged journal content and verify both session records.
- Resolve `workspace/tanggod/index.md` to target/ours, because it is a summary pointer and concurrent-worktree conflicts are documented as safe to resolve that way.
- The merge task itself is committed/archived only on the integration history, then target fast-forwards to it.

## 5. Validation and target update

After conflict resolution:

1. Focused account/content-rule + affinity/provider tests.
2. Static/VM UI checks.
3. Full syntax and `npm test` gate.
4. Inspect merge commit parents and clean integration status.
5. Re-snapshot dirty target paths and hashes.
6. Confirm none overlap the commit update or changed unexpectedly.
7. Fast-forward target with `git merge --ff-only`.
8. Confirm target HEAD equals integration HEAD and dirty paths remain unchanged.

If fast-forward refuses or a dirty path overlaps, stop without stashing/resetting/cleaning operator work.

## 6. Rollback

Before target fast-forward, rollback is simply abandoning the integration branch; target is unchanged. After a successful local fast-forward and before push/deploy, rollback requires an explicit new owner decision—do not reset the checked-out target automatically, especially with dirty files present.
