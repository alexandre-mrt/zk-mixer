import fs from "fs";
import path from "path";
import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  EventLog,
  formatEther,
  randomBytes,
} from "ethers";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { createMerkleTree, MerkleTree } from "./merkle-tree";

export interface Note {
  secret: bigint;
  nullifier: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

export interface SavedNote extends Note {
  txHash: string;
  leafIndex: number;
  timestamp: number;
}

const NOTE_PREFIX = "zk-mixer";

/**
 * Generate a new random note: secret, nullifier, commitment, nullifierHash.
 * commitment = Poseidon(secret, nullifier)
 * nullifierHash = Poseidon(nullifier)
 */
export async function generateNote(): Promise<Note> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Random 31-byte field elements — safely below BN254 field prime
  const secretBytes = randomBytes(31);
  const nullifierBytes = randomBytes(31);

  const secret = BigInt(ethers.hexlify(secretBytes));
  const nullifier = BigInt(ethers.hexlify(nullifierBytes));

  const commitment: bigint = F.toObject(poseidon([secret, nullifier]));
  const nullifierHash: bigint = F.toObject(poseidon([nullifier]));

  return { secret, nullifier, commitment, nullifierHash };
}

/**
 * Recompute commitment and nullifierHash from secret and nullifier.
 */
export async function deriveNoteHashes(
  secret: bigint,
  nullifier: bigint
): Promise<{ commitment: bigint; nullifierHash: bigint }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const commitment: bigint = F.toObject(poseidon([secret, nullifier]));
  const nullifierHash: bigint = F.toObject(poseidon([nullifier]));

  return { commitment, nullifierHash };
}

/**
 * Convert a bigint to a 0x-prefixed hex string (64 hex chars = 32 bytes).
 */
export function toHex(value: bigint): string {
  const hex = value.toString(16).padStart(64, "0");
  return `0x${hex}`;
}

/**
 * Encode a note to a portable string.
 * Format: zk-mixer-<secret_hex>-<nullifier_hex>
 */
export function encodeNote(note: Note): string {
  const secretHex = note.secret.toString(16).padStart(64, "0");
  const nullifierHex = note.nullifier.toString(16).padStart(64, "0");
  return `${NOTE_PREFIX}-${secretHex}-${nullifierHex}`;
}

/**
 * Parse a note string back into { secret, nullifier, commitment, nullifierHash }.
 * Throws if the format is invalid.
 */
export async function parseNote(noteString: string): Promise<Note> {
  const parts = noteString.trim().split("-");
  // Format: zk-mixer-<64hexChars>-<64hexChars>  => splits to ["zk", "mixer", <secret>, <nullifier>]
  if (
    parts.length !== 4 ||
    parts[0] !== "zk" ||
    parts[1] !== "mixer" ||
    !/^[0-9a-f]{64}$/.test(parts[2]) ||
    !/^[0-9a-f]{64}$/.test(parts[3])
  ) {
    throw new Error(
      `Invalid note format. Expected: ${NOTE_PREFIX}-<64hexChars>-<64hexChars>`
    );
  }

  const secret = BigInt(`0x${parts[2]}`);
  const nullifier = BigInt(`0x${parts[3]}`);
  const { commitment, nullifierHash } = await deriveNoteHashes(secret, nullifier);

  return { secret, nullifier, commitment, nullifierHash };
}

/**
 * Build a Merkle tree by replaying all Deposit events from the contract.
 * Returns the tree with all known commitments inserted in order.
 */
