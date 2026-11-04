# indexer

Indexes Mesa on Elysium (launches, every trade with its fees, token
transfers, buybacks) into SQLite, and serves the terminal's API. One
process, no other services: Node 22's built-in SQLite, and any Elysium RPC.

```bash
npm ci
NETWORK=testnet npm run dev                           # API on :8080
RPC=http://127.0.0.1:8547 NETWORK=mainnet npm start   # against our own node
```

## API

Amounts are whole units: HYPE (or the pool's quote asset) and tokens. Prices
are quote per token. Market cap = price × 1,000,000,000.

| Endpoint | Returns |
|---|---|
| `GET /tokens?sort=new\|trending\|volume\|mcap&q=&limit=&offset=` | The token table: `address, name, symbol, metadataUri, creator, quote, genesis, launchedAt, price, marketCap, change24h, volume24h, trades24h, holders, devPct, bundlePct` |
| `GET /tokens/:address` | The row above, plus `config` (fees, sniper fee, snipe window, buy cap), all-time volume, and `forensics` |
| `GET /tokens/:address/trades?limit=&before=` | Newest first: `tx, timestamp, trader, side (buy/sell), kind (trade/dev/buyback), quote_amount, token_amount, fee, sniper_fee, price` |
| `GET /tokens/:address/candles?interval=60&limit=500` | `[{ t, o, h, l, c, v }]`, `interval` in seconds |
| `GET /tokens/:address/holders?limit=100` | `[{ address, balance, pct }]`, excluding the pool and burned tokens |
| `GET /stats` | `tokensLaunched, volume24h, trades24h, mesaBurned, buybacks, indexedTo, head` |
| `GET /stream` | Server-sent events `launch` and `trade`, as they are indexed |

`forensics` holds: `devBuy` (declared, at launch), `devHoldsPct` (what the
creator wallet holds now), `bundlePct` (bought by other wallets in the launch
block), `snipeWindow` (wallets, share bought and sniper fees paid during the
snipe window), `top10Pct`, `topHolders`, `creatorLaunches` (the creator's
other tokens).

Trade amounts include fees: `quote_amount` is what a buyer paid or a seller
received. `kind: dev` is the declared dev buy; `kind: buyback` is the
protocol buying $MESA to burn.

Tested against the Elysium testnet deployment: it indexes both rehearsal
launches and all nine of their trades, with fees, prices, holders and the
burned $MESA matching the chain.
