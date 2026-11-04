// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {MultiSwapper, ReentrantRecipient} from "./utils/Helpers.sol";

contract MesaHookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant INITIAL_TICK = 173_200; // starting market cap ≈ 30 HYPE
    uint16 constant CREATOR_SHARE = 7_000;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant BPS = 10_000;

    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MesaHook hook;
    BuybackBurner burner;
    MesaToken mesa;

    address genesis = makeAddr("genesis");
    address genesisFees = makeAddr("genesisFees");
    address creator = makeAddr("creator");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    /// Every address fees can accrue to in these tests.
    address[] payees;

    PoolSwapTest.TestSettings settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function deployHook(uint160 salt) internal returns (MesaHook h) {
        address at = address(FLAGS | (salt << 144));
        deployCodeTo(
            "MesaHook.sol:MesaHook",
            abi.encode(manager, CREATOR_SHARE, INITIAL_TICK, genesis, owner, keeper, 10 ether),
            at
        );
        h = MesaHook(at);
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        hook = deployHook(0x4444);
        burner = BuybackBurner(payable(hook.protocolRecipient()));
        vm.deal(genesis, 1_000 ether);
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);

        // Launch #1: $MESA, by the genesis launcher.
        MesaHook.LaunchParams memory p = params();
        p.name = "Mesa";
        p.symbol = "MESA";
        p.feeRecipient = genesisFees;
        vm.prank(genesis);
        (address m,) = hook.launch(p);
        mesa = MesaToken(m);

        payees.push(feeTo);
        payees.push(genesisFees);
        payees.push(address(burner));
        payees.push(bob);
    }

    // ------------------------------------------------------------ helpers

    function params() internal view returns (MesaHook.LaunchParams memory) {
        return MesaHook.LaunchParams({
            name: "Test",
            symbol: "TEST",
            metadataURI: "ipfs://x",
            feeRecipient: feeTo,
            buyFeeBps: 100,
            sellFeeBps: 100,
            sniperFeeBps: 0,
            snipeSeconds: 0,
            maxBuyBps: 10_000
        });
    }

    function launch(MesaHook.LaunchParams memory p, uint256 devBuy) internal returns (MesaToken t, PoolKey memory k) {
        vm.prank(creator);
        (address token, PoolKey memory key) = hook.launch{value: devBuy}(p);
        return (MesaToken(token), key);
    }

    function swapParams(bool buy, int256 amount) internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams(buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function buyExactIn(address who, PoolKey memory k, uint256 hype) internal returns (BalanceDelta d) {
        vm.prank(who);
        d = swapRouter.swap{value: hype}(k, swapParams(true, -int256(hype)), settings, "");
    }

    function sellExactIn(address who, PoolKey memory k, MesaToken t, uint256 tokens) internal returns (BalanceDelta d) {
        vm.startPrank(who);
        t.approve(address(swapRouter), tokens);
        d = swapRouter.swap(k, swapParams(false, -int256(tokens)), settings, "");
        vm.stopPrank();
    }

    /// A router swap that must revert inside the hook; returns the hook's own
    /// error selector, unwrapped from the PoolManager's WrappedError.
    function hookErrorOf(address who, PoolKey memory k, IPoolManager.SwapParams memory sp, uint256 value)
        internal
        returns (bytes4)
    {
        vm.prank(who);
        (bool ok, bytes memory err) =
            address(swapRouter).call{value: value}(abi.encodeCall(PoolSwapTest.swap, (k, sp, settings, "")));
        assertFalse(ok, "expected revert");
        return unwrap(err);
    }

    function unwrap(bytes memory err) internal pure returns (bytes4) {
        require(bytes4(err) == CustomRevert.WrappedError.selector, "not a wrapped hook error");
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        return bytes4(reason);
    }

    function wrapped(bytes4 hookFn, bytes4 reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookFn,
            abi.encodeWithSelector(reason),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// Everything owed must equal the hook's native claims in the PoolManager.
    function assertSolvent() internal view {
        uint256 owed;
        for (uint256 i; i < payees.length; ++i) {
            owed += hook.accrued(payees[i]);
        }
        assertEq(manager.balanceOf(address(hook), 0), owed, "hook claims != accrued");
    }

    // ------------------------------------------------------------ genesis

    function test_genesisLaunchComesFirstAndFixesTheBuybackToken() public {
        MesaHook fresh = deployHook(0x5555);
        vm.prank(creator);
        vm.expectRevert(MesaHook.GenesisFirst.selector);
        fresh.launch(params());

        assertEq(hook.genesisToken(), address(mesa));
        assertEq(burner.mesa(), address(mesa));
        assertEq(address(burner.hook()), address(hook), "burner is bound to the hook that deployed it");
        assertEq(hook.protocolRecipient(), address(burner));
    }

    // ------------------------------------------------------------ launch

    function test_launch_locksEntireSupplyInPool() public {
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(address(hook)), 0, "hook keeps no tokens");
        uint256 inPool = t.balanceOf(address(manager));
        assertGt(inPool, SUPPLY - 1e18, "all but dust in pool");
        assertEq(inPool + t.balanceOf(hook.DEAD()), SUPPLY);

        (uint160 sqrtP, int24 tick,,) = manager.getSlot0(k.toId());
        assertEq(tick, INITIAL_TICK);
        assertEq(sqrtP, TickMath.getSqrtPriceAtTick(INITIAL_TICK));
        assertEq(Currency.unwrap(k.currency0), address(0), "native HYPE is currency0");
    }

    function test_launch_rejectsOutOfBoundsParams() public {
        MesaHook.LaunchParams memory p = params();
        p.buyFeeBps = 1_001;
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "buyFeeBps"));
        hook.launch(p);

        p = params();
        p.sellFeeBps = 99;
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "sellFeeBps"));
        hook.launch(p);

        p = params();
        p.sniperFeeBps = 3_001;
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "sniperFeeBps"));
        hook.launch(p);

        p = params();
        p.snipeSeconds = 15 minutes + 1;
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "snipeSeconds"));
        hook.launch(p);

        p = params();
        p.feeRecipient = address(0);
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "feeRecipient"));
        hook.launch(p);
    }

    function test_constructorRejectsAStartingPriceThatCannotHoldTheSupply() public {
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "initialTick"));
        new MesaHook(manager, CREATOR_SHARE, -400_000, genesis, owner, keeper, 10 ether);
    }

    function test_startingMarketCapIsAbout30Hype() public {
        (, PoolKey memory k) = launch(params(), 0);
        (uint160 sqrtP,,,) = manager.getSlot0(k.toId());
        // price = tokens per HYPE; market cap = supply / price.
        uint256 tokensPerHype = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 192);
        assertApproxEqRel(SUPPLY / tokensPerHype, 30.09e18, 0.001e18, "about 30 HYPE");
        // x·y = k with 30 HYPE virtual: 30 HYPE (net of the 1% fee) buys ~half the supply.
        BalanceDelta d = buyExactIn(alice, k, 30.31 ether);
        assertApproxEqRel(uint256(uint128(d.amount1())), SUPPLY / 2, 0.01e18);
    }

    // ------------------------------------------------------------ fees

    function test_buyExactIn_feeOnHypeSplit70_30() public {
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        BalanceDelta d = buyExactIn(alice, k, 10 ether);
        assertEq(-d.amount0(), int128(10 ether), "buyer pays exactly the input");
        assertEq(t.balanceOf(alice), uint256(uint128(d.amount1())));
        assertEq(hook.accrued(feeTo), 0.07 ether);
        assertEq(hook.accrued(address(burner)), 0.03 ether);
        assertSolvent();
    }

    function test_sellExactIn_feeTakenFromHypeOut() public {
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        buyExactIn(alice, k, 10 ether);
        uint256 claimsBefore = manager.balanceOf(address(hook), 0);
        uint256 bal = alice.balance;
        BalanceDelta d = sellExactIn(alice, k, t, t.balanceOf(alice));
        uint256 received = alice.balance - bal;
        assertEq(int256(received), d.amount0());
        uint256 fee = manager.balanceOf(address(hook), 0) - claimsBefore;
        assertApproxEqAbs(fee * 100, received + fee, 100, "fee is 1% of the gross output");
        assertSolvent();
    }

    /// Exact-output swaps pay the same share of gross HYPE as exact-input
    /// ones, sniper surcharge included.
    function test_exactOutputSwapsPayTheSameShareOfGross() public {
        MesaHook.LaunchParams memory p = params();
        p.sniperFeeBps = 3_000;
        p.snipeSeconds = 600;
        uint256 t0 = block.timestamp;
        (MesaToken t, PoolKey memory k) = launch(p, 0);

        // Exact-output buy at t = 0: the fee is 31% of what the buyer pays.
        uint256 before = alice.balance;
        uint256 claimsBefore = manager.balanceOf(address(hook), 0);
        vm.prank(alice);
        swapRouter.swap{value: 5 ether}(k, swapParams(true, int256(1_000_000e18)), settings, "");
        assertEq(t.balanceOf(alice), 1_000_000e18);
        uint256 paid = before - alice.balance;
        uint256 fee = manager.balanceOf(address(hook), 0) - claimsBefore;
        assertApproxEqRel(fee * BPS * 1e18 / paid, 3_100e18, 0.0001e18, "31% of gross");

        // Exact-output sell after the window: the fee is 1% of gross output.
        vm.warp(t0 + 600);
        before = alice.balance;
        claimsBefore = manager.balanceOf(address(hook), 0);
        vm.startPrank(alice);
        t.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(k, swapParams(false, int256(0.001 ether)), settings, "");
        vm.stopPrank();
        assertEq(alice.balance - before, 0.001 ether);
        fee = manager.balanceOf(address(hook), 0) - claimsBefore;
        assertApproxEqAbs(fee * 100, 0.001 ether + fee, 100, "1% of gross");
        assertSolvent();
    }

    function test_partialFillsRevertInsteadOfOvercharging() public {
        (, PoolKey memory k) = launch(params(), 0);
        // A price limit one tick-spacing away would fill the swap only partly.
        IPoolManager.SwapParams memory sp =
            IPoolManager.SwapParams(true, -100 ether, TickMath.getSqrtPriceAtTick(INITIAL_TICK - 200));
        assertEq(hookErrorOf(alice, k, sp, 100 ether), MesaHook.PartialFill.selector);
    }

    function testFuzz_roundTripNeverProfits(uint96 hypeIn) public {
        hypeIn = uint96(bound(hypeIn, 0.001 ether, 500 ether));
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        uint256 start = alice.balance;
        buyExactIn(alice, k, hypeIn);
        sellExactIn(alice, k, t, t.balanceOf(alice));
        assertLt(alice.balance, start, "a buy-sell round trip loses at least the fees");
        assertSolvent();
    }

    // ------------------------------------------------------------ fairness kit

    function test_sniperSurchargeDecaysAndGoesToProtocolOnly() public {
        MesaHook.LaunchParams memory p = params();
        p.sniperFeeBps = 3_000;
        p.snipeSeconds = 600;
        uint256 t0 = block.timestamp; // absolute warps: via_ir caches block.timestamp
        (, PoolKey memory k) = launch(p, 0);

        buyExactIn(alice, k, 1 ether); // t = 0: 1% base + 30% surcharge
        assertEq(hook.accrued(feeTo), 0.007 ether, "creator gets only the base share");
        assertEq(hook.accrued(address(burner)), 0.003 ether + 0.3 ether);

        vm.warp(t0 + 300); // halfway: 15% surcharge
        uint256 p0 = hook.accrued(address(burner));
        buyExactIn(bob, k, 1 ether);
        assertEq(hook.accrued(address(burner)) - p0, 0.003 ether + 0.15 ether);

        vm.warp(t0 + 600); // window over
        p0 = hook.accrued(address(burner));
        buyExactIn(bob, k, 1 ether);
        assertEq(hook.accrued(address(burner)) - p0, 0.003 ether);
        assertSolvent();
    }

    function test_maxBuyCapPerTransactionDuringSnipeWindow() public {
        MesaHook.LaunchParams memory p = params();
        p.snipeSeconds = 60;
        p.maxBuyBps = 100; // 1% of supply
        uint256 t0 = block.timestamp;
        (, PoolKey memory k) = launch(p, 0);

        buyExactIn(alice, k, 0.1 ether); // ~0.33% of supply
        assertEq(hookErrorOf(alice, k, swapParams(true, -5 ether), 5 ether), MesaHook.MaxBuyExceeded.selector);

        // Splitting into many swaps inside one transaction does not get around it.
        MultiSwapper s = new MultiSwapper(manager);
        IPoolManager.SwapParams[] memory ps = new IPoolManager.SwapParams[](3);
        for (uint256 i; i < 3; ++i) {
            ps[i] = swapParams(true, -0.15 ether); // ~0.5% each, ~1.5% together
        }
        vm.prank(bob);
        (bool ok, bytes memory err) = address(s).call{value: 0.45 ether}(abi.encodeCall(MultiSwapper.run, (k, ps)));
        assertFalse(ok);
        assertEq(unwrap(err), MesaHook.MaxBuyExceeded.selector);

        vm.warp(t0 + 60);
        buyExactIn(alice, k, 5 ether); // cap lifted
    }

    function test_devBuy_declaredCappedAndCharged() public {
        (MesaToken t,) = launch(params(), 3 ether); // ~9% of supply
        uint256 dev = t.balanceOf(creator);
        assertGt(dev, 0);
        assertLe(dev, SUPPLY / 10);
        assertEq(hook.accrued(feeTo), 0.021 ether, "1% fee on the dev buy");
        assertEq(creator.balance, 997 ether);
        assertSolvent();

        vm.prank(creator);
        vm.expectPartialRevert(MesaHook.DevBuyTooLarge.selector); // ~12% of supply at 4 HYPE
        hook.launch{value: 4 ether}(params());
    }

    // ------------------------------------------------------------ locks

    function test_liquidityCannotBeRemoved() public {
        (, PoolKey memory k) = launch(params(), 0);
        int24 lower = TickMath.minUsableTick(200);
        // Every removal on a Mesa pool is refused by the hook before any
        // position lookup; the hook's own position has no removal code path.
        vm.expectRevert(wrapped(IHooks.beforeRemoveLiquidity.selector, MesaHook.LiquidityLocked.selector));
        modifyLiquidityRouter.modifyLiquidity(k, IPoolManager.ModifyLiquidityParams(lower, INITIAL_TICK, -1e18, 0), "");
        // A zero-delta "poke" (fee collection) takes the same path.
        vm.expectRevert(wrapped(IHooks.beforeRemoveLiquidity.selector, MesaHook.LiquidityLocked.selector));
        modifyLiquidityRouter.modifyLiquidity(k, IPoolManager.ModifyLiquidityParams(lower, INITIAL_TICK, 0, 0), "");
    }

    function test_onlyTheHookAddsLiquidity() public {
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        deal(address(t), alice, 1e24);
        vm.startPrank(alice);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.expectRevert(wrapped(IHooks.beforeAddLiquidity.selector, MesaHook.OnlyMesa.selector));
        modifyLiquidityRouter.modifyLiquidity{value: 1 ether}(
            k, IPoolManager.ModifyLiquidityParams(-887_200, 887_200, 1e18, 0), ""
        );
        vm.stopPrank();
    }

    function test_onlyMesaCanCreatePoolsWithThisHook() public {
        MesaToken other = new MesaToken("X", "X", address(this));
        PoolKey memory k = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(other)), 0, 200, IHooks(hook));
        vm.expectRevert(wrapped(IHooks.beforeInitialize.selector, MesaHook.OnlyMesa.selector));
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    function test_donationsDisabled() public {
        (, PoolKey memory k) = launch(params(), 0);
        vm.prank(alice);
        vm.expectRevert(wrapped(IHooks.beforeDonate.selector, MesaHook.DonationsDisabled.selector));
        donateRouter.donate{value: 1 ether}(k, 1 ether, 0, "");
    }

    // ------------------------------------------------------------ claims

    function test_claimPaysOutOnce() public {
        (, PoolKey memory k) = launch(params(), 0);
        buyExactIn(alice, k, 10 ether);
        uint256 owed = hook.accrued(feeTo);
        vm.prank(feeTo);
        assertEq(hook.claim(), owed);
        assertEq(feeTo.balance, owed);
        assertEq(hook.accrued(feeTo), 0);
        vm.prank(feeTo);
        vm.expectRevert(MesaHook.NothingToClaim.selector);
        hook.claim();
        assertSolvent();
    }

    function test_reentrantRecipientIsChargedAndHookStaysSolvent() public {
        ReentrantRecipient r = new ReentrantRecipient(manager, hook);
        payees.push(address(r));
        MesaHook.LaunchParams memory p = params();
        p.feeRecipient = address(r);
        (, PoolKey memory k) = launch(p, 0);
        r.setKey(k);
        buyExactIn(alice, k, 10 ether);
        r.claim(); // trades inside the hook's unlock with the HYPE it receives
        assertGt(r.tokensBought(), 0);
        assertGt(hook.accrued(address(r)), 0, "the re-entrant trade paid fees");
        assertSolvent();
    }

    function test_feeRecipientCanHandOver() public {
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        vm.expectRevert(MesaHook.NotFeeRecipient.selector);
        hook.setFeeRecipient(address(t), bob);
        vm.prank(feeTo);
        hook.setFeeRecipient(address(t), bob);
        buyExactIn(alice, k, 1 ether);
        assertEq(hook.accrued(bob), 0.007 ether);
        assertSolvent();
    }

    // ------------------------------------------------------------ buyback

    function test_buybackBurnsMesaWithProtocolFees() public {
        (MesaToken t, PoolKey memory k) = launch(params(), 0);
        buyExactIn(alice, k, 100 ether);
        sellExactIn(alice, k, t, t.balanceOf(alice));

        uint256 collected = burner.collect();
        assertGt(collected, 0);
        assertEq(address(burner).balance, collected);

        uint256 dead = mesa.balanceOf(burner.DEAD());
        vm.expectRevert(BuybackBurner.NotKeeper.selector);
        burner.buyback(collected, 0);
        vm.prank(keeper);
        uint256 burned = burner.buyback(collected, 1);
        assertEq(mesa.balanceOf(burner.DEAD()) - dead, burned);
        assertEq(address(burner).balance, 0);
        assertEq(hook.accrued(address(burner)), 0, "the buyback itself pays no Mesa fee");
        assertSolvent();
    }

    function test_buybackIsCappedPerCall() public {
        vm.deal(address(manager), 100 ether);
        vm.prank(address(manager));
        (bool ok,) = address(burner).call{value: 20 ether}("");
        assertTrue(ok);
        vm.prank(keeper);
        vm.expectRevert(BuybackBurner.TooMuch.selector);
        burner.buyback(11 ether, 0);
    }
}
