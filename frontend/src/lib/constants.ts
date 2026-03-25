export const MIXER_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [{ name: "_commitment", type: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      { name: "_pA", type: "uint256[2]" },
      { name: "_pB", type: "uint256[2][2]" },
      { name: "_pC", type: "uint256[2]" },
      { name: "_root", type: "uint256" },
      { name: "_nullifierHash", type: "uint256" },
      { name: "_recipient", type: "address" },
      { name: "_relayer", type: "address" },
      { name: "_fee", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getLastRoot",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextIndex",
    inputs: [],
    outputs: [{ type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "denomination",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getStats",
    inputs: [],
    outputs: [
      { name: "_totalDeposited", type: "uint256" },
      { name: "_totalWithdrawn", type: "uint256" },
      { name: "_depositCount", type: "uint256" },
      { name: "_withdrawalCount", type: "uint256" },
      { name: "_poolBalance", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "commitment", type: "uint256", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawal",
    inputs: [
      { name: "to", type: "address", indexed: false },
      { name: "nullifierHash", type: "uint256", indexed: false },
      { name: "relayer", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "isSpent",
    inputs: [{ name: "_nullifierHash", type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

// Placeholder — update after deployment
export const MIXER_ADDRESS =
  "0x0000000000000000000000000000000000000000" as `0x${string}`; // NIGHT-SHIFT-REVIEW: replace with actual deployed address

export function getMixerAddress(): `0x${string}` {
  if (MIXER_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "MIXER_ADDRESS is not configured. Deploy the mixer contract and update MIXER_ADDRESS in frontend/src/lib/constants.ts"
    );
  }
  return MIXER_ADDRESS;
}

export const DENOMINATION = BigInt("100000000000000000"); // 0.1 ETH

export const MERKLE_TREE_DEPTH = 20;

// Must match MerkleTree.sol constructor: zeros[0] = 0 (empty leaf)
export const ZERO_VALUE = 0n;

export const DEPLOY_BLOCK = 0n; // Update after deployment to reduce event scanning range
