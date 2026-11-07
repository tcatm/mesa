# Private perps

Perpetual futures on Elysium where a position belongs to a key nobody can tie
to a wallet. `PerpMarket` is the first stage of this: one market,
HYPE-margined, funded from and settled back into [shielded HYPE](shielded.md).

Status: groundwork. The contract and tests are in this repo; nothing is
deployed.

## Stage 1: unlinkable ownership (this code)

```
ShieldedPool ──withdraw(recipient = market, data = open order)──▶ PerpMarket
     ▲                                                                │
     └──────────── deposit(precommitment) on close ◀──────────────────┘
```

1. **Open.** The trader makes a one-time key. They spend a shielded note with
   the market as recipient and `data = abi.encode(owner, isLong, size, acceptablePrice)`.
   A relayer submits it. The proof binds `data`, so the relayer can't change
   the order or its owner. The key never holds HYPE or sends a transaction.
2. **Close.** The key signs an EIP-712 `Close`:

    ```
    Close(positionId, acceptablePrice, payoutTo, precommitment, relayer, relayerFee, nonce, deadline)
    ```

    A relayer submits `closeWithSig`. With a `precommitment`, the proceeds go
    straight back into the pool as a new note.
3. **Liquidate.** Anyone can liquidate a position whose equity is below the
   maintenance margin. They get `liquidationFeeBps` of what margin is left,
   and the vault keeps the rest.

No public wallet appears anywhere in a position's life. Its size, side, price
and margin are public, and so is its PnL.

## The market

| Parameter | Meaning | Test value |
|---|---|---|
| `oracle` | Index price in HYPE per unit, 1e18 | mock |
| `maxPriceAge` | Oldest price accepted | 1 hour |
| `maxLeverage` | Notional / margin at open | 20x |
| `maintenanceBps` | Liquidation threshold, share of notional | 2.5% |
| `tradeFeeBps` | On notional at open and close, to the vault | 0.05% |
| `liquidationFeeBps` | Liquidator's share of remaining margin | 10% |
| `oiCapBps` | Open interest per side, share of vault | 50% |
| `fundingRatePerSecond` | Funding at full skew, share of notional | 10%/day |

**Counterparty.** A vault in the contract takes the other side of every
trade, and anyone can add HYPE to it. It earns fees, liquidation remainders
and losing PnL, and pays winning PnL. Liquidity can't be removed below what
the larger side's open interest needs.

**Funding.** Funding follows skew: `rate = skew × fundingRatePerSecond`, with
`skew = (long − short) / (long + short)`. The crowded side pays and the other
side receives, through the vault.

**Accounting invariant.** The market's balance is always `vaultAssets` plus
the margin of every open position. The liquidation test asserts it.

## Known stage-1 limits

- **Vault share price ignores open PnL**, so an LP can time entries and exits.
  The fix is a mark-to-market NAV with a withdrawal delay.
- **Payouts are capped at the vault**. A large enough winner is paid what the
  vault holds; the fix is auto-deleveraging.
- **Reshielding is capped by the pool's `maxDeposit`**. A bigger close has to
  pay out publicly, to a fresh address.
- Isolated margin and market orders only.
- One oracle with a staleness check and no deviation guard.

## Oracle: open question

Elysium settles to Hyperliquid, whose validators publish oracle prices for
every perp. The best index is one read from there. How Elysium exposes those
prices to contracts (a precompile, or a relayed feed) is still to confirm. The
stage-1 fallback is a keeper-pushed feed with bounded moves per update.

## Stage 2: hidden positions

Hiding size and direction too means positions become notes. The plan:

- **Batched entry.** Orders are commitments, matched in epochs at one oracle
  price. Only the net change in open interest reaches the chain.
- **Proof of solvency.** Each position note proves, in zero knowledge, that its
  margin covers maintenance at the current price. Liquidation becomes a
  per-epoch auction over positions that fail to prove.
- **Shared tree.** Position notes live in the same Poseidon tree as shielded
  HYPE, so the anonymity set is shared.

The circuits for stage 2 come after the shielded pool's ceremony and audit.
