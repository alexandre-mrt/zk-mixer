import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const TIMELOCK_DELAY_SECONDS = 86_400n; // 1 day
const ROOT_HISTORY_SIZE = 30n;
const HARDHAT_CHAIN_ID = 31337n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, depositor] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const verifierAddress = await verifier.getAddress();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, verifierAddress, hasherAddress, owner, depositor };
}

// ---------------------------------------------------------------------------
// Immutability and Determinism
// ---------------------------------------------------------------------------

describe("Immutability and Determinism", function () {
  // -------------------------------------------------------------------------
  // Immutable storage slots survive state changes
  // -------------------------------------------------------------------------

  it("denomination unchanged after 5 deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const denominationBefore = await mixer.denomination();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.denomination()).to.equal(denominationBefore);
    expect(await mixer.denomination()).to.equal(DENOMINATION);
  });

  it("levels unchanged after tree mutations", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const levelsBefore = await mixer.levels();

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.levels()).to.equal(levelsBefore);
    expect(await mixer.levels()).to.equal(BigInt(MERKLE_TREE_HEIGHT));
  });

  it("verifier address unchanged after deposits", async function () {
    const { mixer, depositor, verifierAddress } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.verifier()).to.equal(verifierAddress);
  });

  it("hasher address unchanged after deposits", async function () {
    const { mixer, depositor, hasherAddress } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.hasher()).to.equal(hasherAddress);
  });

  it("deployedChainId unchanged after deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const chainIdBefore = await mixer.deployedChainId();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.deployedChainId()).to.equal(chainIdBefore);
    expect(await mixer.deployedChainId()).to.equal(HARDHAT_CHAIN_ID);
  });

  it("TIMELOCK_DELAY is constant and unchanged after state changes", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const delayBefore = await mixer.TIMELOCK_DELAY();

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.TIMELOCK_DELAY()).to.equal(delayBefore);
    expect(await mixer.TIMELOCK_DELAY()).to.equal(TIMELOCK_DELAY_SECONDS);
  });

  it("ROOT_HISTORY_SIZE is constant and unchanged after tree mutations", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const sizeBefore = await mixer.ROOT_HISTORY_SIZE();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    expect(await mixer.ROOT_HISTORY_SIZE()).to.equal(sizeBefore);
    expect(await mixer.ROOT_HISTORY_SIZE()).to.equal(ROOT_HISTORY_SIZE);
  });

  // -------------------------------------------------------------------------
  // View function determinism — same input, same output, no state change
  // -------------------------------------------------------------------------

  it("getLastRoot returns same value on consecutive calls without state change", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    // Perform one deposit so the tree has a non-trivial root
    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const root1 = await mixer.getLastRoot();
    const root2 = await mixer.getLastRoot();
    const root3 = await mixer.getLastRoot();

    expect(root1).to.equal(root2);
    expect(root2).to.equal(root3);
    expect(root1).to.be.greaterThan(0n);
  });

  it("getStats returns same values on consecutive calls without state change", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    const stats1 = await mixer.getStats();
    const stats2 = await mixer.getStats();

    expect(stats1[0]).to.equal(stats2[0]); // totalDeposited
    expect(stats1[1]).to.equal(stats2[1]); // totalWithdrawn
    expect(stats1[2]).to.equal(stats2[2]); // depositCount
    expect(stats1[3]).to.equal(stats2[3]); // withdrawalCount
    expect(stats1[4]).to.equal(stats2[4]); // poolBalance
  });

  it("getPoolHealth returns same values on consecutive calls without state change", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    const health1 = await mixer.getPoolHealth();
    const health2 = await mixer.getPoolHealth();

    expect(health1[0]).to.equal(health2[0]); // anonymitySetSize
    expect(health1[1]).to.equal(health2[1]); // treeUtilization
    expect(health1[2]).to.equal(health2[2]); // poolBalance
    expect(health1[3]).to.equal(health2[3]); // isPaused
  });

  it("isKnownRoot is deterministic for the same root", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();

    const result1 = await mixer.isKnownRoot(root);
    const result2 = await mixer.isKnownRoot(root);
    const result3 = await mixer.isKnownRoot(root);

    expect(result1).to.equal(result2);
    expect(result2).to.equal(result3);
    expect(result1).to.be.true;

    // Unknown root is also deterministically false
    const unknownRoot = randomCommitment();
    const unknown1 = await mixer.isKnownRoot(unknownRoot);
    const unknown2 = await mixer.isKnownRoot(unknownRoot);
    expect(unknown1).to.equal(unknown2);
    expect(unknown1).to.be.false;
  });

  it("hashLeftRight(a, b) is deterministic across multiple calls", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const left = 1n;
    const right = 2n;

    const hash1 = await mixer.hashLeftRight(left, right);
    const hash2 = await mixer.hashLeftRight(left, right);
    const hash3 = await mixer.hashLeftRight(left, right);

    expect(hash1).to.equal(hash2);
    expect(hash2).to.equal(hash3);
    expect(hash1).to.be.greaterThan(0n);

    // Different inputs produce different outputs
    const hashDiff = await mixer.hashLeftRight(right, left);
    expect(hash1).to.not.equal(hashDiff);
  });
});
