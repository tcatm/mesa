// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaTokenFactory} from "../src/MesaTokenFactory.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {MesaRewardToken} from "../src/MesaRewardToken.sol";
import {MesaPayout} from "../src/MesaPayout.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";

/// Builder fees, the standard hook events, the open buyback contract, and
/// split payouts: payout wallets, holder rewards and own-token buybacks.
contract PayoutsTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint256 constant SUPPLY = 1_000_000_000e18;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MesaHook hook;
    BuybackBurner burner;
    MesaToken mesa;

    address genesis = makeAddr("genesis");
    address creator = makeAddr("creator");
    address feeTo = makeAddr("feeTo");
    address builder = makeAddr("builder");
    address teamA = makeAddr("teamA");
    address teamB = makeAddr("teamB");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    PoolSwapTest.TestSettings settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function setUp() public {
        deployFreshManagerAndRouters();
        address at = address(FLAGS | (uint160(0x7777) << 144));
        deployCodeTo(
            "MesaHook.sol:MesaHook",
            abi.encode(
                manager,
                uint16(7_000),
                int24(173_200),
                genesis,
                makeAddr("owner"),
                makeAddr("keeper"),
                10 ether,
                makeAddr("qa"),
                new MesaTokenFactory()
            ),
            at
        );
        hook = MesaHook(at);
        burner = BuybackBurner(payable(hook.protocolRecipient()));
        for (uint256 i; i < 5; ++i) {
            vm.deal([genesis, creator, alice, bob, carol][i], 1_000 ether);
        }
        vm.prank(genesis);
        (address m,) = hook.launch(params());
        mesa = MesaToken(m);
    }

    // ------------------------------------------------------------ helpers

    function params() internal view returns (MesaHook.LaunchParams memory) {
        return MesaHook.LaunchParams({
            name: "Test",
            symbol: "TEST",
            metadataURI: "",
            feeRecipient: feeTo,
            feeBps: 100,
            sniperFeeBps: 0,
            snipeSeconds: 0,
            maxBuyBps: 10_000,
            builder: address(0),
            builderFeeBps: 0,
            payout: ""
        });
    }

    function split(address[] memory r, uint16[] memory bps, uint16 holders, uint16 buyback)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(r, bps, holders, buyback);
    }

    function launch(MesaHook.LaunchParams memory p) internal returns (address t, PoolKey memory k) {
        vm.prank(creator);
        (t, k) = hook.launch(p);
    }

    function sp(bool buy, int256 amount) internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams(buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function buy(address who, PoolKey memory k, uint256 hype) internal returns (uint256 tokens) {
        vm.prank(who);
        BalanceDelta d = swapRouter.swap{value: hype}(k, sp(true, -int256(hype)), settings, "");
        tokens = uint256(uint128(d.amount1()));
    }

    function sell(address who, PoolKey memory k, address t, uint256 tokens) internal {
        vm.startPrank(who);
        MesaToken(t).approve(address(swapRouter), tokens);
        swapRouter.swap(k, sp(false, -int256(tokens)), settings, "");
        vm.stopPrank();
    }

    function team() internal view returns (address[] memory r, uint16[] memory bps) {
        r = new address[](2);
        (r[0], r[1]) = (teamA, teamB);
        bps = new uint16[](2);
        (bps[0], bps[1]) = (3_000, 1_000);
    }

    // ------------------------------------------------------------ one fee, builder

    function test_oneFeeOnBuysAndSells() public {
        (address t, PoolKey memory k) = launch(params());
        uint256 tokens = buy(alice, k, 1 ether);
        assertEq(hook.accruedOf(address(0), feeTo), 0.007 ether, "70% of 1% of a 1 HYPE buy");
        uint256 before = hook.accruedOf(address(0), feeTo);
        uint256 hypeBefore = alice.balance;
        sell(alice, k, t, tokens);
        uint256 got = alice.balance - hypeBefore;
        uint256 creatorFee = hook.accruedOf(address(0), feeTo) - before;
        // creator fee = 70% of 1% of the gross payout (got + total fee).
        assertApproxEqAbs(creatorFee * 10_000 * 100, (got * 100 / 99) * 7_000, 1e9);
        assertEq(hook.currentFeeBps(t, true), 100);
        assertEq(hook.currentFeeBps(t, false), 100);
    }

    function test_builderFeeIsAnAddOn() public {
        MesaHook.LaunchParams memory p = params();
        p.feeBps = 200;
        p.builder = builder;
        p.builderFeeBps = 50;
        (address t, PoolKey memory k) = launch(p);
        assertEq(hook.currentFeeBps(t, true), 250);
        uint256 burnerBefore = hook.accrued(address(burner));
        buy(alice, k, 1 ether);
        // 2% coin through a 0.5% builder: creator and protocol shares of the 2% are unchanged.
        assertEq(hook.accrued(builder), 0.005 ether);
        assertEq(hook.accrued(feeTo), 0.014 ether);
        assertEq(hook.accrued(address(burner)) - burnerBefore, 0.006 ether);
        (uint256 base, uint256 b,, uint256 toCreator, uint256 toProtocol) = hook.previewFees(t, 1 ether, true);
        assertEq(base, 0.02 ether);
        assertEq(b, 0.005 ether);
        assertEq(toCreator, 0.014 ether);
        assertEq(toProtocol, 0.006 ether);
        vm.prank(builder);
        assertEq(hook.claim(), 0.005 ether);
        assertEq(builder.balance, 0.005 ether);
    }

    function test_builderBounds() public {
        MesaHook.LaunchParams memory p = params();
        p.builder = builder;
        p.builderFeeBps = 101;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "builderFeeBps"));
        hook.launch(p);
        p.builderFeeBps = 0;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "builder"));
        hook.launch(p);
        p.builder = address(0);
        p.builderFeeBps = 10;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "builder"));
        hook.launch(p);
    }

    function test_devBuyPaysTheFeeAndBuilder() public {
        MesaHook.LaunchParams memory p = params();
        p.builder = builder;
        p.builderFeeBps = 100;
        vm.prank(creator);
        hook.launch{value: 1 ether}(p);
        assertEq(hook.accrued(feeTo), 0.007 ether);
        assertEq(hook.accrued(builder), 0.01 ether);
    }

    // ------------------------------------------------------------ standard events

    function test_emitsStandardHookEvents() public {
        (, PoolKey memory k) = launch(params());
        vm.recordLogs();
        buy(alice, k, 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 swapSig = keccak256("HookSwap(bytes32,address,int128,int128,uint128,uint128)");
        bytes32 feeSig = keccak256("HookFee(bytes32,address,uint128,uint128)");
        bool sawSwap;
        bool sawFee;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics[0] == swapSig) {
                sawSwap = true;
                assertEq(logs[i].topics[1], PoolId.unwrap(k.toId()));
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(swapRouter));
                (int128 a0, int128 a1, uint128 f0, uint128 f1) =
                    abi.decode(logs[i].data, (int128, int128, uint128, uint128));
                assertEq(a0, int128(0.01 ether));
                assertEq(a1, int128(0));
                assertEq(f0, uint128(0.01 ether));
                assertEq(f1, uint128(0));
            }
            if (logs[i].topics[0] == feeSig) {
                sawFee = true;
                (uint128 f0, uint128 f1) = abi.decode(logs[i].data, (uint128, uint128));
                assertEq(f0, uint128(0.01 ether));
                assertEq(f1, uint128(0));
            }
        }
        assertTrue(sawSwap && sawFee);
    }

    // ------------------------------------------------------------ buyback contract

    function test_burnerAcceptsHypeFromAnyoneAndCanOnlyBurnMesa() public {
        vm.prank(alice);
        (bool ok,) = address(burner).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 deadBefore = mesa.balanceOf(DEAD);
        vm.prank(makeAddr("keeper"));
        uint256 burned = burner.buyback(1 ether, 1);
        assertGt(burned, 0);
        assertEq(mesa.balanceOf(DEAD) - deadBefore, burned);
        assertEq(address(burner).balance, 0);
    }

    // ------------------------------------------------------------ split payouts

    function test_plainLaunchHasNoPayoutContract() public {
        (address t,) = launch(params());
        (, address recipient,,,,,,,,,) = hook.pools(hook.poolOf(t));
        assertEq(recipient, feeTo);
    }

    function test_splitPaysWalletsHoldersAndBuyback() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000); // 30% + 10% wallets, 40% holders, 20% buyback
        (address t, PoolKey memory k) = launch(p);
        (, address recipient,,,,,,,,,) = hook.pools(hook.poolOf(t));
        MesaPayout payout = MesaPayout(payable(recipient));
        MesaRewardToken token = MesaRewardToken(t);
        assertEq(payout.token(), t);

        // Alice and Bob qualify, Carol holds less than 1M tokens.
        buy(alice, k, 3 ether);
        buy(bob, k, 1 ether);
        uint256 small = buy(carol, k, 0.0001 ether);
        assertLt(small, token.MIN_ELIGIBLE());
        assertEq(token.eligibleBalanceOf(carol), 0);
        assertEq(token.eligibleSupply(), token.balanceOf(alice) + token.balanceOf(bob));

        // Fees so far: 1% of 4.0001 HYPE, 70% to the payout contract.
        uint256 fees = hook.accrued(address(payout));
        payout.collect();
        assertEq(payout.owedOf(teamA), fees * 3_000 / 10_000);
        assertEq(payout.owedOf(teamB), fees - fees * 3_000 / 10_000 - fees * 4_000 / 10_000 - fees * 2_000 / 10_000);
        assertEq(payout.holdersPot(), fees * 4_000 / 10_000);
        assertEq(payout.buybackPot(), fees * 2_000 / 10_000);

        vm.prank(teamA);
        payout.claim();
        assertEq(teamA.balance, fees * 3_000 / 10_000);

        // Holders: shared by eligible balance.
        uint256 pot = payout.holdersPot();
        payout.distribute();
        uint256 a = token.claimable(alice);
        uint256 b = token.claimable(bob);
        assertEq(token.claimable(carol), 0);
        assertApproxEqAbs(a + b, pot, 2);
        assertApproxEqRel(a * token.balanceOf(bob), b * token.balanceOf(alice), 1e12);
        vm.prank(alice);
        token.claim();
        assertEq(token.claimedOf(alice), a);
        token.claimFor(bob); // anyone can push it; it goes to Bob
        assertEq(token.claimedOf(bob), b);

        // Once per round.
        vm.expectRevert(MesaPayout.NotYet.selector);
        payout.distribute();
    }

    function test_rewardsFollowBalancesAndThreshold() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000);
        (address t, PoolKey memory k) = launch(p);
        MesaRewardToken token = MesaRewardToken(t);
        buy(alice, k, 2 ether);
        buy(bob, k, 2 ether);

        vm.deal(address(this), 10 ether);
        token.distribute{value: 1 ether}();
        uint256 aliceFirst = token.claimable(alice);

        // Alice sends almost everything to Carol, keeping less than 1M: only Bob and Carol earn next.
        uint256 send = token.balanceOf(alice) - (token.MIN_ELIGIBLE() - 1);
        vm.prank(alice);
        token.transfer(carol, send);
        assertEq(token.eligibleBalanceOf(alice), 0);
        token.distribute{value: 1 ether}();
        assertEq(token.claimable(alice), aliceFirst, "earned before leaving is kept, nothing after");
        assertGt(token.claimable(carol), 0);
        assertApproxEqAbs(token.claimable(alice) + token.claimable(bob) + token.claimable(carol), 2 ether, 3);

        // Contracts never earn: the PoolManager holds most of the supply and gets nothing.
        assertEq(token.eligibleBalanceOf(address(manager)), 0);
        assertFalse(token.canEarn(address(swapRouter)));
        assertTrue(token.canEarn(alice));
    }

    function test_delegatedWalletsStillEarn() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000);
        (address t,) = launch(p);
        // An EIP-7702 account's code is 0xef0100 || delegate.
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(0x1234)));
        assertTrue(MesaRewardToken(t).canEarn(alice));
        vm.etch(bob, hex"6000");
        assertFalse(MesaRewardToken(t).canEarn(bob));
    }

    function test_rewardsWithNoEligibleHoldersWait() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000);
        (address t, PoolKey memory k) = launch(p);
        MesaRewardToken token = MesaRewardToken(t);
        vm.deal(address(this), 1 ether);
        token.distribute{value: 0.5 ether}();
        assertEq(token.pending(), 0.5 ether);
        buy(alice, k, 1 ether);
        token.distribute{value: 0.5 ether}();
        assertApproxEqAbs(token.claimable(alice), 1 ether, 1);
    }

    function test_buybackBurnsInCappedChunks() public {
        address[] memory r = new address[](0);
        uint16[] memory bps = new uint16[](0);
        MesaHook.LaunchParams memory p = params();
        p.feeBps = 1_000; // 10%, so fees add up fast
        p.payout = split(r, bps, 0, 10_000); // everything buys back
        (address t, PoolKey memory k) = launch(p);
        (, address recipient,,,,,,,,,) = hook.pools(hook.poolOf(t));
        MesaPayout payout = MesaPayout(payable(recipient));
        assertEq(MesaToken(t).balanceOf(address(0x1)), 0);
        buy(alice, k, 20 ether);

        (uint256 hypeIn, uint256 burned) = payout.buyback();
        assertEq(hypeIn, payout.MAX_BUYBACK());
        assertGt(burned, 0);
        uint256 dead = MesaToken(t).balanceOf(DEAD);
        assertGe(dead, burned);
        assertGt(payout.buybackPot(), 0, "the rest waits for later rounds");

        vm.expectRevert(MesaPayout.NotYet.selector);
        payout.buyback();
        vm.warp(block.timestamp + 10 minutes);
        payout.buyback();
        assertGt(MesaToken(t).balanceOf(DEAD), dead);
    }

    function test_payoutWalletHandover() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000);
        (address t, PoolKey memory k) = launch(p);
        (, address recipient,,,,,,,,,) = hook.pools(hook.poolOf(t));
        MesaPayout payout = MesaPayout(payable(recipient));
        buy(alice, k, 1 ether);
        payout.collect();
        uint256 owedBefore = payout.owedOf(teamA);

        vm.prank(teamA);
        payout.proposeRecipient(carol);
        vm.prank(bob);
        vm.expectRevert(MesaPayout.NotRecipient.selector);
        payout.acceptRecipient(teamA);
        vm.prank(carol);
        payout.acceptRecipient(teamA);

        buy(alice, k, 1 ether);
        payout.collect();
        assertEq(payout.owedOf(teamA), owedBefore, "old wallet keeps what it was owed");
        assertGt(payout.owedOf(carol), 0);
        vm.prank(teamA);
        payout.claim();
        assertEq(teamA.balance, owedBefore);
    }

    function test_splitValidation() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 1_000); // adds to 90%
        vm.prank(creator);
        vm.expectRevert(MesaPayout.InvalidSplit.selector);
        hook.launch(p);

        address[] memory six = new address[](6);
        uint16[] memory sixBps = new uint16[](6);
        for (uint256 i; i < 6; ++i) {
            six[i] = address(uint160(i + 1));
            sixBps[i] = 1_000;
        }
        p.payout = split(six, sixBps, 4_000, 0);
        vm.prank(creator);
        vm.expectRevert(MesaPayout.InvalidSplit.selector);
        hook.launch(p);

        r[1] = r[0]; // the same wallet twice
        p.payout = split(r, bps, 4_000, 2_000);
        vm.prank(creator);
        vm.expectRevert(MesaPayout.InvalidSplit.selector);
        hook.launch(p);
    }

    function test_payoutRefusesStrayHype() public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000);
        (address t,) = launch(p);
        (, address recipient,,,,,,,,,) = hook.pools(hook.poolOf(t));
        vm.prank(alice);
        (bool ok,) = recipient.call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_holdersOnlySplitMakesAPlainTokenWithoutRewards() public {
        address[] memory r = new address[](1);
        r[0] = teamA;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 5_000;
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 0, 5_000); // no holders share: a plain token
        (address t,) = launch(p);
        vm.expectRevert();
        MesaRewardToken(t).eligibleSupply();
    }

    /// Random transfers across the 1M threshold and random distributions: the
    /// token always holds at least what holders can claim, and loses at most
    /// rounding dust.
    function testFuzz_rewardsStaySolvent(uint256 seed) public {
        (address[] memory r, uint16[] memory bps) = team();
        MesaHook.LaunchParams memory p = params();
        p.payout = split(r, bps, 4_000, 2_000);
        (address t, PoolKey memory k) = launch(p);
        MesaRewardToken token = MesaRewardToken(t);
        address[4] memory who = [alice, bob, carol, teamA];
        buy(alice, k, 5 ether);
        buy(bob, k, 1 ether);
        vm.deal(address(this), 100 ether);
        uint256 given;
        for (uint256 i; i < 24; ++i) {
            uint256 x = uint256(keccak256(abi.encode(seed, i)));
            if (x % 3 == 0) {
                uint256 v = (x >> 8) % 1 ether;
                token.distribute{value: v}();
                given += v;
            } else {
                address from = who[(x >> 16) % 4];
                address to = who[(x >> 24) % 4];
                uint256 bal = token.balanceOf(from);
                if (bal == 0) continue;
                uint256 amt = (x >> 32) % (bal + 1);
                vm.prank(from);
                token.transfer(to, amt);
            }
            if (x % 7 == 0) {
                address h = who[(x >> 40) % 4];
                if (token.claimable(h) > 0) token.claimFor(h);
            }
            uint256 owed;
            for (uint256 j; j < 4; ++j) {
                owed += token.claimable(who[j]);
            }
            assertGe(address(t).balance + 1, owed + token.pending(), "insolvent");
        }
        uint256 claimed;
        uint256 left;
        for (uint256 j; j < 4; ++j) {
            claimed += token.claimedOf(who[j]);
            left += token.claimable(who[j]);
        }
        assertApproxEqAbs(claimed + left + token.pending(), given, 100, "only rounding dust is lost");
    }
}
