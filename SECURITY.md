# Security Model — ZK Mixer

## Smart Contract Security

### Access Control

| Role   | Capabilities |
|--------|-------------|
| Owner  | `pause()`, `unpause()`, `setDepositReceipt()`, `setMaxDepositsPerAddress()` |
| Anyone | `deposit(commitment)`, `withdraw(proof, ...)` with a valid ZK proof |

### Reentrancy Protection

`ReentrancyGuard` (`nonReentrant`) is applied to both `deposit` and `withdraw`. In `withdraw`,
the nullifier is marked spent before any ETH transfer, strictly following the
checks-effects-interactions pattern:

```
nullifierHashes[_nullifierHash] = true   // state write
totalWithdrawn += denomination           // state write
withdrawalCount++                        // state write
_recipient.call{value: withdrawAmount}   // ETH transfer (last)
_relayer.call{value: _fee}               // ETH transfer (last)
```

### Replay and Double-Spend Protection

- `deployedChainId` is stored at construction (`block.chainid`) and verified on every `deposit`
  and `withdraw` call via the `onlyDeployedChain` modifier. This prevents cross-chain replays
  of the same commitment or proof.
- The `nullifierHashes` mapping prevents double-withdrawal: once `nullifierHash = Poseidon(nullifier)`
  is recorded, any subsequent use of the same nullifier reverts.
- The `commitments` mapping prevents the same commitment from being deposited twice.

### Root Staleness

The Merkle tree maintains a ring buffer of the last `ROOT_HISTORY_SIZE` roots. A proof anchored
to any of these roots is accepted, giving in-flight tolerance for deposits that land between
proof generation and submission.

### Front-Running Protection

The recipient address and relayer address are included as public signals in the Groth16 proof
(signals 2 and 3: `pubSignals[2] = uint160(recipient)`, `pubSignals[3] = uint160(relayer)`).
A mempool observer cannot substitute a different recipient without invalidating the proof.

### Privacy Guarantees

- The link between deposit and withdrawal is broken by the ZK proof. The proof reveals only
  the nullifier hash, the Merkle root, and the designated recipient — never the note preimage.
- Fixed denomination (`denomination` is immutable) ensures that all deposits are
  indistinguishable, providing a uniform anonymity set.
- Soulbound deposit receipts (ERC721, non-transferable) record only the commitment and timestamp.
  They do not reveal withdrawal information. Owning a receipt does not grant withdrawal rights —
  the ZK proof is the sole authorization mechanism.
- The commitment `Poseidon(secret, nullifier)` is computed off-chain; the contract never sees
  the preimage.

### Emergency Controls

- `pause()` / `unpause()` halt all `deposit` and `withdraw` calls (OpenZeppelin `Pausable`).
- No `emergencyDrain` function exists. To recover funds in a critical bug scenario, users must
  withdraw normally (requires valid ZK proofs). This is intentional: it prevents the owner
  from unilaterally seizing user funds.

---

## Known Limitations

### Verifier Placeholder

`Verifier.sol` (`Groth16Verifier`) is a **placeholder that always returns `true`** on Hardhat
(chain ID 31337). It reverts on any other network, but it must be **replaced with the
snarkjs-generated verifier** before any non-local deployment. Without a real verifier, the
contract provides no ZK security guarantees.

To generate the real verifier:

```bash
bash scripts/generate-verifier.sh
```

### Anonymity Set

Privacy improves with pool size. A small anonymity set makes timing and amount-based
correlation attacks easier. Until a critical mass of deposits exists, withdrawal timing
should be randomised off-chain by the user.

### Trusted Setup

Groth16 requires a trusted setup (powers-of-tau ceremony + circuit-specific phase 2). The
security of the proof system depends on at least one participant in the ceremony being honest.
The current setup has not been audited or run as a public ceremony.

### No KYC / AML Mechanism

The contract has no on-chain compliance controls. Operators deploying this contract must
assess their regulatory obligations independently.

### Frontend / Client Security

- The note (`secret + nullifier`) is generated and stored client-side. If localStorage is
  compromised (XSS), an attacker can derive the nullifier hash and front-run a withdrawal.
- No server stores private note data. Loss of the note means permanent loss of funds.

---

## Circuit Security

- `commitment = Poseidon(secret, nullifier)` — Poseidon is snark-friendly and well-studied
  over BN254.
- `nullifierHash = Poseidon(nullifier)` — the nullifier is a private input; only its hash is
  revealed on-chain.
- The withdraw circuit constrains `root`, `nullifierHash`, `recipient`, `relayer`, and `fee`
  as public signals, binding the proof to a specific withdrawal transaction.
- Range proofs are not required for the mixer since denomination is fixed and enforced at the
  contract level (`msg.value == denomination`).
- Groth16 is a succinct non-interactive proof system (one-time trusted setup, constant-size
  proofs). Soundness holds under the q-power knowledge of exponent assumption over BN254.

---

## Upgrade Path

Contracts are **not upgradeable** (no proxy, no `selfdestruct`, no `delegatecall`). This is
intentional for trust minimisation: users do not need to trust that a future upgrade will not
drain their funds.

To deploy an improved version:

1. Deploy new contracts with the fixed verifier.
2. Announce the new address publicly.
3. Users withdraw from the old pool and deposit into the new one.

There is no automated migration mechanism. Funds in the old contract are accessible as long as
the old contract exists on-chain.

---

## Reporting Vulnerabilities

Do not open a public GitHub issue for security vulnerabilities. Contact the maintainer directly
before disclosure.
