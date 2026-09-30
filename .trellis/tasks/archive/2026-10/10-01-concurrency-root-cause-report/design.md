# Investigation design

This is an evidence investigation, not a runtime implementation. The existing server owns leases, workflow decisions, transports and error handling; no additional owner is introduced.

Evidence follows the client request ID through ordinary routing logs to upstream attempts. Historical two-egress records independently change the route while holding accounts/model/request shape fixed, including an idle account and a reverse crossover. Recomputations read sanitized artifacts from the prior benchmark checkout and write only task-local aggregate evidence. Input hashes identify the exact evidence read.

The production projection uses the documented canonical SSH identity (mode and Git ignore checked without reading its contents), bounded noninteractive SSH, and a privileged read-only Python helper. It extracts only explicit non-secret fields, anonymized account labels and aggregate log counts. No model call, API authorization call, data write, container mutation or proxy mutation occurs. Configuration bytes remain remote and only their hash is returned. Dynamic active counts, RPM reservations and session bindings remain unknown without an authenticated runtime read.

The report distinguishes instantaneous request/lease overlap from sustained successful generation, and request launch rate from concurrency. Limits inferred from repeated experiments are not presented as an upstream policy specification. Current configuration is a timestamped snapshot, kept separate from older load results.
