// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

interface IMesaHookForPayout {
    function claim() external returns (uint256);
    function accrued(address account) external view returns (uint256);
    function poolKeyOf(address token) external view returns (PoolKey memory);
    function poolManager() external view returns (IPoolManager);
}

interface IRewardToken {
    function distribute() external payable;
    function eligibleSupply() external view returns (uint256);
}

/// @title MesaPayout
/// @notice Where one Mesa token's creator fees go when the creator splits them.
/// It is the token's fee recipient in MesaHook and splits every HYPE it
/// collects, at shares fixed at launch, between:
///  - up to five payout wallets, which claim their share;
///  - the token's holders (a MesaRewardToken), sent at most every 10 minutes;
///  - buying the token back in its own pool and burning it, in chunks of at
///    most 0.25 HYPE, at most every 10 minutes.
///
/// Anyone can call `collect`, `distribute` and `buyback`: none of them lets
/// the caller choose where any HYPE goes. Buybacks are kept small so that a
/// sandwich around one costs more in the pool's fee (paid twice, on at least
/// 1%) than it can make. This contract never runs inside a swap and only ever
/// holds this one token's fees: nothing in it can reach any pool's liquidity
/// or another token's fees.
contract MesaPayout is IUnlockCallback {
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 5;
    uint256 public constant ROUND = 10 minutes;
    uint256 public constant MIN_ROUND = 0.01 ether;
    uint256 public constant MAX_BUYBACK = 0.25 ether;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IMesaHookForPayout public immutable hook;
    IPoolManager public immutable poolManager;
    address public immutable token;
    uint16 public immutable holdersBps;
    uint16 public immutable buybackBps;

    address[] internal _recipients;
    uint16[] internal _recipientBps;
    mapping(address => address) public pendingRecipient;

    /// @notice HYPE owed to each payout wallet.
    mapping(address => uint256) public owedOf;
    uint256 public holdersPot;
    uint256 public buybackPot;
    uint64 public lastDistribution;
    uint64 public lastBuyback;
    bool internal _collecting;

    event Collected(uint256 amount, uint256 toRecipients, uint256 toHolders, uint256 toBuyback);
    event Paid(address indexed recipient, uint256 amount);
    event HoldersPaid(uint256 amount);
    event BoughtBack(uint256 hypeIn, uint256 tokensBurned);
    event RecipientProposed(address indexed current, address indexed next);
    event RecipientChanged(address indexed previous, address indexed next);

    error InvalidSplit();
    error NotYet();
    error NothingToDo();
    error NotRecipient();
    error NotPoolManager();
    error TransferFailed();

    constructor(
        address hook_,
        address token_,
        address[] memory recipients_,
        uint16[] memory recipientBps_,
        uint16 holdersBps_,
        uint16 buybackBps_
    ) {
        uint256 n = recipients_.length;
        if (n > MAX_RECIPIENTS || n != recipientBps_.length) revert InvalidSplit();
        uint256 sum = uint256(holdersBps_) + buybackBps_;
        for (uint256 i; i < n; ++i) {
            if (recipients_[i] == address(0) || recipientBps_[i] == 0) revert InvalidSplit();
            for (uint256 j; j < i; ++j) {
                if (recipients_[j] == recipients_[i]) revert InvalidSplit();
            }
            sum += recipientBps_[i];
        }
        if (sum != BPS) revert InvalidSplit();
        hook = IMesaHookForPayout(hook_);
        poolManager = IMesaHookForPayout(hook_).poolManager();
        token = token_;
        _recipients = recipients_;
        _recipientBps = recipientBps_;
        holdersBps = holdersBps_;
        buybackBps = buybackBps_;
    }

    /// @dev HYPE arrives from the PoolManager when this contract claims its fees.
    receive() external payable {
        if (!_collecting) revert TransferFailed();
    }

    /// @notice The payout wallets and their shares, in basis points of the creator fees.
    function recipients() external view returns (address[] memory, uint16[] memory) {
        return (_recipients, _recipientBps);
    }

    // ------------------------------------------------------------- collect

    /// @notice Pull this token's creator fees from MesaHook and split them.
    function collect() public returns (uint256 amount) {
        if (hook.accrued(address(this)) == 0) return 0;
        _collecting = true;
        amount = hook.claim();
        _collecting = false;
        uint256 toHolders = amount * holdersBps / BPS;
        uint256 toBuyback = amount * buybackBps / BPS;
        uint256 rest = amount - toHolders - toBuyback;
        uint256 n = _recipients.length;
        uint256 given;
        for (uint256 i; i < n; ++i) {
            // The last wallet takes the rounding remainder.
            uint256 share = i == n - 1 ? rest - given : amount * _recipientBps[i] / BPS;
            owedOf[_recipients[i]] += share;
            given += share;
        }
        // With no payout wallets, the rounding dust joins whichever pot is in use.
        if (n == 0) {
            if (holdersBps > 0) toHolders += rest;
            else toBuyback += rest;
        }
        holdersPot += toHolders;
        buybackPot += toBuyback;
        emit Collected(amount, given, toHolders, toBuyback);
    }

    /// @notice Claim the HYPE owed to `msg.sender` as a payout wallet.
    function claim() external returns (uint256 amount) {
        collect();
        amount = owedOf[msg.sender];
        if (amount == 0) revert NothingToDo();
        owedOf[msg.sender] = 0;
        _send(msg.sender, amount);
        emit Paid(msg.sender, amount);
    }

    // ------------------------------------------------------------- holders

    /// @notice Send the holders' pot to the token, shared among eligible holders.
    /// At most once per round, and only once the pot is worth sending.
    function distribute() external returns (uint256 amount) {
        collect();
        if (lastDistribution != 0 && block.timestamp < uint256(lastDistribution) + ROUND) revert NotYet();
        amount = holdersPot;
        if (amount < MIN_ROUND || IRewardToken(token).eligibleSupply() == 0) revert NothingToDo();
        holdersPot = 0;
        lastDistribution = uint64(block.timestamp);
        IRewardToken(token).distribute{value: amount}();
        emit HoldersPaid(amount);
    }

    // ------------------------------------------------------------- buyback

    /// @notice Buy the token with up to `MAX_BUYBACK` of the buyback pot and burn it.
    /// At most once per round.
    function buyback() external returns (uint256 hypeIn, uint256 burned) {
        collect();
        if (lastBuyback != 0 && block.timestamp < uint256(lastBuyback) + ROUND) revert NotYet();
        hypeIn = buybackPot < MAX_BUYBACK ? buybackPot : MAX_BUYBACK;
        if (hypeIn < MIN_ROUND) revert NothingToDo();
        buybackPot -= hypeIn;
        lastBuyback = uint64(block.timestamp);
        burned = abi.decode(poolManager.unlock(abi.encode(hypeIn)), (uint256));
        emit BoughtBack(hypeIn, burned);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 hypeIn = abi.decode(data, (uint256));
        PoolKey memory key = hook.poolKeyOf(token);
        // Native HYPE is currency0 of every pool it is in.
        BalanceDelta d = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(hypeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        poolManager.settle{value: uint256(uint128(-d.amount0()))}();
        uint256 out = uint256(uint128(d.amount1()));
        poolManager.take(key.currency1, DEAD, out);
        return abi.encode(out);
    }

    // ------------------------------------------------------------- recipients

    /// @notice A payout wallet proposes handing its share to `next`; `next` must accept.
    function proposeRecipient(address next) external {
        if (_indexOf(msg.sender) == type(uint256).max || next == address(0)) revert NotRecipient();
        pendingRecipient[msg.sender] = next;
        emit RecipientProposed(msg.sender, next);
    }

    /// @notice Accept a payout wallet's share proposed by `current`. HYPE already owed stays with `current`.
    function acceptRecipient(address current) external {
        uint256 i = _indexOf(current);
        if (
            i == type(uint256).max || pendingRecipient[current] != msg.sender
                || _indexOf(msg.sender) != type(uint256).max
        ) {
            revert NotRecipient();
        }
        delete pendingRecipient[current];
        _recipients[i] = msg.sender;
        emit RecipientChanged(current, msg.sender);
    }

    function _indexOf(address a) internal view returns (uint256) {
        for (uint256 i; i < _recipients.length; ++i) {
            if (_recipients[i] == a) return i;
        }
        return type(uint256).max;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