export async function buildMerkleTree(
  provider: JsonRpcProvider,
  mixerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mixerAbi: any[]
): Promise<MerkleTree> {
  const contract = new Contract(mixerAddress, mixerAbi, provider);
  const levels = 20; // MERKLE_TREE_HEIGHT

  const filter = contract.filters.Deposit();
  const events = await contract.queryFilter(filter);

  // Sort by leafIndex to ensure correct insertion order
  const sorted = [...events].sort((a, b) => {
    const aIdx =
      a instanceof EventLog ? Number((a as EventLog).args.leafIndex) : 0;
    const bIdx =
      b instanceof EventLog ? Number((b as EventLog).args.leafIndex) : 0;
    return aIdx - bIdx;
  });

  const tree = await createMerkleTree(levels);
  for (const event of sorted) {
    if (event instanceof EventLog) {
      const commitment = BigInt(
        (event as EventLog).args.commitment?.toString() ?? "0"
      );
      tree.insert(commitment);
    }
  }

  return tree;
}

export interface GrothProof {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proof: any;
  publicSignals: string[];
}

/**
 * Generate a Groth16 proof using snarkjs.
 */
export async function generateProof(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  wasmPath: string,
  zkeyPath: string
): Promise<GrothProof> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );
  return { proof, publicSignals };
}

/**
 * Parse the exportSolidityCallData string from snarkjs into typed arrays
 * matching the contract's withdraw function signature.
 *
 * exportSolidityCallData returns:
 *   [pA0, pA1],[[pB00,pB01],[pB10,pB11]],[pC0,pC1],[pub0,pub1,...]
 */
export function parseCallData(calldata: string): {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
} {
  const parsed = JSON.parse(`[${calldata}]`) as [
    [string, string],
    [[string, string], [string, string]],
    [string, string],
    string[],
  ];

  const toBigInt = (s: string): bigint => BigInt(s);

  const pA: [bigint, bigint] = [toBigInt(parsed[0][0]), toBigInt(parsed[0][1])];
  const pB: [[bigint, bigint], [bigint, bigint]] = [
    [toBigInt(parsed[1][0][0]), toBigInt(parsed[1][0][1])],
    [toBigInt(parsed[1][1][0]), toBigInt(parsed[1][1][1])],
  ];
  const pC: [bigint, bigint] = [toBigInt(parsed[2][0]), toBigInt(parsed[2][1])];

  return { pA, pB, pC };
}

/**
 * Get an ethers Contract instance connected to a signer.
 */
export function getMixerContract(
  rpcUrl: string,
  privateKey: string,
  mixerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mixerAbi: any[]
): Contract {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  return new Contract(mixerAddress, mixerAbi, wallet);
}

/**
 * Get a read-only ethers Contract instance (no signer).
 */
export function getMixerContractReadOnly(
  rpcUrl: string,
  mixerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mixerAbi: any[]
): { contract: Contract; provider: JsonRpcProvider } {
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(mixerAddress, mixerAbi, provider);
  return { contract, provider };
}

/**
 * Resolve the mixer address: use --mixer option, then deployment.json, then fail.
 */
export function resolveMixerAddress(
  optionValue: string | undefined,
  deploymentFallback: string | undefined
): string {
  const addr = optionValue ?? deploymentFallback;
  if (!addr) {
    throw new Error(
      "Mixer address required. Provide --mixer <address> or run deploy first (creates deployment.json)."
    );
  }
  return addr;
}

/**
 * Resolve the private key: use --key option, then PRIVATE_KEY env var, then fail.
 */
export function resolvePrivateKey(optionValue: string | undefined): string {
  const key = optionValue ?? process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Private key required. Provide --key <privateKey> or set PRIVATE_KEY in .env"
    );
  }
  return key;
}

/**
 * Save a note to notes/<commitment_hex>.json.
 */
export function saveNote(note: SavedNote): string {
  const notesDir = path.resolve("notes");
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }
  const filename = path.join(notesDir, `${toHex(note.commitment)}.json`);
  fs.writeFileSync(
    filename,
    JSON.stringify(
      {
        secret: note.secret.toString(),
        nullifier: note.nullifier.toString(),
        commitment: note.commitment.toString(),
        nullifierHash: note.nullifierHash.toString(),
        txHash: note.txHash,
        leafIndex: note.leafIndex,
        timestamp: note.timestamp,
      },
      null,
      2
    )
  );
  return filename;
}

// Re-export formatEther for use in status.ts
export { formatEther };
