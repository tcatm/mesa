# Deployments

## Elysium testnet (99801), rehearsal

Deployed 2026-11-04 with `script/Deploy.s.sol` in rehearsal mode (its own
PoolManager, since Uniswap v4 is not on Elysium testnet), then exercised with
`script/Rehearsal.s.sol`. Every role (genesis launcher, burner owner and
keeper, quote admin) is one throwaway testnet wallet,
`0x157F797Dd4B1BCb689f98D35d69c54590d13d420`.

| Contract | Address |
|---|---|
| PoolManager (rehearsal only) | `0xDe6D3E1938A0546074C67C04edF8aAF6Acb2419f` |
| Create2Deployer | `0xBc3a89ac6347D292EBc1d75EC517BEFe05De6ECA` |
| MesaHook | `0xdc9dE61dA0ABD148DD36dCC380803B86dBE72AEc` |
| BuybackBurner | `0x60d13A743d7256586a46E22E7Dd2B937357630bd` |
| MesaBridgeRouter | `0x3a07c37500eE81600426Cd777fB97FAFE7Eb841B` |
| PoolSwapTest (test router) | `0x6766aD211F284Ab5B489383D9A5501dF51D4A6CE` |
| $MESA (genesis) | `0x140A465AEEF02416E04C698bb0b724B4349D5515` |
| RHSL (second launch) | `0x17363D3f65Fe6947f525A2C77a247022d9F569A6` |

What the rehearsal did, all in 15 transactions that succeeded: launched
$MESA (15% sniper surcharge over 5 minutes, 1% buy cap, 0.01 HYPE dev buy)
and RHSL (2% fees, 0.005 HYPE dev buy); ran an exact-in buy, exact-out buy,
exact-in sell and exact-out sell on RHSL; bought through the router and
forced a router refund; claimed creator fees; collected protocol fees and
bought and burned 12,343.6 $MESA; sold all RHSL back. Afterwards the hook's
HYPE claims equalled exactly what was owed, all of RHSL's supply was back in
its pool (or burned launch dust), and the router held nothing.

Cost: 0.00125 HYPE to deploy, 0.011 HYPE for the rehearsal (mostly the dev
buys, whose $MESA is still held).

## Elysium mainnet (99901)

Not deployed.
