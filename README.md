# Mesa

[![ci](https://github.com/tcatm/mesa/actions/workflows/ci.yml/badge.svg)](https://github.com/tcatm/mesa/actions/workflows/ci.yml)

The table where Elysium launches.

Mesa is a token launchpad on Elysium. Every launch is a Uniswap v4 pool on
the official PoolManager, with Mesa's hook attached:

- **Liquidity locked forever.** The whole supply goes into the pool at
  launch, and no one, Mesa included, can ever remove it.
- **Fees on the quote side, split 70/30.** 70% of the base fee to the token's
  creator, 30% buys $MESA and burns it.
- **HYPE or a listed quote.** Launches pair against native HYPE, or an
  ERC-20 quote listed after a public 3-day delay.
- **Fairness kit.** A decaying sniper surcharge that goes entirely to the
  burn, a per-transaction buy cap at launch, and a declared, capped dev buy.
- **Published source.** Every contract that holds liquidity is in this repo.

> **Status: pre-launch.** Contracts are written and tested against a local
> PoolManager; not yet deployed or audited. See [docs/risks.md](docs/risks.md).

## Docs

| | |
|---|---|
| [docs/design.md](docs/design.md) | What the contracts do, exactly |
| [docs/fees.md](docs/fees.md) | Every fee, cap and default |
| [docs/risks.md](docs/risks.md) | What can go wrong |
| [docs/elysium.md](docs/elysium.md) | Chain facts and Uniswap addresses Mesa depends on, with sources |
| [docs/log.md](docs/log.md) | Dev log |

## Layout

| Path | What it is |
|---|---|
| [`contracts/`](contracts/) | `MesaHook`, `MesaToken`, `BuybackBurner`, `Create2Deployer`; deploy script and tests (Foundry) |

## Develop

```bash
git clone --recurse-submodules https://github.com/tcatm/mesa && cd mesa/contracts
forge test
```

## License

[MIT](LICENSE)
