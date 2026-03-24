import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

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

  return { mixer, verifier, hasherAddress, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Security: Pausable + Ownable
// ---------------------------------------------------------------------------

describe("Mixer — Security", function () {
  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------

  describe("Ownership", function () {
    it("deployer is set as owner", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      expect(await mixer.owner()).to.equal(await owner.getAddress());
    });

    it("non-owner cannot call pause", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await expect(mixer.connect(alice).pause()).to.be.revertedWithCustomError(
        mixer,
        "OwnableUnauthorizedAccount"
      );
    });

    it("non-owner cannot call unpause", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await expect(
        mixer.connect(alice).unpause()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // Pausable
  // -------------------------------------------------------------------------

  describe("Pausable", function () {
    it("contract starts unpaused", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.paused()).to.be.false;
    });

    it("owner can pause the contract", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      expect(await mixer.paused()).to.be.true;
    });

    it("owner can unpause the contract", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await mixer.connect(owner).unpause();
      expect(await mixer.paused()).to.be.false;
    });

    it("pause emits Paused event", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(mixer.connect(owner).pause())
        .to.emit(mixer, "Paused")
        .withArgs(await owner.getAddress());
    });

    it("unpause emits Unpaused event", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await expect(mixer.connect(owner).unpause())
        .to.emit(mixer, "Unpaused")
        .withArgs(await owner.getAddress());
    });

    // -----------------------------------------------------------------------
    // Deposit reverts when paused
    // -----------------------------------------------------------------------

    it("deposit reverts when paused", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();

      const commitment = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("deposit succeeds after unpause", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await mixer.connect(owner).unpause();

      const commitment = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
      ).to.not.be.reverted;
    });

    // -----------------------------------------------------------------------
    // Withdraw reverts when paused
    // -----------------------------------------------------------------------

    it("withdraw reverts when paused", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

      // Deposit first so the contract has funds and a known root
      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await alice.getAddress();
      const relayerAddr = await alice.getAddress();

      // Pause after deposit, before withdraw
      await mixer.connect(owner).pause();

      await expect(
        mixer.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifierHash,
          recipientAddr,
          relayerAddr,
          0n
        )
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("withdraw succeeds after unpause", async function () {
      const { mixer, owner, alice, bob } = await loadFixture(deployMixerFixture);

      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await bob.getAddress();
      const relayerAddr = await bob.getAddress();

      await mixer.connect(owner).pause();
      await mixer.connect(owner).unpause();

      await expect(
        mixer.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifierHash,
          recipientAddr,
          relayerAddr,
          0n
        )
      ).to.not.be.reverted;
    });
  });
});
