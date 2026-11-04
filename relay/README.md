# relay

An Elysium JSON-RPC endpoint for wallets. Until Elysium's public sequencer
opens, transactions cannot be sent to Elysium directly; this server posts
each signed Elysium transaction, unchanged, to Elysium's official inbox on
HyperEVM (`sendL2Message`), and the next batch executes it as the user's own
transaction. The relay pays the HyperEVM gas (a fraction of a cent per
transaction); the user pays Elysium gas as usual. It cannot alter, redirect
or forge a transaction: it only forwards what the user signed.

| Method | Behaviour |
|---|---|
| `eth_sendRawTransaction` | Checked, then posted to the inbox. Returns the Elysium transaction hash. |
| `eth_getTransactionCount` (`pending`) | Includes relayed transactions not executed yet, so wallets do not reuse a nonce. |
| `eth_getTransactionByHash` | Shows a relayed transaction as pending until it executes. |
| `mesa_relayStatus` | The HyperEVM transaction that carried a relayed one. |
| anything else | Forwarded to `UPSTREAM_RPC`. |

Checks before a transaction is relayed, so the relayer's HyperEVM gas is
spent only on transactions that will do something:

- chain id, signature, gas limit cap, exact next nonce, and enough HYPE on
  Elysium for the sender's own gas and value;
- the target is allowed: `ALLOW_TO`, or with `MESA_HOOK` set, the hook or any
  token it launched (checked on chain);
- it simulates cleanly against current state. The one exception is a sender
  with exactly one relayed transaction still waiting, since the new one may
  depend on it (an approval, then a swap). At most 8 may wait per sender;
- rate limits per sender and per IP, and a rolling hourly budget for the
  relayer's spend (`MAX_HYPE_PER_HOUR`, `MAX_RELAYS_PER_HOUR`). Over budget,
  transactions are refused and reads keep working.

Reads: `debug_`, `trace_`, `admin_`, `personal_`, `txpool_` and signing
methods are refused; `eth_getLogs` is limited to 10,000 blocks, batches to 50
requests, and reads to 600 a minute per IP. `/health` reports relay counts,
rejections by reason, and the hour's spend.

With `MODE=direct`, transactions are forwarded upstream and the relay is a
plain proxy: the setting for after the public sequencer opens.

Reads go to `UPSTREAM_RPC`. Use one that includes inbox messages not yet
batched (as `rpc.agoradex.app` does), so balances and nonces reflect what the
next batch will execute.

```bash
npm ci
NETWORK=testnet RELAYER_KEY=0x.. npm run dev     # http://localhost:8545
curl localhost:8545/health
```

Tested on Elysium testnet: a transaction sent to the relay with `cast send`
was posted to the inbox and executed on Elysium about two minutes later, from
the signer's own address, with the hash the relay returned.

Deploy: `render.yaml` at the repository root defines a Render web service.
