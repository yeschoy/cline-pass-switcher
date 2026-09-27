# Schema-Changing Production Deployment Guidelines

> Stop-first supplement to [versioned production deployment](./deployment-guidelines.md) when the previous image cannot safely read the candidate's persisted DATA_DIR schema.

---

## Scenario: Stop-first release across an incompatible DATA_DIR schema

### 1. Scope / Trigger

Use this contract when the candidate may persist state that the previous image cannot safely read—for example, client-key account ownership or a newer statistics price schema. Follow the versioned-release contract for source, identity, hardening, endpoints and acceptance, but **this contract overrides its immediate previous-Compose `up -d --no-build` rollback** whenever the old image cannot safely read active v2 data. Never start the old image on writable v2, including after an ambiguous candidate start or Compose failure. A code-only release with `rawBodyLogging=false` is **not** approval to raise memory, add `CLINE_PASS_RAW_BODY_READY=1`, or enable raw capture.

### 2. Signatures

```text
Live DATA_DIR:    /opt/cline-pass-switcher/data          # runtime UID/GID 1000:1000
Project parent:   /opt/cline-pass-switcher               # may be UID 1000, mode 0750
Private stage:    root-private, mode 0700, same filesystem for any directory swap
Old service:      docker compose --project-directory /opt/cline-pass-switcher \
                    -f /opt/cline-pass-switcher/compose.yml stop -t <reviewed-seconds> cline-pass-console
New service:      docker compose --project-directory /opt/cline-pass-switcher \
                    -f /opt/cline-pass-switcher/compose.yml up -d --no-build --no-deps cline-pass-console
Phase evidence shape (example, not a fixed API):
                { phase, oldContainerId, oldImage, oldComposeSha256,
                  v1TreeSha256, candidateImage, candidateComposeSha256 }
```

The phase record contains only opaque digests/identities, is created complete before its first file open, and is atomically replaced/fsynced **before** each mutation boundary. Its exact fields depend on the reviewed transaction; it is not a substitute for inspecting Docker and both data trees after an ambiguous command.

### 3. Contracts

