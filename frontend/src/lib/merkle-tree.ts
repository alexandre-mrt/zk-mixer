import { hashLeftRight } from "./crypto";
import { MERKLE_TREE_DEPTH, ZERO_VALUE } from "./constants";

export type MerkleProof = {
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
};

async function buildZeros(depth: number): Promise<bigint[]> {
  const zeros: bigint[] = [ZERO_VALUE];
  for (let i = 1; i <= depth; i++) {
    const prev = zeros[i - 1];
    zeros.push(await hashLeftRight(prev, prev));
  }
  return zeros;
}

export class MerkleTree {
  private readonly depth: number;
  private readonly layers: bigint[][];
  private zeros: bigint[] = [];
  private initialized = false;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.depth = depth;
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.zeros = await buildZeros(this.depth);
    this.initialized = true;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("MerkleTree must be initialized before use");
    }
  }

  async insert(commitment: bigint): Promise<number> {
    this.assertInitialized();

    const leafIndex = this.layers[0].length;
    this.layers[0].push(commitment);

    let currentIndex = leafIndex;
    let currentHash = commitment;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling =
        this.layers[level][siblingIndex] ?? this.zeros[level];

      const left = isRight ? sibling : currentHash;
      const right = isRight ? currentHash : sibling;

      currentHash = await hashLeftRight(left, right);
      currentIndex = Math.floor(currentIndex / 2);

      if (this.layers[level + 1].length <= currentIndex) {
        this.layers[level + 1].push(currentHash);
      } else {
        this.layers[level + 1][currentIndex] = currentHash;
      }
    }

    return leafIndex;
  }

  getRoot(): bigint {
    this.assertInitialized();
    return this.layers[this.depth][0] ?? this.zeros[this.depth];
  }

  getProof(leafIndex: number): MerkleProof {
    this.assertInitialized();

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling =
        this.layers[level][siblingIndex] ?? this.zeros[level];

      pathElements.push(sibling);
      pathIndices.push(isRight ? 1 : 0);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      pathElements,
      pathIndices,
      root: this.getRoot(),
    };
  }

  getLeafCount(): number {
    return this.layers[0].length;
  }
}

export async function buildTreeFromLeaves(
  commitments: bigint[],
): Promise<MerkleTree> {
  const tree = new MerkleTree(MERKLE_TREE_DEPTH);
  await tree.init();
  for (const commitment of commitments) {
    await tree.insert(commitment);
  }
  return tree;
}
