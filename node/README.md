# node

Our own Elysium mainnet node, so Mesa's reads depend on no one else's RPC.
Elysium is an Arbitrum Orbit chain with AnyTrust data availability: HyperEVM
holds a small certificate per batch, and the batch data itself comes from the
data availability committee. Everything a node needs is public:

| Input | Source |
|---|---|
| Chain info | `chaininfo-mainnet.json`, from Conduit: `https://api.conduit.xyz/file/v1/arbitrum/chaininfo/elysium-mainnet`. Its rollup addresses match the ones read on chain from the inbox (docs/elysium.md). |
| Batch data | `https://das-elysium-mainnet.t.conduit.xyz` (checked: it serves the latest batch's data without a key) |
| Live blocks | Conduit's sequencer feed, `wss://relay-elysium-mainnet.t.conduit.xyz/` |
| HyperEVM | your own RPC (a dRPC key works) |
| Software | stock Arbitrum Nitro `v3.9.5`, the version Hypedexer documents for Elysium testnet |

The feed gives the node blocks as the sequencer makes them, ahead of the
batch that confirms them; without it, the node follows batches only (every
few hours before the public sequencer opens).

```bash
PARENT_RPC=https://lb.drpc.live/hyperliquid/<key> docker compose up -d
curl -s localhost:8547 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
```

Host: a VPS with 4+ cores, 16 GB RAM and a few hundred GB of NVMe, which is
more than a Render web service offers. The relay can run on the same machine
or on Render with `UPSTREAM_RPC` pointing here.

Not yet run end to end: the sandbox this was written in cannot reach Docker
Hub. The first run on the server is the test.
