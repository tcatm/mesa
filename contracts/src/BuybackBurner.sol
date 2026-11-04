// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

interface IMesaHook {
    function claim() external returns (uint256);
    function genesisToken() external view returns (address);
    function poolKeyOf(address token) external view returns (PoolKey memory);
}

/// @title BuybackBurner
/// @notice Receives the protocol share of every Mesa fee and spends it on one
/// thing only: buying $MESA (the hook's genesis token) in its Mesa pool and
/// sending it to the burn address.
///
/// Deployed by MesaHook's constructor, so its hook is fixed and genuine. The
/// token it buys is the hook's first launch, which only the hook's
/// `genesisLauncher` can make, and which can never change.
///
/// What the keeper controls: when a buyback runs, how much (up to
/// `maxPerCall`), and the minimum $MESA out. What nobody controls: where the
/// HYPE goes. There is no withdraw function; the only exit for HYPE held here
/// is a swap into $MESA that is burned in the same transaction.
contract BuybackBurner is IUnlockCallback {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    IMesaHook public immutable hook;
    /// @notice Largest buyback per call, limiting price impact per transaction.
    uint256 public immutable maxPerCall;

    address public owner;
    address public keeper;

    event KeeperChanged(address keeper);
    event OwnershipRenounced();
    event Bought(uint256 hypeIn, uint256 mesaBurned);

    error NotOwner();
    error NotKeeper();
    error NoGenesisToken();
    error TooMuch();
    error Slippage(uint256 out, uint256 minOut);
    error NotPoolManager();

    constructor(IPoolManager poolManager_, address hook_, uint256 maxPerCall_, address owner_, address keeper_) {
        poolManager = poolManager_;
        hook = IMesaHook(hook_);
        maxPerCall = maxPerCall_;
        owner = owner_;
        keeper = keeper_;
    }

    /// @dev Native HYPE arrives from the PoolManager when fees are claimed.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    /// @notice The token every buyback buys and burns.
    function mesa() public view returns (address token) {
        token = hook.genesisToken();
        if (token == address(0)) revert NoGenesisToken();
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert NotOwner();
        keeper = keeper_;
        emit KeeperChanged(keeper_);
    }

    /// @notice Give up the ability to change the keeper.
    function renounceOwnership() external {
        if (msg.sender != owner) revert NotOwner();
        owner = address(0);
        emit OwnershipRenounced();
    }

    /// @notice Pull accrued protocol fees from the hook. Anyone may call.
    function collect() external returns (uint256) {
        return hook.claim();
    }

    /// @notice Buy $MESA with `hypeIn` and burn it.
    function buyback(uint256 hypeIn, uint256 minMesaOut) external returns (uint256 burned) {
        if (msg.sender != keeper) revert NotKeeper();
        if (hypeIn > maxPerCall || hypeIn > address(this).balance) revert TooMuch();
        burned = abi.decode(poolManager.unlock(abi.encode(hypeIn)), (uint256));
        if (burned < minMesaOut) revert Slippage(burned, minMesaOut);
        emit Bought(hypeIn, burned);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 hypeIn = abi.decode(data, (uint256));
        PoolKey memory key = hook.poolKeyOf(mesa());
        BalanceDelta d = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(hypeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        uint256 spent = uint256(uint128(-d.amount0()));
        uint256 out = uint256(uint128(d.amount1()));
        poolManager.settle{value: spent}();
        poolManager.take(key.currency1, DEAD, out);
        return abi.encode(out);
    }
}
