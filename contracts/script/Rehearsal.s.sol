// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {MesaBridgeRouter} from "../src/MesaBridgeRouter.sol";

/// Testnet rehearsal against a deployed Mesa: launches $MESA and a second
/// token, runs every swap kind, a router buy and a forced router refund,
/// claims fees, collects and burns, then sells back. Small amounts only.
///
///   MESA_HOOK=0x.. forge script script/Rehearsal.s.sol --rpc-url elysium_testnet --broadcast --slow
///
/// The broadcaster must be the hook's genesis launcher and the burner's keeper.
contract Rehearsal is Script {
    PoolSwapTest.TestSettings internal settings =
        PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function run() external {
        require(block.chainid == 99_801 || block.chainid == 31_337, "rehearsal is testnet only");
        MesaHook hook = MesaHook(vm.envAddress("MESA_HOOK"));
        IPoolManager manager = hook.poolManager();
        BuybackBurner burner = BuybackBurner(payable(hook.protocolRecipient()));

        vm.startBroadcast();
        address me = msg.sender;
        PoolSwapTest swapper = new PoolSwapTest(manager);
        MesaBridgeRouter router = new MesaBridgeRouter(manager, address(hook));

        // 1. $MESA: 15% sniper surcharge over 5 minutes, 1% cap per transaction, 0.01 HYPE dev buy.
        (address mesa,) = hook.launch{value: 0.01 ether}(
            MesaHook.LaunchParams("Mesa", "MESA", "ipfs://mesa-rehearsal", me, 100, 1_500, 300, 100, address(0), 0, "")
        );
        // 2. A second token, no fairness settings, 0.005 HYPE dev buy.
        (address t2, PoolKey memory k) = hook.launch{value: 0.005 ether}(
            MesaHook.LaunchParams("Rehearsal", "RHSL", "", me, 200, 0, 0, 10_000, address(0), 0, "")
        );
        MesaToken token = MesaToken(t2);
        token.approve(address(swapper), type(uint256).max);

        // 3. Every swap kind.
        swapper.swap{value: 0.02 ether}(k, sp(true, -0.02 ether), settings, ""); // exact-in buy
        swapper.swap{value: 0.02 ether}(k, sp(true, 100_000e18), settings, ""); // exact-out buy; the rest is refunded
        swapper.swap(k, sp(false, -int256(token.balanceOf(me) / 2)), settings, ""); // exact-in sell
        swapper.swap(k, sp(false, 0.005 ether), settings, ""); // exact-out sell

        // 4. Router: a buy, and a buy that must refund.
        router.buy{value: 0.01 ether}(t2, 1, me);
        uint256 before = me.balance;
        router.buy{value: 0.01 ether}(t2, type(uint256).max, me);
        require(me.balance == before - 0.01 ether + 0.01 ether, "refund");

        // 5. Fees: creator claim, protocol collect, buyback and burn of $MESA.
        hook.claim();
        burner.collect();
        uint256 inBurner = address(burner).balance;
        if (inBurner > 0) burner.buyback(inBurner, 1);

        // 6. Sell back everything bought.
        uint256 rest = token.balanceOf(me);
        if (rest > 0) swapper.swap(k, sp(false, -int256(rest)), settings, "");
        vm.stopBroadcast();

        console.log("PoolSwapTest    ", address(swapper));
        console.log("MesaBridgeRouter", address(router));
        console.log("$MESA           ", mesa);
        console.log("RHSL            ", t2);
        console.log("burned MESA     ", MesaToken(mesa).balanceOf(hook.DEAD()));
        console.log("burner HYPE used", inBurner);
    }

    function sp(bool buy, int256 amount) internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams(buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }
}
