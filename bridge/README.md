# bridge

HYPE between HyperEVM and Elysium through Elysium's official bridge, 1:1 with
no fee on top. Built on the Arbitrum SDK, since Elysium is an Arbitrum Orbit
chain; contract addresses are in `src/networks.ts` and
[docs/elysium.md](../docs/elysium.md).

| | Signed on | Arrives |
|---|---|---|
| Deposit | HyperEVM | Elysium, with the next batch |
| Bridge and buy | HyperEVM | Elysium: the token, or the HYPE if the buy fails |
| Withdraw | Elysium | HyperEVM, claimable after the challenge period (about 6 to 7 days on mainnet) |

Bridge and buy is a deposit whose arrival calls `MesaBridgeRouter.buy` on
Elysium. It runs when the batch lands, possibly hours after signing before the
public sequencer opens, so it takes a minimum output; if the price has moved
past it, or the buy fails for any reason, the router sends the HYPE to the
recipient on Elysium.

The functions return transaction requests for a wallet to sign
(`depositRequest`, `bridgeAndBuyRequest`, `withdrawRequest`) and read status
(`depositStatus`, `withdrawalStatus`, `queueStatus`). `claimWithdrawal` sends
the claim.

```bash
npm ci
npm run cli -- queue --net mainnet                  # deposits waiting for the next batch
npm run cli -- deposit-status --net mainnet --tx 0x..
PRIVATE_KEY=0x.. npm run cli -- deposit --net testnet --amount 0.01
```
