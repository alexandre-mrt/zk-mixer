import { buildPoseidon } from "circomlibjs";

// BN254 scalar field size
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

type PoseidonFn = {
  (inputs: bigint[]): Uint8Array;
  F: { toObject: (a: Uint8Array) => bigint };
};

let poseidonInstance: PoseidonFn | null = null;

async function getPoseidon(): Promise<PoseidonFn> {
  if (!poseidonInstance) {
    poseidonInstance = (await buildPoseidon()) as PoseidonFn;
  }
  return poseidonInstance;
}

function randomFieldElement(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let value = BigInt(0);
  for (const byte of bytes) {
    value = (value << BigInt(8)) | BigInt(byte);
  }
  return value % FIELD_SIZE;
}

export type Note = {
  secret: bigint;
  nullifier: bigint;
  commitment: bigint;
  nullifierHash: bigint;
  noteString: string;
};

export async function generateNote(): Promise<Note> {
  const poseidon = await getPoseidon();

  const secret = randomFieldElement();
  const nullifier = randomFieldElement();

  const commitmentRaw = poseidon([secret, nullifier]);
  const commitment = poseidon.F.toObject(commitmentRaw);

  const nullifierHashRaw = poseidon([nullifier]);
  const nullifierHash = poseidon.F.toObject(nullifierHashRaw);

  const noteString = formatNote(secret, nullifier);

  return { secret, nullifier, commitment, nullifierHash, noteString };
}

export function formatNote(secret: bigint, nullifier: bigint): string {
  const secretHex = secret.toString(16).padStart(64, "0");
  const nullifierHex = nullifier.toString(16).padStart(64, "0");
  return `zk-mixer-${secretHex}-${nullifierHex}`;
}

export type ParsedNote = {
  secret: bigint;
  nullifier: bigint;
};

export function parseNote(noteString: string): ParsedNote {
  const trimmed = noteString.trim();
  const parts = trimmed.split("-");
  // format: zk-mixer-<secret_hex>-<nullifier_hex>
  if (parts.length !== 4 || parts[0] !== "zk" || parts[1] !== "mixer") {
    throw new Error(
      "Invalid note format. Expected: zk-mixer-<secret_hex>-<nullifier_hex>",
    );
  }
  const secretHex = parts[2];
  const nullifierHex = parts[3];

  if (!/^[0-9a-fA-F]{1,64}$/.test(secretHex)) {
    throw new Error("Invalid secret hex in note");
  }
  if (!/^[0-9a-fA-F]{1,64}$/.test(nullifierHex)) {
    throw new Error("Invalid nullifier hex in note");
  }

  const secret = BigInt("0x" + secretHex);
  const nullifier = BigInt("0x" + nullifierHex);

  if (secret >= FIELD_SIZE || nullifier >= FIELD_SIZE) {
    throw new Error("Note values exceed field size");
  }

  return { secret, nullifier };
}

export async function computeCommitment(
  secret: bigint,
  nullifier: bigint,
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const raw = poseidon([secret, nullifier]);
  return poseidon.F.toObject(raw);
}

export async function computeNullifierHash(nullifier: bigint): Promise<bigint> {
  const poseidon = await getPoseidon();
  const raw = poseidon([nullifier]);
  return poseidon.F.toObject(raw);
}

export async function hashLeftRight(
  left: bigint,
  right: bigint,
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const raw = poseidon([left, right]);
  return poseidon.F.toObject(raw);
}
