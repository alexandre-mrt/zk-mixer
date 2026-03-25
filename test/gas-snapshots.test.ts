import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

// Thresholds set at ~2x observed gas to catch major regressions without false
// positives from minor EVM or compiler changes.
const MAX_DEPOSIT_GAS = 400_000n;
const MAX_WITHDRAW_GAS = 150_000n; // placeholder verifier is cheap

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
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Gas Snapshots
// ---------------------------------------------------------------------------

describe("Gas Snapshots", function () {
  // -------------------------------------------------------------------------
  // Deposit
  // -------------------------------------------------------------------------

  describe("deposit", function () {
    it("deposit gas is below threshold", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const c = randomCommitment();
      const tx = await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Deposit gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_DEPOSIT_GAS,
        `deposit used ${gas} gas, threshold is ${MAX_DEPOSIT_GAS}`
      );
    });

    it("deposit gas stays stable across 10 sequential deposits", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const gasUsage: bigint[] = [];

      for (let i = 0; i < 10; i++) {
        const c = randomCommitment();
        const tx = await mixer
          .connect(alice)
          .deposit(c, { value: DENOMINATION });
        const receipt = await tx.wait();
        gasUsage.push(receipt!.gasUsed);
      }

      console.log("    Gas per deposit (10 sequential):");
      for (const [i, g] of gasUsage.entries()) {
        console.log(`      Deposit ${i + 1}: ${g}`);
      }

      // All deposits must stay below the threshold individually
      for (const [i, g] of gasUsage.entries()) {
        expect(g).to.be.lessThan(
          MAX_DEPOSIT_GAS,
          `deposit ${i + 1} used ${g} gas, threshold is ${MAX_DEPOSIT_GAS}`
        );
      }

      // All deposits must stay within 20% of each other (no outlier)
      const sum = gasUsage.reduce((a, b) => a + b, 0n);
      const avg = sum / BigInt(gasUsage.length);

      for (const [i, g] of gasUsage.entries()) {
        const diff = g > avg ? g - avg : avg - g;
        expect(diff * 100n / avg).to.be.lessThan(
          20n,
          `deposit ${i + 1} gas ${g} deviates more than 20% from avg ${avg}`
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Withdraw
  // -------------------------------------------------------------------------

  describe("withdraw", function () {
    it("withdraw gas is below threshold", async function () {
      const { mixer, alice, bob } = await loadFixture(deployFixture);

      // Deposit first so there is a valid root
      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      const nullifierHash = randomCommitment();
      const tx = await mixer.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        bob.address,
        ethers.ZeroAddress, // no relayer
        0n // no fee
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Withdraw gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_WITHDRAW_GAS,
        `withdraw used ${gas} gas, threshold is ${MAX_WITHDRAW_GAS}`
      );
    });

    it("withdraw with relayer fee gas is below threshold", async function () {
      const { mixer, alice, bob, relayer } = await loadFixture(deployFixture);

      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      const nullifierHash = randomCommitment();
      const fee = 1_000_000_000_000_000n; // 0.001 ETH
      const tx = await mixer.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        bob.address,
        relayer.address,
        fee
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Withdraw (with relayer fee) gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_WITHDRAW_GAS,
        `withdraw with relayer fee used ${gas} gas, threshold is ${MAX_WITHDRAW_GAS}`
      );
    });
  });
});
