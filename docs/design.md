# Design

Mesa is a token launchpad on Elysium. Every launch is a Uniswap v4 pool on
the official PoolManager, with Mesa's hook attached. This page describes what
the contracts do, exactly. The fee and parameter tables are in
[fees.md](fees.md); what can go wrong is in [risks.md](risks.md).

## Contracts

| Contract | What it is |
|---|---|
| `MesaHook` | The launcher and the hook of every Mesa pool. Holds all launch liquidity. |
| `MesaToken` | The token each launch deploys. Fixed supply of 1,000,000,000, no owner, no mint, no burn, no pause, no transfer tax. |
| `BuybackBurner` | Receives the protocol share of fees. Can only buy $MESA and burn it. Deployed by `MesaHook`'s constructor, so the pairing cannot be forged. |
| `Create2Deployer` | Places the hook at an address whose low bits encode its v4 permissions. |

None of them is upgradeable. `MesaHook` has no owner and no admin function.

## A launch

The first launch can only be made by `genesisLauncher`, an address fixed at
deployment: it is $MESA. After it, anyone can launch. $MESA is then the only
token `BuybackBurner` can ever buy.

`MesaHook.launch(params)`, in one transaction:

1. Deploys a `MesaToken` and mints the full supply to the hook.
2. Creates the pool `HYPE / token` on the PoolManager (native HYPE is
   `currency0`), LP fee 0, tick spacing 200, hook = `MesaHook`.
3. Puts the entire supply into one position from the lowest usable tick up to
   the starting tick. The position is owned by the hook and can never be
   removed. Rounding dust (a fraction of one token) is sent to `0x…dEaD`.
4. If HYPE was sent with the call, executes the creator's **declared dev buy**
   at the starting price, charges the normal buy fee on it, and sends the
   tokens to the caller. A dev buy above 10% of supply reverts.

The starting price is the same for every launch and is fixed at deployment
(`initialTick`). The default, tick 161,200, behaves like a constant-product
curve with a virtual reserve of about 100 HYPE against 1B tokens: roughly 100
HYPE buys half the supply.

## Fees

Every swap pays a fee on its HYPE side, always as the same share of the gross
HYPE amount (what a buyer pays in, or what the pool pays out to a seller),
whichever way the swap is specified:

| Swap | HYPE is | Fee is taken |
|---|---|---|
| Buy, exact input | the input | from the input, before the swap |
| Sell, exact output | the output | added to the swap, before it |
| Buy, exact output | the input | added to what the buyer pays, after the swap |
| Sell, exact input | the output | from the output, after the swap |

A swap with a price limit that would fill only part of a HYPE-specified
amount reverts, rather than charging a fee on input that never traded. Use a
minimum-output check for slippage protection instead; standard routers do.

Fees are held in the PoolManager as ERC-6909 claims of native HYPE owned by
the hook, and credited to `accrued[address]`:

- **Base fee** (per-launch buy and sell rates): `creatorShareBps` to the
  token's fee recipient, the rest to `BuybackBurner`.
- **Sniper surcharge**: 100% to `BuybackBurner`. A creator who snipes their
  own launch from another wallet pays the full surcharge and gets none of it
  back.

Anyone with a balance in `accrued` withdraws it with `claim()`. A token's fee
recipient can hand over to a new address with `setFeeRecipient`; fees already
accrued stay with the old one.

## Fairness kit

Per launch, within contract-enforced bounds:

- **Sniper surcharge** on buys, starting at `sniperFeeBps` and decaying
  linearly to zero over `snipeSeconds`.
- **Max buy per transaction** during `snipeSeconds`, as a share of supply.
  Several swaps inside one transaction count together.
- **Declared dev buy**: the only way the creator can buy at the starting
  price, visible in the `Launched` event.

What the contracts cannot do: stop a creator from also buying from other
wallets, or stop one actor from splitting buys across many transactions and
wallets.
Those are surfaced by the forensics columns in the interface (bundle share,
deployer history), not prevented on chain.

## Locks

| Action | Who can | Enforced by |
|---|---|---|
| Create a pool with this hook | only the hook | `beforeInitialize` |
| Add liquidity | only the hook, at launch | `beforeAddLiquidity` |
| Remove liquidity | no one | `beforeRemoveLiquidity` always reverts |
| Donate to a pool | no one | `beforeDonate` reverts (donations would be stuck forever) |

## Buyback and burn

`BuybackBurner` collects the protocol share with `collect()` (anyone may call)
and its keeper runs `buyback(hypeIn, minMesaOut)`: a swap of HYPE into $MESA
in $MESA's Mesa pool, with the output sent straight to `0x…dEaD`. It has no
withdraw function. The keeper chooses timing, size (capped by `maxPerCall`)
and minimum output; it cannot choose where the HYPE goes or which token is
bought. Buybacks pay no Mesa fee. Its owner can only change the keeper, and
can renounce that.

## Deployment

`script/Deploy.s.sol` deploys `Create2Deployer`, then mines a salt and deploys
`MesaHook` (which deploys `BuybackBurner`). It refuses to run unless
`EXPECTED_CHAIN_ID` matches the chain, bounds-checks every parameter, and
checks that `POOL_MANAGER` answers like a v4 PoolManager. For a rehearsal on
Elysium testnet or a local chain it can deploy its own PoolManager
(`DEPLOY_POOL_MANAGER=true`); it refuses that anywhere else.
