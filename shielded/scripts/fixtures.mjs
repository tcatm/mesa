// Real notes and proofs for the contract tests (contracts/test/fixtures/shielded.json).
//
// The tests deploy, from forge's default test contract, in this order:
//   nonce 1: WithdrawVerifier, 2: ShieldedPool, 3: MockOracle, 4: PerpMarket
// on chain 31337. Proofs are bound to those addresses through the context.
// Rerun after ./scripts/build.sh (new keys mean new proofs).
import { mkdirSync, writeFileSync } from "node:fs";
import { getContractAddress, encodeAbiParameters, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Tree, newNote, precommitment, leafOf, context, proveWithdraw, hash } from "../src/notes.mjs";

const wasm = "build/withdraw_js/withdraw.wasm";
const zkey = "build/withdraw.zkey";
const chainId = 31337;
const deployer = "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496";
const at = (nonce) => getContractAddress({ from: deployer, nonce: BigInt(nonce) });
const pool = at(2);
const market = at(4);

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const RELAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT2 = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
// The perp position's one-time key (tests sign with it via vm.sign).
const OWNER_KEY = "0x00000000000000000000000000000000000000000000000000000000000a11ce";
const owner = privateKeyToAccount(OWNER_KEY).address;

const tree = await Tree.create();
const emptyRoot = tree.root();
const A = newNote(parseEther("1"));
const B = newNote(parseEther("2"));
const P = newNote(parseEther("5"));
const deposits = [];
for (const n of [A, B, P]) {
  const pre = await precommitment(n);
  const leaf = await leafOf(n);
  deposits.push({ value: n.value, precommitment: pre, leaf, index: await tree.insert(leaf) });
}
const rootAfterDeposits = tree.root();

async function withdraw(note, index, withdrawn, terms) {
  const ctx = context({ chainId, pool, ...terms });
  const r = await proveWithdraw({ note, leafIndex: index, tree, withdrawn, ctx, wasm, zkey });
  const [root, nullifierHash, w, newLeaf, c] = r.publicSignals;
  const out = { root, nullifierHash, withdrawn: w, newLeaf, context: c, ...terms, proof: r.proof };
  if (newLeaf !== 0n) out.newIndex = await tree.insert(newLeaf);
  out.rootAfter = tree.root();
  return { out, change: r.change };
}

// 1. Part of A to a recipient through a relayer; 0.6 stays shielded as change.
const w1 = await withdraw(A, 0, parseEther("0.4"), { recipient: RECIPIENT, relayer: RELAYER, fee: parseEther("0.01"), data: "0x" });
// 2. All of that change, no relayer.
const w2 = await withdraw(w1.change, Number(w1.out.newIndex), parseEther("0.6"), { recipient: RECIPIENT2, relayer: ZERO, fee: 0n, data: "0x" });
// 3. 3 HYPE of P straight into a long: 0.5 units at <= 101 HYPE, owned by the one-time key.
const openData = encodeAbiParameters(
  [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
  [owner, true, parseEther("0.5"), parseEther("101")],
);
const w3 = await withdraw(P, 2, parseEther("3"), { recipient: market, relayer: RELAYER, fee: parseEther("0.001"), data: openData });

// Where the closed position's proceeds are reshielded.
const Q = newNote(1n);
const reshield = { precommitment: await precommitment(Q) };

const fixture = {
  pool, market, owner, emptyRoot, rootAfterDeposits,
  poseidon12: await hash(1, 2),
  deposits,
  w1: w1.out, w2: w2.out, w3: w3.out,
  reshield,
};
// forge's parseJson reads big numbers best as decimal strings.
const json = JSON.stringify(fixture, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
mkdirSync("../contracts/test/fixtures", { recursive: true });
writeFileSync("../contracts/test/fixtures/shielded.json", json + "\n");
console.log("pool", pool, "market", market, "owner", owner);
process.exit(0);
