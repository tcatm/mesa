// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Helper contracts adapted from the independent review of the hook.

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

import {MesaHook} from "../../src/MesaHook.sol";

/// Does several swaps on one pool inside a single unlock, then settles.
contract MultiSwapper is IUnlockCallback {
    IPoolManager immutable m;

    constructor(IPoolManager m_) {
        m = m_;
    }

    function run(PoolKey memory key, IPoolManager.SwapParams[] memory ps)
        external
        payable
        returns (int256 d0, int256 d1)
    {
        (d0, d1) = abi.decode(m.unlock(abi.encode(key, ps, msg.sender)), (int256, int256));
        if (address(this).balance > 0) payable(msg.sender).transfer(address(this).balance);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, IPoolManager.SwapParams[] memory ps, address to) =
            abi.decode(data, (PoolKey, IPoolManager.SwapParams[], address));
        int256 d0;
        int256 d1;
        for (uint256 i; i < ps.length; ++i) {
            BalanceDelta d = m.swap(key, ps[i], "");
            d0 += d.amount0();
            d1 += d.amount1();
        }
        require(d0 <= 0 && d1 >= 0, "buys only");
        if (d0 < 0) m.settle{value: uint256(-d0)}();
        if (d1 > 0) m.take(key.currency1, to, uint256(d1));
        return abi.encode(d0, d1);
    }

    receive() external payable {}
}

/// Fee recipient that, while being paid inside the hook's unlock, re-enters
/// the PoolManager and trades.
contract ReentrantRecipient {
    IPoolManager immutable m;
    MesaHook immutable hook;
    PoolKey key;
    bool armed;
    uint256 public tokensBought;

    constructor(IPoolManager m_, MesaHook h) {
        m = m_;
        hook = h;
    }

    function setKey(PoolKey memory k) external {
        key = k;
    }

    function claim() external {
        armed = true;
        hook.claim();
        armed = false;
    }

    receive() external payable {
        if (!armed) return;
        // PoolManager is unlocked (by the hook). Trade with what we just got.
        BalanceDelta d = m.swap(key, IPoolManager.SwapParams(true, -int256(msg.value), TickMath.MIN_SQRT_PRICE + 1), "");
        m.settle{value: uint256(uint128(-d.amount0()))}();
        tokensBought = uint256(uint128(d.amount1()));
        m.take(key.currency1, address(this), tokensBought);
    }
}
