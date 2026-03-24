import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// Shallow tree so tests run fast and capacity math is straightforward
const MERKLE_TREE_HEIGHT = 5;
const EXPECTED_CAPACITY = 2 ** MERKLE_TREE_HEIGHT; // 32

// 0.1 ETH denomination required by the Mixer constructor
const DENOMINATION = 100_000_000_000_000_000n;

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
  const [owner, depositor] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );

  return { mixer, owner, depositor };
}

describe("MerkleTree view functions", function () {
  describe("getTreeCapacity", function () {
    it("returns 2^levels for the configured tree height", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const capacity = await mixer.getTreeCapacity();
      expect(capacity).to.equal(BigInt(EXPECTED_CAPACITY));
    });
  });

  describe("getTreeUtilization", function () {
    it("returns 0 when no deposits have been made", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const utilization = await mixer.getTreeUtilization();
      expect(utilization).to.equal(0n);
    });

    it("increases after a deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      const commitment = randomCommitment();
      await mixer
        .connect(depositor)
        .deposit(commitment, { value: DENOMINATION });

      // 1 leaf out of 32 = floor(1 * 100 / 32) = 3
      const utilization = await mixer.getTreeUtilization();
      expect(utilization).to.equal(3n);
    });

    it("increases proportionally with more deposits", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      // Insert 4 leaves: floor(4 * 100 / 32) = 12
      for (let i = 0; i < 4; i++) {
        await mixer
          .connect(depositor)
          .deposit(randomCommitment(), { value: DENOMINATION });
      }

      const utilization = await mixer.getTreeUtilization();
      expect(utilization).to.equal(12n);
    });
  });

  describe("hasCapacity", function () {
    it("returns true on a fresh deployment", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.hasCapacity()).to.equal(true);
    });

    it("returns true after some deposits when the tree is not full", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await mixer
        .connect(depositor)
        .deposit(randomCommitment(), { value: DENOMINATION });

      expect(await mixer.hasCapacity()).to.equal(true);
    });
  });
});
