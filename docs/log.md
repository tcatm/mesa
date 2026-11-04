# Dev log

What shipped, what broke, and the evidence. Newest first.

---

## 2026-11-04: launches start at 30 HYPE; checked through Uniswap's router

**Changed.** Every launch now starts at a market cap of about 30 HYPE
(tick 173,200), down from about 100.

**Checked.** Trades and quotes now run in tests through Uniswap's own
V4Router and V4Quoter (v4-periphery `a7af5b34`), the path a frontend uses.
All four swap kinds work, quotes match execution exactly with fees included,
and the quoter shows the live sniper surcharge and refuses over-cap buys. A
fuzzed lifecycle test runs 512 full launches: a dev buy, 30 traders buying and
selling through the snipe window, then everyone exits. Every exit succeeded,
HYPE reconciled to the wei, and every pool ended back at its starting price.

**Pinned.** The deploy script now refuses any PoolManager on Elysium mainnet
except the official Uniswap one. ElysPump runs a second PoolManager of its
own, which is easy to confuse with it. Chain facts and addresses, with
sources, are in [elysium.md](elysium.md).

## 2026-11-04: contracts, reviewed

**Shipped.** `MesaHook` (launcher and v4 hook), `MesaToken`, `BuybackBurner`
and a deploy script that mines the hook address. 31 tests against a local
PoolManager: locks, all four swap kinds, the 70/30 split, the sniper
surcharge, the buy cap, the dev buy, claims, buyback and burn, and a fuzzed
round trip that never profits.

**Reviewed.** An independent review found no critical or high issues, and
four medium ones, all fixed before this commit:

1. Exact-output swaps paid their fee on the net amount, so snipers could pay
   about 10% less surcharge. Every swap kind now pays the same share of gross.
2. The launch buy cap applied per swap, so ten swaps in one transaction
   bought 8× the cap. It now applies per transaction.
3. A swap with a tight price limit paid fees on input that never traded. Such
   swaps now revert.
4. A dishonest buyback owner could have pointed it at a fake hook and taken
   the protocol's fees. The hook now deploys its own buyback contract, which
   can only ever buy the first token launched: $MESA.

**Still open, stated in [risks.md](risks.md).** The buy cap can be split
across transactions; the buyback keeper is trusted on price.

**Verified against sources.** kHYPE accrues through its exchange rate and
does not rebase. Elysium mainnet is chain 99901 and testnet 99801 (dRPC's
chain config). The PoolManager address is pinned in the deploy script for
mainnet; see [elysium.md](elysium.md).

## 2026-11-04: quote assets

**Shipped.** Launches can pair against ERC-20 quote assets as well as native
HYPE. `QuoteRegistry` lists them, each with a starting tick and a route to
HYPE; adding one takes a public 3-day delay, disabling one is immediate and
only stops new launches. The hook handles the quote on either side of the
pool, takes fees in the quote, accepts dev buys in it, and pays claims in it.
`BuybackBurner` converts protocol fees in a quote to HYPE through the route,
then buys and burns $MESA as before. Also: `previewFees`, and a two-step fee
recipient handover.

**Why a separate registry.** It keeps the one admin role in a small contract
of its own, and it kept `MesaHook` under the 24,576-byte limit (22,439 bytes
at 500 optimizer runs).

**Tested.** 48 tests, 12 of them new: the registry's delay and gating, every
swap kind with the quote on either side (fuzzed over fees and sizes), dev
buys, the snipe cap, claims, and conversion then buyback.

**Learned from the chain.** Notes on BOXA, Flaunch and the official
PoolManager's use are in [elysium.md](elysium.md).

## 2026-11-04: bridge

**Shipped.** `bridge/`, a TypeScript package on the Arbitrum SDK for HYPE
deposits, withdrawals and claims through Elysium's official bridge, 1:1 with
no fee, plus bridge-and-buy. `MesaBridgeRouter`, its target on Elysium: it buys
a Mesa token for the recipient, or sends the HYPE to them if the buy fails, so
a deposit that lands after the price moved is never stuck.

**Checked live.** The package reads both networks' queues, and tracked a real
mainnet deposit (sent through BOXA, which adds a 2% fee to the same official
deposit) to "credited" when batch 267 landed.

## 2026-11-04: relay

**Shipped.** `relay/`, an Elysium RPC for wallets that posts signed
transactions to the official inbox on HyperEVM until the public sequencer
opens, and `render.yaml` to host it.

**Checked live.** On testnet, a transaction sent to the relay executed on
Elysium about two minutes later, from the signer's own address. Two other
findings: a transaction sent from HyperEVM with the inbox's
`sendUnsignedTransaction` runs as the sender's aliased address, so it cannot
withdraw an account's own funds; and a full testnet deposit, withdrawal and
claim round trip worked, with the claim available after the next state
assertion (about every 15 minutes on testnet).

**Mainnet RPCs.** `rpc.agoradex.app` and BOXA's live RPC serve the state the
next batch will produce; BOXA's plain RPC serves confirmed state only.

## 2026-11-04: indexer and terminal API

**Shipped.** `indexer/`: follows Mesa's contracts on Elysium and stores every
launch, trade (with its fees), transfer and buyback in SQLite, and serves the
terminal's API: the token table, token pages with forensics (dev buy and
holdings, bundle share, snipe-window buys, top holders, the creator's other
launches), trades, candles, holders, stats and a live event stream.

**Checked live.** Against the testnet deployment it indexed both rehearsal
launches and all nine trades in about 20 seconds; fees, prices, holder
counts and burned $MESA match the chain.
