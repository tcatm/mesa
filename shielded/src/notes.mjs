// Shielded HYPE notes, the pool's Merkle tree, and withdraw proofs.
//
// A note is everything needed to spend shielded HYPE later:
//   { value, nullifier, secret }  (value in wei; nullifier and secret random field elements)
// Lose it and the HYPE is gone; leak it and anyone can spend it.

import { randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { encodeAbiParameters, keccak256 } from "viem";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DEPTH = 20;
export const MAX_VALUE = (1n << 128n) - 1n;

let poseidonP = null;
async function poseidon() {
  poseidonP ??= buildPoseidon();
  return poseidonP;
}

/** Poseidon over field elements, as a bigint. */
export async function hash(...xs) {
  const p = await poseidon();
  return p.F.toObject(p(xs.map((x) => BigInt(x))));
}

const randomField = () => BigInt("0x" + randomBytes(31).toString("hex")); // 248 bits < p

/** A fresh note for `value` wei. */
export function newNote(value) {
  value = BigInt(value);
  if (value <= 0n || value > MAX_VALUE) throw new Error("note value out of range");
  return { value, nullifier: randomField(), secret: randomField() };
}

/** What the depositor sends to `deposit`: Poseidon(nullifier, secret). */
export const precommitment = (n) => hash(n.nullifier, n.secret);
/** The tree leaf the pool computes: Poseidon(precommitment, value). */
export const leafOf = async (n) => hash(await precommitment(n), n.value);
/** What a spend reveals: Poseidon(nullifier). */
export const nullifierHashOf = (n) => hash(n.nullifier);

/** Serialise a note as one string the user keeps (e.g. "mesa-note-v1-…"). */
export function encodeNote(n, leafIndex) {
  const hex = (x, w = 64) => x.toString(16).padStart(w, "0");
  return `mesa-note-v1-${hex(n.value, 32)}${hex(n.nullifier)}${hex(n.secret)}${leafIndex === undefined ? "" : "-" + leafIndex}`;
}

export function decodeNote(s) {
  const m = /^mesa-note-v1-([0-9a-f]{32})([0-9a-f]{64})([0-9a-f]{64})(?:-(\d+))?$/.exec(s.trim());
  if (!m) throw new Error("not a Mesa note");
  return {
    note: { value: BigInt("0x" + m[1]), nullifier: BigInt("0x" + m[2]), secret: BigInt("0x" + m[3]) },
    leafIndex: m[4] === undefined ? undefined : Number(m[4]),
  };
}

/**
 * The pool's incremental Merkle tree, rebuilt from its leaves (in insertion
 * order, e.g. from the pool's Inserted events). Empty leaves are 0 and each
 * empty subtree's root is the hash of two empty children, as on chain.
 */
export class Tree {
  static async create(leaves = []) {
    const t = new Tree();
    t.zeros = [0n];
    for (let i = 0; i < DEPTH; i++) t.zeros.push(await hash(t.zeros[i], t.zeros[i]));
    t.layers = [leaves.map(BigInt)];
    await t.rebuild();
    return t;
  }

  async rebuild() {
    for (let level = 0; level < DEPTH; level++) {
      const cur = this.layers[level];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(await hash(cur[i], i + 1 < cur.length ? cur[i + 1] : this.zeros[level]));
      }
      this.layers[level + 1] = next;
    }
  }

  async insert(leaf) {
    this.layers[0].push(BigInt(leaf));
    await this.rebuild();
    return this.layers[0].length - 1;
  }

  root() {
    return this.layers[DEPTH][0] ?? this.zeros[DEPTH];
  }

  path(index) {
    const pathElements = [];
    const pathIndices = [];
    for (let level = 0; level < DEPTH; level++) {
      const sibling = index ^ 1;
      pathElements.push(this.layers[level][sibling] ?? this.zeros[level]);
      pathIndices.push(index & 1);
      index >>= 1;
    }
    return { pathElements, pathIndices };
  }
}

/**
 * The context a withdraw proof is bound to. Must match ShieldedPool.context():
 * keccak256(abi.encode(chainId, pool, recipient, relayer, fee, data)) mod p.
 */
export function context({ chainId, pool, recipient, relayer, fee, data = "0x" }) {
  const enc = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes" },
    ],
    [BigInt(chainId), pool, recipient, relayer, BigInt(fee), data],
  );
  return BigInt(keccak256(enc)) % FIELD;
}

/**
 * Prove a withdraw of `withdrawn` wei from `note` (at `leafIndex` in `tree`).
 * Whatever is left becomes `change`, a new note, unless nothing is left.
 * Returns the proof as the contract takes it, the public signals, and the change note.
 */
export async function proveWithdraw({ note, leafIndex, tree, withdrawn, ctx, wasm, zkey }) {
  withdrawn = BigInt(withdrawn);
  if (withdrawn > note.value) throw new Error("withdrawing more than the note holds");
  const rest = note.value - withdrawn;
  const change = rest > 0n ? newNote(rest) : { value: 0n, nullifier: 0n, secret: 0n };
  const newLeaf = rest > 0n ? await leafOf(change) : 0n;
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const input = {
    root: tree.root(),
    nullifierHash: await nullifierHashOf(note),
    withdrawn,
    newLeaf,
    context: ctx,
    value: note.value,
    nullifier: note.nullifier,
    secret: note.secret,
    pathElements,
    pathIndices,
    newValue: change.value,
    newNullifier: change.nullifier,
    newSecret: change.secret,
  };
  const str = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str(input), wasm, zkey);
  return { proof: solidityProof(proof), publicSignals: publicSignals.map(BigInt), change: rest > 0n ? change : null };
}

/** snarkjs proof -> uint256[8] as the Groth16 verifier takes it (pB coordinates swapped). */
export function solidityProof(p) {
  return [
    p.pi_a[0], p.pi_a[1],
    p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0],
    p.pi_c[0], p.pi_c[1],
  ].map(BigInt);
}
