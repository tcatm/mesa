// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

interface IMesaHook {
    function claim() external returns (uint256);
    function claim(address quote) external returns (uint256);
    function genesisToken() external view returns (address);
    function poolKeyOf(address token) external view returns (PoolKey memory);
    function quoteRegistry() external view returns (IQuoteRegistry);
}

interface IQuoteRegistry {
    function routeOf(address quote) external view returns (PoolKey memory);
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
/// Fees from pools quoted in an ERC-20 arrive in that ERC-20. The keeper
/// converts them to HYPE through the route pool the hook's QuoteRegistry
/// holds for that asset; the HYPE stays here until a buyback.
///
/// What the keeper controls: when a conversion or buyback runs, how much (a
/// buyback up to `maxPerCall`), and the minimum out. What nobody controls:
/// where the funds go. There is no withdraw function; the only exits are a
/// conversion into HYPE held here, and a swap into $MESA that is burned in the
/// same transaction.
contract BuybackBurner is IUnlockCallback {
    using SafeTransferLib for ERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    IMesaHook public immutable hook;
    /// @notice Largest buyback per call, in HYPE, limiting price impact per transaction.
    uint256 public immutable maxPerCall;

    address public owner;
    address public keeper;

    enum Op {
        Buyback,
        Convert
    }

    event KeeperChanged(address keeper);
    event OwnershipRenounced();
    event Bought(uint256 hypeIn, uint256 mesaBurned);
    event Converted(address indexed quote, uint256 amountIn, uint256 hypeOut);

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

    /// @notice Pull accrued native HYPE fees from the hook. Anyone may call.
    function collect() external returns (uint256) {
        return hook.claim();
    }

    /// @notice Pull accrued fees in `quote` from the hook. Anyone may call.
    function collect(address quote) external returns (uint256) {
        return hook.claim(quote);
    }

    /// @notice Buy $MESA with `hypeIn` and burn it.
    function buyback(uint256 hypeIn, uint256 minMesaOut) external returns (uint256 burned) {
        if (msg.sender != keeper) revert NotKeeper();
        if (hypeIn > maxPerCall || hypeIn > address(this).balance) revert TooMuch();
        burned = abi.decode(poolManager.unlock(abi.encode(Op.Buyback, abi.encode(hypeIn))), (uint256));
        if (burned < minMesaOut) revert Slippage(burned, minMesaOut);
        emit Bought(hypeIn, burned);
    }

    /// @notice Sell `amountIn` of an ERC-20 quote for HYPE through the
    /// registered route pool. The HYPE stays here, for buybacks.
    function convert(address quote, uint256 amountIn, uint256 minHypeOut) external returns (uint256 hypeOut) {
        if (msg.sender != keeper) revert NotKeeper();
        if (amountIn > ERC20(quote).balanceOf(address(this))) revert TooMuch();
        hypeOut = abi.decode(poolManager.unlock(abi.encode(Op.Convert, abi.encode(quote, amountIn))), (uint256));
        if (hypeOut < minHypeOut) revert Slippage(hypeOut, minHypeOut);
        emit Converted(quote, amountIn, hypeOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Op op, bytes memory args) = abi.decode(data, (Op, bytes));
        if (op == Op.Buyback) return abi.encode(_buyback(abi.decode(args, (uint256))));
        (address quote, uint256 amountIn) = abi.decode(args, (address, uint256));
        return abi.encode(_convert(quote, amountIn));
    }

    function _buyback(uint256 hypeIn) internal returns (uint256 out) {
        PoolKey memory key = hook.poolKeyOf(mesa());
        BalanceDelta d = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(hypeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        uint256 spent = uint256(uint128(-d.amount0()));
        out = uint256(uint128(d.amount1()));
        poolManager.settle{value: spent}();
        poolManager.take(key.currency1, DEAD, out);
    }

    /// @dev Route pools are HYPE (currency0) against the quote (currency1).
    function _convert(address quote, uint256 amountIn) internal returns (uint256 out) {
        PoolKey memory route = hook.quoteRegistry().routeOf(quote);
        BalanceDelta d = poolManager.swap(
            route,
            IPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 spent = uint256(uint128(-d.amount1()));
        out = uint256(uint128(d.amount0()));
        poolManager.sync(Currency.wrap(quote));
        ERC20(quote).safeTransfer(address(poolManager), spent);
        poolManager.settle();
        poolManager.take(Currency.wrap(address(0)), address(this), out);
    }
}
