# Elysium reference

Facts about Elysium that Mesa depends on, with where each comes from.
"Lead" means a single or secondary source: re-verify on the explorer before
relying on it in a deployment.

## Chain

| Fact | Value | Source | Status |
|---|---|---|---|
| Mainnet chain ID | 99901 (`0x1863d`) | dRPC chain config (drpcorg/public #291, merged); ElysPump docs; KyberSwap integration | Confirmed |
| Testnet chain ID | 99801 (`0x185d9`) | dRPC chain config; Dwellir | Confirmed |
| Testnet RPC | `https://testnet-rpc.elysium.kinetiq.xyz` | Dwellir | Confirmed |
| Gas token | HYPE, 18 decimals | Dwellir | Confirmed |
| Stack | Arbitrum Orbit, Conduit sequencer, settles to HyperEVM | Dwellir | Confirmed |

Until the public sequencer opens, transactions reach Elysium through the
official inbox on HyperEVM (`0xce59f8b65ad41c9dae4c07a0571a39824bd92cff`, per
ElysPump). Mesa does not relay through it and will deploy once the public
sequencer is open.

## Official Uniswap v4 (mainnet)

Deployed by the Uniswap deployer `0x2179a60856e37dfeaaca0ab043b931fe224b27b6`.

| Contract | Address | Source | Status |
|---|---|---|---|
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` | 0x-settler PR #700; ElysPump docs | Two sources; pinned in `Deploy.s.sol` |
| Universal Router | `0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a` | ElysPump docs; BOXA docs (`0x1b34…3c1a`) | Two sources |
| V4 Quoter | `0x379f556c5a748bd7cc9baf0f7a344094ac1814f5` | ElysPump docs | Lead |
| StateView | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` | ElysPump docs | Lead |
| PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | ElysPump docs | Lead (Mesa does not use it) |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` | ElysPump docs | Same address as every chain |

ElysPump also runs a **separate** PoolManager it deployed itself
(`0x5fb015a49f5b35073f9ce01c2adb287a75f89600`) for its Launchpad v2. Mesa must
not use it; the deploy script refuses any PoolManager but the official one on
chain 99901.

## Observed on chain (2026-11-04)

Read from mainnet through BOXA's public RPC (`https://rpc.boxa.club`, which
reports chain `0x1863d`). The mainnet explorer is currently partner-only
("open to partners until it launches"); the testnet explorer is public.

- **The official PoolManager is in use.** 539 pools had been initialized on
  `0xe2e1…23f1`, by at least seven hooks. This independently confirms the
  address pinned in `Deploy.s.sol`.
- **BOXA** (hook `0x00c002cdae688f39a90cf2ad74c59421c9502acc`, launcher
  `0xf3bae49a2019ab9dcfd43fe7b11c6f01340209c5`): 133 pools, 129 against
  native HYPE at tick 166,200 (about 60.6 HYPE fully diluted). Owner-set quote
  assets with a start tick each, effective immediately: KNTQ, wNVDAx, BLOB,
  BOXA, e/acc, ELYCAT. Pools in both orientations (KNTQ pools open at
  -115,000). CREATE2 tokens via `predictToken(creator, name, symbol, salt)`;
  an on-chain fee preview; two-step creator handover. Transactions appear to
  reach the chain through a relayer posting to the HyperEVM inbox.
- **Flaunch** (hook `0x3ab88ddc3cf2a012af88b60828edb4553697e5dc`): 97 pools.
  Paired-token registry, referrer shares, and an internal swap pool that
  sells accumulated fees into incoming buys.
- A hook at `0xb67656ce894ac93c0164d8490ad23161a77ee000` (231 pools) exposes
  only `FACTORY` and `POOL_MANAGER`; not identified.

## Compatibility

Mesa's tests run trades and quotes through Uniswap v4-periphery's V4Router
and V4Quoter at commit `a7af5b34`, the commit ElysPump reports Elysium's
quoter was built from. The Universal Router uses the same V4Router actions
(`SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`).

## kHYPE (for the later, optional kHYPE launch flavor)

kHYPE accrues value through its exchange rate and does not rebase (Kinetiq
FAQ), so it can sit in an AMM pool unwrapped. Still open before building that
flavor: whether kHYPE is on Elysium and liquid, and whether a deep kHYPE/HYPE
pool exists for exits.
