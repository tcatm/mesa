// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {Pool} from "v4-core/src/libraries/Pool.sol";

/// @notice The launch position shared by MesaHook and QuoteRegistry.
library LaunchMath {
    int24 internal constant TICK_SPACING = 200;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    error BadStartTick();

    /// @dev The whole supply, one-sided, on the token side of the starting
    /// price. `startTick` is the price in tokens per quote; when the quote is
    /// currency1 the pool price is its inverse.
    function position(bool quoteIs0, int24 startTick)
        internal
        pure
        returns (int24 lower, int24 upper, uint256 liquidity)
    {
        if (quoteIs0) {
            // Token is currency1: the position sits below the price.
            lower = TickMath.minUsableTick(TICK_SPACING);
            upper = startTick;
            uint160 a = TickMath.getSqrtPriceAtTick(lower);
            uint160 b = TickMath.getSqrtPriceAtTick(upper);
            liquidity = FullMath.mulDiv(SUPPLY, FixedPoint96.Q96, b - a);
        } else {
            // Token is currency0: the position sits above the price.
            lower = -startTick;
            upper = TickMath.maxUsableTick(TICK_SPACING);
            uint160 a = TickMath.getSqrtPriceAtTick(lower);
            uint160 b = TickMath.getSqrtPriceAtTick(upper);
            liquidity = FullMath.mulDiv(SUPPLY, FullMath.mulDiv(a, b, FixedPoint96.Q96), b - a);
        }
    }

    /// @dev On the spacing grid, strictly inside the usable range, and able to
    /// hold the whole supply in one position.
    function checkStartTick(int24 t, bool quoteIs0) internal pure {
        if (
            t % TICK_SPACING != 0 || t <= TickMath.minUsableTick(TICK_SPACING)
                || t >= TickMath.maxUsableTick(TICK_SPACING)
        ) revert BadStartTick();
        (,, uint256 liquidity) = position(quoteIs0, t);
        if (liquidity == 0 || liquidity > Pool.tickSpacingToMaxLiquidityPerTick(TICK_SPACING)) revert BadStartTick();
    }
}
