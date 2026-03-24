## Night Shift Plan — 2026-03-24

### Objective
Build a full-stack ZK Payment Mixer: Circom circuits for anonymous ETH deposits/withdrawals, Solidity contracts with on-chain Merkle tree and Groth16 verifier, TypeScript CLI with commander.js, and React frontend with wagmi + shadcn/ui.

### Architecture

```
zk-mixer/
├── circuits/              # Circom circuits
│   ├── hasher.circom      # Poseidon hash wrapper
│   ├── merkle_tree.circom # Merkle proof verification
│   ├── withdraw.circom    # Main withdrawal circuit
│   └── deposit.circom     # Commitment computation
├── contracts/             # Solidity smart contracts
│   ├── MerkleTree.sol     # Incremental Merkle tree
│   ├── Mixer.sol          # Main mixer contract
│   └── Verifier.sol       # Auto-generated Groth16 verifier
├── scripts/               # Build & deploy scripts
│   ├── compile-circuit.sh # Circuit compilation + trusted setup
│   └── deploy.ts          # Contract deployment
├── test/                  # Test suites
│   ├── circuit.test.ts    # Circuit tests (circom_tester)
│   └── mixer.test.ts      # Contract tests (Hardhat)
├── cli/                   # Commander.js CLI
│   ├── index.ts           # Entry point
│   ├── deposit.ts         # Deposit command
│   ├── withdraw.ts        # Withdraw command
│   └── utils.ts           # Shared utilities
├── frontend/              # React + Vite + wagmi + shadcn
│   ├── src/
│   │   ├── components/    # UI components
│   │   ├── hooks/         # Custom React hooks
│   │   ├── lib/           # Proof generation, contract interaction
│   │   └── App.tsx        # Main app
│   └── ...
└── hardhat.config.ts      # Hardhat configuration
```

### Tasks (ordered by dependency)
1. [T1] Scaffold — project init, deps, directory structure — parallel: no — agent: night-coder
2. [T2] Circuits — all circom circuits with circomlib Poseidon — parallel: no (needs T1) — agent: night-coder
3. [T3] Scripts — circuit compilation + trusted setup — parallel: yes (with T2 prep) — agent: night-coder
4. [T4] Contracts — MerkleTree.sol, Mixer.sol, Verifier gen — parallel: no (needs T2, T3) — agent: night-coder
5. [T5] Contract tests — full Hardhat test suite — parallel: no (needs T4) — agent: night-tester
6. [T6] Circuit tests — circom_tester tests — parallel: yes (with T5) — agent: night-tester
7. [T7] CLI — commander.js CLI with deposit/withdraw/status — parallel: no (needs T4) — agent: night-coder
8. [T8] Frontend — React + wagmi + shadcn — parallel: yes (with T7) — agent: night-coder
9. [T9] Finalize — validation, review, PR — parallel: no (needs all) — agent: code-reviewer

### Pre-made decisions
- Poseidon hash from circomlib for both circuits and on-chain (consistency)
- Groth16 proving system (most mature, best tooling)
- Fixed 0.1 ETH denomination (simplicity + larger anonymity set)
- Merkle tree depth 20 (1M deposits capacity)
- 30 root history (flexibility for concurrent withdrawals)
- Commander.js for CLI (professional UX)
- shadcn/ui + Tailwind for frontend (clean, accessible)
- Hardhat for contract development (best circom integration)
