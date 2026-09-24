# Parent integration plan (planning draft)

- [ ] Review and approve each child's PRD/design/implement independently; curate both `implement.jsonl` and `check.jsonl` with real spec/research context before each child starts. Do not start this coordination-only parent as an implementation task.
- [ ] Complete independent admin login first; verify client keys are rejected across all sensitive management routes, legacy localStorage key is not reused, bootstrap code is one-time, and sessions/change-password/logout/rollback paths work.
- [ ] Complete monthly reference quota display and multi-window forecast; then quota exhaustion policy using the existing quota job, with full 3-window concurrency/restart/reset/error matrix.
- [ ] Complete model/provider page and reference-price estimator with coverage and missing-price cases; browser VM/static, then real-browser navigation, keyboard and narrow-width checks.
- [ ] Complete raw-body capture only after auth acceptance. First test isolated local mock DATA_DIR and saved sanitized legacy groups. Then test 35 MiB/512 MiB admission, 48h expiry, access denial, old/new mode transitions and model traffic parity.
- [ ] For every child run the narrowest relevant tests first, scope-wide tests, Node checks and full `npm test` with credential/base env overrides removed; run `git diff --check`. Re-read spec contracts before editing and update changed executable contracts under `.trellis/spec/` in English.
- [ ] Final parent integration review: account quota projection vs admission, provider attribution vs request finalizer, authentication vs all admin/log URLs, raw-body expiry vs storage maintenance, and startup/rollback compatibility. Preserve unrelated worktree files and require separate explicit production deployment authorization.
