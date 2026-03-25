import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Zero proof — used with verifiers that always return true (placeholder) or
// always return false (MockFalseVerifier).
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

/**
 * Standard fixture: Mixer with the placeholder Groth16Verifier (always true).
 * Suitable for tests that must reach post-proof-check reverts, and for all
 * deposit-path tests.
 */
async function deployMixerFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  return { mixer, hasherAddress, owner, depositor, recipient, relayer };
}

/**
 * Fixture with MockFalseVerifier: always rejects proofs.
 * Used exclusively to test "Mixer: invalid proof".
 */
async function deployMixerFalseVerifierFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const FalseVerifier = await ethers.getContractFactory("MockFalseVerifier");
  const falseVerifier = await FalseVerifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await falseVerifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, depositor, recipient, relayer };
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

describe("Revert Messages", function () {
  // -------------------------------------------------------------------------
  // deposit()
  // -------------------------------------------------------------------------

  describe("deposit()", function () {
    it('reverts with "Mixer: incorrect deposit amount" when msg.value != denomination', async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const c = randomCommitment();

      await expect(
        mixer.connect(depositor).deposit(c, { value: DENOMINATION - 1n })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it('reverts with "Mixer: commitment is zero" when commitment == 0', async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(depositor).deposit(0n, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment is zero");
    });

    it('reverts with "Mixer: commitment >= field size" when commitment == FIELD_SIZE', async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(depositor).deposit(FIELD_SIZE, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment >= field size");
    });

    it('reverts with "Mixer: duplicate commitment" when same commitment deposited twice', async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const c = randomCommitment();

      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });

      await expect(
        mixer.connect(depositor).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: duplicate commitment");
    });

    it('reverts with "Mixer: deposit limit reached" when per-address limit is exceeded', async function () {
      const { mixer, owner, depositor } = await loadFixture(deployMixerFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 1n]
        )
      );
      await mixer.connect(owner).queueAction(actionHash);
      await time.increase(24 * 60 * 60 + 1);
      await mixer.connect(owner).setMaxDepositsPerAddress(1n);

      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

      await expect(
        mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: deposit limit reached");
    });

    it('reverts with "Mixer: deposit cooldown active" when cooldown has not elapsed', async function () {
      const { mixer, owner, depositor } = await loadFixture(deployMixerFixture);

      const cooldown = 3600n;
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setDepositCooldown", cooldown]
        )
      );
      await mixer.connect(owner).queueAction(actionHash);
      await time.increase(24 * 60 * 60 + 1);
      await mixer.connect(owner).setDepositCooldown(cooldown);

      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

      await expect(
        mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: deposit cooldown active");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw()
  // -------------------------------------------------------------------------

  describe("withdraw()", function () {
    it('reverts with "Mixer: fee exceeds denomination" when fee > denomination', async function () {
      const { mixer, depositor, recipient, relayer } = await loadFixture(
        deployMixerFixture
      );
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          DENOMINATION + 1n
        )
      ).to.be.revertedWith("Mixer: fee exceeds denomination");
    });

    it('reverts with "Mixer: recipient is zero address" when recipient is address(0)', async function () {
      const { mixer, depositor, relayer } = await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier,
          ZERO_ADDRESS as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: recipient is zero address");
    });

    it('reverts with "Mixer: unknown root" when root is not in ring buffer', async function () {
      const { mixer, depositor, recipient, relayer } = await loadFixture(
        deployMixerFixture
      );
      await depositNote(mixer, depositor);
      const nullifier = randomCommitment();
      const unknownRoot = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          unknownRoot, nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: unknown root");
    });

    it('reverts with "Mixer: invalid proof" when verifier returns false', async function () {
      // Uses MockFalseVerifier which always rejects proofs, so this test
      // reliably reaches the "invalid proof" revert without a real ZK proof.
      const { mixer, depositor, recipient, relayer } = await loadFixture(
        deployMixerFalseVerifierFixture
      );
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: invalid proof");
    });

    it('reverts with "Mixer: already spent" when nullifier has already been used', async function () {
      // Placeholder Groth16Verifier always returns true on Hardhat (chainid 31337),
      // so we can complete a full withdraw to spend the nullifier, then attempt
      // a second withdraw with the same nullifier.
      const { mixer, depositor, recipient, relayer } = await loadFixture(
        deployMixerFixture
      );
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();

      // First withdraw succeeds (placeholder verifier returns true)
      await mixer.connect(depositor).withdraw(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root, nullifier,
        recipient.address as `0x${string}`,
        relayer.address as `0x${string}`,
        0n
      );

      // Second withdraw with same nullifier must revert
      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier,
          recipient.address as `0x${string}`,
          relayer.address as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("Mixer: already spent");
    });

    it('reverts with "Mixer: relayer is zero address for non-zero fee" when fee > 0 and relayer is address(0)', async function () {
      // Placeholder verifier always returns true, so this test reaches the
      // post-proof ETH transfer phase where the relayer address is checked.
      const { mixer, depositor, recipient } = await loadFixture(deployMixerFixture);
      const { root } = await depositNote(mixer, depositor);
      const nullifier = randomCommitment();
      const fee = 1n;

      await expect(
        mixer.connect(depositor).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier,
          recipient.address as `0x${string}`,
          ZERO_ADDRESS as `0x${string}`,
          fee
        )
      ).to.be.revertedWith("Mixer: relayer is zero address for non-zero fee");
    });
  });

  // -------------------------------------------------------------------------
  // MerkleTree constructor guards (exercised via Mixer deployment)
  // -------------------------------------------------------------------------

  describe("MerkleTree constructor guards", function () {
    it('reverts with "MerkleTree: levels out of range" when levels == 0', async function () {
      const hasherAddress = await deployHasher();
      const Verifier = await ethers.getContractFactory("Groth16Verifier");
      const verifier = await Verifier.deploy();
      const MixerFactory = await ethers.getContractFactory("Mixer");

      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          DENOMINATION,
          0,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it('reverts with "MerkleTree: levels out of range" when levels == 33', async function () {
      const hasherAddress = await deployHasher();
      const Verifier = await ethers.getContractFactory("Groth16Verifier");
      const verifier = await Verifier.deploy();
      const MixerFactory = await ethers.getContractFactory("Mixer");

      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          DENOMINATION,
          33,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it('reverts with "MerkleTree: hasher is zero address" when hasher is address(0)', async function () {
      const Verifier = await ethers.getContractFactory("Groth16Verifier");
      const verifier = await Verifier.deploy();
      const MixerFactory = await ethers.getContractFactory("Mixer");

      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          DENOMINATION,
          MERKLE_TREE_HEIGHT,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith("MerkleTree: hasher is zero address");
    });

    it('reverts with "MerkleTree: left overflow" when left >= FIELD_SIZE', async function () {
      const { mixer } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.hashLeftRight(FIELD_SIZE, 1n)
      ).to.be.revertedWith("MerkleTree: left overflow");
    });

    it('reverts with "MerkleTree: right overflow" when right >= FIELD_SIZE', async function () {
      const { mixer } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.hashLeftRight(1n, FIELD_SIZE)
      ).to.be.revertedWith("MerkleTree: right overflow");
    });
  });

  // -------------------------------------------------------------------------
  // Timelock
  // -------------------------------------------------------------------------

  describe("timelock", function () {
    it('reverts with "Mixer: no pending action" when cancelAction called with nothing queued', async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      await expect(
        mixer.connect(owner).cancelAction()
      ).to.be.revertedWith("Mixer: no pending action");
    });

    it('reverts with "Mixer: action not queued" when executing with a different hash than queued', async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      // Queue hash for value=5 but execute function with value=99
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

    it('reverts with "Mixer: timelock not expired" when delay has not passed', async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 3n]
        )
      );
      await mixer.connect(owner).queueAction(actionHash);

      // Do not advance time
      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWith("Mixer: timelock not expired");
    });
  });
});
