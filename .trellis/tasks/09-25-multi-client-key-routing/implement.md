# Execution plan (after review/start)

- [ ] Trace every `authOK` caller and legacy/pipeline/cache/session-binding/management selection path; finalize canonical key inventory, environment precedence and empty-key compatibility. Add spec/research context to manifests.
- [ ] Add isolated temp-data integration tests for old config migration, malformed/duplicate inventory preservation, full-list account save, rotation/revocation, keyless legacy behavior, admin-cookie denial and secret exclusions.
- [ ] Implement one validator/normalizer and same-directory atomic persistence for keys and account owner ID; add authenticated key API while preserving existing `POST /api/security` compatibility.
- [ ] Resolve client key ID at auth, scope all chat/catalog selection and replacement before lease/permit; namespace/invalidate session binding and preserve in-flight semantics. Test every scheduler/pool/retry/empty-scope path and no foreign attempt.
- [ ] Update security/account UI drafts, confirmations and accessible key labels without exposing existing secrets; run native browser focus/keyboard/narrow-width checks and old-client roundtrip tests.
- [ ] Update backend/frontend English specs, README/config example; run `node --test test/admin-auth.test.js test/integration.test.js test/account-draft.test.js test/ui-contract.test.js`, Node/inline-VM checks, full env-scrubbed `npm test`, `git diff --check`, independent review and commit.

Rollback gate: synthetic copied-`DATA_DIR` migration+old-image compatibility rehearsal and documented env-backed legacy-key behavior before any separately authorized production rollout.
