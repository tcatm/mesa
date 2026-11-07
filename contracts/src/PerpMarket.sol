// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IShieldedReceiver} from "./ShieldedPool.sol";

/// @notice An index price, in HYPE per unit of the asset, scaled by 1e18.
interface IPriceOracle {
    function latest() external view returns (uint256 price, uint256 updatedAt);
}

interface IShieldedDeposit {
    function deposit(uint256 precommitment) external payable returns (uint32);
}

/// @title PerpMarket
/// @notice One HYPE-margined perpetual market (e.g. BTC priced in HYPE) whose
/// positions belong to keys, not wallets.
///
/// Privacy, stage 1: unlinkable ownership. A position's `owner` is a
/// one-time key. Margin arrives straight from the ShieldedPool (a withdraw
/// whose recipient is this market and whose data says what to open), every
/// later action is signed by the key and submitted by a relayer, and the
/// proceeds can go straight back into the pool as a new note. No wallet that
/// ever held public HYPE appears in the position's life. Sizes, prices and
/// margins are public; hiding them is stage 2 (docs/perps.md).
///
/// Counterparty: a liquidity vault in this contract takes the other side of
/// every trade. It earns trading fees, liquidation remainders and losing PnL,
/// and pays winning PnL. Funding moves with skew: while longs outweigh shorts,
/// longs pay shorts (through the vault), and the reverse.
///
/// Stage-1 limits, deliberate: isolated margin, market orders only, one oracle,
/// vault share price excludes open PnL, payouts capped at what the vault holds.
/// Unaudited and not deployed.
contract PerpMarket is IShieldedReceiver {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    // ------------------------------------------------------------- config

    IPriceOracle public immutable oracle;
    address public immutable shieldedPool;
    /// @notice Oldest oracle price accepted.
    uint256 public immutable maxPriceAge;
    uint256 public immutable maxLeverage; // e.g. 20 (x)
    uint256 public immutable maintenanceBps; // margin below this share of notional can be liquidated
    uint256 public immutable tradeFeeBps; // on notional, at open and close, to the vault
    uint256 public immutable liquidationFeeBps; // share of remaining margin to the liquidator
    uint256 public immutable oiCapBps; // open interest per side, as share of the vault
    /// @notice Funding per second at full skew (all OI on one side), WAD-scaled share of notional.
    uint256 public immutable fundingRatePerSecond;

    // ------------------------------------------------------------- state

    struct Position {
        address owner;
        bool isLong;
        uint256 size; // asset units, 1e18
        uint256 margin; // HYPE wei
        uint256 entryPrice; // HYPE per asset, 1e18
        int256 entryFunding; // cumulative funding index at open
    }

    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId = 1;
    mapping(address => uint256) public nonces;

    uint256 public longSize;
    uint256 public shortSize;
    /// @notice HYPE a long pays per unit of size since launch (shorts receive it), WAD.
    int256 public cumulativeFunding;
    uint256 public lastFundingAt;

    uint256 public vaultAssets;
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    uint256 private locked = 1;

    // ------------------------------------------------------------- EIP-712

    bytes32 public constant CLOSE_TYPEHASH = keccak256(
        "Close(uint256 positionId,uint256 acceptablePrice,address payoutTo,uint256 precommitment,address relayer,uint256 relayerFee,uint256 nonce,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ------------------------------------------------------------- events

    event Opened(
        uint256 indexed id,
        address indexed owner,
        bool isLong,
        uint256 size,
        uint256 margin,
        uint256 price,
        bool shielded
    );
    event Closed(uint256 indexed id, uint256 price, int256 pnl, uint256 payout, bool reshielded);
    event Liquidated(uint256 indexed id, uint256 price, address liquidator, uint256 reward);
    event LiquidityAdded(address indexed lp, uint256 assets, uint256 shares);
    event LiquidityRemoved(address indexed lp, uint256 assets, uint256 shares);

    // ------------------------------------------------------------- errors

    error NotPool();
    error ZeroSize();
    error TooMuchLeverage();
    error OpenInterestCap();
    error Slippage();
    error StalePrice();
    error NotOwner();
    error BadSignature();
    error Expired();
    error NotLiquidatable();
    error Liquidatable();
    error UnknownPosition();
    error InsufficientShares();
    error VaultCommitted();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    struct Config {
        IPriceOracle oracle;
        address shieldedPool;
        uint256 maxPriceAge;
        uint256 maxLeverage;
        uint256 maintenanceBps;
        uint256 tradeFeeBps;
        uint256 liquidationFeeBps;
        uint256 oiCapBps;
        uint256 fundingRatePerSecond;
    }

    constructor(Config memory c) {
        oracle = c.oracle;
        shieldedPool = c.shieldedPool;
        maxPriceAge = c.maxPriceAge;
        maxLeverage = c.maxLeverage;
        maintenanceBps = c.maintenanceBps;
        tradeFeeBps = c.tradeFeeBps;
        liquidationFeeBps = c.liquidationFeeBps;
        oiCapBps = c.oiCapBps;
        fundingRatePerSecond = c.fundingRatePerSecond;
        lastFundingAt = block.timestamp;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Mesa Perps"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ------------------------------------------------------------- opening

    /// @notice Open with public HYPE: `msg.value` is the margin plus the fee.
    function open(address owner, bool isLong, uint256 size, uint256 acceptablePrice)
        external
        payable
        nonReentrant
        returns (uint256)
    {
        return _open(owner, isLong, size, acceptablePrice, msg.value, false);
    }

    /// @notice Open with shielded HYPE: called by the ShieldedPool during a
    /// withdraw whose recipient is this market. The proof binds `data`, so no
    /// relayer can change what is opened or for whom.
    /// @param data abi.encode(address owner, bool isLong, uint256 size, uint256 acceptablePrice)
    function onShieldedWithdraw(bytes calldata data) external payable nonReentrant {
        if (msg.sender != shieldedPool) revert NotPool();
        (address owner, bool isLong, uint256 size, uint256 acceptablePrice) =
            abi.decode(data, (address, bool, uint256, uint256));
        _open(owner, isLong, size, acceptablePrice, msg.value, true);
    }

    function _open(address owner, bool isLong, uint256 size, uint256 acceptablePrice, uint256 paid, bool shielded)
        internal
        returns (uint256 id)
    {
        if (size == 0) revert ZeroSize();
        if (owner == address(0)) revert NotOwner();
        _accrueFunding();
        uint256 price = _price();
        if (isLong ? price > acceptablePrice : price < acceptablePrice) revert Slippage();

        uint256 notional = size * price / WAD;
        uint256 fee = notional * tradeFeeBps / BPS;
        if (paid <= fee) revert TooMuchLeverage();
        uint256 margin = paid - fee;
        if (notional > margin * maxLeverage) revert TooMuchLeverage();
        if (notional * BPS / margin >= BPS * BPS / maintenanceBps) revert Liquidatable();

        uint256 sideSize = (isLong ? longSize : shortSize) + size;
        if (sideSize * price / WAD > vaultAssets * oiCapBps / BPS) revert OpenInterestCap();
        if (isLong) longSize = sideSize;
        else shortSize = sideSize;

        vaultAssets += fee;
        id = nextPositionId++;
        positions[id] = Position(owner, isLong, size, margin, price, cumulativeFunding);
        emit Opened(id, owner, isLong, size, margin, price, shielded);
    }

    // ------------------------------------------------------------- closing

    struct Payout {
        address to; // public payout, used when precommitment is 0
        uint256 precommitment; // otherwise: reshield into a new note with this precommitment
    }

    /// @notice Close your own position.
    function close(uint256 id, uint256 acceptablePrice, Payout calldata payout) external nonReentrant {
        if (positions[id].owner != msg.sender) revert NotOwner();
        _close(id, acceptablePrice, payout, address(0), 0);
    }

    /// @notice Close for the position's key, which signed the terms. The
    /// relayer (anyone) pays the gas and takes `relayerFee` from the proceeds.
    function closeWithSig(
        uint256 id,
        uint256 acceptablePrice,
        Payout calldata payout,
        address relayer,
        uint256 relayerFee,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        address owner = positions[id].owner;
        if (owner == address(0)) revert UnknownPosition();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        CLOSE_TYPEHASH,
                        id,
                        acceptablePrice,
                        payout.to,
                        payout.precommitment,
                        relayer,
                        relayerFee,
                        nonces[owner]++,
                        deadline
                    )
                )
            )
        );
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert BadSignature();
        _close(id, acceptablePrice, payout, relayer, relayerFee);
    }

    function _close(uint256 id, uint256 acceptablePrice, Payout calldata payout, address relayer, uint256 relayerFee)
        internal
    {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        _accrueFunding();
        uint256 price = _price();
        if (p.isLong ? price < acceptablePrice : price > acceptablePrice) revert Slippage();
        if (_isLiquidatable(p, price)) revert Liquidatable();

        int256 pnl = _pnl(p, price) - _funding(p);
        uint256 fee = p.size * price / WAD * tradeFeeBps / BPS;
        int256 equity = int256(p.margin) + pnl - int256(fee);
        uint256 payoutAmount = equity > 0 ? uint256(equity) : 0;

        // The vault takes the margin and fee and pays the equity, but never
        // more than it holds: a payout beyond the vault is capped (stage 1).
        uint256 inflow = p.margin;
        uint256 available = vaultAssets + inflow;
        if (payoutAmount > available) payoutAmount = available;
        vaultAssets = available - payoutAmount;

        _removeSize(p);
        delete positions[id];
        bool reshield = payout.precommitment != 0;
        emit Closed(id, price, pnl, payoutAmount, reshield);

        if (relayerFee > payoutAmount) relayerFee = payoutAmount;
        uint256 rest = payoutAmount - relayerFee;
        if (rest > 0) {
            if (reshield) IShieldedDeposit(shieldedPool).deposit{value: rest}(payout.precommitment);
            else _send(payout.to, rest);
        }
        if (relayerFee > 0) _send(relayer, relayerFee);
    }

    // ------------------------------------------------------------- liquidation

    /// @notice Liquidate a position below maintenance margin. The caller gets
    /// `liquidationFeeBps` of what margin is left; the vault keeps the rest.
    function liquidate(uint256 id) external nonReentrant {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        _accrueFunding();
        uint256 price = _price();
        if (!_isLiquidatable(p, price)) revert NotLiquidatable();

        int256 equity = int256(p.margin) + _pnl(p, price) - _funding(p);
        uint256 left = equity > 0 ? uint256(equity) : 0;
        if (left > p.margin) left = p.margin;
        uint256 reward = left * liquidationFeeBps / BPS;
        vaultAssets += p.margin - reward;

        _removeSize(p);
        delete positions[id];
        emit Liquidated(id, price, msg.sender, reward);
        if (reward > 0) _send(msg.sender, reward);
    }

    // ------------------------------------------------------------- vault

    function addLiquidity() external payable nonReentrant returns (uint256 minted) {
        minted = totalShares == 0 ? msg.value : msg.value * totalShares / vaultAssets;
        totalShares += minted;
        shares[msg.sender] += minted;
        vaultAssets += msg.value;
        emit LiquidityAdded(msg.sender, msg.value, minted);
    }

    /// @notice Withdraw vault liquidity, as long as what stays still covers the
    /// open-interest cap of the larger side.
    function removeLiquidity(uint256 amount) external nonReentrant returns (uint256 assets) {
        if (shares[msg.sender] < amount) revert InsufficientShares();
        assets = amount * vaultAssets / totalShares;
        uint256 rest = vaultAssets - assets;
        uint256 price = _price();
        uint256 side = longSize > shortSize ? longSize : shortSize;
        if (side * price / WAD > rest * oiCapBps / BPS) revert VaultCommitted();
        shares[msg.sender] -= amount;
        totalShares -= amount;
        vaultAssets = rest;
        emit LiquidityRemoved(msg.sender, assets, amount);
        _send(msg.sender, assets);
    }

    // ------------------------------------------------------------- views

    function equityOf(uint256 id) external view returns (int256) {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert UnknownPosition();
        (uint256 price,) = oracle.latest();
        return int256(p.margin) + _pnl(p, price) - _fundingAt(p, _currentFunding());
    }

    function isLiquidatable(uint256 id) external view returns (bool) {
        Position memory p = positions[id];
        if (p.owner == address(0)) return false;
        (uint256 price,) = oracle.latest();
        int256 equity = int256(p.margin) + _pnl(p, price) - _fundingAt(p, _currentFunding());
        return equity < int256(p.size * price / WAD * maintenanceBps / BPS);
    }

    // ------------------------------------------------------------- internals

    function _price() internal view returns (uint256 price) {
        uint256 at;
        (price, at) = oracle.latest();
        if (price == 0 || block.timestamp - at > maxPriceAge) revert StalePrice();
    }

    function _pnl(Position memory p, uint256 price) internal pure returns (int256) {
        int256 move = int256(price) - int256(p.entryPrice);
        int256 pnl = move * int256(p.size) / int256(WAD);
        return p.isLong ? pnl : -pnl;
    }

    function _funding(Position memory p) internal view returns (int256) {
        return _fundingAt(p, cumulativeFunding);
    }

    /// @dev What the position owes in funding (negative: is owed).
    function _fundingAt(Position memory p, int256 index) internal pure returns (int256) {
        int256 owed = (index - p.entryFunding) * int256(p.size) / int256(WAD);
        return p.isLong ? owed : -owed;
    }

    function _isLiquidatable(Position memory p, uint256 price) internal view returns (bool) {
        int256 equity = int256(p.margin) + _pnl(p, price) - _funding(p);
        return equity < int256(p.size * price / WAD * maintenanceBps / BPS);
    }

    function _currentFunding() internal view returns (int256) {
        uint256 total = longSize + shortSize;
        if (total == 0 || block.timestamp == lastFundingAt) return cumulativeFunding;
        (uint256 price,) = oracle.latest();
        int256 skew = (int256(longSize) - int256(shortSize)) * int256(WAD) / int256(total);
        int256 rate = skew * int256(fundingRatePerSecond) / int256(WAD);
        return cumulativeFunding + rate * int256(block.timestamp - lastFundingAt) * int256(price) / int256(WAD);
    }

    function _accrueFunding() internal {
        cumulativeFunding = _currentFunding();
        lastFundingAt = block.timestamp;
    }

    function _removeSize(Position memory p) internal {
        if (p.isLong) longSize -= p.size;
        else shortSize -= p.size;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
