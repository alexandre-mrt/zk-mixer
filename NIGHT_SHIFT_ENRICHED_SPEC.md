# Night Shift Enriched Spec — 2026-03-24

## Original spec

Build a full-stack ZK Payment Mixer using Circom. A privacy tool that lets users deposit ETH into a pool and withdraw to a different address without linking the two, using zero-knowledge proofs.

### Architecture

#### Circuits (Circom)
- `circuits/hasher.circom` — Poseidon hash wrapper
- `circuits/merkle_tree.circom` — Incremental Merkle tree proof verification (depth 20)
- `circuits/withdraw.circom` — Main circuit: proves knowledge of (secret, nullifier) such that commitment is in the Merkle tree, reveals nullifierHash to prevent double-spend. Public inputs: root, nullifierHash, recipient, fee. Private inputs: secret, nullifier, pathElements, pathIndices.
- `circuits/deposit.circom` — Simple commitment computation circuit (for testing)

#### Contracts (Solidity + Hardhat)
- `contracts/MerkleTree.sol` — On-chain incremental Merkle tree using Poseidon hash
- `contracts/Mixer.sol` — deposit(commitment) adds to tree, withdraw(proof, root, nullifierHash, recipient, fee) verifies proof and sends ETH. Fixed denomination (0.1 ETH). Nullifier registry. Stores last 30 roots.
- `contracts/Verifier.sol` — Auto-generated Groth16 verifier from snarkjs

#### Scripts
- `scripts/compile-circuit.sh` — Compile circom circuits, generate R1CS, WASM, zkey
- `scripts/generate-verifier.sh` — Export Solidity verifier from zkey

#### Tests
- `test/circuit.test.ts` — Test circuits with circom_tester
- `test/mixer.test.ts` — Hardhat tests: deposit, withdraw, double-spend, invalid proof

#### CLI (TypeScript + Bun)
- `cli/index.ts` — CLI entry point (commander.js): deposit, withdraw, status
- `cli/deposit.ts` — Generate secret+nullifier, compute commitment, call deposit(), save note
- `cli/withdraw.ts` — Load note, fetch Merkle path, generate proof, call withdraw()
- `cli/utils.ts` — Poseidon hash, Merkle tree builder, proof helpers

#### Frontend (React + Vite + wagmi)
- Connect wallet, deposit, withdraw, transaction history
- Client-side proof generation with snarkjs
- wagmi + viem for wallet/contract interaction

### Tech Stack
- circom 2.1.x + snarkjs
- Hardhat + ethers.js
- Bun for CLI and tooling
- React + Vite + wagmi + viem
- Poseidon hash (circomlib)
- Groth16 proving system

### Key Design Decisions
- Fixed denomination: 0.1 ETH
- Merkle tree depth: 20 (~1M deposits)
- Root history: last 30 roots
- nullifierHash = Poseidon(nullifier)
- commitment = Poseidon(secret, nullifier)

## Clarifications from pre-flight

### Scope
- Full stack: circuits + contracts + CLI + frontend
- No exclusions — full creative freedom on approach
- Stretch goals if time permits: polish + E2E tests (both)

### Tech decisions
- **Frontend UI**: Tailwind CSS + shadcn/ui components
- **Poseidon on-chain**: Generate from circomlib (consistent with circuits)
- **CLI**: Commander.js with proper subcommands (`zk-mixer deposit`, `zk-mixer withdraw`, `zk-mixer status`)
- **Package manager**: Bun everywhere

### Priorities (must-haves vs nice-to-haves)
**Must-haves:**
1. Circom circuits (withdraw is the core)
2. Solidity contracts (Mixer + MerkleTree + Verifier)
3. Circuit compilation scripts
4. Contract tests (deposit, withdraw, double-spend)
5. Circuit tests
6. CLI
7. Frontend

**Nice-to-haves (stretch):**
- E2E tests (full deposit-to-withdraw flow)
- Code polish and refactoring
- Multi-denomination support
- Relayer support

### Testing
- Full coverage: circuits + contracts + CLI
- Circuit tests with circom_tester (valid/invalid proofs, edge cases)
- Contract tests with Hardhat (deposit, withdraw, double-spend prevention, invalid proof rejection)
- CLI tests

### Deployment
- Local Hardhat node for development
- Sepolia-ready config (hardhat.config.ts with Sepolia network, but no actual deploy)
- Deploy scripts that work for both local and testnet

### Do NOT
- No AI/Claude mentions in commits, code, or PR
- No restrictions otherwise
