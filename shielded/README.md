# shielded

Shielded HYPE: the withdraw circuit, its keys, and the client library that
makes notes and proofs. The contracts live in [`contracts/`](../contracts)
(`ShieldedPool.sol`, `WithdrawVerifier.sol`); the design is in
[`docs/shielded.md`](../docs/shielded.md).

```bash
npm ci
npm test            # notes, tree and context, no circuit needed
npm run build       # needs circom 2.2+: compile, dev setup, export the verifier
npm run fixtures    # real proofs for contracts/test (after build)
```

`npm run build` writes `build/` (r1cs, wasm, zkey; not committed) and
regenerates `contracts/src/WithdrawVerifier.sol`. Its trusted setup is a
**development** setup: fine for tests and testnets, not for real funds.

```js
import { newNote, precommitment, Tree, context, proveWithdraw } from "./src/notes.mjs";

const note = newNote(10n ** 18n);              // 1 HYPE
await pool.deposit(await precommitment(note), { value: note.value });

const tree = await Tree.create(leavesFromInsertedEvents);
const ctx = context({ chainId, pool, recipient, relayer, fee, data: "0x" });
const { proof, publicSignals, change } = await proveWithdraw({
  note, leafIndex, tree, withdrawn: 4n * 10n ** 17n, ctx,
  wasm: "build/withdraw_js/withdraw.wasm", zkey: "build/withdraw.zkey",
});
// keep `change`: it holds the 0.6 HYPE left
```
