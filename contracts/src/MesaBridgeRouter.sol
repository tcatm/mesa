// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

interface IMesaHookKeys {
    function poolKeyOf(address token) external view returns (PoolKey memory);
}

/// @title MesaBridgeRouter
/// @notice Buys a Mesa token with native HYPE for someone else, and never
/// keeps the HYPE if the buy fails. Built to be the target of a bridge
/// deposit from HyperEVM: the deposit carries the HYPE and a call to `buy`,
/// and runs when the next Elysium batch includes it, possibly much later than
/// it was signed. If the price has moved past `minOut` by then, or the buy
/// fails for any other reason, the HYPE is sent to `recipient` on Elysium.
///
/// Holds nothing between calls and has no owner. Buys pay the normal Mesa fees
/// and count against a launch's per-transaction buy cap like any other buy.
contract MesaBridgeRouter is IUnlockCallback {
    using CurrencyLibrary for Currency;

    IPoolManager public immutable poolManager;
    IMesaHookKeys public immutable hook;

    event Bought(address indexed recipient, address indexed token, uint256 hypeIn, uint256 tokensOut);
    event Refunded(address indexed recipient, address indexed token, uint256 hypeIn, bytes reason);

    error NotPoolManager();
    error OnlySelf();
    error Slippage(uint256 out, uint256 minOut);
    error NotNativePool();
    error RefundFailed();

    constructor(IPoolManager poolManager_, address hook_) {
        poolManager = poolManager_;
        hook = IMesaHookKeys(hook_);
    }

    /// @notice Buy `token` with all of `msg.value` and send it to `recipient`,
    /// or, if that fails, send `msg.value` back to `recipient`.
    /// @return tokensOut Tokens bought; 0 if the HYPE was refunded.
    function buy(address token, uint256 minOut, address recipient) external payable returns (uint256 tokensOut) {
        try this.buyOrRevert{value: msg.value}(token, minOut, recipient) returns (uint256 out) {
            tokensOut = out;
            emit Bought(recipient, token, msg.value, out);
        } catch (bytes memory reason) {
            (bool ok,) = recipient.call{value: msg.value}("");
            // A recipient that refuses HYPE leaves the bridge message
            // redeemable, so the funds can still be recovered from it.
            if (!ok) revert RefundFailed();
            emit Refunded(recipient, token, msg.value, reason);
        }
    }

    /// @dev Only callable by this contract, so `buy` can catch its revert.
    function buyOrRevert(address token, uint256 minOut, address recipient) external payable returns (uint256 out) {
        if (msg.sender != address(this)) revert OnlySelf();
        PoolKey memory key = hook.poolKeyOf(token);
        if (!key.currency0.isAddressZero()) revert NotNativePool();
        out = abi.decode(poolManager.unlock(abi.encode(key, msg.value, recipient)), (uint256));
        if (out < minOut) revert Slippage(out, minOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 hypeIn, address recipient) = abi.decode(data, (PoolKey, uint256, address));
        BalanceDelta d = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(hypeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        uint256 out = uint256(uint128(d.amount1()));
        poolManager.settle{value: hypeIn}();
        poolManager.take(key.currency1, recipient, out);
        // Mesa reverts partial fills, so nothing should be left; if it is, it is the recipient's.
        uint256 unspent = hypeIn - uint256(uint128(-d.amount0()));
        if (unspent > 0) poolManager.take(key.currency0, recipient, unspent);
        return abi.encode(out);
    }
}
