// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Pool} from "v4-core/src/libraries/Pool.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";

import {MesaToken} from "./MesaToken.sol";
import {BuybackBurner} from "./BuybackBurner.sol";

/// @title MesaHook
/// @notice Launches tokens on the official Uniswap v4 PoolManager and is the
/// hook of every pool it creates.
///
/// Each launch:
///  - deploys a fixed-supply MesaToken (no owner, no mint);
///  - creates a HYPE/token pool with this contract as hook, at a fixed starting
///    price, and puts the entire supply into one one-sided position owned by
///    this contract;
///  - optionally executes the creator's declared dev buy in the same
///    transaction, capped at `MAX_DEV_BUY_BPS` of supply.
///
/// Invariants, enforced in code:
///  - Liquidity is locked forever: no one can remove it, this contract
///    included. Only this contract can add liquidity, and only at launch.
///  - Only this contract can create pools that use it as hook.
///  - Fees are charged on the HYPE side of every trade, within hard caps, and
///    split between the token's fee recipient and the protocol at a ratio
///    fixed at deployment. The sniper surcharge goes entirely to the protocol,
///    so a creator gains nothing by sniping their own launch.
///  - Every swap kind pays the same share of its gross HYPE amount. Swaps
///    that would fill only partially (because of a price limit) revert
///    instead of paying fees on input that never traded.
///  - Nothing here is upgradeable and there is no admin. Accrued fees can only
///    be claimed by the address they accrued to.
///  - The first launch can only be made by `genesisLauncher`; it is $MESA, and
///    the protocol's buyback contract can only ever buy that token.
contract MesaHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    // ------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;
    int24 public constant TICK_SPACING = 200;

    /// @notice Base trading fee bounds per side.
    uint16 public constant MIN_FEE_BPS = 100;
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice Sniper surcharge: starts at most here and decays to zero.
    uint16 public constant MAX_SNIPER_FEE_BPS = 3_000;
    uint32 public constant MAX_SNIPE_SECONDS = 15 minutes;
    /// @notice Per-transaction buy cap during the snipe window, as share of supply.
    uint16 public constant MIN_MAX_BUY_BPS = 10;
    /// @notice Dev buy cap, as share of supply.
    uint16 public constant MAX_DEV_BUY_BPS = 1_000;

    uint256 internal constant NATIVE_ID = 0; // ERC-6909 id of native HYPE in the PoolManager
    uint256 internal constant WAD = 1e18;
    /// @dev Transient-storage namespaces, keyed by pool id.
    bytes32 internal constant T_FEE = keccak256("mesa.swap.fee");
    bytes32 internal constant T_BOUGHT = keccak256("mesa.tx.bought");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------- immutables

    IPoolManager public immutable poolManager;
    /// @notice Receives the protocol share of fees: the buyback-and-burn
    /// contract, deployed by this constructor so the pairing cannot be forged.
    address public immutable protocolRecipient;
    /// @notice The only address that can make the first launch ($MESA).
    address public immutable genesisLauncher;
    /// @notice Share of the base fee that goes to a token's fee recipient.
    uint16 public immutable creatorShareBps;
    /// @notice Starting tick of every pool: price in tokens per HYPE.
    int24 public immutable initialTick;

    // ------------------------------------------------------------- state

    struct LaunchParams {
        string name;
        string symbol;
        /// Off-chain metadata (image, links), emitted only.
        string metadataURI;
        /// Receives the creator share of fees. Can be changed later by itself.
        address feeRecipient;
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        /// Surcharge on buys at launch, decaying linearly to zero over `snipeSeconds`.
        uint16 sniperFeeBps;
        uint32 snipeSeconds;
        /// Max share of supply one swap may buy during `snipeSeconds`. 10_000 = no cap.
        uint16 maxBuyBps;
    }

    struct PoolConfig {
        address token;
        address feeRecipient;
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        uint16 sniperFeeBps;
        uint16 maxBuyBps;
        uint32 snipeSeconds;
        uint64 launchedAt;
    }

    /// @notice The first token launched here: $MESA.
    address public genesisToken;

    mapping(PoolId => PoolConfig) public pools;
    mapping(address token => PoolId) public poolOf;
    /// @notice Claimable native HYPE per address, backed by this contract's
    /// ERC-6909 balance in the PoolManager.
    mapping(address => uint256) public accrued;

    enum Action {
        Launch,
        Claim
    }

    // ------------------------------------------------------------- events

    event Launched(
        address indexed token,
        PoolId indexed poolId,
        address indexed creator,
        address feeRecipient,
        string name,
        string symbol,
        string metadataURI,
        uint16 buyFeeBps,
        uint16 sellFeeBps,
        uint16 sniperFeeBps,
        uint32 snipeSeconds,
        uint16 maxBuyBps,
        uint256 devBuyHype,
        uint256 devBuyTokens
    );
    event FeesTaken(PoolId indexed poolId, bool buy, uint256 baseFee, uint256 sniperFee);
    event FeeRecipientChanged(PoolId indexed poolId, address previous, address next);
    event Claimed(address indexed recipient, uint256 amount);

    // ------------------------------------------------------------- errors

    error NotPoolManager();
    error OnlyMesa();
    error LiquidityLocked();
    error DonationsDisabled();
    error HookNotImplemented();
    error InvalidParams(string reason);
    error UnknownPool();
    error MaxBuyExceeded(uint256 tokensOut, uint256 maxTokens);
    error DevBuyTooLarge(uint256 tokensOut, uint256 maxTokens);
    error NothingToClaim();
    error NotFeeRecipient();
    error Reentrancy();
    error GenesisFirst();
    error PartialFill();

    // ------------------------------------------------------------- setup

    /// @param burnerOwner Owner of the buyback contract (can only set its keeper).
    /// @param burnerKeeper Keeper of the buyback contract (runs buybacks).
    /// @param buybackMaxPerCall Largest single buyback, in HYPE.
    constructor(
        IPoolManager poolManager_,
        uint16 creatorShareBps_,
        int24 initialTick_,
        address genesisLauncher_,
        address burnerOwner,
        address burnerKeeper,
        uint256 buybackMaxPerCall
    ) {
        if (creatorShareBps_ > BPS) revert InvalidParams("creatorShareBps");
        if (genesisLauncher_ == address(0)) revert InvalidParams("genesisLauncher");
        if (
            initialTick_ % TICK_SPACING != 0 || initialTick_ <= TickMath.minUsableTick(TICK_SPACING)
                || initialTick_ >= TickMath.maxUsableTick(TICK_SPACING)
        ) revert InvalidParams("initialTick");
        // The whole supply must fit one position, or every launch would revert.
        uint256 liquidity = _liquidityForAmount1(
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
            TickMath.getSqrtPriceAtTick(initialTick_),
            1_000_000_000e18
        );
        if (liquidity > Pool.tickSpacingToMaxLiquidityPerTick(TICK_SPACING)) revert InvalidParams("initialTick");

        poolManager = poolManager_;
        creatorShareBps = creatorShareBps_;
        initialTick = initialTick_;
        genesisLauncher = genesisLauncher_;
        protocolRecipient =
            address(new BuybackBurner(poolManager_, address(this), buybackMaxPerCall, burnerOwner, burnerKeeper));
        Hooks.validateHookPermissions(IHooks(address(this)), permissions());
    }

    /// @notice The hook flags this contract's address must encode.
    function permissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @dev Transient-storage lock on launch and claim.
    modifier nonReentrant() {
        bool locked;
        assembly ("memory-safe") {
            locked := tload(0)
        }
        if (locked) revert Reentrancy();
        assembly ("memory-safe") {
            tstore(0, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(0, 0)
        }
    }

    // ------------------------------------------------------------- launch

    /// @notice Launch a token. `msg.value`, if any, is the declared dev buy,
    /// executed at the starting price; the tokens go to `msg.sender`.
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token, PoolKey memory key) {
        _validate(p);

        token = address(new MesaToken(p.name, p.symbol, address(this)));
        if (genesisToken == address(0)) {
            if (msg.sender != genesisLauncher) revert GenesisFirst();
            genesisToken = token;
        }
        key = PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
        PoolId id = key.toId();
        pools[id] = PoolConfig({
            token: token,
            feeRecipient: p.feeRecipient,
            buyFeeBps: p.buyFeeBps,
            sellFeeBps: p.sellFeeBps,
            sniperFeeBps: p.sniperFeeBps,
            maxBuyBps: p.maxBuyBps,
            snipeSeconds: p.snipeSeconds,
            launchedAt: uint64(block.timestamp)
        });
        poolOf[token] = id;

        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(initialTick));
        bytes memory result = poolManager.unlock(abi.encode(Action.Launch, abi.encode(key, msg.value, msg.sender)));
        (uint256 devBuyTokens) = abi.decode(result, (uint256));

        emit Launched(
            token,
            id,
            msg.sender,
            p.feeRecipient,
            p.name,
            p.symbol,
            p.metadataURI,
            p.buyFeeBps,
            p.sellFeeBps,
            p.sniperFeeBps,
            p.snipeSeconds,
            p.maxBuyBps,
            msg.value,
            devBuyTokens
        );
    }

    function _validate(LaunchParams calldata p) internal pure {
        uint256 nameLen = bytes(p.name).length;
        uint256 symbolLen = bytes(p.symbol).length;
        if (nameLen == 0 || nameLen > 64) revert InvalidParams("name");
        if (symbolLen == 0 || symbolLen > 16) revert InvalidParams("symbol");
        if (bytes(p.metadataURI).length > 512) revert InvalidParams("metadataURI");
        if (p.feeRecipient == address(0)) revert InvalidParams("feeRecipient");
        if (p.buyFeeBps < MIN_FEE_BPS || p.buyFeeBps > MAX_FEE_BPS) revert InvalidParams("buyFeeBps");
        if (p.sellFeeBps < MIN_FEE_BPS || p.sellFeeBps > MAX_FEE_BPS) revert InvalidParams("sellFeeBps");
        if (p.sniperFeeBps > MAX_SNIPER_FEE_BPS) revert InvalidParams("sniperFeeBps");
        if (p.snipeSeconds > MAX_SNIPE_SECONDS) revert InvalidParams("snipeSeconds");
        if (p.maxBuyBps < MIN_MAX_BUY_BPS || p.maxBuyBps > BPS) revert InvalidParams("maxBuyBps");
    }

    /// @notice Liquidity for `amount1` of token1 in `[sqrtA, sqrtB]`.
    function _liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) internal pure returns (uint256) {
        return FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtB - sqrtA);
    }

    // ------------------------------------------------------------- claims

    /// @notice Claim all native HYPE accrued to `msg.sender`.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = accrued[msg.sender];
        if (amount == 0) revert NothingToClaim();
        accrued[msg.sender] = 0;
        poolManager.unlock(abi.encode(Action.Claim, abi.encode(msg.sender, amount)));
        emit Claimed(msg.sender, amount);
    }

    /// @notice Change a token's fee recipient. Only the current recipient can.
    /// Fees already accrued stay with the previous recipient.
    function setFeeRecipient(address token, address next) external {
        PoolId id = poolOf[token];
        PoolConfig storage c = pools[id];
        if (c.token == address(0)) revert UnknownPool();
        if (msg.sender != c.feeRecipient) revert NotFeeRecipient();
        if (next == address(0)) revert InvalidParams("feeRecipient");
        emit FeeRecipientChanged(id, c.feeRecipient, next);
        c.feeRecipient = next;
    }

    // ------------------------------------------------------------- unlock

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Action action, bytes memory args) = abi.decode(data, (Action, bytes));
        if (action == Action.Launch) {
            (PoolKey memory key, uint256 devBuyHype, address buyer) = abi.decode(args, (PoolKey, uint256, address));
            return abi.encode(_launchInUnlock(key, devBuyHype, buyer));
        }
        (address recipient, uint256 amount) = abi.decode(args, (address, uint256));
        poolManager.burn(address(this), NATIVE_ID, amount);
        poolManager.take(CurrencyLibrary.ADDRESS_ZERO, recipient, amount);
        return "";
    }

    function _launchInUnlock(PoolKey memory key, uint256 devBuyHype, address buyer)
        internal
        returns (uint256 devBuyTokens)
    {
        MesaToken token = MesaToken(Currency.unwrap(key.currency1));

        // 1. Entire supply as one one-sided position below the starting price.
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        uint128 liquidity = SafeCast.toUint128(
            _liquidityForAmount1(
                TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(initialTick), token.TOTAL_SUPPLY()
            )
        );
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: initialTick, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)
            }),
            ""
        );
        uint256 owed = uint256(uint128(-added.amount1()));
        poolManager.sync(key.currency1);
        token.transfer(address(poolManager), owed);
        poolManager.settle();
        // Rounding dust that did not fit the position is burned.
        uint256 dust = token.balanceOf(address(this));
        if (dust > 0) token.transfer(DEAD, dust);

        // 2. Declared dev buy at the starting price. Hooks are skipped for
        // swaps this contract makes, so the fee and cap are applied here.
        if (devBuyHype == 0) return 0;
        PoolConfig storage c = pools[key.toId()];
        uint256 fee = devBuyHype * c.buyFeeBps / BPS;
        BalanceDelta swapped = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(devBuyHype - fee),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        devBuyTokens = uint256(uint128(swapped.amount1()));
        uint256 maxTokens = token.TOTAL_SUPPLY() * MAX_DEV_BUY_BPS / BPS;
        if (devBuyTokens > maxTokens) revert DevBuyTooLarge(devBuyTokens, maxTokens);

        uint256 spent = uint256(uint128(-swapped.amount0()));
        poolManager.settle{value: devBuyHype}();
        poolManager.mint(address(this), NATIVE_ID, fee);
        poolManager.take(key.currency1, buyer, devBuyTokens);
        uint256 refund = devBuyHype - fee - spent;
        if (refund > 0) poolManager.take(CurrencyLibrary.ADDRESS_ZERO, buyer, refund);
        _accrue(key.toId(), c, true, fee, 0);
    }

    // ------------------------------------------------------------- fees

    /// @dev Fee rates as a share of gross HYPE, in WAD (1e18 = 100%).
    function _rates(PoolConfig storage c, bool buy) internal view returns (uint256 baseRate, uint256 sniperRate) {
        baseRate = uint256(buy ? c.buyFeeBps : c.sellFeeBps) * (WAD / BPS);
        if (buy && c.sniperFeeBps > 0) {
            uint256 elapsed = block.timestamp - c.launchedAt;
            if (elapsed < c.snipeSeconds) {
                sniperRate = uint256(c.sniperFeeBps) * (WAD / BPS) * (c.snipeSeconds - elapsed) / c.snipeSeconds;
            }
        }
    }

    /// @dev Fees on a swap's HYPE side, always as a share of the gross amount
    /// (what the buyer pays, or what the pool pays out to a seller).
    /// `gross` says whether `hypeAmount` is that gross amount (exact-input
    /// swaps) or the net amount the fee is added to (exact-output swaps).
    function _fees(PoolConfig storage c, bool buy, uint256 hypeAmount, bool gross)
        internal
        view
        returns (uint256 baseFee, uint256 sniperFee)
    {
        (uint256 baseRate, uint256 sniperRate) = _rates(c, buy);
        uint256 denom = gross ? WAD : WAD - baseRate - sniperRate;
        baseFee = FullMath.mulDiv(hypeAmount, baseRate, denom);
        sniperFee = FullMath.mulDiv(hypeAmount, sniperRate, denom);
    }

    function _accrue(PoolId id, PoolConfig storage c, bool buy, uint256 baseFee, uint256 sniperFee) internal {
        uint256 creator = baseFee * creatorShareBps / BPS;
        accrued[c.feeRecipient] += creator;
        accrued[protocolRecipient] += baseFee - creator + sniperFee;
        emit FeesTaken(id, buy, baseFee, sniperFee);
    }

    /// @dev Take `amount` of native HYPE from the swap as ERC-6909 claims.
    function _take(PoolKey calldata key, bool buy, uint256 hypeAmount, bool gross) internal returns (uint256 total) {
        PoolId id = key.toId();
        PoolConfig storage c = pools[id];
        (uint256 baseFee, uint256 sniperFee) = _fees(c, buy, hypeAmount, gross);
        total = baseFee + sniperFee;
        if (total == 0) return 0;
        poolManager.mint(address(this), NATIVE_ID, total);
        _accrue(id, c, buy, baseFee, sniperFee);
    }

    // ------------------------------------------------------------- hooks

    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != address(this)) revert OnlyMesa();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        if (sender != address(this)) revert OnlyMesa();
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert LiquidityLocked();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert DonationsDisabled();
    }

    /// @dev HYPE is the specified currency for exact-input buys and
    /// exact-output sells: the fee is taken here, from the specified amount,
    /// and remembered so afterSwap can reject partial fills.
    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bool buy = params.zeroForOne;
        bool exactIn = params.amountSpecified < 0;
        if (sender == protocolRecipient || buy != exactIn) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 amount = uint256(exactIn ? -params.amountSpecified : params.amountSpecified);
        uint256 total = _take(key, buy, amount, exactIn);
        _tset(T_FEE, key.toId(), total);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(total)), 0), 0);
    }

    /// @dev Rejects partial fills of HYPE-specified swaps, enforces the
    /// snipe-window buy cap per transaction, and takes the fee when HYPE is
    /// the unspecified currency (exact-input sells, exact-output buys).
    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        if (sender == protocolRecipient) return (IHooks.afterSwap.selector, 0);
        PoolId id = key.toId();
        bool buy = params.zeroForOne;
        bool exactIn = params.amountSpecified < 0;
        int128 hype = delta.amount0();

        if (buy) {
            PoolConfig storage c = pools[id];
            if (c.maxBuyBps < BPS && block.timestamp - c.launchedAt < c.snipeSeconds) {
                uint256 bought = _tget(T_BOUGHT, id) + uint256(uint128(delta.amount1()));
                uint256 maxTokens = MesaToken(c.token).TOTAL_SUPPLY() * c.maxBuyBps / BPS;
                if (bought > maxTokens) revert MaxBuyExceeded(bought, maxTokens);
                _tset(T_BOUGHT, id, bought);
            }
        }

        if (buy == exactIn) {
            // Fee was taken in beforeSwap from the full specified amount:
            // the pool must have swapped all of the rest.
            uint256 fee = _tget(T_FEE, id);
            _tset(T_FEE, id, 0);
            // exact-in buy: -(gross - fee); exact-out sell: +(net + fee). Both are specified + fee.
            if (int256(hype) != params.amountSpecified + int256(fee)) revert PartialFill();
            return (IHooks.afterSwap.selector, 0);
        }

        uint256 amount = uint256(uint128(hype < 0 ? -hype : hype));
        uint256 total = _take(key, buy, amount, exactIn);
        return (IHooks.afterSwap.selector, int128(int256(total)));
    }

    function _tget(bytes32 ns, PoolId id) internal view returns (uint256 v) {
        bytes32 slot = keccak256(abi.encode(ns, id));
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _tset(bytes32 ns, PoolId id, uint256 v) internal {
        bytes32 slot = keccak256(abi.encode(ns, id));
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    // Hooks this contract does not enable. The PoolManager never calls them.

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ------------------------------------------------------------- views

    /// @notice The pool key of a Mesa token.
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        if (pools[poolOf[token]].token != token || token == address(0)) revert UnknownPool();
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }
}
