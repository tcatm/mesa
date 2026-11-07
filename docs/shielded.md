# Shielded HYPE

Shielded HYPE lets anyone on Elysium move HYPE out of public view and back,
with nothing on chain linking the address that put it in to the address that
takes it out. It is one contract, `ShieldedPool`, a Groth16 circuit, and a
small client library in [`shielded/`](../shielded).

Status: built and tested, **not deployed**. The proving key comes from a
single-party development setup and the code is unaudited (see
[Before mainnet](#before-mainnet)).

## Notes

A note is three numbers only its owner knows:

| Field | What it is |
|---|---|
| `value` | HYPE in wei, less than 2^128 |
| `nullifier` | random field element, revealed (hashed) when the note is spent |
| `secret` | random field element, never revealed |

The pool's Merkle tree (depth 20, 1,048,576 leaves, Poseidon) holds one leaf
per note:

```
precommitment = Poseidon(nullifier, secret)     sent by the depositor
leaf          = Poseidon(precommitment, value)  computed by the pool
```

Because the pool computes the leaf from `msg.value`, a note always holds
exactly what was paid for it. Wallets keep notes as one string,
`mesa-note-v1-<value><nullifier><secret>-<leaf index>` (`encodeNote` in
`shielded/src/notes.mjs`). Losing the string loses the HYPE; anyone holding it
can spend it.

## Deposit

`deposit(precommitment)` with HYPE attached. The pool checks the value
(non-zero, at most `maxDeposit`, the total under `maxTotalDeposits`) and the
precommitment (inside the field), inserts the leaf and emits
`Deposited(from, precommitment, leaf, index, value)` and `Inserted(leaf, index, root)`.

## Withdraw

One note in, up to two outputs: HYPE out of the pool, and a change note for
the rest. The circuit (`shielded/circuits/withdraw.circom`, 13,146
constraints) proves, without revealing which leaf:

1. the note's leaf is under `root`, one of the pool's last 64 roots;
2. `nullifierHash = Poseidon(nullifier)`;
3. `value = withdrawn + newValue`, both parts range-checked to 128 bits;
4. `newLeaf` is the change note's leaf, or 0 when nothing is left;
5. the proof is for `context`.

`context` is `keccak256(abi.encode(chainId, pool, recipient, relayer, fee, data)) mod p`.
Binding it into the proof means a relayer can submit the withdraw for the user,
so the user needs no gas and no public address. The relayer still can't change
where the HYPE goes, what it is paid, or what the callback does.

The pool then:

- marks `nullifierHash` spent;
- inserts `newLeaf` if it isn't 0;
- pays `withdrawn - fee` to `recipient`;
- pays `fee` to `relayer`.

With non-empty `data`, the recipient must be a contract. It receives the HYPE
through `onShieldedWithdraw(data)`. This is how a position opens straight from
shielded funds ([perps.md](perps.md)).

A withdraw of 0 with a change note re-randomises a note. A partial withdraw
breaks the link between deposit size and withdraw size.

## What is private, and what is not

| Public | Private |
|---|---|
| Every deposit's sender and amount | Which deposit a withdraw spends |
| Every withdraw's recipient, amount and relayer | Who owns any unspent note |
| The number of notes and when they were added | The value of any change note |

The anonymity set is every note in the tree. It is small at first, and timing
and amounts can still correlate a deposit with a withdraw. Wallets should
nudge users toward round amounts and toward waiting.

## Gas

Measured in tests at Elysium's 0.1 gwei floor:

| Call | Gas | Cost |
|---|---|---|
| `deposit` | ~1.53M | ~0.00015 HYPE |
| `withdraw` with change | ~1.78M | ~0.00018 HYPE |

Most of it is 21 Poseidon hashes for the tree insert and one pairing check.
Both fit under the Mesa relay's 5M gas cap.

## Guardian and limits

`guardian` can pause and resume **deposits** only. Withdrawals can't be
paused, and no role can move funds, change the verifier or touch the tree.
`maxDeposit` and `maxTotalDeposits` are immutable caps for the unaudited
period. A new pool with higher caps would be a new deployment, with users
withdrawing from the old one at their own pace.

## Before mainnet

1. **Trusted setup.** `shielded/scripts/build.sh` runs a single-party phase 2
   on a locally generated phase 1. Whoever runs it could forge proofs.
   Mainnet needs:
    - a public phase-1 file (Hermez/Polygon powers of tau, 2^14 or larger);
    - a multi-party phase-2 ceremony with published transcripts;
    - the verifier regenerated from that key.
2. **Audit** of the circuit and `ShieldedPool`.
3. **Relay allowlist.** Until Elysium's public sequencer opens, rpc.mesa.cx
   only relays calls to allowlisted contracts. The pool and its relayer
   service need adding.
4. **Compliance path.** Privacy Pools-style association sets, letting a
   withdrawer prove their deposit is in a vetted set, and a public exit for
   depositors excluded from it. This is the next circuit.

## Next

- 2-in-2-out transfers inside the pool, so notes change hands without leaving.
- Shielded ERC-20s, $MESA first.
- A relayer service and a wallet flow on mesa.cx.

## Files

| Path | What |
|---|---|
| `shielded/circuits/withdraw.circom` | The circuit |
| `shielded/scripts/build.sh` | Compile, dev setup, export `WithdrawVerifier.sol` |
| `shielded/src/notes.mjs` | Notes, the off-chain tree, contexts, proving |
| `shielded/scripts/fixtures.mjs` | Real proofs for the contract tests |
| `contracts/src/ShieldedPool.sol` | The pool |
| `contracts/src/WithdrawVerifier.sol` | Generated Groth16 verifier (GPL-3.0, from snarkjs) |
| `contracts/src/PoseidonT3.sol` | Poseidon(2) in Solidity (MIT, poseidon-solidity) |
