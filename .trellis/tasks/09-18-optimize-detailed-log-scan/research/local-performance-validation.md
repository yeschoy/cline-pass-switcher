# Local incremental-index performance validation

Synthetic validation used 5,000 generated UUID roots with metadata-only manifests in a temporary directory. The directory was removed in the same command after the measurement; no production data was copied.

Results on the local development machine:

- startup reconciliation: 688.96 ms
- indexed query (50 rows): 2.77 ms
- indexed minute expiry: 0.10 ms
- one publication: 0.98 ms
- measured heap delta after startup: 10.10 MiB
- indexed entries after publication: 5,001

The focused filesystem-call regression additionally proves that publication, query and indexed expiry perform zero corpus `opendir` calls and zero stored-manifest/body reads after startup. Explicit `reconcile()` is the only tested runtime operation that performs the full disk refresh.
