import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ROOT_HISTORY_SIZE = 30n;
const HARDHAT_CHAIN_ID = 31337n;
const TIMELOCK_DELAY = 86_400n; // 1 day in seconds

// Proof stubs accepted by the mock Groth16Verifier (returns true for any inputs)
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// Gas thresholds — generous to avoid false positives from minor compiler changes
const MAX_DEPOSIT_GAS = 400_000n;
const MAX_WITHDRAW_GAS = 200_000n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

function actionHash(fnName: string, value: bigint | string): string {
  const encoded =
    typeof value === "bigint"
      ? ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          [fnName, value]
        )
      : ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "address"],
          [fnName, value]
        );
  return ethers.keccak256(encoded);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
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

async function deployMixerWithReceiptFixture() {
  const base = await deployMixerFixture();
  const { mixer, owner } = base;
  const DepositReceiptFactory =
    await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;
  // Wire receipt into mixer via timelock
  const hash = actionHash("setDepositReceipt", await receipt.getAddress());
  await mixer.connect(owner).queueAction(hash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());
  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Final Coverage", function () {
  // -------------------------------------------------------------------------
  // Timelock — initial state
  // -------------------------------------------------------------------------

  describe("Timelock — initial state", function () {
    it("TIMELOCK_DELAY is exactly 86400 seconds", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.TIMELOCK_DELAY()).to.equal(TIMELOCK_DELAY);
    });

    it("pending action hash is bytes32(0) initially", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });

    it("pending action executeAfter is 0 initially", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const pending = await mixer.pendingAction();
      expect(pending.executeAfter).to.equal(0n);
    });

    it("queue sets both actionHash and executeAfter", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = actionHash("setMaxDepositsPerAddress", 3n);
      await mixer.connect(owner).queueAction(hash);
      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash);
      expect(pending.executeAfter).to.be.greaterThan(0n);
    });

    it("execute clears both actionHash and executeAfter", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = actionHash("setMaxDepositsPerAddress", 3n);
      await mixer.connect(owner).queueAction(hash);
      await time.increase(ONE_DAY + 1);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
      expect(pending.executeAfter).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // DepositReceipt — metadata
  // -------------------------------------------------------------------------

  describe("DepositReceipt — metadata", function () {
    it("receipt name() returns correct string", async function () {
      const { receipt } = await loadFixture(deployMixerWithReceiptFixture);
      expect(await receipt.name()).to.equal("ZK Mixer Deposit Receipt");
    });

    it("receipt symbol() returns correct string", async function () {
      const { receipt } = await loadFixture(deployMixerWithReceiptFixture);
      expect(await receipt.symbol()).to.equal("ZKDR");
    });

    it("receipt mixer() returns correct address", async function () {
      const { mixer, receipt } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      expect(await receipt.mixer()).to.equal(await mixer.getAddress());
    });

    it("transfer of receipt reverts (soulbound)", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      const c = randomCommitment();
      await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      // alice owns token 0 — attempt transfer to bob must revert
      await expect(
        receipt
          .connect(alice)
          .transferFrom(alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });
  });

  // -------------------------------------------------------------------------
  // View function edge cases
  // -------------------------------------------------------------------------

  describe("View function edge cases", function () {
    it("isSpent(0) returns false", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.isSpent(0n)).to.equal(false);
    });

    it("isCommitted(0) returns false", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.isCommitted(0n)).to.equal(false);
    });

    it("getCommitmentIndex(0) reverts when not committed", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      await expect(mixer.getCommitmentIndex(0n)).to.be.revertedWith(
        "commitment not found"
      );
    });

    it("indexToCommitment at nextIndex returns 0 (unset)", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const nextIdx = await mixer.getDepositCount();
      expect(await mixer.indexToCommitment(nextIdx)).to.equal(0n);
    });

    it("getRemainingDeposits returns max uint256 when no limit set", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const remaining = await mixer.getRemainingDeposits(alice.address);
      expect(remaining).to.equal(ethers.MaxUint256);
    });
  });

  // -------------------------------------------------------------------------
  // ERC165
  // -------------------------------------------------------------------------

  describe("ERC165", function () {
    it("supportsInterface(0xffffffff) returns false", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("supportsInterface returns true for ERC165 (0x01ffc9a7)", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.supportsInterface("0x01ffc9a7")).to.equal(true);
    });

    it("supportsInterface returns true for MIXER_INTERFACE_ID", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const interfaceId = await mixer.MIXER_INTERFACE_ID();
      expect(await mixer.supportsInterface(interfaceId)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-deposit / multi-withdrawal
  // -------------------------------------------------------------------------

  describe("Multi-withdrawal", function () {
    it("3 deposits then 3 withdrawals leave anonymitySetSize at 0", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);

      const commitments: bigint[] = [];
      const nullifiers: bigint[] = [];

      for (let i = 0; i < 3; i++) {
        const c = randomCommitment();
        commitments.push(c);
        await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      }

      const root = await mixer.getLastRoot();

      for (let i = 0; i < 3; i++) {
        const n = randomCommitment();
        nullifiers.push(n);
        await mixer
          .connect(alice)
          .withdraw(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, n, bob.address, ethers.ZeroAddress, 0n);
      }

      expect(await mixer.getAnonymitySetSize()).to.equal(0n);
    });

    it("pool balance is 0 after all withdrawals", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);

      const depositCount = 2;
      const root_commitments: bigint[] = [];
      for (let i = 0; i < depositCount; i++) {
        const c = randomCommitment();
        root_commitments.push(c);
        await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      }

      const root = await mixer.getLastRoot();

      for (let i = 0; i < depositCount; i++) {
        const n = randomCommitment();
        await mixer
          .connect(alice)
          .withdraw(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, n, bob.address, ethers.ZeroAddress, 0n);
      }

      const [, , poolBalance] = await mixer.getPoolHealth();
      expect(poolBalance).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Gas efficiency
  // -------------------------------------------------------------------------

  describe("Gas efficiency", function () {
    it("deposit gas is under 400K", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const c = randomCommitment();
      const tx = await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      const rcpt = await tx.wait();
      expect(rcpt!.gasUsed).to.be.lessThan(MAX_DEPOSIT_GAS);
    });

    it("withdraw gas is under 200K", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await mixer.getLastRoot();
      const n = randomCommitment();
      const tx = await mixer
        .connect(alice)
        .withdraw(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, n, bob.address, ethers.ZeroAddress, 0n);
      const rcpt = await tx.wait();
      expect(rcpt!.gasUsed).to.be.lessThan(MAX_WITHDRAW_GAS);
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("Constants", function () {
    it("ROOT_HISTORY_SIZE is 30", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.ROOT_HISTORY_SIZE()).to.equal(ROOT_HISTORY_SIZE);
    });

    it("FIELD_SIZE matches BN254 scalar field", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.FIELD_SIZE()).to.equal(FIELD_SIZE);
    });

    it("VERSION is 1.0.0", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.VERSION()).to.equal("1.0.0");
    });

    it("deployedChainId is 31337 on Hardhat", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.deployedChainId()).to.equal(HARDHAT_CHAIN_ID);
    });
  });
});
