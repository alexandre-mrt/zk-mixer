import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5; // 2^5 = 32 leaves — small enough to fill in tests
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
// Fixtures
// ---------------------------------------------------------------------------

/** Standard Mixer — placeholder Groth16Verifier always returns true. */
async function deployMixerFixture() {
  const [owner, depositor, recipient, relayer, stranger] =
    await ethers.getSigners();

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

  return { mixer, owner, depositor, recipient, relayer, stranger };
}

/**
 * Small-tree Mixer (height=1 → 2 leaves) for tree-full tests.
 * We only need to fill 2 slots to trigger the revert.
 */
async function deploySmallTreeMixerFixture() {
  const [owner, depositor] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    1, // height 1 = 2 leaves
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, depositor };
}

async function depositNote(
  mixer: Mixer,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  commitment?: bigint
): Promise<{ commitment: bigint; root: bigint }> {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  const root = await mixer.getLastRoot();
  return { commitment: c, root };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Input Validation Exhaustive", function () {
  // -------------------------------------------------------------------------
  // deposit() — invalid commitment values
  // -------------------------------------------------------------------------

  describe("deposit() — invalid commitment values", function () {
    it("deposit(0): zero commitment reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(depositor).deposit(0n, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment is zero");
    });

    it("deposit(FIELD_SIZE): field overflow reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(depositor).deposit(FIELD_SIZE, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment >= field size");
    });

    it("deposit(FIELD_SIZE+1): field overflow reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer
          .connect(depositor)
          .deposit(FIELD_SIZE + 1n, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment >= field size");
    });

    it("deposit(MAX_UINT256): field overflow reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer
          .connect(depositor)
          .deposit(MAX_UINT256, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment >= field size");
    });

    it("deposit duplicate commitment: reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const c = randomCommitment();

      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });

      await expect(
        mixer.connect(depositor).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: duplicate commitment");
    });
  });

  // -------------------------------------------------------------------------
  // deposit() — wrong ETH amounts
  // -------------------------------------------------------------------------

  describe("deposit() — wrong ETH amounts", function () {
    it("deposit with 0 ETH: wrong amount reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(depositor).deposit(randomCommitment(), { value: 0n })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it("deposit with 0.05 ETH: wrong amount reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      // 0.05 ETH = half denomination
      const halfDenom = DENOMINATION / 2n;

      await expect(
        mixer
          .connect(depositor)
          .deposit(randomCommitment(), { value: halfDenom })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it("deposit with 0.2 ETH: wrong amount reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      // 0.2 ETH = 2x denomination
      const doubleDenom = DENOMINATION * 2n;

      await expect(
        mixer
          .connect(depositor)
          .deposit(randomCommitment(), { value: doubleDenom })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it("deposit with 1 ETH: wrong amount reverts", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      // 1 ETH = 10x denomination
      const oneEth = ethers.parseEther("1");

      await expect(
        mixer
          .connect(depositor)
          .deposit(randomCommitment(), { value: oneEth })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });
  });

  // -------------------------------------------------------------------------
  // deposit() — pause and tree-full states
  // -------------------------------------------------------------------------

  describe("deposit() — pause and capacity states", function () {
    it("deposit when paused: reverts with EnforcedPause", async function () {
      const { mixer, owner, depositor } = await loadFixture(deployMixerFixture);

      await mixer.connect(owner).pause();

      await expect(
        mixer
          .connect(depositor)
          .deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("deposit when tree full: reverts with MerkleTree: tree is full", async function () {
      // Height=1 tree has exactly 2 leaves; the third deposit overflows nextIndex.
      const { mixer, depositor } = await loadFixture(deploySmallTreeMixerFixture);

      // Fill both leaves
      await depositNote(mixer, depositor);
      await depositNote(mixer, depositor);

      // Third deposit must revert
      await expect(
        mixer
          .connect(depositor)
          .deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWith("MerkleTree: tree is full");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw() — invalid inputs
  // -------------------------------------------------------------------------

  describe("withdraw() — invalid inputs", function () {
    it("withdraw with spent nullifier: reverts", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      // First withdrawal spends the nullifier (placeholder verifier returns true)
      await mixer.connect(depositor).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        recipient.address as `0x${string}`,
        relayer.address as `0x${string}`,
        0n
      );

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: already spent");
    });

    it("withdraw with unknown root: reverts", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      await depositNote(mixer, depositor);
      const unknownRoot = randomCommitment();
      const nullifier = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          unknownRoot,
          nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: unknown root");
    });

    it("withdraw with zero recipient: reverts", async function () {
      const { mixer, depositor, relayer } =
        await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          ZERO_ADDRESS as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: recipient is zero address");
    });

    it("withdraw with fee > denomination: reverts", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          DENOMINATION + 1n
        )
      ).to.be.revertedWith("Mixer: fee exceeds denomination");
    });

    it("withdraw with non-zero fee + zero relayer: reverts", async function () {
      const { mixer, depositor, recipient } =
        await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();
      const fee = 1n;

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          recipient.address as `0x${string}`,
          ZERO_ADDRESS as `0x${string}`,
          fee
        )
      ).to.be.revertedWith("Mixer: relayer is zero address for non-zero fee");
    });

    it("withdraw when paused: reverts with EnforcedPause", async function () {
      const { mixer, owner, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);

      await mixer.connect(owner).pause();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          randomCommitment(),
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // Admin invalid inputs
  // -------------------------------------------------------------------------

  describe("admin — non-owner calls", function () {
    it("pause by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { mixer, stranger } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(stranger).pause()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("unpause by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { mixer, owner, stranger } = await loadFixture(deployMixerFixture);

      await mixer.connect(owner).pause();

      await expect(
        mixer.connect(stranger).unpause()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("queueAction by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { mixer, stranger } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(stranger).queueAction(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("setDepositReceipt by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { mixer, stranger } = await loadFixture(deployMixerFixture);

      await expect(
        mixer
          .connect(stranger)
          .setDepositReceipt(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("setMaxDepositsPerAddress by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { mixer, stranger } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(stranger).setMaxDepositsPerAddress(5n)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });
  });

  describe("admin — timelock guards", function () {
    it("cancelAction with no pending: reverts", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(owner).cancelAction()
      ).to.be.revertedWith("Mixer: no pending action");
    });

    it("execute before delay: reverts with Mixer: timelock not expired", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 3n]
        )
      );
      await mixer.connect(owner).queueAction(actionHash);

      // Do not advance time — timelock has not expired
      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWith("Mixer: timelock not expired");
    });

    it("execute wrong hash: reverts with Mixer: action not queued", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      // Queue hash for value=5, but try to execute with value=99
      const queuedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 5n]
        )
      );
      await mixer.connect(owner).queueAction(queuedHash);
      await time.increase(24 * 60 * 60 + 1);

      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(99n)
      ).to.be.revertedWith("Mixer: action not queued");
    });
  });
});
