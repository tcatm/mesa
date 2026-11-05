# market

Market data for chains Mesa does not index itself, from [Codex](https://docs.codex.io),
served at `api.mesa.cx/<chain>/...`. HyperEVM (999) first; Elysium is not on
Codex and stays on Mesa's own indexer.

The Codex key (`CODEX_API_KEY`, in `deploy/secrets.env.age`) never leaves this
service. Every answer is cached for a few seconds, identical requests in flight
share one Codex call, and each IP is limited to 300 requests a minute, so the
plan's compute units scale with distinct pages viewed, not with visitors.

| Route | Cache |
|---|---|
| `GET /hyperevm/tokens?sort=trending\|volume\|gainers\|new&limit=50` | 10 s |
| `GET /hyperevm/search?q=` | 30 s |
| `GET /hyperevm/tokens/:address` | 10 s |
| `GET /hyperevm/tokens/:address/bars?resolution=1\|5\|15\|60\|240\|1D&from&to` | up to 15 s, bucketed per bar |
| `GET /hyperevm/tokens/:address/trades?cursor=` | 4 s (latest), 60 s (older pages) |
| `GET /img?u=<https url>` | a token image, fetched once, checked to be an image (no private addresses, 3 MB max) and cached for a day |
| `GET /health` | none |

Market caps above $500B, or more than 20,000 times the token's HyperEVM
liquidity, are dropped (`marketCapUsd: null`): they come from total supplies
counted across chains (USDC, bridged BTC and ETH), not from HyperEVM.

    CODEX_API_KEY=… npm run dev
