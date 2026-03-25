import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ROOT_HISTORY_SIZE = 30n;

// 31 random bytes stay well below FIELD_SIZE (BN254 prime)
function randomLeaf(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

async function deployMixerFixture(): Promise<{ mixer: Mixer }> {
  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer };
}

describe("Merkle Tree Mathematical Properties — zk-mixer", function () {
  // circomlibjs Poseidon instance, built once for the whole suite
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // ---------------------------------------------------------------------------
  // Empty tree
  // ---------------------------------------------------------------------------

  it("empty tree root is deterministic (same across deployments)", async function () {
    // Deploy two independent fixtures and compare their initial roots
    const { mixer: mixer1 } = await deployMixerFixture();
    const { mixer: mixer2 } = await deployMixerFixture();

    const root1 = await mixer1.getLastRoot();
    const root2 = await mixer2.getLastRoot();

    expect(root1).to.equal(root2);
    expect(root1).to.not.equal(0n);
  });

  // ---------------------------------------------------------------------------
  // Root mutation on insertion
  // ---------------------------------------------------------------------------

  it("root changes after every insertion", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const [, depositor] = await ethers.getSigners();

    const roots: bigint[] = [await mixer.getLastRoot()];

    for (let i = 0; i < 3; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomLeaf(), { value: DENOMINATION });
      const newRoot = await mixer.getLastRoot();
      expect(newRoot).to.not.equal(roots[roots.length - 1]);
      roots.push(newRoot);
    }

    // All collected roots must be distinct
    const unique = new Set(roots.map(String));
    expect(unique.size).to.equal(roots.length);
  });

  it("inserting the same leaf at different positions gives different roots", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const [, depositor] = await ethers.getSigners();

    const leaf = randomLeaf();

    // Insert leaf at position 0
    await mixer.connect(depositor).deposit(leaf, { value: DENOMINATION });
    const rootAtPos0 = await mixer.getLastRoot();

    // Pad with a different leaf so leaf occupies position 1
    const filler = randomLeaf();
    const { mixer: mixer2 } = await deployMixerFixture();
    await mixer2.connect(depositor).deposit(filler, { value: DENOMINATION });
    await mixer2.connect(depositor).deposit(leaf, { value: DENOMINATION });
    const rootAtPos1 = await mixer2.getLastRoot();

    expect(rootAtPos0).to.not.equal(rootAtPos1);
  });

  // ---------------------------------------------------------------------------
  // hashLeftRight properties
  // ---------------------------------------------------------------------------

  it("hashLeftRight is not commutative: hash(a,b) != hash(b,a) for a != b", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const a = randomLeaf();
    const b = a + 1n;

    const ab = await mixer.hashLeftRight(a, b);
    const ba = await mixer.hashLeftRight(b, a);

    expect(ab).to.not.equal(ba);
  });

  it("hashLeftRight is deterministic: same inputs always produce the same output", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const a = randomLeaf();
    const b = randomLeaf();

    const first = await mixer.hashLeftRight(a, b);
    const second = await mixer.hashLeftRight(a, b);

    expect(first).to.equal(second);
  });

  // ---------------------------------------------------------------------------
  // Zero-value chain
  // ---------------------------------------------------------------------------

  it("zero values chain: zeros[i+1] = hash(zeros[i], zeros[i])", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    // Verify the chain from level 0 upwards matches the off-chain computation
    let currentZero = 0n;
    for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) {
      const next = await mixer.hashLeftRight(currentZero, currentZero);
      const offChain = F.toObject(poseidon([currentZero, currentZero]));
      expect(next).to.equal(offChain);
      currentZero = next;
    }

    // currentZero is now the expected empty-tree root
    const emptyRoot = await mixer.getLastRoot();
    expect(emptyRoot).to.equal(currentZero);
  });

  // ---------------------------------------------------------------------------
  // Root after N insertions is independent of insertion timing
  // ---------------------------------------------------------------------------

  it("tree root after N insertions is independent of insertion timing", async function () {
    const [, depositor] = await ethers.getSigners();

    // Build two sets of identical leaves
    const leaves = Array.from({ length: 4 }, () => randomLeaf());

    // Deployment A: insert one by one
    const { mixer: mixerA } = await deployMixerFixture();
    for (const leaf of leaves) {
      await mixerA.connect(depositor).deposit(leaf, { value: DENOMINATION });
    }
    const rootA = await mixerA.getLastRoot();

    // Deployment B: same leaves in the same order (timing differs by block)
    const { mixer: mixerB } = await deployMixerFixture();
    for (const leaf of leaves) {
      await mixerB.connect(depositor).deposit(leaf, { value: DENOMINATION });
    }
    const rootB = await mixerB.getLastRoot();

    expect(rootA).to.equal(rootB);
  });

  // ---------------------------------------------------------------------------
  // Root history / isKnownRoot
  // ---------------------------------------------------------------------------

  it("isKnownRoot returns true for all roots within ROOT_HISTORY_SIZE window", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const [, depositor] = await ethers.getSigners();

    const collectedRoots: bigint[] = [await mixer.getLastRoot()];

    // Insert ROOT_HISTORY_SIZE - 1 leaves (window is 30; initial root occupies slot 0)
    for (let i = 0; i < Number(ROOT_HISTORY_SIZE) - 1; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomLeaf(), { value: DENOMINATION });
      collectedRoots.push(await mixer.getLastRoot());
    }

    // Every collected root should still be known
    for (const root of collectedRoots) {
      expect(await mixer.isKnownRoot(root)).to.equal(true);
    }
  });

  it("isKnownRoot returns false for evicted roots beyond the window", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const [, depositor] = await ethers.getSigners();

    // Capture the initial empty-tree root (slot 0)
    const evictedRoot = await mixer.getLastRoot();

    // Insert ROOT_HISTORY_SIZE leaves to overwrite every slot in the ring buffer
    for (let i = 0; i < Number(ROOT_HISTORY_SIZE); i++) {
      await mixer
        .connect(depositor)
        .deposit(randomLeaf(), { value: DENOMINATION });
    }

    // The initial root is now evicted
    expect(await mixer.isKnownRoot(evictedRoot)).to.equal(false);
  });

  it("getValidRootCount grows with deposits up to ROOT_HISTORY_SIZE + 1", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const [, depositor] = await ethers.getSigners();

    // Initial state: 1 valid root (the empty-tree root stored at roots[0])
    expect(await mixer.getValidRootCount()).to.equal(1n);

    // Insert 3 leaves: each adds one non-zero root to the ring buffer
    for (let i = 0; i < 3; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomLeaf(), { value: DENOMINATION });
      const count = await mixer.getValidRootCount();
      expect(count).to.equal(BigInt(i + 2)); // starts at 1, increments by 1
    }

    // Once every slot is filled the count is capped at ROOT_HISTORY_SIZE
    for (
      let i = 4;
      i <= Number(ROOT_HISTORY_SIZE);
      i++
    ) {
      await mixer
        .connect(depositor)
        .deposit(randomLeaf(), { value: DENOMINATION });
    }
    const saturatedCount = await mixer.getValidRootCount();
    expect(saturatedCount).to.equal(ROOT_HISTORY_SIZE);
  });
});
