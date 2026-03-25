import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";
import type { MixerLens } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

// Gas ceiling for view calls — anything beyond 200 k indicates an unintended loop
const VIEW_GAS_LIMIT = 200_000n;

async function deployFixture() {
  const [owner, alice] = await ethers.getSigners();

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

  const LensFactory = await ethers.getContractFactory("MixerLens");
  const lens = (await LensFactory.deploy()) as unknown as MixerLens;

  return { mixer, lens, owner, alice };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate gas for a static call and assert it is below VIEW_GAS_LIMIT.
 * ethers v6 staticCall does not return gas — use provider.estimateGas with
 * the encoded call data instead.
 */
async function assertReasonableGas(
  contract: { getAddress(): Promise<string>; interface: { encodeFunctionData(fn: string, args?: unknown[]): string } },
  fn: string,
  args: unknown[] = []
): Promise<void> {
  const to = await contract.getAddress();
  const data = contract.interface.encodeFunctionData(fn, args);
  const provider = ethers.provider;
  const gas = await provider.estimateGas({ to, data });
  expect(gas).to.be.lessThanOrEqual(
    VIEW_GAS_LIMIT,
    `${fn} used ${gas} gas — exceeds VIEW_GAS_LIMIT of ${VIEW_GAS_LIMIT}`
  );
}

// ---------------------------------------------------------------------------
// View Function Accessibility
// ---------------------------------------------------------------------------

describe("View Function Accessibility", function () {
  // -------------------------------------------------------------------------
  // denomination() — immutable public variable
  // -------------------------------------------------------------------------

  it("denomination callable by alice returns a positive bigint", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).denomination();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(DENOMINATION);
    await assertReasonableGas(mixer, "denomination");
  });

  // -------------------------------------------------------------------------
  // levels() — immutable from MerkleTree
  // -------------------------------------------------------------------------

  it("levels callable by alice returns a number", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).levels();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(BigInt(MERKLE_TREE_HEIGHT));
    await assertReasonableGas(mixer, "levels");
  });

  // -------------------------------------------------------------------------
  // getLastRoot()
  // -------------------------------------------------------------------------

  it("getLastRoot callable by alice returns a bigint", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getLastRoot();
    expect(typeof result).to.equal("bigint");
    // Fresh tree — root should be non-zero (empty-tree root)
    expect(result).to.be.greaterThan(0n);
    await assertReasonableGas(mixer, "getLastRoot");
  });

  // -------------------------------------------------------------------------
  // isKnownRoot(uint256)
  // -------------------------------------------------------------------------

  it("isKnownRoot callable by alice returns a boolean", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const root = await mixer.getLastRoot();
    const result = await mixer.connect(alice).isKnownRoot(root);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(true);
    await assertReasonableGas(mixer, "isKnownRoot", [root]);
  });

  it("isKnownRoot returns false for unknown root when called by alice", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).isKnownRoot(1n);
    expect(result).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // isSpent(uint256)
  // -------------------------------------------------------------------------

  it("isSpent callable by alice returns a boolean", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).isSpent(12345n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
    await assertReasonableGas(mixer, "isSpent", [12345n]);
  });

  // -------------------------------------------------------------------------
  // isCommitted(uint256)
  // -------------------------------------------------------------------------

  it("isCommitted callable by alice returns a boolean", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).isCommitted(99n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
    await assertReasonableGas(mixer, "isCommitted", [99n]);
  });

  // -------------------------------------------------------------------------
  // getStats()
  // -------------------------------------------------------------------------

  it("getStats callable by alice returns a tuple of bigints", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.connect(alice).getStats();
    expect(typeof totalDeposited).to.equal("bigint");
    expect(typeof totalWithdrawn).to.equal("bigint");
    expect(typeof depositCount).to.equal("bigint");
    expect(typeof withdrawalCount).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    // Fresh deployment — all counters start at zero
    expect(totalDeposited).to.equal(0n);
    expect(withdrawalCount).to.equal(0n);
    await assertReasonableGas(mixer, "getStats");
  });

  // -------------------------------------------------------------------------
  // getAnonymitySetSize()
  // -------------------------------------------------------------------------

  it("getAnonymitySetSize callable by alice returns a bigint", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getAnonymitySetSize();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(0n);
    await assertReasonableGas(mixer, "getAnonymitySetSize");
  });

  // -------------------------------------------------------------------------
  // getPoolHealth()
  // -------------------------------------------------------------------------

  it("getPoolHealth callable by alice returns correct types", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.connect(alice).getPoolHealth();
    expect(typeof anonymitySetSize).to.equal("bigint");
    expect(typeof treeUtilization).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    expect(typeof isPaused).to.equal("boolean");
    expect(isPaused).to.equal(false);
    await assertReasonableGas(mixer, "getPoolHealth");
  });

  // -------------------------------------------------------------------------
  // getTreeCapacity()
  // -------------------------------------------------------------------------

  it("getTreeCapacity callable by alice returns 2^levels", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getTreeCapacity();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(2n ** BigInt(MERKLE_TREE_HEIGHT));
    await assertReasonableGas(mixer, "getTreeCapacity");
  });

  // -------------------------------------------------------------------------
  // getTreeUtilization()
  // -------------------------------------------------------------------------

  it("getTreeUtilization callable by alice returns a bigint", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getTreeUtilization();
    expect(typeof result).to.equal("bigint");
    // Fresh tree — 0 % utilization
    expect(result).to.equal(0n);
    await assertReasonableGas(mixer, "getTreeUtilization");
  });

  // -------------------------------------------------------------------------
  // hasCapacity()
  // -------------------------------------------------------------------------

  it("hasCapacity callable by alice returns a boolean", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).hasCapacity();
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(true);
    await assertReasonableGas(mixer, "hasCapacity");
  });

  // -------------------------------------------------------------------------
  // getRootHistory()
  // -------------------------------------------------------------------------

  it("getRootHistory callable by alice returns an array of bigints", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getRootHistory();
    expect(Array.isArray(result)).to.equal(true);
    expect(result.length).to.equal(30); // ROOT_HISTORY_SIZE
    for (const entry of result) {
      expect(typeof entry).to.equal("bigint");
    }
    await assertReasonableGas(mixer, "getRootHistory");
  });

  // -------------------------------------------------------------------------
  // getValidRootCount()
  // -------------------------------------------------------------------------

  it("getValidRootCount callable by alice returns a bigint", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getValidRootCount();
    expect(typeof result).to.equal("bigint");
    // One initial root (empty tree root) is stored in roots[0]
    expect(result).to.be.greaterThanOrEqual(1n);
    await assertReasonableGas(mixer, "getValidRootCount");
  });

  // -------------------------------------------------------------------------
  // getCommitments(uint32, uint32)
  // -------------------------------------------------------------------------

  it("getCommitments callable by alice returns an array", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const result = await mixer.connect(alice).getCommitments(0, 10);
    expect(Array.isArray(result)).to.equal(true);
    // No deposits yet — empty array
    expect(result.length).to.equal(0);
    await assertReasonableGas(mixer, "getCommitments", [0, 10]);
  });

  // -------------------------------------------------------------------------
  // MixerLens.getSnapshot() callable by alice
  // -------------------------------------------------------------------------

  it("MixerLens.getSnapshot callable by alice returns a full snapshot", async function () {
    const { mixer, lens, alice } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();
    const snapshot = await lens.connect(alice).getSnapshot(mixerAddress);

    expect(typeof snapshot.totalDeposited).to.equal("bigint");
    expect(typeof snapshot.totalWithdrawn).to.equal("bigint");
    expect(typeof snapshot.depositCount).to.equal("bigint");
    expect(typeof snapshot.withdrawalCount).to.equal("bigint");
    expect(typeof snapshot.poolBalance).to.equal("bigint");
    expect(typeof snapshot.anonymitySetSize).to.equal("bigint");
    expect(typeof snapshot.treeCapacity).to.equal("bigint");
    expect(typeof snapshot.treeUtilization).to.equal("bigint");
    expect(typeof snapshot.lastRoot).to.equal("bigint");
    expect(typeof snapshot.denomination).to.equal("bigint");
    expect(typeof snapshot.isPaused).to.equal("boolean");
    expect(typeof snapshot.maxDepositsPerAddress).to.equal("bigint");
    expect(typeof snapshot.owner).to.equal("string");
    expect(typeof snapshot.version).to.equal("string");

    expect(snapshot.denomination).to.equal(DENOMINATION);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.version).to.equal("1.0.0");
  });
});
