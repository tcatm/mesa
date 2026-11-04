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
