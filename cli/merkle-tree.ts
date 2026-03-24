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
  readonly leaves: bigint[];
  private readonly zeros: bigint[];
  private layers: bigint[][];
  private readonly poseidon: PoseidonFn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly F: FieldObj;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(levels: number, poseidon: any, F: any) {
    this.levels = levels;
    this.poseidon = poseidon as PoseidonFn;
    this.F = F as FieldObj;
    this.leaves = [];
    this.layers = [];

    // Compute zero values bottom-up: zeros[0] = 0, zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= levels; i++) {
      zeros.push(this.hash(zeros[i - 1], zeros[i - 1]));
    }
    this.zeros = zeros;
  }

  hash(left: bigint, right: bigint): bigint {
    return this.F.toObject(this.poseidon([left, right]));
  }

  insert(leaf: bigint): number {
    const index = this.leaves.length;
    this.leaves.push(leaf);
    this.rebuildLayers();
    return index;
  }

  private rebuildLayers(): void {
    this.layers = [this.leaves.slice()];
    for (let level = 0; level < this.levels; level++) {
      const currentLevel = this.layers[level];
      const nextLevel: bigint[] = [];
      for (let i = 0; i < Math.max(currentLevel.length, 1); i += 2) {
        const left = currentLevel[i] ?? this.zeros[level];
        const right = currentLevel[i + 1] ?? this.zeros[level];
        nextLevel.push(this.hash(left, right));
      }
      this.layers.push(nextLevel);
    }
  }

  getRoot(): bigint {
    if (this.layers.length === 0) return this.zeros[this.levels];
    return this.layers[this.levels]?.[0] ?? this.zeros[this.levels];
  }

  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(
        `MerkleTree: leaf index ${leafIndex} out of range (tree has ${this.leaves.length} leaves)`
      );
    }

    if (this.layers.length === 0) this.rebuildLayers();

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let index = leafIndex;

    for (let level = 0; level < this.levels; level++) {
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      const sibling = this.layers[level]?.[siblingIndex] ?? this.zeros[level];
      pathElements.push(sibling);
      pathIndices.push(index % 2);
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
