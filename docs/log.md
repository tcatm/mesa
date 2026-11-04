# Dev log

What shipped, what broke, and the evidence. Newest first.

---

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
does not rebase. Elysium testnet is chain 99801. The PoolManager address in
circulation is a lead only and is a deploy parameter, not hardcoded. Mainnet
chain ID 99901 is not yet confirmed from a primary source.
