# Mesa for agents

Elysium's markets and Mesa's launchpad for AI agents, three ways: an **MCP server**, a **`mesa` CLI** and a
**TypeScript SDK**. One package.

```bash
# MCP server (stdio)
npx -y --package=https://mesa.cx/agent/mesa-agent.tgz mesa-mcp

# CLI
npx -y --package=https://mesa.cx/agent/mesa-agent.tgz mesa tokens --launchpad Mesa
```

## Add it to an MCP client

```json
{
  "mcpServers": {
    "mesa": {
      "command": "npx",
      "args": ["-y", "--package=https://mesa.cx/agent/mesa-agent.tgz", "mesa-mcp"],
      "env": { "MESA_PRIVATE_KEY": "0x…", "MESA_MAX_HYPE": "0.5" }
    }
  }
}
```

Leave `MESA_PRIVATE_KEY` out for read-only.

## Tools

| Read (no setup) | Write (needs `MESA_PRIVATE_KEY`) |
|---|---|
| `list_tokens` every launchpad, sorted | `buy` a token with HYPE |
| `get_token` price, holders, launch settings, forensics | `sell` an amount, `all` or `50%` |
| `get_trades`, `get_holders`, `get_candles` | `launch_token` on Mesa |
| `get_portfolio`, `get_balance` | `claim_fees` in HYPE |
| `market_stats`, `mesa_burns`, `explain_transaction` | `post_update` to the token's build log |
| `quote`, `claimable_fees`, `get_updates` | |

## Live alerts: Telegram bots and webhooks

`mesa watch` follows Elysium live (trades, new launches, build-log updates), filters it, and forwards each event.

```bash
# A Telegram alert bot for your token, in three steps:
# 1. Make a bot with @BotFather and copy its token. Add it to your group (or message it).
export TELEGRAM_BOT_TOKEN=123456:ABC…
# 2. Find the chat's id.
npx -y --package=https://mesa.cx/agent/mesa-agent.tgz mesa telegram-chats
export TELEGRAM_CHAT_ID=-100…
# 3. Run it (keep it running with pm2, systemd, or a small VPS).
npx -y --package=https://mesa.cx/agent/mesa-agent.tgz mesa watch --token '$MESA' --telegram
```

Filters: `--token` (addresses or tickers, comma-separated), `--launchpad Mesa`, `--only trades,launches,updates`,
`--min 1` (trades of at least 1 HYPE), `--side buy`. Without a destination it prints to the terminal (JSON lines in a pipe).

**Webhooks:** `--webhook https://your.app/hook` POSTs each event as JSON. Set `MESA_WEBHOOK_SECRET` and every request
carries `x-mesa-signature: sha256=<HMAC-SHA256 of the raw body>`, so your server can check it came from your watcher.
Failed deliveries retry three times. The watcher runs on your machine, so nothing about your endpoint is shared with Mesa.

From code:

```ts
import { watch, describe } from "mesa-agent";

for await (const e of watch({ launchpad: "Mesa", kinds: ["launch", "trade"], minHype: 1 })) {
  console.log(describe(e)); // 🟢 BUY  $MESA  2.5 HYPE  (…)
}
```

Events are `{ type: "trade" | "launch" | "update", token: { address, symbol, name, venue }, … }` with explorer and chart
links. The raw feed is `GET https://api.mesa.cx/elysium/stream` (server-sent events: `trade`, `pool`, `update`).

## Safety

- Use a **wallet made for the agent**, funded with only what it may spend. Never your main wallet.
- `MESA_MAX_HYPE` caps every buy, launch and dev buy (default **1 HYPE**). Anything above it is refused.
- Swaps quote first and set a minimum output (`MESA_SLIPPAGE_BPS`, default 300 = 3%).
- Sells approve exactly the amount sold to Permit2 and sign a single-use, 30-minute permission. No unlimited approvals.
- The key stays on the machine running the agent. Transactions go to `rpc.mesa.cx`, which only relays to Mesa's contracts and the
  Uniswap routers.

## SDK

```ts
import { Mesa } from "mesa-agent";

const mesa = new Mesa({ privateKey: process.env.AGENT_KEY as `0x${string}`, maxHypePerTx: 0.5 });
const { tokens } = await mesa.tokens({ sort: "volume", limit: 5 });
const q = await mesa.quote(tokens[0].address as string, "buy", "0.1");
const res = await mesa.buy(tokens[0].address as string, "0.1");
console.log(res.explorer); // https://mesa.cx/tx/0x…
```

## Builder fees

Building an app that launches tokens? Set `MESA_BUILDER` (your address) and `MESA_BUILDER_FEE` (up to 1, in percent) and every
launch through your agent pays you that share of its trading fees, for life.

## Notes

- Elysium is the Hyperliquid L2 (chain 99901, gas in HYPE). Until its public sequencer opens, transactions are relayed through
  the official inbox on HyperEVM and land about a minute later; the SDK waits for them.
- Data comes from Mesa's own node and indexer at `api.mesa.cx/elysium`. Every transaction is viewable at `mesa.cx/tx/<hash>`.
- MIT licensed. Source: [github.com/tcatm/mesa/tree/main/agent](https://github.com/tcatm/mesa/tree/main/agent).
