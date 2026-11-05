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
| `MesaRewardToken` | The same, plus the books for holder rewards. Deployed instead of `MesaToken` when a creator gives holders a share of their fees. |
| `MesaPayout` | Per token, when a creator splits their fees: pays up to five wallets, holders and buyback-and-burn of the token. Outside the swap path. |
| `MesaTokenFactory` | Deploys each launch's token, and its `MesaPayout` if any. Called by `MesaHook`. |
| `BuybackBurner` | Receives the protocol share of fees. Can only buy $MESA and burn it, after converting fees in other quotes to HYPE. Deployed by `MesaHook`'s constructor, so the pairing cannot be forged. |
| `QuoteRegistry` | Which ERC-20 quote assets new launches may pair against. Deployed by `MesaHook`'s constructor. |
| `Create2Deployer` | Places the hook at an address whose low bits encode its v4 permissions. |

None of them is upgradeable. `MesaHook` has no owner and no admin function.
Besides the buyback keeper and owner (below), the only role with a say over
launches is the `QuoteRegistry` admin, described under
[Quote assets](#quote-assets); it cannot touch existing pools or fees.

## A launch

The first launch can only be made by `genesisLauncher`, an address fixed at
deployment: it is $MESA. After it, anyone can launch. $MESA is then the only
token `BuybackBurner` can ever buy.

`MesaHook.launch(params)`, in one transaction:

1. Has `MesaTokenFactory` deploy the token (and its `MesaPayout`, if the
   creator splits their fees) and mint the full supply to the hook.
2. Creates the pool of the token against its quote (native HYPE, or an
   enabled ERC-20 quote) on the PoolManager, LP fee 0, tick spacing 200,
   hook = `MesaHook`.
3. Puts the entire supply into one one-sided position between the starting
   price and the end of the price range on the token's side. The position is owned by the hook and can never be
   removed. Rounding dust (a fraction of one token) is sent to `0x…dEaD`.
4. If a dev buy was sent with the call (HYPE as `msg.value`, or an ERC-20
   quote pulled from the caller), executes the creator's **declared dev buy**
   at the starting price, charges the normal fee on it, and sends the
   tokens to the caller. A dev buy above 10% of supply reverts.

The starting price of native HYPE launches is fixed at deployment
(`initialTick`); each ERC-20 quote has its own, set in the registry. The default, tick 173,200, starts every token at a market cap
of about 30 HYPE. It behaves like a constant-product curve with a virtual
reserve of 30 HYPE against 1B tokens: roughly 30 HYPE buys half the supply,
and each further share costs more, without limit, so the pool never runs out.

## Fees

Every swap pays a fee on its quote side (HYPE, or the pool's ERC-20 quote),
always as the same share of the gross quote amount (what a buyer pays in, or
what the pool pays out to a seller), whichever way the swap is specified:

| Swap | Quote is | Fee is taken |
|---|---|---|
| Buy, exact input | the input | from the input, before the swap |
| Sell, exact output | the output | added to the swap, before it |
| Buy, exact output | the input | added to what the buyer pays, after the swap |
| Sell, exact input | the output | from the output, after the swap |

A swap with a price limit that would fill only part of a quote-specified
amount reverts, rather than charging a fee on input that never traded. Use a
minimum-output check for slippage protection instead; standard routers do.

Fees are held in the PoolManager as ERC-6909 claims of the quote, owned by
the hook, and credited to `accruedOf[quote][address]`:

- **Trading fee** (one rate per launch, on buys and sells, fixed for the
  pool's life): `creatorShareBps` to the token's fee recipient, the rest to
  `BuybackBurner`.
- **Builder fee**: a launch may name a builder (the app it was launched
  through) who earns up to 1% on top of the trading fee, on every trade. It
  is an add-on: the creator's and protocol's shares of the trading fee do not
  change.
- **Sniper surcharge**: 100% to `BuybackBurner`. A creator who snipes their
  own launch from another wallet pays the full surcharge and gets none of it
  back.

Anyone with a balance withdraws it with `claim()` (HYPE) or `claim(quote)`.
`previewFees(token, amount, isBuy)` returns what a trade would pay right now
and where it would go, and `currentFeeBps(token, isBuy)` the total rate. Every
fee also emits the standard `HookSwap` and `HookFee` events of the Uniswap
Foundation's hook data standard, so indexers and aggregators can read it. A token's fee recipient hands over in two steps:
`setFeeRecipient` proposes, and the new address must `acceptFeeRecipient`, so
a typo cannot strand the fees. Fees already accrued stay with the old one.

## Payouts

A creator chooses where their share of the fees goes, at launch:

- **One wallet** (the default): the fee recipient claims from `MesaHook`.
- **A split**, between up to five payout wallets, the token's holders and
  buying back and burning the token itself, in shares fixed at launch. The
  token's fee recipient is then its own `MesaPayout` contract:
  - `collect()` (anyone) pulls the fees from `MesaHook` and splits them.
    Payout wallets `claim()` theirs; each can hand its share to a new wallet
    in two steps.
  - Holder rewards: `distribute()` (anyone, at most every 10 minutes, once
    at least 0.01 HYPE is waiting) sends the holders' share to the token.
    Every wallet holding at least 1,000,000 tokens (0.1% of supply) earns in
    proportion to its balance; contracts never earn, except EIP-7702
    delegated wallets. Holders claim with `claim()`, or anyone pushes it to
    them with `claimFor(holder)`. Nothing loops over holders.
  - Buyback: `buyback()` (anyone, at most every 10 minutes) buys the token
    with at most 0.25 HYPE of the buyback share and sends it to `0x…dEaD`.
    Kept small so that sandwiching it costs more in the pool's fee (paid
    twice, at least 1% each way) than it can make.

A payout contract only ever holds its own token's fees and never runs inside
a swap: nothing in it can reach a pool's liquidity, another token's fees or
$MESA. Splits are for tokens paired with native HYPE.

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

## Quote assets

Native HYPE is always a valid quote. ERC-20 quotes are listed in
`QuoteRegistry`, each with a starting tick (tokens per quote, so a launch
opens at a sensible value whatever it pairs with) and a route: a HYPE/quote
pool the protocol's fees in that quote are sold through.

| Action | Who | When |
|---|---|---|
| Propose a quote, or new settings for one | admin | any time; replaces a pending proposal |
| Activate a proposal | anyone | 3 days after the proposal |
| Cancel a pending proposal | admin | before it is activated |
| Disable a quote | admin | immediately; only stops new launches |
| Hand over the admin role | admin, then the new admin accepts | any time |
| Renounce | admin | any time; no quote can be added again |

The registry checks that a quote is a contract, that its starting tick is
valid on either side of a pool (a launched token's address can sort above or
below the quote's), and that the route pairs HYPE with that quote. It cannot
check that a quote is a plain ERC-20: no transfer fee, no rebasing, no
blocklist. That is what the 3-day delay is for. A dev buy whose quote arrives
short reverts. $MESA itself must launch against native HYPE.

## Buyback and burn

`BuybackBurner` collects the protocol share with `collect()` (anyone may call)
(`collect(quote)` for an ERC-20 quote). Its keeper sells ERC-20 fees for
HYPE through the registry's route with `convert(quote, amountIn,
minHypeOut)`, and runs `buyback(hypeIn, minMesaOut)`: a swap of HYPE into $MESA
in $MESA's Mesa pool, with the output sent straight to `0x…dEaD`. It has no
withdraw function. The keeper chooses timing, size (capped by `maxPerCall`)
and minimum output; it cannot choose where the HYPE goes or which token is
bought. Buybacks pay no Mesa fee. Its owner can only change the keeper, and
can renounce that.

## Deployment

`script/Deploy.s.sol` deploys `MesaTokenFactory` and `Create2Deployer`, then
mines a salt and deploys `MesaHook` (which deploys `BuybackBurner` and
`QuoteRegistry`). It refuses to run unless
`EXPECTED_CHAIN_ID` matches the chain, bounds-checks every parameter, and
checks that `POOL_MANAGER` answers like a v4 PoolManager. For a rehearsal on
Elysium testnet or a local chain it can deploy its own PoolManager
(`DEPLOY_POOL_MANAGER=true`); it refuses that anywhere else.
