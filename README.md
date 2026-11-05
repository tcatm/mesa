<div align="center">

<img src="brand/png/mesa-wide-mint-1300.png" alt="Mesa" width="140">

# Mesa

**The launchpad for builders on Elysium.**

Launch the token for what you're building, earn HYPE from its trading for life, and let holders verify everything on chain. With a terminal and bridge for [Elysium](https://elysium.kinetiq.xyz), the Hyperliquid L2.

[![ci](https://github.com/tcatm/mesa/actions/workflows/ci.yml/badge.svg)](https://github.com/tcatm/mesa/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-B6FFEE?labelColor=1B1B1B)](LICENSE)
[![chain: Elysium 99901](https://img.shields.io/badge/chain-Elysium%2099901-B6FFEE?labelColor=1B1B1B)](https://elysium.kinetiq.xyz/explorer)
[![status](https://img.shields.io/badge/status-live-B6FFEE?labelColor=1B1B1B)](https://status.mesa.cx)

[**mesa.cx**](https://mesa.cx) · [Launch](https://mesa.cx/launch) · [Terminal](https://mesa.cx/terminal) · [Bridge](https://mesa.cx/bridge) · [Docs](https://mesa.cx/docs) · [Status](https://status.mesa.cx)

</div>

---

## What Mesa is

| | |
|---|---|
| **Launchpad** | Launch your project's token in one transaction. 1B supply, all of it in a Uniswap v4 pool, liquidity locked forever, revenue in HYPE for life. |
| **Terminal** | Every token on every Elysium launchpad, indexed from our own node: live charts, forensics, one-click trading. |
| **Bridge** | HYPE between HyperEVM and Elysium through Elysium's official bridge, 1:1, no fee on top. |
| **RPC** | [`https://rpc.mesa.cx`](https://status.mesa.cx), chain ID `99901`, served from Mesa's own Elysium node. |

## $MESA

`0xD1Fe265a3A30177a0c5E74F535a2350b5f370197`, the first token launched on Mesa.

**30% of every Mesa token's trading fees buys $MESA and burns it.** Every launch after it feeds the burn. The burn
runs every 10 minutes in small chunks, and you can watch it live at [status.mesa.cx](https://status.mesa.cx) and on
[mesa.cx](https://mesa.cx).

```
someone launches on Mesa  →  every trade pays a fee in HYPE  →  30% buys $MESA  →  🔥 burned forever
```

## For builders

- **Revenue in HYPE, for life.** 70% of a 1% to 10% trading fee goes to your side on every trade, in HYPE, never in your token.
- **Pay the team, reward holders.** Split your side across up to five wallets, holders of 0.1%+, or buybacks of your own token.
- **Builder fees.** Apps that launch tokens through Mesa can take up to 1% on top of every trade, for life: `mesa.cx/launch?builder=0x…&builderFee=0.5`.
- **Coming next:** a builder dashboard and SDK, verified builder profiles, and shielded HYPE.

## How a launch works

- **Fixed supply.** 1,000,000,000 tokens. No owner, no mint, ever.
- **All of it in the pool.** The whole supply goes into one Uniswap v4 pool on the official PoolManager, starting at a
  market cap of about 30 HYPE.
- **Liquidity locked forever.** No one can remove it, Mesa included.
- **One fee for life.** 1% to 10% on every buy and sell, chosen at launch and fixed.
- **Fees in HYPE.** Taken on the HYPE side of each swap through the hook's return deltas, never in the token, so no fee
  tokens are ever sold back into a chart.
- **Launch protection, optional.** A sniper surcharge that fades to zero (all of it burns $MESA) and a per-transaction
  buy cap for the opening window.
- **Declared dev buy.** Up to 10% of supply, at the starting price, in the launch transaction, shown publicly.

### Where the fees go

| Fee | Range | Goes to |
|---|---|---|
| Trading fee | 1% to 10%, fixed for life | **70%** to the creator's side, **30%** buys and burns $MESA |
| Sniper surcharge | 0% to 30%, fading over up to 15 min | **100%** buys and burns $MESA |
| Builder fee | 0% to 1%, on top | The app the token was launched through |

The creator's side can go to one wallet, or be split between up to five payout wallets, **holders** (every wallet with
1M+ tokens, paid every 10 minutes) and **buybacks** of the token itself. Full detail in [docs/fees.md](docs/fees.md).

## Contracts

Elysium mainnet, chain `99901`. Nothing in Mesa can be upgraded.

| Contract | Address |
|---|---|
| `MesaHook`: launches, fees, claims | [`0xE928F2336051cBD5B9D4531C25EaDd13f9A82aeC`](https://elysium.kinetiq.xyz/explorer/address/0xE928F2336051cBD5B9D4531C25EaDd13f9A82aeC) |
| `BuybackBurner`: buys and burns $MESA | [`0xcCFe02C0a8Fec0c39683aE00b35A5d4560d8E7C1`](https://elysium.kinetiq.xyz/explorer/address/0xcCFe02C0a8Fec0c39683aE00b35A5d4560d8E7C1) |
| `MesaTokenFactory`: deploys each token | [`0x4E395ad9938689BF6456d7f058f85c8842312f1E`](https://elysium.kinetiq.xyz/explorer/address/0x4E395ad9938689BF6456d7f058f85c8842312f1E) |
| $MESA | [`0xD1Fe265a3A30177a0c5E74F535a2350b5f370197`](https://elysium.kinetiq.xyz/explorer/address/0xD1Fe265a3A30177a0c5E74F535a2350b5f370197) |
| Uniswap v4 PoolManager (official) | [`0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1`](https://elysium.kinetiq.xyz/explorer/address/0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1) |

Every address, role and the bridge contracts: [docs/deployments.md](docs/deployments.md).

## Repository

| Path | What it is |
|---|---|
| [`contracts/`](contracts/) | Solidity (Foundry): `MesaHook`, `MesaToken`, `MesaTokenFactory`, `MesaRewardToken`, `MesaPayout`, `BuybackBurner`, `QuoteRegistry`, bridge contracts; deploy scripts and tests |
| [`relay/`](relay/) | `rpc.mesa.cx`: wallet RPC that relays signed transactions through Elysium's inbox until its public sequencer opens; also the $MESA buyback keeper |
| [`indexer/`](indexer/) | `api.mesa.cx/elysium`: indexes every Uniswap v4 PoolManager on Elysium for the terminal |
| [`market/`](market/) | `api.mesa.cx`: HyperEVM market data, the image proxy and launch image uploads |
| [`bridge/`](bridge/) | HyperEVM ↔ Elysium bridge client (Arbitrum SDK) |
| [`status/`](status/) | [status.mesa.cx](https://status.mesa.cx): live health, uptime, relayer balance and burns |
| [`node/`](node/) | Mesa's Elysium node (Nitro) |
| [`deploy/`](deploy/) | Server setup: every service, applied automatically from `main` |
| [`brand/`](brand/) | The Mesa logo, every variant, generated from one geometry |
| [`docs/`](docs/) | Design, fees, risks, chain facts and deployments |

## Docs

| | |
|---|---|
| [design.md](docs/design.md) | What the contracts do, exactly |
| [fees.md](docs/fees.md) | Every fee, cap and default |
| [risks.md](docs/risks.md) | What can go wrong, and what Mesa can't do |
| [elysium.md](docs/elysium.md) | Chain facts and the Uniswap addresses Mesa depends on, with sources |
| [deployments.md](docs/deployments.md) | Every deployed contract and role |
| [log.md](docs/log.md) | Dev log |

## Develop

```bash
git clone --recurse-submodules https://github.com/tcatm/mesa && cd mesa

# contracts
cd contracts && forge test

# any service: relay, indexer, market, status
cd relay && npm ci && npm run typecheck
```

## Security

The contracts have been tested and rehearsed on testnet and on mainnet with a throwaway deployment, but **not
audited**. Read [docs/risks.md](docs/risks.md) before you put in more than you'd lose. Mesa will never ask for your
seed phrase or ask you to send funds.

## License

[MIT](LICENSE)
