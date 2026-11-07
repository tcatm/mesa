pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Shielded HYPE: spend one note, take some HYPE out, keep the rest as a new note.
//
// A note is a leaf of the pool's Merkle tree:
//
//     precommitment = Poseidon(nullifier, secret)      // the depositor chooses this
//     leaf          = Poseidon(precommitment, value)   // the pool computes this on chain
//
// so the pool, not the depositor, binds the value to the note. Spending a note
// reveals Poseidon(nullifier), once; the pool records it so the note can never
// be spent twice. Nothing ties the spend to the deposit it came from.
//
// Public inputs (in this order, as the verifier takes them):
//   root           a recent root of the pool's tree
//   nullifierHash  Poseidon(nullifier) of the spent note
//   withdrawn      HYPE (wei) leaving the pool
//   newLeaf        the change note's leaf, inserted by the pool; 0 if none
//   context        keccak256 of everything the transaction does with the HYPE
//                  (recipient, relayer, fee, callback data), reduced mod p.
//                  Bound here so no one can reuse the proof with other terms.

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    component muxes[depth];
    signal levels[depth + 1];
    levels[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxes[i] = MultiMux1(2);
        muxes[i].c[0][0] <== levels[i];
        muxes[i].c[0][1] <== pathElements[i];
        muxes[i].c[1][0] <== pathElements[i];
        muxes[i].c[1][1] <== levels[i];
        muxes[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxes[i].out[0];
        hashers[i].inputs[1] <== muxes[i].out[1];
        levels[i + 1] <== hashers[i].out;
    }
    root <== levels[depth];
}

template Withdraw(depth) {
    // public
    signal input root;
    signal input nullifierHash;
    signal input withdrawn;
    signal input newLeaf;
    signal input context;

    // private: the note being spent
    signal input value;
    signal input nullifier;
    signal input secret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // private: the change note
    signal input newValue;
    signal input newNullifier;
    signal input newSecret;

    // The spent note is in the tree.
    component pre = Poseidon(2);
    pre.inputs[0] <== nullifier;
    pre.inputs[1] <== secret;
    component leaf = Poseidon(2);
    leaf.inputs[0] <== pre.out;
    leaf.inputs[1] <== value;

    component tree = MerkleProof(depth);
    tree.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // Its nullifier is revealed, hashed.
    component nh = Poseidon(1);
    nh.inputs[0] <== nullifier;
    nh.out === nullifierHash;

    // Value is conserved, with no wraparound: both parts fit in 128 bits, and
    // the pool only ever creates notes of less than 2^128 wei.
    component wBits = Num2Bits(128);
    wBits.in <== withdrawn;
    component cBits = Num2Bits(128);
    cBits.in <== newValue;
    value === withdrawn + newValue;

    // The change note. With nothing left, the leaf must be 0 (no note is made).
    component newPre = Poseidon(2);
    newPre.inputs[0] <== newNullifier;
    newPre.inputs[1] <== newSecret;
    component newLeafHash = Poseidon(2);
    newLeafHash.inputs[0] <== newPre.out;
    newLeafHash.inputs[1] <== newValue;

    component empty = IsZeroValue();
    empty.in <== newValue;
    // newLeaf = empty ? 0 : hash
    newLeaf === newLeafHash.out * (1 - empty.out);

    // Bind the context into the proof.
    signal contextSquared;
    contextSquared <== context * context;
}

template IsZeroValue() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in != 0 ? 1 / in : 0;
    out <== 1 - in * inv;
    in * out === 0;
}

component main {public [root, nullifierHash, withdrawn, newLeaf, context]} = Withdraw(20);
