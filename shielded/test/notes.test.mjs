import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD, DEPTH, Tree, hash, newNote, leafOf, precommitment, nullifierHashOf,
  encodeNote, decodeNote, context,
} from "../src/notes.mjs";

// The root of an empty depth-20 tree, as ShieldedPool's constructor computes it.
const EMPTY_ROOT = 15019797232609675441998260052101280400536945603062888308240081994073687793470n;

test("Poseidon(1, 2) matches circomlib and PoseidonT3.sol", async () => {
  assert.equal(await hash(1, 2), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
});

test("empty tree root matches the contract", async () => {
  const t = await Tree.create();
  assert.equal(t.root(), EMPTY_ROOT);
});

test("a leaf's path hashes back to the root", async () => {
  const notes = [newNote(1n), newNote(2n), newNote(3n), newNote(4n), newNote(5n)];
  const leaves = await Promise.all(notes.map(leafOf));
  const t = await Tree.create(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const { pathElements, pathIndices } = t.path(i);
    let node = leaves[i];
    for (let level = 0; level < DEPTH; level++) {
      node = pathIndices[level] ? await hash(pathElements[level], node) : await hash(node, pathElements[level]);
    }
    assert.equal(node, t.root(), `leaf ${i}`);
  }
});

test("inserting one by one gives the same root as building at once", async () => {
  const leaves = [11n, 22n, 33n];
  const a = await Tree.create(leaves);
  const b = await Tree.create();
  for (const l of leaves) await b.insert(l);
  assert.equal(a.root(), b.root());
});

test("leaf = Poseidon(Poseidon(nullifier, secret), value)", async () => {
  const n = newNote(42n);
  assert.equal(await leafOf(n), await hash(await hash(n.nullifier, n.secret), 42n));
  assert.equal(await precommitment(n), await hash(n.nullifier, n.secret));
  assert.equal(await nullifierHashOf(n), await hash(n.nullifier));
});

test("notes round-trip through their string form", () => {
  const n = newNote(123456789n);
  const s = encodeNote(n, 7);
  assert.match(s, /^mesa-note-v1-/);
  const { note, leafIndex } = decodeNote(s);
  assert.deepEqual(note, n);
  assert.equal(leafIndex, 7);
  assert.throws(() => decodeNote("mesa-note-v0-xyz"));
});

test("note values must fit the circuit's 128-bit range", () => {
  assert.throws(() => newNote(0n));
  assert.throws(() => newNote(1n << 128n));
  assert.ok(newNote((1n << 128n) - 1n));
});

test("context is in the field and changes with every term", () => {
  const base = {
    chainId: 99901,
    pool: "0x2e234DAe75C793f67A35089C9d99245E1C58470b",
    recipient: "0x1111111111111111111111111111111111111111",
    relayer: "0x2222222222222222222222222222222222222222",
    fee: 10n ** 16n,
    data: "0x",
  };
  const c = context(base);
  assert.ok(c < FIELD);
  for (const [k, v] of Object.entries({
    chainId: 31337,
    recipient: "0x3333333333333333333333333333333333333333",
    relayer: "0x0000000000000000000000000000000000000000",
    fee: 0n,
    data: "0x01",
  })) {
    assert.notEqual(context({ ...base, [k]: v }), c, k);
  }
});
