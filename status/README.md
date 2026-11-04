# status

`status.mesa.cx`: checks Mesa's services every 15 seconds and serves a
public page and `/api/status`.

- **Elysium node:** our head against the confirmed chain (the message count
  Elysium's Bridge on HyperEVM reports, i.e. the last batch) and against an
  independent live RPC. "Up" once within 5 blocks of the confirmed head.
- **Wallet RPC** (`rpc.mesa.cx`): relay health, relayer balance (degraded
  under 0.02 HYPE), relays, refusals and the hour's spend against its budget.
- **Terminal API** (`api.mesa.cx`): blocks behind its chain head.
- **Server:** load, memory, disk and uptime, from the host's `/proc`.

Uptime is the share of checks a service answered, kept for 30 days in
SQLite. Nothing secret is published.
