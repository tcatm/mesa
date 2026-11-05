// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

import {MesaTokenFactory} from "./MesaTokenFactory.sol";
import {BuybackBurner} from "./BuybackBurner.sol";
import {QuoteRegistry} from "./QuoteRegistry.sol";
import {LaunchMath} from "./LaunchMath.sol";

/// @title MesaHook
/// @notice Launches tokens on the official Uniswap v4 PoolManager and is the
/// hook of every pool it creates.
///
/// Each launch:
///  - has `tokenFactory` deploy a fixed-supply token (no owner, no mint), and
///    the token's payout contract if the creator splits their fees;
///  - creates a pool of the token against its quote asset (native HYPE by
///    default, or an ERC-20 the quote registry has enabled), with this
///    contract as hook, at the quote's fixed starting price, and puts the
///    entire supply into one one-sided position owned by this contract;
///  - optionally executes the creator's declared dev buy in the same
///    transaction, capped at `MAX_DEV_BUY_BPS` of supply.
///
/// Invariants, enforced in code:
///  - Liquidity is locked forever: no one can remove it, this contract
///    included. Only this contract can add liquidity, and only at launch.
///  - Only this contract can create pools that use it as hook.
///  - Every trade pays one fee, fixed for the pool's life, on the quote side,
///    within hard caps, split between the token's fee recipient and the
///    protocol at a ratio fixed at deployment. A launch may name a builder,
///    who earns an add-on of at most 1% on top. The sniper surcharge goes
///    entirely to the protocol, so a creator gains nothing by sniping their
///    own launch.
///  - Every swap kind pays the same share of its gross quote amount. Swaps
///    that would fill only partially (because of a price limit) revert
///    instead of paying fees on input that never traded.
///  - Nothing here is upgradeable. Accrued fees can only be claimed by the
///    address they accrued to.
///  - The first launch can only be made by `genesisLauncher`, against native
///    HYPE; it is $MESA, and the protocol's buyback contract can only ever buy
///    that token.
///
/// ERC-20 quote assets come from `quoteRegistry`, deployed by this
/// constructor. Its admin, the only privileged role in Mesa, decides which
/// quotes new launches may use (adding one takes a public delay). It cannot
/// touch existing pools, their fees, claims or tokens.
contract MesaHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeTransferLib for ERC20;

    // ------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;
    int24 public constant TICK_SPACING = LaunchMath.TICK_SPACING;
    uint256 internal constant SUPPLY = LaunchMath.SUPPLY;

    /// @notice Trading fee bounds: one fee on buys and sells, fixed at launch.
    uint16 public constant MIN_FEE_BPS = 100;
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice Builder add-on bound, on top of the trading fee.
    uint16 public constant MAX_BUILDER_FEE_BPS = 100;
    /// @notice Sniper surcharge: starts at most here and decays to zero.
    uint16 public constant MAX_SNIPER_FEE_BPS = 3_000;
    uint32 public constant MAX_SNIPE_SECONDS = 15 minutes;
    /// @notice Per-transaction buy cap during the snipe window, as share of supply.
    uint16 public constant MIN_MAX_BUY_BPS = 10;
    /// @notice Dev buy cap, as share of supply.
    uint16 public constant MAX_DEV_BUY_BPS = 1_000;

    uint256 internal constant WAD = 1e18;
    /// @dev Transient-storage namespaces, keyed by pool id.
    bytes32 internal constant T_FEE = keccak256("mesa.swap.fee");
    bytes32 internal constant T_BOUGHT = keccak256("mesa.tx.bought");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant NATIVE = address(0);

    // ------------------------------------------------------------- immutables

    IPoolManager public immutable poolManager;
    /// @notice Receives the protocol share of fees: the buyback-and-burn
    /// contract, deployed by this constructor so the pairing cannot be forged.
    address public immutable protocolRecipient;
    /// @notice The only address that can make the first launch ($MESA).
    address public immutable genesisLauncher;
    /// @notice Share of the base fee that goes to a token's fee recipient.
    uint16 public immutable creatorShareBps;
    /// @notice Starting tick of native HYPE pools, as the price in tokens per
    /// HYPE.
    int24 public immutable initialTick;
    /// @notice Which ERC-20 quote assets new launches may use.
    QuoteRegistry public immutable quoteRegistry;
    /// @notice Deploys each launch's token, and its payout contract if any.
    MesaTokenFactory public immutable tokenFactory;

    // ------------------------------------------------------------- state

    struct LaunchParams {
        string name;
        string symbol;
        /// Off-chain metadata (image, links), emitted only.
        string metadataURI;
        /// Receives the creator share of fees, when `payout` is empty. Can be handed over later.
        address feeRecipient;
        /// The trading fee on buys and sells, for the pool's life.
        uint16 feeBps;
        /// Surcharge on buys at launch, decaying linearly to zero over `snipeSeconds`.
        uint16 sniperFeeBps;
        uint32 snipeSeconds;
        /// Max share of supply one transaction may buy during `snipeSeconds`. 10_000 = no cap.
        uint16 maxBuyBps;
        /// Earns `builderFeeBps` on top of the trading fee; address(0) for none.
        address builder;
        uint16 builderFeeBps;
        /// Empty, or a split of the creator fees (see MesaTokenFactory).
        bytes payout;
    }

    struct PoolConfig {
        address token;
        address feeRecipient;
        /// Quote asset; address(0) is native HYPE.
        address quote;
        /// Whether the quote is currency0 of the pool.
        bool quoteIs0;
        uint16 feeBps;
        uint16 builderFeeBps;
        uint16 sniperFeeBps;
        uint16 maxBuyBps;
        uint32 snipeSeconds;
        uint64 launchedAt;
        address builder;
    }

    /// @notice The first token launched here: $MESA.
    address public genesisToken;

    mapping(PoolId => PoolConfig) public pools;
    mapping(address token => PoolId) public poolOf;
    mapping(PoolId => address) public pendingFeeRecipient;
    /// @notice Claimable fees per quote asset and address, backed by this
    /// contract's ERC-6909 balances in the PoolManager.
    mapping(address quote => mapping(address => uint256)) public accruedOf;

    enum Action {
        Launch,
        Claim
    }

    // ------------------------------------------------------------- events

    event Launched(
        address indexed token,
        PoolId indexed poolId,
        address indexed creator,
        address quote,
        address feeRecipient,
        string name,
        string symbol,
        string metadataURI,
        uint16 feeBps,
        address builder,
        uint16 builderFeeBps,
        uint16 sniperFeeBps,
        uint32 snipeSeconds,
        uint16 maxBuyBps,
        uint256 devBuyQuote,
        uint256 devBuyTokens
    );
    event FeesTaken(PoolId indexed poolId, bool buy, uint256 baseFee, uint256 builderFee, uint256 sniperFee);
    /// @notice Standard hook swap event (Uniswap Foundation hook data
    /// standard): the hook's delta on the swap, which is its fee, taken in
    /// the quote currency; the same amount again as the fee fields.
    event HookSwap(
        bytes32 indexed id,
        address indexed sender,
        int128 amount0,
        int128 amount1,
        uint128 hookLPfeeAmount0,
        uint128 hookLPfeeAmount1
    );
    /// @notice Standard hook fee event: every fee this hook took on a swap.
    event HookFee(bytes32 indexed id, address indexed sender, uint128 feeAmount0, uint128 feeAmount1);
    event FeeRecipientProposed(PoolId indexed poolId, address next);
    event FeeRecipientChanged(PoolId indexed poolId, address previous, address next);
    event Claimed(address indexed recipient, address indexed quote, uint256 amount);

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
    /// @param quoteAdmin_ Governs the ERC-20 quote registry; address(0) for none.
    constructor(
        IPoolManager poolManager_,
        uint16 creatorShareBps_,
        int24 initialTick_,
        address genesisLauncher_,
        address burnerOwner,
        address burnerKeeper,
        uint256 buybackMaxPerCall,
        address quoteAdmin_,
        MesaTokenFactory tokenFactory_
    ) {
        if (creatorShareBps_ > BPS) revert InvalidParams("creatorShareBps");
        if (genesisLauncher_ == address(0)) revert InvalidParams("genesisLauncher");
        if (address(tokenFactory_).code.length == 0) revert InvalidParams("tokenFactory");
        // Native HYPE is always currency0, so only that orientation matters here.
        LaunchMath.checkStartTick(initialTick_, true);

        poolManager = poolManager_;
        creatorShareBps = creatorShareBps_;
        initialTick = initialTick_;
        genesisLauncher = genesisLauncher_;
        tokenFactory = tokenFactory_;
        quoteRegistry = new QuoteRegistry(quoteAdmin_);
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

    /// @notice Launch a token against native HYPE. `msg.value`, if any, is the
    /// declared dev buy, executed at the starting price; the tokens go to
    /// `msg.sender`.
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address, PoolKey memory) {
        return _launch(p, NATIVE, msg.value);
    }

    /// @notice Launch a token against `quote` (address(0) = native HYPE).
    /// `devBuy` is the declared dev buy in the quote: sent as `msg.value` for
    /// native HYPE, or pulled from `msg.sender` (approve this contract first).
    function launchWithQuote(LaunchParams calldata p, address quote, uint256 devBuy)
        external
        payable
        nonReentrant
        returns (address, PoolKey memory)
    {
        if (msg.value != (quote == NATIVE ? devBuy : 0)) revert InvalidParams("msg.value");
        return _launch(p, quote, devBuy);
    }

    function _launch(LaunchParams calldata p, address quote, uint256 devBuy)
        internal
        returns (address token, PoolKey memory key)
    {
        _validate(p);
        int24 startTick = initialTick;
        if (quote != NATIVE) startTick = quoteRegistry.startTickOf(quote);

        address feeRecipient;
        (token, feeRecipient) = tokenFactory.create(p.name, p.symbol, quote, p.feeRecipient, p.payout);
        if (feeRecipient == address(0)) revert InvalidParams("feeRecipient");
        if (ERC20(token).balanceOf(address(this)) != SUPPLY) revert InvalidParams("token");
        if (genesisToken == address(0)) {
            if (msg.sender != genesisLauncher || quote != NATIVE) revert GenesisFirst();
            genesisToken = token;
        }
        bool quoteIs0 = quote < token;
        key = _key(token, quote, quoteIs0);
        PoolId id = key.toId();
        pools[id] = PoolConfig({
            token: token,
            feeRecipient: feeRecipient,
            quote: quote,
            quoteIs0: quoteIs0,
            feeBps: p.feeBps,
            builderFeeBps: p.builderFeeBps,
            sniperFeeBps: p.sniperFeeBps,
            maxBuyBps: p.maxBuyBps,
            snipeSeconds: p.snipeSeconds,
            launchedAt: uint64(block.timestamp),
            builder: p.builder
        });
        poolOf[token] = id;

        if (quote != NATIVE && devBuy > 0) {
            // Exact amounts only: a quote that takes a transfer fee is refused.
            uint256 before = ERC20(quote).balanceOf(address(this));
            ERC20(quote).safeTransferFrom(msg.sender, address(this), devBuy);
            if (ERC20(quote).balanceOf(address(this)) - before != devBuy) revert InvalidParams("quote transfer");
        }

        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(quoteIs0 ? startTick : -startTick));
        bytes memory result =
            poolManager.unlock(abi.encode(Action.Launch, abi.encode(key, startTick, devBuy, msg.sender)));
        uint256 devBuyTokens = abi.decode(result, (uint256));

        emit Launched(
            token,
            id,
            msg.sender,
            quote,
            feeRecipient,
            p.name,
            p.symbol,
            p.metadataURI,
            p.feeBps,
            p.builder,
            p.builderFeeBps,
            p.sniperFeeBps,
            p.snipeSeconds,
            p.maxBuyBps,
            devBuy,
            devBuyTokens
        );
    }

    function _validate(LaunchParams calldata p) internal pure {
        uint256 nameLen = bytes(p.name).length;
        uint256 symbolLen = bytes(p.symbol).length;
        if (nameLen == 0 || nameLen > 64) revert InvalidParams("name");
        if (symbolLen == 0 || symbolLen > 16) revert InvalidParams("symbol");
        if (bytes(p.metadataURI).length > 512) revert InvalidParams("metadataURI");
        if (p.feeBps < MIN_FEE_BPS || p.feeBps > MAX_FEE_BPS) revert InvalidParams("feeBps");
        if (p.builderFeeBps > MAX_BUILDER_FEE_BPS) revert InvalidParams("builderFeeBps");
        if ((p.builder == address(0)) != (p.builderFeeBps == 0)) revert InvalidParams("builder");
        if (p.sniperFeeBps > MAX_SNIPER_FEE_BPS) revert InvalidParams("sniperFeeBps");
        if (p.snipeSeconds > MAX_SNIPE_SECONDS) revert InvalidParams("snipeSeconds");
        if (p.maxBuyBps < MIN_MAX_BUY_BPS || p.maxBuyBps > BPS) revert InvalidParams("maxBuyBps");
    }

    function _key(address token, address quote, bool quoteIs0) internal view returns (PoolKey memory) {
        (address c0, address c1) = quoteIs0 ? (quote, token) : (token, quote);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    // ------------------------------------------------------------- claims

    /// @notice Claim all native HYPE accrued to `msg.sender`.
    function claim() external nonReentrant returns (uint256) {
        return _claim(NATIVE);
    }

    /// @notice Claim all of `quote` accrued to `msg.sender`.
    function claim(address quote) external nonReentrant returns (uint256) {
        return _claim(quote);
    }

    function _claim(address quote) internal returns (uint256 amount) {
        amount = accruedOf[quote][msg.sender];
        if (amount == 0) revert NothingToClaim();
        accruedOf[quote][msg.sender] = 0;
        poolManager.unlock(abi.encode(Action.Claim, abi.encode(msg.sender, quote, amount)));
        emit Claimed(msg.sender, quote, amount);
    }

    /// @notice Propose a new fee recipient for a token. Only the current
    /// recipient can; the new one must accept. Fees already accrued stay with
    /// the previous recipient.
    function setFeeRecipient(address token, address next) external {
        PoolId id = poolOf[token];
        PoolConfig storage c = pools[id];
        if (c.token == address(0)) revert UnknownPool();
        if (msg.sender != c.feeRecipient) revert NotFeeRecipient();
        if (next == address(0)) revert InvalidParams("feeRecipient");
        pendingFeeRecipient[id] = next;
        emit FeeRecipientProposed(id, next);
    }

    /// @notice Accept a proposed fee-recipient handover.
    function acceptFeeRecipient(address token) external {
        PoolId id = poolOf[token];
        PoolConfig storage c = pools[id];
        if (c.token == address(0)) revert UnknownPool();
        if (msg.sender != pendingFeeRecipient[id]) revert NotFeeRecipient();
        emit FeeRecipientChanged(id, c.feeRecipient, msg.sender);
        c.feeRecipient = msg.sender;
        delete pendingFeeRecipient[id];
    }

    // ------------------------------------------------------------- unlock

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Action action, bytes memory args) = abi.decode(data, (Action, bytes));
        if (action == Action.Launch) {
            (PoolKey memory key, int24 startTick, uint256 devBuy, address buyer) =
                abi.decode(args, (PoolKey, int24, uint256, address));
            return abi.encode(_launchInUnlock(key, startTick, devBuy, buyer));
        }
        (address recipient, address quote, uint256 amount) = abi.decode(args, (address, address, uint256));
        Currency c = Currency.wrap(quote);
        poolManager.burn(address(this), c.toId(), amount);
        poolManager.take(c, recipient, amount);
        return "";
    }

    function _launchInUnlock(PoolKey memory key, int24 startTick, uint256 devBuy, address buyer)
        internal
        returns (uint256 devBuyTokens)
    {
        PoolId id = key.toId();
        PoolConfig storage c = pools[id];
        bool q0 = c.quoteIs0;
        Currency tokenC = Currency.wrap(c.token);
        Currency quoteC = Currency.wrap(c.quote);

        // 1. Entire supply as one one-sided position on the token side of the price.
        (int24 lower, int24 upper, uint256 liquidity) = LaunchMath.position(q0, startTick);
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(uint256(SafeCast.toUint128(liquidity))),
                salt: bytes32(0)
            }),
            ""
        );
        uint256 owed = uint256(uint128(-(q0 ? added.amount1() : added.amount0())));
        poolManager.sync(tokenC);
        ERC20(c.token).safeTransfer(address(poolManager), owed);
        poolManager.settle();
        // Rounding dust that did not fit the position is burned.
        uint256 dust = ERC20(c.token).balanceOf(address(this));
        if (dust > 0) ERC20(c.token).safeTransfer(DEAD, dust);

        // 2. Declared dev buy at the starting price. Hooks are skipped for
        // swaps this contract makes, so the fee and cap are applied here.
        if (devBuy == 0) return 0;
        (uint256 baseFee, uint256 builderFee,) = _fees(c, true, devBuy, true);
        uint256 fee = baseFee + builderFee;
        BalanceDelta swapped = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: q0,
                amountSpecified: -int256(devBuy - fee),
                sqrtPriceLimitX96: q0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 quoteDelta, int128 tokenDelta) =
            q0 ? (swapped.amount0(), swapped.amount1()) : (swapped.amount1(), swapped.amount0());
        devBuyTokens = uint256(uint128(tokenDelta));
        uint256 maxTokens = SUPPLY * MAX_DEV_BUY_BPS / BPS;
        if (devBuyTokens > maxTokens) revert DevBuyTooLarge(devBuyTokens, maxTokens);

        uint256 spent = uint256(uint128(-quoteDelta));
        if (quoteC.isAddressZero()) {
            poolManager.settle{value: devBuy}();
        } else {
            poolManager.sync(quoteC);
            quoteC.transfer(address(poolManager), devBuy);
            poolManager.settle();
        }
        poolManager.mint(address(this), quoteC.toId(), fee);
        poolManager.take(tokenC, buyer, devBuyTokens);
        uint256 refund = devBuy - fee - spent;
        if (refund > 0) poolManager.take(quoteC, buyer, refund);
        _accrue(id, c, true, baseFee, builderFee, 0);
    }

    // ------------------------------------------------------------- fees

    /// @dev Fee rates as a share of the gross quote amount, in WAD (1e18 = 100%).
    function _rates(PoolConfig storage c, bool buy)
        internal
        view
        returns (uint256 baseRate, uint256 builderRate, uint256 sniperRate)
    {
        baseRate = uint256(c.feeBps) * (WAD / BPS);
        builderRate = uint256(c.builderFeeBps) * (WAD / BPS);
        if (buy && c.sniperFeeBps > 0) {
            uint256 elapsed = block.timestamp - c.launchedAt;
            if (elapsed < c.snipeSeconds) {
                sniperRate = uint256(c.sniperFeeBps) * (WAD / BPS) * (c.snipeSeconds - elapsed) / c.snipeSeconds;
            }
        }
    }

    /// @dev Fees on a swap's quote side, always as a share of the gross amount
    /// (what the buyer pays, or what the pool pays out to a seller).
    /// `gross` says whether `amount` is that gross amount (exact-input swaps)
    /// or the net amount the fee is added to (exact-output swaps).
    function _fees(PoolConfig storage c, bool buy, uint256 amount, bool gross)
        internal
        view
        returns (uint256 baseFee, uint256 builderFee, uint256 sniperFee)
    {
        (uint256 baseRate, uint256 builderRate, uint256 sniperRate) = _rates(c, buy);
        uint256 denom = gross ? WAD : WAD - baseRate - builderRate - sniperRate;
        baseFee = FullMath.mulDiv(amount, baseRate, denom);
        builderFee = FullMath.mulDiv(amount, builderRate, denom);
        sniperFee = FullMath.mulDiv(amount, sniperRate, denom);
    }

    function _accrue(PoolId id, PoolConfig storage c, bool buy, uint256 baseFee, uint256 builderFee, uint256 sniperFee)
        internal
    {
        uint256 creator = baseFee * creatorShareBps / BPS;
        accruedOf[c.quote][c.feeRecipient] += creator;
        accruedOf[c.quote][protocolRecipient] += baseFee - creator + sniperFee;
        if (builderFee > 0) accruedOf[c.quote][c.builder] += builderFee;
        emit FeesTaken(id, buy, baseFee, builderFee, sniperFee);
    }

    /// @dev Take the fee from the swap's quote side as ERC-6909 claims.
    function _take(address sender, PoolId id, PoolConfig storage c, bool buy, uint256 amount, bool gross)
        internal
        returns (uint256 total)
    {
        (uint256 baseFee, uint256 builderFee, uint256 sniperFee) = _fees(c, buy, amount, gross);
        total = baseFee + builderFee + sniperFee;
        if (total == 0) return 0;
        poolManager.mint(address(this), Currency.wrap(c.quote).toId(), total);
        _accrue(id, c, buy, baseFee, builderFee, sniperFee);
        uint128 t = uint128(total);
        (uint128 f0, uint128 f1) = c.quoteIs0 ? (t, uint128(0)) : (uint128(0), t);
        emit HookSwap(PoolId.unwrap(id), sender, int128(f0), int128(f1), f0, f1);
        emit HookFee(PoolId.unwrap(id), sender, f0, f1);
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

    /// @dev The quote is the specified currency for exact-input buys and
    /// exact-output sells: the fee is taken here, from the specified amount,
    /// and remembered so afterSwap can reject partial fills.
    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender == protocolRecipient) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        PoolId id = key.toId();
        PoolConfig storage c = pools[id];
        bool buy = params.zeroForOne == c.quoteIs0;
        bool exactIn = params.amountSpecified < 0;
        if (buy != exactIn) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        uint256 amount = uint256(exactIn ? -params.amountSpecified : params.amountSpecified);
        uint256 total = _take(sender, id, c, buy, amount, exactIn);
        _tset(T_FEE, id, total);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(total)), 0), 0);
    }

    /// @dev Rejects partial fills of quote-specified swaps, enforces the
    /// snipe-window buy cap per transaction, and takes the fee when the quote
    /// is the unspecified currency (exact-input sells, exact-output buys).
    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        if (sender == protocolRecipient) return (IHooks.afterSwap.selector, 0);
        PoolId id = key.toId();
        PoolConfig storage c = pools[id];
        bool q0 = c.quoteIs0;
        bool buy = params.zeroForOne == q0;
        bool exactIn = params.amountSpecified < 0;
        (int128 quoteDelta, int128 tokenDelta) =
            q0 ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());

        if (buy && c.maxBuyBps < BPS && block.timestamp - c.launchedAt < c.snipeSeconds) {
            uint256 bought = _tget(T_BOUGHT, id) + uint256(uint128(tokenDelta));
            uint256 maxTokens = SUPPLY * c.maxBuyBps / BPS;
            if (bought > maxTokens) revert MaxBuyExceeded(bought, maxTokens);
            _tset(T_BOUGHT, id, bought);
        }

        if (buy == exactIn) {
            // Fee was taken in beforeSwap from the full specified amount:
            // the pool must have swapped all of the rest.
            uint256 fee = _tget(T_FEE, id);
            _tset(T_FEE, id, 0);
            // exact-in buy: -(gross - fee); exact-out sell: +(net + fee). Both are specified + fee.
            if (int256(quoteDelta) != params.amountSpecified + int256(fee)) revert PartialFill();
            return (IHooks.afterSwap.selector, 0);
        }

        uint256 amount = uint256(uint128(quoteDelta < 0 ? -quoteDelta : quoteDelta));
        uint256 total = _take(sender, id, c, buy, amount, exactIn);
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

    /// @notice The current total fee on a buy or a sell, in basis points
    /// (trading fee, builder add-on and any sniper surcharge).
    function currentFeeBps(address token, bool buy) external view returns (uint256) {
        PoolConfig storage c = pools[poolOf[token]];
        if (c.token != token || token == address(0)) revert UnknownPool();
        (uint256 a, uint256 b, uint256 d) = _rates(c, buy);
        return (a + b + d) / (WAD / BPS);
    }

    /// @notice Native HYPE claimable by `account`.
    function accrued(address account) external view returns (uint256) {
        return accruedOf[NATIVE][account];
    }

    /// @notice The pool key of a Mesa token.
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        PoolConfig storage c = pools[poolOf[token]];
        if (c.token != token || token == address(0)) revert UnknownPool();
        return _key(token, c.quote, c.quoteIs0);
    }

    /// @notice The fees a trade of `amount` gross quote (what a buyer pays in,
    /// or what the pool pays a seller before fees) would pay right now, and
    /// where they would go. `builderFee` goes to the launch's builder.
    function previewFees(address token, uint256 amount, bool buy)
        external
        view
        returns (uint256 baseFee, uint256 builderFee, uint256 sniperFee, uint256 toCreator, uint256 toProtocol)
    {
        PoolConfig storage c = pools[poolOf[token]];
        if (c.token != token || token == address(0)) revert UnknownPool();
        (baseFee, builderFee, sniperFee) = _fees(c, buy, amount, true);
        toCreator = baseFee * creatorShareBps / BPS;
        toProtocol = baseFee - toCreator + sniperFee;
    }
}
