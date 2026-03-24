# ZK Payment Mixer

## Overview
Privacy-preserving ETH mixer using zero-knowledge proofs. Users deposit a fixed amount (0.1 ETH) and can withdraw to any address without linking deposit and withdrawal.

## Stack
- **Circuits**: Circom 2.1.x + snarkjs (Groth16) + circomlib (Poseidon)
- **Contracts**: Solidity + Hardhat + ethers.js
- **CLI**: TypeScript + Bun + Commander.js
- **Frontend**: React + Vite + wagmi + viem + Tailwind + shadcn/ui
- **Package manager**: Bun

## Structure
```
circuits/       — Circom circuits (hasher, merkle_tree, withdraw, deposit)
contracts/      — Solidity (MerkleTree, Mixer, Verifier)
scripts/        — Circuit compilation + deploy scripts
test/           — Circuit tests + contract tests
cli/            — Commander.js CLI (deposit, withdraw, status)
frontend/       — React app with client-side proof generation
```

## Dev Commands
```bash
# Install dependencies
bun install

# Compile circuits (requires circom installed)
bash scripts/compile-circuit.sh

# Compile contracts
bunx hardhat compile

# Run contract tests
bunx hardhat test

# Run circuit tests
bun test test/circuit.test.ts

# Start local node
bunx hardhat node

# Deploy locally
bunx hardhat run scripts/deploy.ts --network localhost

# CLI
bun run cli/index.ts deposit
bun run cli/index.ts withdraw <note>
bun run cli/index.ts status

# Frontend
cd frontend && bun dev
```

## Key Design
- commitment = Poseidon(secret, nullifier)
- nullifierHash = Poseidon(nullifier) — prevents double-spend
- Merkle tree depth 20, stores last 30 roots
- Fixed 0.1 ETH denomination
