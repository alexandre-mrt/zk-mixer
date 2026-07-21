# ZK Mixer

Privacy-preserving ETH mixer using Circom zero-knowledge proofs (Groth16). Deposit a fixed amount of ETH and withdraw to any address without linking the two transactions.

## Architecture

```
circuits/       Circom ZK circuits (Poseidon hash, Merkle tree, withdraw)
contracts/      Solidity (Mixer, MerkleTree, DepositReceipt ERC721)
cli/            TypeScript CLI (deposit, withdraw, status)
frontend/       React + wagmi + Tailwind + shadcn/ui
test/           981 Hardhat tests
scripts/        Deploy, verify, compile circuits
```

```
              Deposit                          Withdraw
                 |                                |
    generate(secret, nullifier)      prove(note, recipient, relayer)
                 |                                |
    commitment = Poseidon(s, n)      ZK proof (off-chain, snarkjs)
                 |                                |
    deposit(commitment) + ETH        withdraw(proof, nullifierHash, root)
                 |                                |
    Merkle leaf inserted             nullifierHash marked spent
                 |                                |
         Merkle root updated              ETH sent to recipient
```

## How It Works

1. **Deposit**: Generate a secret note, deposit 0.1 ETH with the note's commitment
2. **Wait**: Other users deposit, growing the anonymity set
3. **Withdraw**: Prove you know a valid note without revealing which one, withdraw to any address

```
commitment   = Poseidon(secret, nullifier)
nullifierHash = Poseidon(nullifier)
Merkle tree depth: 20  (up to 2^20 = 1M deposits)
Root history:      30  (proofs valid against last 30 roots)
```

## Quick Start

```bash
# Install
bun install

# Run tests
npx hardhat test

# Local deployment
bash scripts/local-setup.sh

# CLI
bun run cli/index.ts deposit --key <private_key>
bun run cli/index.ts withdraw --note <note> --recipient <address>
bun run cli/index.ts status

# Frontend
cd frontend && bun install && bun dev
```

## Security Features

- OpenZeppelin ReentrancyGuard, Pausable, Ownable
- Relayer bound as 5th public signal (front-running protection)
- Soulbound ERC721 deposit receipts
- Chain ID replay protection

## Status & Limitations

This is a working reference implementation, not an audited production system. Read this before deploying anything:

- **The on-chain Groth16 verifier is a development placeholder** (`contracts/Verifier.sol`). It accepts any proof and is hard-guarded to the Hardhat network (`chainid == 31337`), so it reverts on any real network. To get real zero-knowledge verification you must compile the circuits and generate the real verifier:
  ```bash
  bash scripts/compile-circuit.sh     # requires circom 2.x installed
  bash scripts/generate-verifier.sh   # snarkjs -> real Groth16Verifier
  ```
  Until you do this, the ZK proving path is not enforced end-to-end. The tests exercise the contracts (Merkle tree, nullifiers, receipts, access control) with real Poseidon hashing but dummy proofs against the placeholder verifier.
- Not audited. Do not deploy to mainnet with real funds.

## Tests

The Hardhat suite covers the Solidity contracts (Mixer, MerkleTree, DepositReceipt, MixerLens, timelock governance, access control) using a real circomlibjs Poseidon hasher deployed on-chain.

```bash
npx hardhat test             # 981 tests, all passing
npx hardhat test --grep E2E  # end-to-end scenarios with real Poseidon hashing
```

## Tech Stack

| Component  | Technology                          |
|------------|-------------------------------------|
| Circuits   | Circom 2.1 + snarkjs (Groth16)      |
| Contracts  | Solidity 0.8.20 + Hardhat           |
| CLI        | TypeScript + Commander.js           |
| Frontend   | React + Vite + wagmi + shadcn/ui    |
| Hash       | Poseidon (circomlib)                |

## License

MIT
