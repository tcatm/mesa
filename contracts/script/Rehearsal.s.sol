// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {MesaRewardToken} from "../src/MesaRewardToken.sol";
import {MesaPayout} from "../src/MesaPayout.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {MesaBridgeRouter} from "../src/MesaBridgeRouter.sol";

/// Testnet rehearsal against a deployed Mesa: launches $MESA with its planned
/// settings, then a second token with a builder fee and a split payout
/// (holder rewards and buyback). Runs every swap kind, a router buy and a
/// forced router refund, claims creator and builder fees, pays holders, buys
/// back and burns the token, collects and burns $MESA, then sells back.
/// Small amounts only.
///
///   MESA_HOOK=0x.. forge script script/Rehearsal.s.sol --rpc-url elysium_testnet --broadcast --slow
///
/// On mainnet, only against a throwaway deployment, with MAINNET_REHEARSAL=true:
/// the tokens are then called TEST and TEST2, nothing that hints at Mesa.
///
/// The broadcaster must be the hook's genesis launcher and the burner's keeper.
contract Rehearsal is Script {
    PoolSwapTest.TestSettings internal settings =
        PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function run() external {
        bool mainnet = vm.envOr("MAINNET_REHEARSAL", false);
        require(
            block.chainid == 99_801 || block.chainid == 31_337 || (mainnet && block.chainid == 99_901),
            "rehearsal is testnet only, or mainnet with MAINNET_REHEARSAL=true"
        );
        (string memory n1, string memory s1, string memory n2, string memory s2) =
            mainnet ? ("Test Token", "TEST", "Test Two", "TEST2") : ("Mesa", "MESA", "Rehearsal", "RHSL");
        MesaHook hook = MesaHook(vm.envAddress("MESA_HOOK"));
        IPoolManager manager = hook.poolManager();
        BuybackBurner burner = BuybackBurner(payable(hook.protocolRecipient()));

        vm.startBroadcast();
        address me = msg.sender;
        PoolSwapTest swapper = new PoolSwapTest(manager);
        MesaBridgeRouter router = new MesaBridgeRouter(manager, address(hook));

        // 1. $MESA, as planned: 1% fee, 10% sniper surcharge over 5 seconds, no buy cap, small dev buy.
        (address mesa,) = hook.launch{value: 0.002 ether}(
            MesaHook.LaunchParams(n1, s1, "", me, 100, 1_000, 5, 10_000, address(0), 0, "")
        );

        // 2. A 10% token through a 0.5% builder, with creator fees split 50/50
        //    between holder rewards and buyback-and-burn.
        address[] memory none = new address[](0);
        uint16[] memory noneBps = new uint16[](0);
        (address t2, PoolKey memory k) = hook.launch{value: 0.002 ether}(
            MesaHook.LaunchParams(
                n2, s2, "", me, 1_000, 0, 0, 10_000, me, 50, abi.encode(none, noneBps, uint16(5_000), uint16(5_000))
            )
        );
        MesaRewardToken token = MesaRewardToken(t2);
        (, address payoutAddr,,,,,,,,,) = hook.pools(hook.poolOf(t2));
        MesaPayout payout = MesaPayout(payable(payoutAddr));
        token.approve(address(swapper), type(uint256).max);

        // 3. Every swap kind, then round trips for fees.
        swapper.swap{value: 0.02 ether}(k, sp(true, -0.02 ether), settings, ""); // exact-in buy
        swapper.swap{value: 0.02 ether}(k, sp(true, 500_000e18), settings, ""); // exact-out buy; the rest is refunded
        swapper.swap(k, sp(false, -int256(token.balanceOf(me) / 4)), settings, ""); // exact-in sell
        swapper.swap(k, sp(false, 0.002 ether), settings, ""); // exact-out sell
        uint256 trip = mainnet ? 0.04 ether : 0.05 ether;
        for (uint256 i; i < 4; ++i) {
            swapper.swap{value: trip}(k, sp(true, -int256(trip)), settings, "");
            swapper.swap(k, sp(false, -int256(token.balanceOf(me) * 9 / 10)), settings, "");
        }

        // 4. Router: a buy, and a buy that must refund.
        router.buy{value: 0.005 ether}(t2, 1, me);
        if (!mainnet) {
            uint256 before = me.balance;
            router.buy{value: 0.005 ether}(t2, type(uint256).max, me);
            require(me.balance == before, "refund");
        }

        // 5. Payouts: hold at least 1M RHSL to earn, then pay holders, buy back
        //    RHSL and claim the builder fee.
        uint256 hold = mainnet ? 0.035 ether : 0.04 ether;
        swapper.swap{value: hold}(k, sp(true, -int256(hold)), settings, "");
        require(token.eligibleBalanceOf(me) > 0, "not eligible");
        payout.collect();
        console.log("holders pot     ", payout.holdersPot());
        console.log("buyback pot     ", payout.buybackPot());
        payout.distribute();
        token.claim();
        (, uint256 rhslBurned) = payout.buyback();
        hook.claim(); // builder share (and $MESA creator share), all to `me` here

        // 6. Protocol: collect and burn $MESA.
        burner.collect();
        uint256 inBurner = address(burner).balance;
        if (inBurner > 0) burner.buyback(inBurner, 1);

        // 7. Sell back everything bought.
        uint256 rest = token.balanceOf(me);
        if (rest > 0) swapper.swap(k, sp(false, -int256(rest)), settings, "");
        vm.stopBroadcast();

        console.log("PoolSwapTest    ", address(swapper));
        console.log("MesaBridgeRouter", address(router));
        console.log("$MESA           ", mesa);
        console.log("RHSL            ", t2);
        console.log("RHSL payout     ", payoutAddr);
        console.log("RHSL burned     ", rhslBurned);
        console.log("burned MESA     ", MesaToken(mesa).balanceOf(hook.DEAD()));
        console.log("burner HYPE used", inBurner);
    }

    function sp(bool buy, int256 amount) internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams(buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }
}
