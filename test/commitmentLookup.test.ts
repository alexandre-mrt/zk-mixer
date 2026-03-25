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
  const [owner, depositor] = await ethers.getSigners();

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

  return { mixer, owner, depositor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reverse commitment lookup and paginated listing (Mixer)", function () {
  it("indexToCommitment returns the correct commitment after a deposit", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const leafIndex = await mixer.commitmentIndex(commitment);
    const stored = await mixer.indexToCommitment(leafIndex);
    expect(stored).to.equal(commitment);
  });

  it("getCommitments returns the correct range after multiple deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c3, { value: DENOMINATION });

    const page = await mixer.getCommitments(0, 3);
    expect(page.length).to.equal(3);
    expect(page[0]).to.equal(c1);
    expect(page[1]).to.equal(c2);
    expect(page[2]).to.equal(c3);
  });

  it("getCommitments with _from >= nextIndex returns empty array", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // nextIndex is 1 after one deposit; _from = 5 is beyond the tree
    const result = await mixer.getCommitments(5, 3);
    expect(result.length).to.equal(0);
  });

  it("multiple deposits maintain correct ordering in indexToCommitment", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitments: bigint[] = [];

    for (let i = 0; i < 4; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    for (let i = 0; i < commitments.length; i++) {
      const stored = await mixer.indexToCommitment(i);
      expect(stored).to.equal(commitments[i]);
    }
  });

  it("getCommitments clamps _count to nextIndex when range exceeds deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });

    // Request 10 but only 2 exist
    const result = await mixer.getCommitments(0, 10);
    expect(result.length).to.equal(2);
    expect(result[0]).to.equal(c1);
    expect(result[1]).to.equal(c2);
  });
});