- Before stopping the exact old container, recheck committed/pushed `main`, archive/source hashes, exact Compose-built image ID, the candidate's resolved Compose diff (normally only image/build context), live container/mount/limit/raw state, and a scratch atomic Compose install/restore. The `releases/` parent may be UID-1000-writable even when the release tree is root-owned/readable: rehash the actual files and image rather than calling the path immutable. Establish an operator-attended ingress/in-flight and **all-writers** fence, including host/external writers. A read-only hash or FD sample does not establish a continuing fence.
- Stop only the exact old service; keep it stopped through a fresh, complete, root-private **non-raw** v1 DATA_DIR copy and authoritative Compose/env/gateway/deployment sidecars. Verify framed relative-path, size, SHA-256, UID/GID and mode inventory source→copy→source, then restore to another private path and boot the exact old image there without network. A point-in-time backup made before resuming the old service is stale for a later switch, even if `config.json` still matches.
- Before any candidate writes live v2, durably mark that boundary. An exact candidate started on live data with `--network none` and no published port can validate migration **while the old service remains stopped**; compare snapshot-specific allowed config fields, stable account IDs, ownership, admin state and raw=false. Background quota metadata may change: compare safe field paths rather than inventing a deterministic metadata hash. Preserve an independent complete v2 copy before replacing v2 for rollback; after traffic resumes, make a **fresh** v2 copy before any rollback because the pre-live copy is no longer current.
- For a candidate/Compose failure **before any possible v2 write**, restart old only after proving old Compose and the whole active v1 tree unchanged. After an ambiguous candidate start or `up`, assume v2 may exist: fence traffic, stop the exact candidate, preserve current v2 and sidecars, decide how to retain/reconcile post-switch writes, and install an independently verified complete compatible v1 tree **before** starting the old image. This takes precedence over generic instructions to restore Compose and immediately `up` the previous image. Never restore only `config.json` or run an old permissive parser on writable v2.
- If swapping active DATA_DIR directories for rollback, the project parent can legitimately be UID 1000; do not loosen it to group/world-write or require it to be root-owned. Pin and verify the trusted root-owned ancestor plus project/stage directory FDs and inode/device/mode, keep the backup stage under root-private ancestry on the **same filesystem**, and use Linux `renameat2(RENAME_NOREPLACE)` for each distinct move with durable phase and parent-directory fsyncs. The two moves are **not one atomic transaction**: recovery must distinguish an empty active slot from a completed v1 active tree and verify sealed v1/preserved v2 before any old-image start. Directory FDs do not stop another UID-1000 writer; the external writer fence remains mandatory.
- A deployment-host HTTPS self-probe can be rejected by an edge/WAF while an independent external client receives public 200. Record both observations separately, verify local and internal alias endpoints, and investigate the asymmetry; neither a host-side 403 alone proves public success nor should it override an independently demonstrated public failure. A healthy deployed image with unavailable positive administrator access remains `awaiting-admin-acceptance`, not “not deployed” or “completed.” Retain rollback snapshots, journal, old image and release until an independently approved retention decision; cleanup may remove only scoped, verified disposable fixtures or temporary logs, not the active rollback materials.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Pre-stop source, Compose, container, schema or writer-fence drift | No stop or switch; old healthy service stays running |
| Stop/backup failure while old Compose and entire v1 still match | Restore only exact old service, verify health, keep incomplete private stage untrusted |
| Candidate start or Compose `up` times out/loses response | Treat state as possibly v2; inspect/fence; **never** immediately start old |
| Current v2 copy, v1 seal, stage ownership, same-device or rename destination differs | Fail closed; preserve both trees; no destructive overwrite or old-image start |
| Crash between two directory moves or after second move before journal completion | Recover only from proven gap or proven complete v1/preserved-v2 identities and hashes; otherwise manual fenced intervention |
| Host self-probe 403, independent public 200 and local/internal 200 | Record probe asymmetry; continue only after verifying the independent path; do not claim host self-reachability |
| New image healthy but protected administrator views unavailable | Record deployed image and `awaiting-admin-acceptance`; 401 denial is not positive authentication |

### 5. Good / Base / Bad Cases

- **Good:** stop exact v1, seal/restore its full tree, validate candidate migration offline, install two-field Compose using the exact image, verify all stable account IDs and expected owners from the current snapshot and raw=false, retain v1 plus a separate v2 copy.
- **Base:** candidate is healthy and public meta works externally, but the deployment host receives edge 403 and no independent administrator session is available; record both limits and leave acceptance pending.
- **Bad:** reapply an old image directly on v2, copy only three JSON files, trust a UID-1000-owned verification child as root-private, or let a timer restart old merely because `up` timed out.

### 6. Tests Required

- On a disposable **Linux** same-filesystem fixture with root-private stage and UID-1000 project/data, test `RENAME_NOREPLACE`, occupied destination, parent substitution, wrong seal, and injected failure both between renames and after the second rename before journal completion. A macOS rename simulation does not prove Linux atomic behavior. Check v1 active and v2 preserved byte/mode/owner parity before booting exact old image on a private restore.
- On full private copies, verify raw exclusion, complete non-raw inventory and four authoritative sidecars, scratch atomic Compose replace/restore, candidate's exact image/source/runtime hardening, config-owner migration and old-image startup from **v1 only**. Test pre-stop no-op and ambiguous candidate-up recovery without assuming that a failed command did no write.
- After live switch, assert exact image ID, health/restarts/OOM and cgroup bytes; config prediction and stable account ownership; raw=false and ready flag absent for code-only releases; local/internal/external meta and client-key-only management denial. Obtain positive administrator protected-view evidence separately; no synthetic test or 401 proves it. Do not call a non-billing model-auth status a paid chat test.

### 7. Wrong vs Correct

```text
Wrong:  candidate `up` timed out → `docker compose` old-image up on the active v2 tree.
Correct: mark possible-v2 before `up` → stop/fence candidate → seal current v2 separately
         → verify complete v1 and restore it under a no-replace, journaled boundary
         → verify old Compose/ingress → only then start the exact old image.
```
