# contracts

Foundry project. Uniswap v4-core v4.0.0 and forge-std are git submodules.

| Contract | Role |
|---|---|
| `src/MesaHook.sol` | Launcher and hook of every Mesa pool; holds all launch liquidity |
| `src/MesaToken.sol` | The fixed-supply token each launch deploys |
| `src/BuybackBurner.sol` | Protocol fee recipient; buys $MESA and burns it |
| `src/QuoteRegistry.sol` | ERC-20 quote assets new launches may use (3-day delay to add) |
| `src/LaunchMath.sol` | The launch position, shared by the hook and the registry |
| `src/MesaBridgeRouter.sol` | Target of bridge-and-buy deposits: buys a Mesa token, or refunds the HYPE |
| `src/Create2Deployer.sol` | Places the hook at an address encoding its v4 permissions |

```bash
forge test                 # 54 tests, each top-level call its own transaction
forge build --sizes        # MesaHook must stay under 24,576 bytes
```

Deploying: see the header of `script/Deploy.s.sol`. It refuses to run on the
wrong chain and only deploys its own PoolManager on Elysium testnet or a
local chain.

Tests run against a PoolManager deployed in the test itself. The hook is
loaded from the production build's artifact, because test files that import
the PoolManager are compiled with Uniswap's own optimizer settings.
