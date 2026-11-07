// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoseidonT3} from "./PoseidonT3.sol";

interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[5] calldata pubSignals
    ) external view returns (bool);
}

/// @notice A contract that takes shielded HYPE with instructions, e.g. a perp
/// market opening a position for a key that has never touched the chain.
interface IShieldedReceiver {
    function onShieldedWithdraw(bytes calldata data) external payable;
}

/// @title ShieldedPool
/// @notice Shielded HYPE on Elysium. Deposit HYPE against a note only you
/// know; later, spend the note from any address to take some or all of the
/// HYPE out, with nothing on chain linking the two.
///
/// Notes are leaves of an append-only Merkle tree of depth 20 (1,048,576
/// notes), hashed with Poseidon:
///
///     precommitment = Poseidon(nullifier, secret)   chosen by the depositor
///     leaf          = Poseidon(precommitment, value) computed here, so the
///                     value in a note is always what was paid in
///
/// A withdraw proves (Groth16, circuits/withdraw.circom in shielded/) that the
/// caller knows a note under a recent root, reveals Poseidon(nullifier) so the
/// note cannot be spent twice, and may leave a change note worth the rest.
/// The proof is bound to the recipient, relayer, fee and callback data, so a
/// relayer can submit it for the user (who then needs no gas and no linked
/// address) but cannot redirect it.
///
/// Invariants:
///  - Every leaf's value was paid in (deposits) or split off a spent note
///    (change), so the pool always holds at least the sum of unspent notes.
///  - A nullifier hash is accepted once.
///  - Nothing can move HYPE out except a valid withdraw. The guardian can only
///    pause new deposits; it cannot pause withdrawals, touch funds or change
///    the verifier.
///
/// Unaudited, with a development trusted setup until the ceremony: deposits
/// are capped per transaction and in total.
contract ShieldedPool {
    // ------------------------------------------------------------- constants

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant DEPTH = 20;
    uint32 public constant ROOT_HISTORY = 64;
    /// @notice Notes hold less than 2^128 wei, as the circuit's range checks assume.
    uint256 public constant MAX_NOTE = type(uint128).max;

    // ------------------------------------------------------------- immutables

    IWithdrawVerifier public immutable verifier;
    /// @notice Largest single deposit, in wei.
    uint256 public immutable maxDeposit;
    /// @notice Most HYPE the pool takes in deposits overall while unaudited.
    uint256 public immutable maxTotalDeposits;
    /// @notice May pause and resume deposits. Nothing else.
    address public immutable guardian;

    // ------------------------------------------------------------- state

    uint256[DEPTH] internal filledSubtrees;
    uint256[DEPTH + 1] internal zeros;
    uint256[ROOT_HISTORY] public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    mapping(uint256 => bool) public spent;
    uint256 public totalDeposited;
    bool public depositsPaused;
    uint256 private locked = 1;

    // ------------------------------------------------------------- events

    event Inserted(uint256 indexed leaf, uint32 index, uint256 root);
    event Deposited(address indexed from, uint256 indexed precommitment, uint256 leaf, uint32 index, uint256 value);
    event Withdrawn(
        uint256 indexed nullifierHash, address indexed recipient, address relayer, uint256 withdrawn, uint256 fee
    );
    event DepositsPaused(bool paused);

    // ------------------------------------------------------------- errors

    error ZeroValue();
    error DepositTooLarge();
    error PoolFull();
    error CapReached();
    error Paused();
    error NotGuardian();
    error NotInField();
    error UnknownRoot();
    error AlreadySpent();
    error FeeTooHigh();
    error InvalidProof();
    error TransferFailed();
    error Reentrancy();

    struct Withdrawal {
        uint256 root;
        uint256 nullifierHash;
        uint256 withdrawn;
        uint256 newLeaf;
        address recipient;
        address relayer;
        uint256 fee;
        bytes data;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IWithdrawVerifier verifier_, uint256 maxDeposit_, uint256 maxTotalDeposits_, address guardian_) {
        verifier = verifier_;
        maxDeposit = maxDeposit_;
        maxTotalDeposits = maxTotalDeposits_;
        guardian = guardian_;

        uint256 z = 0;
        for (uint32 i = 0; i < DEPTH; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = PoseidonT3.hash([z, z]);
        }
        zeros[DEPTH] = z;
        roots[0] = z;
    }

    // ------------------------------------------------------------- deposit

    /// @notice Shield `msg.value` HYPE into a new note.
    /// @param precommitment Poseidon(nullifier, secret) of the note; keep both secret.
    function deposit(uint256 precommitment) external payable nonReentrant returns (uint32 index) {
        if (depositsPaused) revert Paused();
        if (msg.value == 0) revert ZeroValue();
        if (msg.value > maxDeposit) revert DepositTooLarge();
        if (precommitment >= FIELD) revert NotInField();
        uint256 total = totalDeposited + msg.value;
        if (total > maxTotalDeposits) revert CapReached();
        totalDeposited = total;

        uint256 leaf = PoseidonT3.hash([precommitment, msg.value]);
        index = _insert(leaf);
        emit Deposited(msg.sender, precommitment, leaf, index, msg.value);
    }

    // ------------------------------------------------------------- withdraw

    /// @notice Spend a note: `w.withdrawn` HYPE leaves the pool, `w.fee` of it to
    /// the relayer and the rest to the recipient (through `onShieldedWithdraw`
    /// when `w.data` is set); `w.newLeaf`, if not 0, is the change note.
    /// @param proof Groth16 proof as uint256[8]: pA, pB (snarkjs order), pC.
    function withdraw(Withdrawal calldata w, uint256[8] calldata proof) external nonReentrant {
        if (!isKnownRoot(w.root)) revert UnknownRoot();
        if (spent[w.nullifierHash]) revert AlreadySpent();
        if (w.fee > w.withdrawn) revert FeeTooHigh();
        if (w.recipient == address(0) && w.withdrawn > w.fee) revert TransferFailed();
        if (w.nullifierHash >= FIELD || w.newLeaf >= FIELD || w.withdrawn > MAX_NOTE) revert NotInField();

        uint256[5] memory pub = [w.root, w.nullifierHash, w.withdrawn, w.newLeaf, context(w)];
        bool ok = verifier.verifyProof(
            [proof[0], proof[1]], [[proof[2], proof[3]], [proof[4], proof[5]]], [proof[6], proof[7]], pub
        );
        if (!ok) revert InvalidProof();

        spent[w.nullifierHash] = true;
        if (w.newLeaf != 0) _insert(w.newLeaf);
        emit Withdrawn(w.nullifierHash, w.recipient, w.relayer, w.withdrawn, w.fee);

        uint256 out = w.withdrawn - w.fee;
        if (out > 0 || w.data.length > 0) {
            if (w.data.length > 0) {
                IShieldedReceiver(w.recipient).onShieldedWithdraw{value: out}(w.data);
            } else {
                _send(w.recipient, out);
            }
        }
        if (w.fee > 0) _send(w.relayer, w.fee);
    }

    /// @notice What a withdraw proof is bound to: keccak256 of this chain, this
    /// pool and the withdraw's terms, reduced into the field.
    function context(Withdrawal calldata w) public view returns (uint256) {
        return
            uint256(keccak256(abi.encode(block.chainid, address(this), w.recipient, w.relayer, w.fee, w.data))) % FIELD;
    }

    // ------------------------------------------------------------- guardian

    function setDepositsPaused(bool paused) external {
        if (msg.sender != guardian) revert NotGuardian();
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    // ------------------------------------------------------------- tree

    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// @notice Whether `root` is one of the last ROOT_HISTORY roots, so a proof
    /// made just before other notes landed still verifies.
    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        for (uint32 n = 0; n < ROOT_HISTORY; n++) {
            if (roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY - 1 : i - 1;
        }
        return false;
    }

    function zeroAt(uint256 level) external view returns (uint256) {
        return zeros[level];
    }

    function _insert(uint256 leaf) internal returns (uint32 index) {
        index = nextIndex;
        if (index == uint32(1) << DEPTH) revert PoolFull();
        uint32 i = index;
        uint256 node = leaf;
        for (uint32 level = 0; level < DEPTH; level++) {
            if (i & 1 == 0) {
                filledSubtrees[level] = node;
                node = PoseidonT3.hash([node, zeros[level]]);
            } else {
                node = PoseidonT3.hash([filledSubtrees[level], node]);
            }
            i >>= 1;
        }
        uint32 r = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = r;
        roots[r] = node;
        nextIndex = index + 1;
        emit Inserted(leaf, index, node);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
