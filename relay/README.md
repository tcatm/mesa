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
| `eth_sendRawTransaction` | Checked (chain, signature, gas cap, nonce, balance, rate limits, optional `ALLOW_TO`), then posted to the inbox. Returns the Elysium transaction hash. |
| `eth_getTransactionCount` (`pending`) | Includes relayed transactions not executed yet, so wallets do not reuse a nonce. |
| `eth_getTransactionByHash` | Shows a relayed transaction as pending until it executes. |
| `mesa_relayStatus` | The HyperEVM transaction that carried a relayed one. |
| anything else | Forwarded to `UPSTREAM_RPC`. |

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
