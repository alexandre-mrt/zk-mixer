## Night Shift Plan — 2026-03-24

### Objective
Build a full-stack ZK Payment Mixer: Circom circuits for anonymous ETH deposits/withdrawals, Solidity contracts with on-chain Merkle tree and Groth16 verifier, TypeScript CLI with commander.js, and React frontend with wagmi + shadcn/ui.

### Architecture

```
zk-mixer/
├── circuits/              # Circom circuits
│   ├── hasher.circom      # Poseidon hash wrapper (Hasher2, HashLeftRight)
│   ├── merkle_tree.circom # Merkle proof verification (DualMux, MerkleTreeChecker)
│   ├── withdraw.circom    # Main withdrawal circuit (Withdraw(20))
│   └── deposit.circom     # Commitment computation (testing)
├── contracts/             # Solidity smart contracts
│   ├── MerkleTree.sol     # Incremental Merkle tree with Poseidon
│   ├── Mixer.sol          # Main mixer (deposit/withdraw)
│   └── Verifier.sol       # Groth16 verifier (placeholder)
├── scripts/
│   ├── compile-circuit.sh # Circuit compilation + trusted setup (pot20)
│   ├── generate-verifier.sh # Export Solidity verifier from zkey
│   └── deploy.ts          # Contract deployment (Hasher + Verifier + Mixer)
├── test/
│   ├── helpers/hasher.ts  # Poseidon contract deployer via circomlibjs
│   └── mixer.test.ts      # 41 tests — deployment, deposit, merkle, withdraw, integration
├── cli/                   # Commander.js CLI
│   ├── index.ts           # Entry point with subcommands
│   ├── config.ts          # ABI loader, constants
│   ├── deposit.ts         # Generate note + deposit
│   ├── withdraw.ts        # Build proof + withdraw
│   ├── status.ts          # Pool status
│   ├── merkle-tree.ts     # Client-side Merkle tree
│   ├── utils.ts           # Poseidon, note format, proof helpers
│   └── types.d.ts         # Type declarations
├── frontend/src/
│   ├── components/        # Header, DepositCard, WithdrawCard, StatusCard, TabNav
│   ├── components/ui/     # shadcn-style: Button, Card, Input, Tabs, Badge
│   ├── lib/               # constants, wagmi-config, crypto, merkle-tree, proof, utils
│   ├── types/             # Module declarations
│   ├── App.tsx            # Root with WagmiProvider
│   └── main.tsx           # Entry point
└── hardhat.config.ts      # Solidity 0.8.20, hardhat/localhost/sepolia
```

### Tasks (ordered by dependency)
1. [T1] Scaffold — project init, deps, directory structure
2. [T2] Circuits — all circom circuits with circomlib Poseidon
3. [T3] Scripts — circuit compilation + trusted setup
4. [T4] Contracts — MerkleTree.sol, Mixer.sol, Verifier placeholder
5. [T5] Contract tests — 41 Hardhat tests, all passing
6. [T6] Circuit tests — BLOCKED (circom binary not installed)
7. [T7] CLI — commander.js with deposit/withdraw/status
8. [T8] Frontend — React + wagmi + shadcn/ui, dark theme
9. [T9] Finalize — validation, review

### Pre-made decisions
- Poseidon hash from circomlib for both circuits and on-chain (consistency)
- Groth16 proving system (most mature, best tooling)
- Fixed 0.1 ETH denomination (simplicity + larger anonymity set)
- Merkle tree depth 20 (1M deposits capacity)
- 30 root history (flexibility for concurrent withdrawals)
- Commander.js for CLI (professional UX)
- shadcn/ui + Tailwind for frontend (clean, accessible)
- Hardhat 2.22 for contract development

---

## Night Shift Summary — 2026-03-24

### Timing
- Started: 2026-03-24T23:30:00+01:00
- Finished: 2026-03-25T00:15:00+01:00
- Duration: ~45min

### Completed
- [x] T1: Project scaffold (Hardhat 2.22, Bun, Vite, wagmi, shadcn, Tailwind v4)
- [x] T2: 4 Circom circuits (hasher, merkle_tree, withdraw depth-20, deposit)
- [x] T3: compile-circuit.sh (pot20 download + Groth16 setup), generate-verifier.sh, deploy.ts
- [x] T4: MerkleTree.sol (incremental, IHasher interface, 30-root history), Mixer.sol (deposit/withdraw with reentrancy protection), Verifier.sol placeholder
- [x] T5: 41 contract tests — all passing (deployment, deposit, merkle tree, withdrawal, integration)
- [x] T7: Commander.js CLI with deposit (note generation), withdraw (proof generation), status
- [x] T8: React frontend — wallet connect, deposit card, withdraw card with step progress, status card
- [BLOCKED] T6: Circuit tests — requires circom binary

### Decisions made
- Hardhat 3 incompatible with toolbox plugin — downgraded to Hardhat 2.22
- MerkleTree uses IHasher interface — Poseidon deployed separately via circomlibjs
- Verifier.sol is a placeholder (returns true) until circuits are compiled
- Tests use tree height 5 (faster) instead of 20
- Frontend uses manual shadcn component creation (no CLI init)

### Not completed / Needs review
- Circuit tests (T6) — need circom binary installed
- Real Verifier.sol — needs circuit compilation first
- Frontend needs Node.js polyfills for circomlibjs/snarkjs in browser (logged in problems)
- MIXER_ADDRESS in frontend needs updating after deployment

### Issues encountered
- Hardhat 3 vs 2 incompatibility
- Frontend TypeScript build errors (missing @types packages, deprecated baseUrl)
- Merge conflicts on NIGHT_SHIFT_PROBLEMS.md (parallel agent writes)

### Final validation
- Build: PASS (Solidity compiles, Frontend builds)
- Tests: 41/41 PASS
- Lint: N/A (no biome configured for Solidity project)
- Visual: N/A (no dev server needed for build check)

### Stats
- Iterations: 1
- Agents spawned: 7 (scaffold, circuits, scripts, contracts, tests, CLI, frontend)
- Files created: ~35 source files + configs
- Lines of code: ~3,558
- Commits: 17
