import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, depositor, recipient] = await ethers.getSigners();

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

  return { mixer, owner, depositor, recipient };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("Pagination", function () {
  it("getCommitments(0, 0) returns empty array", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const result = await mixer.getCommitments(0, 0);
    expect(result.length).to.equal(0);
  });

  it("getCommitments(0, 1) returns first commitment after 1 deposit", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const c = randomCommitment();
    await mixer.connect(depositor).deposit(c, { value: DENOMINATION });

    const result = await mixer.getCommitments(0, 1);
    expect(result.length).to.equal(1);
    expect(result[0]).to.equal(c);
  });

  it("getCommitments(0, 5) returns all 5 after 5 deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const inserted: bigint[] = [];

    for (let i = 0; i < 5; i++) {
      const c = randomCommitment();
      inserted.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    const result = await mixer.getCommitments(0, 5);
    expect(result.length).to.equal(5);
    for (let i = 0; i < 5; i++) {
      expect(result[i]).to.equal(inserted[i]);
    }
  });

  it("getCommitments(2, 3) returns correct slice from middle", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const inserted: bigint[] = [];

    for (let i = 0; i < 6; i++) {
      const c = randomCommitment();
      inserted.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    // Indexes 2, 3, 4
    const result = await mixer.getCommitments(2, 3);
    expect(result.length).to.equal(3);
    expect(result[0]).to.equal(inserted[2]);
    expect(result[1]).to.equal(inserted[3]);
    expect(result[2]).to.equal(inserted[4]);
  });

  it("getCommitments(0, 100) clamps to actual count", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const inserted: bigint[] = [];

    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      inserted.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    const result = await mixer.getCommitments(0, 100);
    expect(result.length).to.equal(3);
    for (let i = 0; i < 3; i++) {
      expect(result[i]).to.equal(inserted[i]);
    }
  });

  it("getCommitments(99, 5) returns empty when past nextIndex", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const c = randomCommitment();
    await mixer.connect(depositor).deposit(c, { value: DENOMINATION });

    // nextIndex is 1; _from = 99 is beyond
    const result = await mixer.getCommitments(99, 5);
    expect(result.length).to.equal(0);
  });

  it("getCommitments returns commitments in insertion order", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitments: bigint[] = [];

    for (let i = 0; i < 8; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    const result = await mixer.getCommitments(0, 8);
    expect(result.length).to.equal(8);
    for (let i = 0; i < 8; i++) {
      expect(result[i]).to.equal(commitments[i]);
    }
  });

  it("pagination is consistent with indexToCommitment", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitments: bigint[] = [];

    for (let i = 0; i < 5; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    const page = await mixer.getCommitments(0, 5);

    // Each entry from getCommitments must match the direct indexToCommitment lookup
    for (let i = 0; i < 5; i++) {
      const direct = await mixer.indexToCommitment(i);
      expect(page[i]).to.equal(direct);
    }
  });

  it("after withdrawal, getCommitments still returns all (not removed)", async function () {
    const { mixer, depositor, recipient } = await loadFixture(deployFixture);
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    // Perform a withdrawal (dummy proof — test verifier accepts anything)
    await mixer.connect(depositor).withdraw(
      [0n, 0n],
      [[0n, 0n], [0n, 0n]],
      [0n, 0n],
      root,
      nullifierHash,
      recipient.address,
      ethers.ZeroAddress,
      0n
    );

    // Commitments are leaves and are never removed after a withdrawal
    const result = await mixer.getCommitments(0, 10);
    expect(result.length).to.equal(2);
    expect(result[0]).to.equal(c1);
    expect(result[1]).to.equal(c2);
  });

  it("getCommitments gas is linear in count", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 10; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // Estimate gas for small vs larger slice to assert linear-ish growth
    const gasSmall = await mixer.getCommitments.estimateGas(0, 2);
    const gasLarge = await mixer.getCommitments.estimateGas(0, 10);

    // Large slice should cost more than small slice
    expect(gasLarge).to.be.greaterThan(gasSmall);

    // Growth must be sub-quadratic: ratio ≤ 5× for a 5× count increase
    const ratio = Number(gasLarge) / Number(gasSmall);
    expect(ratio).to.be.lessThan(5);
  });
});
