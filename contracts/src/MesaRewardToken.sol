// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title MesaRewardToken
/// @notice A Mesa token whose holders share HYPE rewards. Like MesaToken it
/// has a fixed supply minted once at creation, no owner, no mint, no burn,
/// no pause and no transfer tax. On top, it keeps the books for holder
/// rewards:
///  - A wallet earns while it holds at least `MIN_ELIGIBLE` tokens (0.1% of
///    supply), in proportion to its balance. At most 1,000 wallets can be
///    eligible at once.
///  - Contracts (pools, routers, the PoolManager, multisigs) and the dead
///    address never earn: their share goes to everyone else. Wallets whose
///    code is an EIP-7702 delegation are treated as wallets.
///  - Anyone can add HYPE with `distribute()`; it is shared at once among the
///    eligible balances. Holders take theirs with `claim()`, or anyone can
///    push it to them with `claimFor()`. Nothing is ever paid by looping
///    over holders, so gas stays flat however many there are.
/// Uses the standard "magnified dividend per share" accounting.
contract MesaRewardToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant MIN_ELIGIBLE = 1_000_000e18;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant MAGNITUDE = 2 ** 128;

    /// @notice HYPE per eligible token, scaled by 2^128.
    uint256 public rewardPerShare;
    /// @notice Sum of all eligible balances.
    uint256 public eligibleSupply;
    /// @notice HYPE distributed while no one was eligible, added to the next distribution.
    uint256 public pending;
    mapping(address => uint256) public eligibleBalanceOf;
    mapping(address => int256) internal corrections;
    mapping(address => uint256) public claimedOf;

    event Distributed(address indexed from, uint256 amount);
    event RewardClaimed(address indexed holder, uint256 amount);

    error TransferFailed();
    error NothingToClaim();

    constructor(string memory name_, string memory symbol_, address recipient) ERC20(name_, symbol_, 18) {
        _mint(recipient, TOTAL_SUPPLY);
        _sync(recipient);
    }

    // ------------------------------------------------------------- rewards

    /// @notice Share `msg.value` among current eligible holders.
    function distribute() external payable {
        uint256 amount = msg.value + pending;
        if (eligibleSupply == 0) {
            pending = amount;
        } else {
            pending = 0;
            rewardPerShare += amount * MAGNITUDE / eligibleSupply;
        }
        emit Distributed(msg.sender, msg.value);
    }

    /// @notice HYPE `holder` can claim now.
    function claimable(address holder) public view returns (uint256) {
        uint256 earned = uint256(int256(rewardPerShare * eligibleBalanceOf[holder]) + corrections[holder]) / MAGNITUDE;
        return earned - claimedOf[holder];
    }

    /// @notice Claim your rewards.
    function claim() external returns (uint256) {
        return _claim(msg.sender);
    }

    /// @notice Pay `holder` their rewards; anyone may call, the HYPE goes to `holder`.
    function claimFor(address holder) external returns (uint256) {
        return _claim(holder);
    }

    function _claim(address holder) internal returns (uint256 amount) {
        amount = claimable(holder);
        if (amount == 0) revert NothingToClaim();
        claimedOf[holder] += amount;
        (bool ok,) = holder.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit RewardClaimed(holder, amount);
    }

    // ------------------------------------------------------------- transfers

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        _sync(msg.sender);
        _sync(to);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        _sync(from);
        _sync(to);
        return true;
    }

    /// @notice Whether `account` can earn rewards at all (ignoring its balance).
    function canEarn(address account) public view returns (bool) {
        if (account == DEAD || account == address(0) || account == address(this)) return false;
        uint256 size = account.code.length;
        if (size == 0) return true;
        // An EIP-7702 delegated wallet: 0xef0100 followed by a 20-byte address.
        if (size != 23) return false;
        bytes memory head = new bytes(3);
        assembly ("memory-safe") {
            extcodecopy(account, add(head, 32), 0, 3)
        }
        return head[0] == 0xef && head[1] == 0x01 && head[2] == 0x00;
    }

    /// @dev Bring `account`'s eligible balance in line with its balance.
    function _sync(address account) internal {
        uint256 bal = balanceOf[account];
        uint256 next = bal >= MIN_ELIGIBLE && canEarn(account) ? bal : 0;
        uint256 prev = eligibleBalanceOf[account];
        if (next == prev) return;
        eligibleBalanceOf[account] = next;
        if (next > prev) {
            uint256 d = next - prev;
            eligibleSupply += d;
            corrections[account] -= int256(rewardPerShare * d);
        } else {
            uint256 d = prev - next;
            eligibleSupply -= d;
            corrections[account] += int256(rewardPerShare * d);
        }
    }
}
