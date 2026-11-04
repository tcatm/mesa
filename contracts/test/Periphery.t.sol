// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaToken} from "../src/MesaToken.sol";

/// ABI of v4-periphery's V4Router single-pool params at commit a7af5b34.
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

struct ExactOutputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    uint256 minHopPriceX36;
    bytes hookData;
}

struct QuoteExactSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
}

interface IRouter {
    function executeActionsAndSweepExcessETH(bytes calldata params) external payable;
}

interface IQuoter {
    function quoteExactInputSingle(QuoteExactSingleParams memory) external returns (uint256 amountOut, uint256 gas);
    function quoteExactOutputSingle(QuoteExactSingleParams memory) external returns (uint256 amountIn, uint256 gas);
}

/// Every swap kind through Uniswap's own V4Router and V4Quoter, the path a
/// frontend uses (the Universal Router wraps the same V4Router actions).
/// Quotes must match execution exactly, fees included.
contract PeripheryTest is Test, Deployers {
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SWAP_EXACT_OUT_SINGLE = 0x08;
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;

    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MesaHook hook;
    IRouter router;
    IQuoter quoter;
    address genesis = makeAddr("genesis");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");

    function setUp() public {
        deployFreshManagerAndRouters();
        address at = address(FLAGS | (uint160(0x4444) << 144));
        deployCodeTo(
            "out/MesaHook.sol/MesaHook.json",
            abi.encode(
                manager, uint16(7_000), int24(173_200), genesis, makeAddr("o"), makeAddr("k"), 10 ether, makeAddr("qa")
            ),
            at
        );
        hook = MesaHook(at);
        router = IRouter(deployCode("MockV4Router.sol:MockV4Router", abi.encode(manager)));
        quoter = IQuoter(deployCode("V4Quoter.sol:V4Quoter", abi.encode(manager)));
        vm.prank(genesis);
        hook.launch(params(0, 0, 10_000));
        vm.deal(alice, 1_000 ether);
    }

    function params(uint16 sniper, uint32 secs, uint16 cap) internal view returns (MesaHook.LaunchParams memory) {
        return MesaHook.LaunchParams("Token", "TKN", "", feeTo, 100, 200, sniper, secs, cap);
    }

    function launch(uint16 sniper, uint32 secs, uint16 cap) internal returns (MesaToken t, PoolKey memory k) {
        vm.prank(alice);
        (address token, PoolKey memory key) = hook.launch(params(sniper, secs, cap));
        return (MesaToken(token), key);
    }

    function run(uint8 swapAction, bytes memory swapParams, Currency payIn, uint256 maxIn, Currency out, uint256 value)
        internal
    {
        bytes[] memory ps = new bytes[](3);
        ps[0] = swapParams;
        ps[1] = abi.encode(payIn, maxIn);
        ps[2] = abi.encode(out, uint256(0));
        bytes memory actions = abi.encodePacked(swapAction, SETTLE_ALL, TAKE_ALL);
        vm.prank(alice);
        router.executeActionsAndSweepExcessETH{value: value}(abi.encode(actions, ps));
    }

    function test_buyAndSellExactInputQuotesMatchExecution() public {
        (MesaToken t, PoolKey memory k) = launch(0, 0, 10_000);
        Currency hype = CurrencyLibrary.ADDRESS_ZERO;
        Currency tkn = Currency.wrap(address(t));

        // Buy with exactly 1 HYPE.
        (uint256 quotedOut,) = quoter.quoteExactInputSingle(QuoteExactSingleParams(k, true, 1 ether, ""));
        uint256 before = alice.balance;
        run(
            SWAP_EXACT_IN_SINGLE,
            abi.encode(ExactInputSingleParams(k, true, 1 ether, 0, 0, "")),
            hype,
            1 ether,
            tkn,
            1 ether
        );
        assertEq(t.balanceOf(alice), quotedOut, "tokens out = quote");
        assertEq(before - alice.balance, 1 ether, "paid exactly 1 HYPE");
        assertEq(hook.accrued(feeTo), 0.007 ether, "1% buy fee, 70% to creator");

        // Sell everything.
        uint256 tokens = t.balanceOf(alice);
        (uint256 quotedHype,) = quoter.quoteExactInputSingle(QuoteExactSingleParams(k, false, uint128(tokens), ""));
        vm.prank(alice);
        t.approve(address(router), tokens);
        before = alice.balance;
        run(
            SWAP_EXACT_IN_SINGLE,
            abi.encode(ExactInputSingleParams(k, false, uint128(tokens), 0, 0, "")),
            tkn,
            tokens,
            hype,
            0
        );
        assertEq(alice.balance - before, quotedHype, "HYPE out = quote");
        assertEq(t.balanceOf(alice), 0);
        assertLt(quotedHype, 0.99 ether, "a round trip pays both fees");
    }

    function test_exactOutputQuotesMatchExecution() public {
        (MesaToken t, PoolKey memory k) = launch(0, 0, 10_000);
        Currency hype = CurrencyLibrary.ADDRESS_ZERO;
        Currency tkn = Currency.wrap(address(t));

        // Buy exactly 1M tokens.
        (uint256 quotedIn,) = quoter.quoteExactOutputSingle(QuoteExactSingleParams(k, true, 1_000_000e18, ""));
        uint256 before = alice.balance;
        run(
            SWAP_EXACT_OUT_SINGLE,
            abi.encode(ExactOutputSingleParams(k, true, 1_000_000e18, type(uint128).max, 0, "")),
            hype,
            type(uint256).max,
            tkn,
            1 ether
        );
        assertEq(t.balanceOf(alice), 1_000_000e18, "exactly the tokens asked for");
        assertEq(before - alice.balance, quotedIn, "HYPE in = quote, excess refunded");

        // Sell for exactly 0.01 HYPE.
        vm.prank(alice);
        t.approve(address(router), type(uint256).max);
        (uint256 quotedTokens,) = quoter.quoteExactOutputSingle(QuoteExactSingleParams(k, false, 0.01 ether, ""));
        uint256 tokensBefore = t.balanceOf(alice);
        before = alice.balance;
        run(
            SWAP_EXACT_OUT_SINGLE,
            abi.encode(ExactOutputSingleParams(k, false, 0.01 ether, type(uint128).max, 0, "")),
            tkn,
            type(uint256).max,
            hype,
            0
        );
        assertEq(alice.balance - before, 0.01 ether, "exactly the HYPE asked for");
        assertEq(tokensBefore - t.balanceOf(alice), quotedTokens, "tokens in = quote");
    }

    /// The quoter sees the live sniper surcharge and the launch cap, so a
    /// frontend shows what a trade will really cost, or that it will fail.
    function test_quotesReflectSniperFeeAndCap() public {
        (, PoolKey memory k) = launch(3_000, 600, 100); // 30% surcharge, 1% cap, 10 minutes
        (uint256 outNow,) = quoter.quoteExactInputSingle(QuoteExactSingleParams(k, true, 0.1 ether, ""));
        vm.warp(block.timestamp + 600);
        (uint256 outLater,) = quoter.quoteExactInputSingle(QuoteExactSingleParams(k, true, 0.1 ether, ""));
        assertApproxEqRel(outNow * 1e18 / outLater, uint256(0.69e18) * 1e18 / 0.99e18, 0.01e18, "31% vs 1% fee");

        vm.warp(block.timestamp - 600);
        (bool ok,) = address(quoter)
            .call(abi.encodeCall(IQuoter.quoteExactInputSingle, (QuoteExactSingleParams(k, true, 5 ether, ""))));
        assertFalse(ok, "a buy over the cap fails at quote time");
    }
}
