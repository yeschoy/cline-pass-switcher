# 详细日志增量索引与生产止损设计

## 1. Boundary and source owner

`lib/detailed-log-store.js` remains the only owner of detailed-log persistence, retention, listing, direct reads and clear semantics. `server.js`, detailed capture/redaction, API payloads and browser state do not gain a second store or scheduler.

The production source is the committed application allowlist from the Cline Pass repository. The existing dirty/untracked worktree state is unrelated and must not be staged, archived or deployed.

## 2. Current failure mode

The current store deliberately avoids a corpus index. Every `scan()` walks all root directories, stats every manifest/body file and parses every manifest. That operation is called repeatedly:

```text
minute timer -> expire -> scan + admit(0) -> scan
publication  -> expire -> scan + admit(0) -> scan -> admit(bytes) -> scan
query        -> expire -> scan + admit(0) -> scan -> listing scan
```

At 4,754 roots and 22,812 files, the design turns normal operations into O(corpus) filesystem and JSON work. Publication also serializes behind these scans, retaining sanitized work while queued and increasing heap/GC pressure.

## 3. Runtime inventory

Add an in-memory inventory inside `DetailedLogStore`; do not create another module or persistent sidecar.

Each validated root entry contains only bounded metadata already approved for listing plus storage accounting:

```js
{
  requestId,
  row,              // summary(request), no headers or body text
  bytes,            // manifest + immutable body files
  manifestBytes
}
```

Store-level state tracks:

- entries by UUID;
- total known + preserved-unknown bytes;
- count/presence of unknown or corrupt groups that block unsafe eviction;
- store-owned temporary directories that failed cleanup;
- last successful full reconciliation time.

At the current 1 GiB/7-day production shape this metadata is small relative to captured bodies. Query sorting may remain an in-memory O(N log N) operation; avoiding a one-use heap keeps the implementation direct and removes disk I/O, which is the actual bottleneck. To prevent a corpus of tiny or malicious manifests from turning the index into a new OOM source, the inventory has fixed 100,000-entry and 64 MiB projected-summary/accounting limits. Crossing either fence preserves every root, rejects new diagnostic publication and exposes safe storage-unavailable state until explicit clear or a later hourly reconciliation fits again; it never evicts by record count.

## 4. Full reconciliation

A full reconciliation is allowed:

1. at startup;
2. on the low-frequency production timer, no more than once per hour;
3. on a detected internal inventory mismatch where continuing would be unsafe.

Reconciliation:

- validates the root directory without following symlinks;
- cleans only safely recognized owned temporary directories;
- inspects UUID roots, manifest shape and declared body sizes without reading body contents;
- preserves and accounts for corrupt/unsafe/unreadable groups as unknown;
- recovers persisted `open` roots to `interrupted` using the existing atomic manifest replacement;
- removes only existing contract-approved unreferenced files;
- builds a separate inventory snapshot and swaps it in only after the pass completes successfully;
- then applies indexed age and capacity retention.

Failure leaves the previous active inventory intact and records only safe health state. No partial snapshot becomes authoritative.

## 5. Incremental operations

### Publication

The serialized publication path performs:

1. existing generation/time/UUID and optional open-root checks;
2. materialization and byte calculation;
3. indexed age expiry;
4. indexed capacity admission/oldest eviction;
5. existing temporary writes and atomic rename;
6. inventory insert/replace only after successful publication.

For an open-root completion, admission reserves the full new publication size while the old root still exists so temporary bytes remain inside the 1 GiB bound. After the atomic replacement, inventory accounting swaps the old root size for the new size. If admission evicts that old root or a previous operation removed it, the late completion is dropped and cannot recreate it.

A failed temporary cleanup is tracked by exact store-owned name. Subsequent serial work retries only tracked temporary paths; persistent cleanup failure returns the existing safe storage failure instead of scanning or proceeding with underestimated storage.

### Age and capacity

The minute timer remains, but it only compares indexed timestamps with `now()` and removes expired roots. Admission sums indexed bytes and selects the oldest validated row in memory. If unknown/corrupt storage exists and the budget cannot be proven safe, admission fails rather than deleting unknown data.

### Query and reads

Metadata queries filter, sort and paginate the validated inventory. They never read body files or rescan the corpus. `detail()` and `body()` continue to validate direct filesystem state on demand; missing, replaced, expired or symlinked content remains a safe 404. Direct expiry/removal updates the inventory.

### Clear

Explicit clear retains its current strong behavior: advance generation first, clean safe temporary groups, enumerate the root once and delete UUID directories, including corrupt UUID roots selected by the operator’s clear action. Unknown names and symlinks remain preserved. A successful clear resets the inventory; a failure reports 503 and does not falsely claim success.

## 6. Consistency model

The process is the authoritative writer. Its own publications, evictions and clears update the inventory synchronously inside the existing serial queue. Process-external file edits are discovered at the next hourly reconciliation or process restart; direct body/detail reads still validate the path immediately.

No durable index is introduced because it would require an additional atomicity/recovery contract and could itself drift from the filesystem. Restart reconstruction remains the source of truth.

## 7. Security and data-loss controls

- Keep UUID-v4 validation, `O_NOFOLLOW`, lstat directory/file checks and body ownership checks.
- Never add headers, body text, credentials or paths to inventory/API health.
- Keep unknown/corrupt data fail-safe: exclude it from listing, account its bytes, never age/size-evict it automatically.
- Do not update inventory before rename succeeds.
- Do not delete production logs for mitigation or deployment.
- Preserve capture fail-open behavior for model traffic.

## 8. Production rollout

### Temporary mitigation

Use a remote Python process to read the management key in memory and POST `{ "detailedLogging": false }` to loopback. The key is not printed or placed in command-line arguments. Verify response, config hash and a safe structural diff. This stops new capture and publication-driven scans while the old minute timer remains until deployment.

### Versioned deployment

Follow `.trellis/spec/backend/deployment-guidelines.md`:

- tests and commit first;
- archive only committed allowlisted application files;
- verify repository-local SSH identity path/mode/gitignore without reading it;
- record production preflight, config/metadata hashes, old compose/release/image and disk space;
- install an immutable release and build the exact Compose candidate;
- back up compose/deployment/config/metadata;
- switch only image tag and build context;
- require health, exact image, zero restarts/OOM, local/authenticated/internal API and unchanged mitigated config hash;
- roll back compose/image/config on any hard failure.

After stable gates, restore the original `detailedLogging: true` through the management API, verify the only intended semantic config transition, create/query a new detailed record through normal traffic if available, and observe at least five minutes of process/container CPU, restart, OOM and logs.

If deployment fails and the old image is restored, retain `detailedLogging: false` as the safe mitigation and report that detailed capture remains temporarily disabled.

## 9. Validation strategy

Focused store tests will instrument filesystem calls against a seeded corpus and assert that, after initialization:

- publication does not reopen pre-existing roots/manifests;
- query does not reopen pre-existing roots/manifests or bodies;
- minute indexed expiry does not perform a corpus walk;
- hourly reconciliation does perform one explicit disk refresh and safely swaps state.

Existing tests remain the behavioral oracle for retention, ordering, restart, temporary cleanup, corruption/symlink preservation, clear/generation and late completion. Full integration and project tests verify unchanged capture/API/traffic behavior.
