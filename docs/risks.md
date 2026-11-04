# Risks

What can go wrong, stated plainly.

## What Mesa cannot do

- Move any pool's liquidity. It is locked in the hook forever; the hook has no
  function to remove it, and the PoolManager refuses removal for every Mesa
  pool.
- Take anyone's fees. Accrued fees can only be claimed by the address they
  accrued to.
- Change fees, caps or the creator share after deployment. There is no admin
  and no upgrade.
- Mint tokens. Every Mesa token has a fixed supply and no owner.

## What can still go wrong

**Tokens can go to zero.** Locked liquidity means the pool always exists, not
that the price holds. If everyone sells, the price falls back toward the
starting price, and holders who bought later lose money.

**Creators can hold more than their dev buy.** The dev buy is the only buy at
the starting price that is declared on chain. Nothing stops a creator from
also buying from other wallets right after launch. The sniper surcharge and
max-buy cap make that expensive and slow, not impossible. Check the bundle and
deployer columns before you buy.

**Smart-contract risk.** The contracts are new and, at the time of writing,
not audited. Their source is published so anyone can check them.

**Uniswap v4 and Elysium.** Every pool lives in the official Uniswap v4
PoolManager on Elysium. Mesa inherits that contract's risks, and Uniswap
governance can turn on a protocol fee that would apply to Mesa pools. Elysium
is a new chain with a single sequencer; if it stops, so does trading.

**Bridging is slow.** HYPE bridged to Elysium takes about a week to withdraw
back to HyperEVM. Treat bridged funds as committed.

**Buyback keeper.** The keeper chooses when buybacks run and the minimum
$MESA they must return; nothing on chain checks that price. A careless or
malicious keeper could run a buyback at a bad price, for example by
sandwiching it, and take value from the burn. It cannot send the HYPE
anywhere else or buy any token but $MESA, and each buyback is capped in
size.

**Price limits.** A swap whose price limit would stop it partway reverts. Use
a minimum-output check for slippage protection instead.

**Pool price readings.** Selling right after a launch, before anyone buys,
can push a pool's reported price far above its real starting price at no
cost, because there is no liquidity above it. Don't use a Mesa pool's spot
price as an oracle.

## What we will never ask you to do

Change your wallet's RPC to a Mesa endpoint, sign a message to "verify" your
wallet, or send funds to an address that is not one of the contracts listed
in the docs.
