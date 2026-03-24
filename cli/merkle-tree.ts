import { buildPoseidon } from "circomlibjs";

// Type returned by circomlibjs buildPoseidon — the poseidon function with .F attached.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoseidonFn = (inputs: bigint[]) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FieldObj = { toObject: (el: any) => bigint; zero: any };

export interface MerkleProof {
  pathElements: bigint[];
  pathIndices: number[];
}

export class MerkleTree {
  readonly levels: number;
  readonly capacity: number;
  readonly leaves: bigint[];
  private readonly zeros: bigint[];
  private readonly poseidon: PoseidonFn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly F: FieldObj;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(levels: number, poseidon: any, F: any) {
    this.levels = levels;
    this.poseidon = poseidon as PoseidonFn;
    this.F = F as FieldObj;
    this.leaves = [];

    // Compute zero values bottom-up: zeros[0] = 0, zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= levels; i++) {
      zeros.push(this.hash(zeros[i - 1], zeros[i - 1]));
    }
    this.zeros = zeros;

    this.capacity = 2 ** levels;
  }

  hash(left: bigint, right: bigint): bigint {
    return this.F.toObject(this.poseidon([left, right]));
  }

  insert(leaf: bigint): number {
    if (this.leaves.length >= this.capacity) {
      throw new Error("MerkleTree: tree is full");
    }
    const index = this.leaves.length;
    this.leaves.push(leaf);
    return index;
  }

  getRoot(): bigint {
    return this.computeRoot();
  }

  private computeRoot(): bigint {
    if (this.leaves.length === 0) {
      return this.zeros[this.levels];
    }

    let currentLevel = [...this.leaves];

    for (let level = 0; level < this.levels; level++) {
      const levelSize = 2 ** (this.levels - level);
      // Pad with zero values for this level
      while (currentLevel.length < levelSize) {
        currentLevel.push(this.zeros[level]);
      }
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(this.hash(currentLevel[i], currentLevel[i + 1]));
      }
      currentLevel = nextLevel;
    }
    return currentLevel[0] ?? this.zeros[this.levels];
  }

  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(
        `MerkleTree: leaf index ${leafIndex} out of range (tree has ${this.leaves.length} leaves)`
      );
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentLevel = [...this.leaves];
    let index = leafIndex;

    for (let level = 0; level < this.levels; level++) {
      const levelSize = 2 ** (this.levels - level);
      // Pad with zero values for this level
      while (currentLevel.length < levelSize) {
        currentLevel.push(this.zeros[level]);
      }

      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      pathElements.push(currentLevel[siblingIndex]);
      pathIndices.push(index % 2);

      // Compute parent level
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(this.hash(currentLevel[i], currentLevel[i + 1]));
      }
      currentLevel = nextLevel;
      index = Math.floor(index / 2);
    }

    return { pathElements, pathIndices };
  }
}

export async function createMerkleTree(levels: number): Promise<MerkleTree> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return new MerkleTree(levels, poseidon, F);
}
