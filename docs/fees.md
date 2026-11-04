# Fees and limits

Every number here is enforced by the contracts. Where a launch chooses a
value, the contract rejects anything outside the range shown.

## Per-launch parameters

| Parameter | Range | Meaning |
|---|---|---|
| Buy fee | 1% to 10% | Fee on the quote side (HYPE or the ERC-20 quote) of buys |
| Sell fee | 1% to 10% | Fee on the quote side of sells |
| Sniper surcharge | 0% to 30% | Extra fee on buys at launch, decaying linearly to 0 |
| Snipe window | 0 to 15 minutes | How long the surcharge and the max-buy cap last |
| Max buy per transaction | 0.1% to 100% of supply | Cap on tokens bought in one transaction during the snipe window |
| Dev buy | up to 10% of supply | Declared buy at the starting price, in the launch transaction |

## Fixed at deployment

| Value | Default | Meaning |
|---|---|---|
| Creator share | 70% | Share of the base fee to the token's fee recipient. The rest buys and burns $MESA. |
| Starting price, HYPE launches | tick 173,200 | A market cap of about 30 HYPE (30 HYPE of virtual reserve against 1B tokens) |
| Starting price, ERC-20 quotes | per quote | Set in `QuoteRegistry`, behind a 3-day delay |
| Supply | 1,000,000,000 | Every token, all of it in the pool at launch |
| LP fee | 0 | Mesa fees replace the pool's LP fee |
| Buyback per call | 10 HYPE | Largest single buyback |

Every fee is a share of the **gross** quote amount, paid in the quote: what a buyer pays in, or
what the pool pays out to a seller before the fee.

## Where a fee goes

| Part | Fee recipient | Buyback and burn |
|---|---|---|
| Base fee | 70% | 30% |
| Sniper surcharge | 0% | 100% |

Fees in an ERC-20 quote go to the creator in that quote. The protocol's share
is sold for HYPE through the quote's registered route, then spent on $MESA.

## Example

A 1 HYPE buy with a 1% buy fee and no surcharge pays 0.01 HYPE in fees:
0.007 HYPE to the creator's fee recipient and 0.003 HYPE to buyback and burn.
The same buy in the first second of a launch with a 30% surcharge over 10
minutes pays 0.31 HYPE: still 0.007 HYPE to the creator, and 0.303 HYPE to
buyback and burn.
