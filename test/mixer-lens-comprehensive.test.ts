import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const TREE_CAPACITY = BigInt(2 ** MERKLE_TREE_HEIGHT); // 32
const ONE_DAY = 24 * 60 * 60;

// Groth16Verifier in the test suite always returns true for any input.
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function randomNullifierHash(): bigint {
  return BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) + 1n;
}

function maxDepositsActionHash(max: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setMaxDepositsPerAddress", max])
  );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, recipient] = await ethers.getSigners();

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

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  return { mixer, mixerLens, owner, alice, bob, recipient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MixerLens Comprehensive", function () {
  // -------------------------------------------------------------------------
  // Empty pool
  // -------------------------------------------------------------------------

  it("snapshot with empty pool has all zero stats", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.totalDeposited).to.equal(0n);
    expect(snapshot.totalWithdrawn).to.equal(0n);
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(0n);
    expect(snapshot.anonymitySetSize).to.equal(0n);
    expect(snapshot.treeCapacity).to.equal(TREE_CAPACITY);
    expect(snapshot.treeUtilization).to.equal(0n);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.maxDepositsPerAddress).to.equal(0n);
    expect(snapshot.owner).to.equal(owner.address);
    // lastRoot is the initial empty-tree root — must be non-zero
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Single deposit
  // -------------------------------------------------------------------------

  it("snapshot after 1 deposit shows correct counts", async function () {
    const { mixer, mixerLens, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    // Compare against individual contract call results
    const [td, tw, dc, wc, pb] = await mixer.getStats();
    expect(snapshot.totalDeposited).to.equal(td);
    expect(snapshot.totalWithdrawn).to.equal(tw);
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.poolBalance).to.equal(pb);

    expect(snapshot.totalDeposited).to.equal(DENOMINATION);
    expect(snapshot.depositCount).to.equal(1n);
    expect(snapshot.anonymitySetSize).to.equal(1n);
    expect(snapshot.poolBalance).to.equal(DENOMINATION);
    expect(snapshot.treeUtilization).to.equal((1n * 100n) / TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // 3 deposits + 1 withdrawal
  // -------------------------------------------------------------------------

  it("snapshot after 3 deposits + 1 withdrawal", async function () {
    const { mixer, mixerLens, alice, recipient } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    // Deposit 3 times
    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // Withdraw once using the current root
    const root = await mixer.getLastRoot();
    const nullifierHash = randomNullifierHash();
    await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      recipient.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.depositCount).to.equal(3n);
    expect(snapshot.withdrawalCount).to.equal(1n);
    expect(snapshot.totalDeposited).to.equal(DENOMINATION * 3n);
    expect(snapshot.totalWithdrawn).to.equal(DENOMINATION);
    expect(snapshot.poolBalance).to.equal(DENOMINATION * 2n);
    // anonymitySetSize = deposits - withdrawals
    expect(snapshot.anonymitySetSize).to.equal(2n);
    expect(snapshot.treeUtilization).to.equal((3n * 100n) / TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // Denomination
  // -------------------------------------------------------------------------

  it("snapshot reflects denomination correctly", async function () {
    const { mixer, mixerLens } = await loadFixture(deployFixture);
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.denomination).to.equal(DENOMINATION);
    // Also cross-check against the direct getter
    expect(snapshot.denomination).to.equal(await mixer.denomination());
  });

  // -------------------------------------------------------------------------
  // Pause state change
  // -------------------------------------------------------------------------

  it("snapshot reflects pause state change", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    const initial = await mixerLens.getSnapshot(mixerAddress);
    expect(initial.isPaused).to.equal(false);

    await mixer.connect(owner).pause();
    const afterPause = await mixerLens.getSnapshot(mixerAddress);
    expect(afterPause.isPaused).to.equal(true);
    expect(afterPause.isPaused).to.equal(await mixer.paused());

    await mixer.connect(owner).unpause();
    const afterUnpause = await mixerLens.getSnapshot(mixerAddress);
    expect(afterUnpause.isPaused).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Version field
  // -------------------------------------------------------------------------

  it("snapshot version field is '1.0.0'", async function () {
    const { mixer, mixerLens } = await loadFixture(deployFixture);
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.version).to.equal("1.0.0");
    expect(snapshot.version).to.equal(await mixer.getVersion());
  });

  // -------------------------------------------------------------------------
  // Owner field
  // -------------------------------------------------------------------------

  it("snapshot owner is deployer address", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.owner).to.equal(owner.address);
    expect(snapshot.owner).to.equal(await mixer.owner());
  });

  // -------------------------------------------------------------------------
  // maxDepositsPerAddress after timelock
  // -------------------------------------------------------------------------

  it("snapshot reflects maxDepositsPerAddress after timelock set", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    const newMax = 3n;
    const actionHash = maxDepositsActionHash(newMax);
    await mixer.connect(owner).queueAction(actionHash);
    await time.increase(ONE_DAY + 1);
    await mixer.connect(owner).setMaxDepositsPerAddress(newMax);

    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.maxDepositsPerAddress).to.equal(newMax);
    expect(snapshot.maxDepositsPerAddress).to.equal(await mixer.maxDepositsPerAddress());
  });

  // -------------------------------------------------------------------------
  // Tree utilization
  // -------------------------------------------------------------------------

  it("snapshot treeUtilization is non-zero after deposits", async function () {
    const { mixer, mixerLens, alice } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.treeUtilization).to.be.gt(0n);
    // Cross-check against the contract's own view
    expect(snapshot.treeUtilization).to.equal(await mixer.getTreeUtilization());
  });

  // -------------------------------------------------------------------------
  // Two distinct pool addresses return independent data
  // -------------------------------------------------------------------------

  it("snapshot with different pool addresses returns different data", async function () {
    const [owner, alice] = await ethers.getSigners();

    const hasherAddress = await deployHasher();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    const MixerFactory = await ethers.getContractFactory("Mixer");

    const mixer1 = (await MixerFactory.deploy(
      await verifier.getAddress(),
      DENOMINATION,
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as Mixer;

    const DENOMINATION_2 = ethers.parseEther("0.5");
    const mixer2 = (await MixerFactory.deploy(
      await verifier.getAddress(),
      DENOMINATION_2,
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as Mixer;

    const MixerLensFactory = await ethers.getContractFactory("MixerLens");
    const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

    // Deposit only into mixer1
    await mixer1.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const snap1 = await mixerLens.getSnapshot(await mixer1.getAddress());
    const snap2 = await mixerLens.getSnapshot(await mixer2.getAddress());

    expect(snap1.depositCount).to.equal(1n);
    expect(snap2.depositCount).to.equal(0n);
    expect(snap1.denomination).to.not.equal(snap2.denomination);
    expect(snap1.denomination).to.equal(DENOMINATION);
    expect(snap2.denomination).to.equal(DENOMINATION_2);
  });

  // -------------------------------------------------------------------------
  // treeCapacity matches 2^MERKLE_TREE_HEIGHT
  // -------------------------------------------------------------------------

  it("snapshot treeCapacity matches 2^height after multiple deposits", async function () {
    const { mixer, mixerLens, alice } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    // Make 2 deposits
    for (let i = 0; i < 2; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.treeCapacity).to.equal(TREE_CAPACITY);
    expect(snapshot.treeCapacity).to.equal(await mixer.getTreeCapacity());
    // utilization = (insertions * 100) / capacity
    expect(snapshot.treeUtilization).to.equal((2n * 100n) / TREE_CAPACITY);
  });
});
