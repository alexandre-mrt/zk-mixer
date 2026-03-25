import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 86_400;
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rc(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function actionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function addrActionHash(name: string, addr: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], [name, addr])
  );
}

async function queue(mixer: Mixer, owner: Signer, hash: string): Promise<void> {
  await mixer.connect(owner).queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, recipient, relayer] = await ethers.getSigners();
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
  return { mixer, owner, alice, bob, recipient, relayer };
}

async function deployWithReceiptFixture() {
  const base = await deployFixture();
  const { mixer, owner } = base;
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;
  const hash = addrActionHash("setDepositReceipt", await receipt.getAddress());
  await queue(mixer, owner, hash);
  await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());
  return { ...base, receipt };
}

async function deployWithLensFixture() {
  const base = await deployFixture();
  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const lens = (await MixerLensFactory.deploy()) as unknown as MixerLens;
  return { ...base, lens };
}

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment: bigint
): Promise<void> {
  await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifier: bigint,
  recipient: string,
  relayer: string,
  fee: bigint
) {
  return mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifier,
    recipient as `0x${string}`,
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Exhaustive Coverage", function () {
  // -------------------------------------------------------------------------
  // Deposit variations
  // -------------------------------------------------------------------------

  describe("Deposit variations", function () {
    it("deposit from owner succeeds", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      await expect(
        doDeposit(mixer, owner, rc())
      ).to.not.be.reverted;
    });

    it("deposit from alice succeeds", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(doDeposit(mixer, alice, rc())).to.not.be.reverted;
    });

    it("deposit from bob succeeds", async function () {
      const { mixer, bob } = await loadFixture(deployFixture);
      await expect(doDeposit(mixer, bob, rc())).to.not.be.reverted;
    });

    it("deposit commitment = 1 is accepted", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(doDeposit(mixer, alice, 1n)).to.not.be.reverted;
    });

    it("deposit commitment = 42 is accepted", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(doDeposit(mixer, alice, 42n)).to.not.be.reverted;
    });

    it("deposit commitment = FIELD_SIZE - 1 is accepted", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(doDeposit(mixer, alice, FIELD_SIZE - 1n)).to.not.be.reverted;
    });

    it("deposit increments nextIndex (depositCount) by 1", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const before = await mixer.getDepositCount();
      await doDeposit(mixer, alice, rc());
      expect(await mixer.getDepositCount()).to.equal(before + 1n);
    });

    it("deposit updates currentRootIndex (lastRoot changes)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const rootBefore = await mixer.getLastRoot();
      await doDeposit(mixer, alice, rc());
      const rootAfter = await mixer.getLastRoot();
      expect(rootAfter).to.not.equal(rootBefore);
    });

    it("deposit emits Deposit event with correct leafIndex = 0 for first", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = rc();
      const tx = await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      await expect(tx)
        .to.emit(mixer, "Deposit")
        .withArgs(commitment, 0, (v: bigint) => v > 0n);
    });

    it("deposit stores commitment in mapping", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = rc();
      await doDeposit(mixer, alice, commitment);
      expect(await mixer.commitments(commitment)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Withdrawal variations
  // -------------------------------------------------------------------------

  describe("Withdrawal variations", function () {
    it("withdraw to owner address succeeds", async function () {
      const { mixer, alice, owner } = await loadFixture(deployFixture);
      const commitment = rc();
      await doDeposit(mixer, alice, commitment);
      const root = await mixer.getLastRoot();
      const nullifier = rc();
      await expect(
        doWithdraw(mixer, root, nullifier, await owner.getAddress(), ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw to alice address succeeds", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await expect(
        doWithdraw(mixer, root, rc(), await alice.getAddress(), ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw to bob address succeeds", async function () {
      const { mixer, alice, bob } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await expect(
        doWithdraw(mixer, root, rc(), await bob.getAddress(), ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw with fee = 0", async function () {
      const { mixer, alice, recipient } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await expect(
        doWithdraw(mixer, root, rc(), await recipient.getAddress(), ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw with fee = 1 wei", async function () {
      const { mixer, alice, recipient, relayer } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await expect(
        doWithdraw(mixer, root, rc(), await recipient.getAddress(), await relayer.getAddress(), 1n)
      ).to.not.be.reverted;
    });

    it("withdraw with fee = denomination / 2", async function () {
      const { mixer, alice, recipient, relayer } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      const halfFee = DENOMINATION / 2n;
      await expect(
        doWithdraw(mixer, root, rc(), await recipient.getAddress(), await relayer.getAddress(), halfFee)
      ).to.not.be.reverted;
    });

    it("withdraw with fee = denomination (max fee) succeeds", async function () {
      const { mixer, alice, relayer } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await expect(
        doWithdraw(mixer, root, rc(), await relayer.getAddress(), await relayer.getAddress(), DENOMINATION)
      ).to.not.be.reverted;
    });

    it("withdraw increments withdrawalCount", async function () {
      const { mixer, alice, recipient } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      const before = await mixer.withdrawalCount();
      await doWithdraw(mixer, root, rc(), await recipient.getAddress(), ethers.ZeroAddress, 0n);
      expect(await mixer.withdrawalCount()).to.equal(before + 1n);
    });

    it("withdraw increments totalWithdrawn by denomination", async function () {
      const { mixer, alice, recipient } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      const before = await mixer.totalWithdrawn();
      await doWithdraw(mixer, root, rc(), await recipient.getAddress(), ethers.ZeroAddress, 0n);
      expect(await mixer.totalWithdrawn()).to.equal(before + DENOMINATION);
    });

    it("withdraw marks nullifier as spent", async function () {
      const { mixer, alice, recipient } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      const nullifier = rc();
      await doWithdraw(mixer, root, nullifier, await recipient.getAddress(), ethers.ZeroAddress, 0n);
      expect(await mixer.nullifierHashes(nullifier)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Admin variations
  // -------------------------------------------------------------------------

  describe("Admin variations", function () {
    it("pause by owner succeeds", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      await expect(mixer.connect(owner).pause()).to.not.be.reverted;
    });

    it("pause blocks deposit", async function () {
      const { mixer, owner, alice } = await loadFixture(deployFixture);
      await mixer.connect(owner).pause();
      await expect(
        doDeposit(mixer, alice, rc())
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("pause blocks withdraw", async function () {
      const { mixer, owner, alice, recipient } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await mixer.connect(owner).pause();
      await expect(
        doWithdraw(mixer, root, rc(), await recipient.getAddress(), ethers.ZeroAddress, 0n)
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("unpause by owner re-enables deposit", async function () {
      const { mixer, owner, alice } = await loadFixture(deployFixture);
      await mixer.connect(owner).pause();
      await mixer.connect(owner).unpause();
      await expect(doDeposit(mixer, alice, rc())).to.not.be.reverted;
    });

    it("unpause by owner re-enables withdraw", async function () {
      const { mixer, owner, alice, recipient } = await loadFixture(deployFixture);
      await doDeposit(mixer, alice, rc());
      const root = await mixer.getLastRoot();
      await mixer.connect(owner).pause();
      await mixer.connect(owner).unpause();
      await expect(
        doWithdraw(mixer, root, rc(), await recipient.getAddress(), ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("queueAction stores the action hash", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash = actionHash("setMaxDepositsPerAddress", 5n);
      await mixer.connect(owner).queueAction(hash);
      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash);
    });

    it("queueAction stores executeAfter as timestamp + 1 day", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash = actionHash("setMaxDepositsPerAddress", 5n);
      const block = await ethers.provider.getBlock("latest");
      await mixer.connect(owner).queueAction(hash);
      const pending = await mixer.pendingAction();
      expect(pending.executeAfter).to.be.gte(BigInt(block!.timestamp) + BigInt(ONE_DAY));
    });

    it("cancelAction clears actionHash to zero", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash = actionHash("setMaxDepositsPerAddress", 5n);
      await mixer.connect(owner).queueAction(hash);
      await mixer.connect(owner).cancelAction();
      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });

    it("cancelAction clears executeAfter to zero", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash = actionHash("setMaxDepositsPerAddress", 5n);
      await mixer.connect(owner).queueAction(hash);
      await mixer.connect(owner).cancelAction();
      const pending = await mixer.pendingAction();
      expect(pending.executeAfter).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Receipt variations
  // -------------------------------------------------------------------------

  describe("Receipt variations", function () {
    it("receipt mints on deposit", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
    });

    it("receipt stores commitment in tokenCommitment mapping", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      const commitment = rc();
      await doDeposit(mixer, alice, commitment);
      expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    });

    it("receipt stores non-zero timestamp in tokenTimestamp mapping", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      expect(await receipt.tokenTimestamp(0n)).to.be.gt(0n);
    });

    it("receipt ownerOf returns depositor", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
    });

    it("receipt balanceOf increases after deposit", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      await doDeposit(mixer, alice, rc());
      expect(await receipt.balanceOf(await alice.getAddress())).to.equal(2n);
    });

    it("receipt tokenURI returns non-empty string", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      const uri = await receipt.tokenURI(0n);
      expect(uri.length).to.be.gt(0);
    });

    it("no receipt minted when depositReceipt not configured", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = rc();
      await doDeposit(mixer, alice, commitment);
      // depositReceipt address is zero — no DepositReceipt contract to query
      expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);
    });

    it("receipt mint works when contract is not paused", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      // deposit succeeded and token exists
      expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
    });

    it("receipt token IDs are sequential — three deposits produce IDs 0, 1, 2", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      await doDeposit(mixer, bob, rc());
      await doDeposit(mixer, alice, rc());
      // All three tokens should exist (ownerOf does not revert)
      const owner0 = await receipt.ownerOf(0n);
      const owner1 = await receipt.ownerOf(1n);
      const owner2 = await receipt.ownerOf(2n);
      expect(owner0).to.be.properAddress;
      expect(owner1).to.be.properAddress;
      expect(owner2).to.be.properAddress;
    });

    it("receipt is soulbound — transfer reverts", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);
      await doDeposit(mixer, alice, rc());
      await expect(
        receipt
          .connect(alice)
          .transferFrom(await alice.getAddress(), await bob.getAddress(), 0n)
      ).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Lens variations
  // -------------------------------------------------------------------------

  describe("Lens variations", function () {
    it("lens depositCount is 0 initially", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.depositCount).to.equal(0n);
    });

    it("lens withdrawalCount is 0 initially", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.withdrawalCount).to.equal(0n);
    });

    it("lens poolBalance is 0 initially", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.poolBalance).to.equal(0n);
    });

    it("lens anonymitySetSize is 0 initially", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.anonymitySetSize).to.equal(0n);
    });

    it("lens treeUtilization is 0 initially", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.treeUtilization).to.equal(0n);
    });

    it("lens denomination matches configured value", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.denomination).to.equal(DENOMINATION);
    });

    it("lens isPaused = false initially", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.isPaused).to.equal(false);
    });

    it("lens isPaused = true after pause", async function () {
      const { mixer, owner, lens } = await loadFixture(deployWithLensFixture);
      await mixer.connect(owner).pause();
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.isPaused).to.equal(true);
    });

    it("lens owner matches deployer", async function () {
      const { mixer, owner, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.owner).to.equal(await owner.getAddress());
    });

    it("lens version field is correct", async function () {
      const { mixer, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await mixer.getAddress());
      expect(snap.version).to.equal("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // Hash variations
  // -------------------------------------------------------------------------

  describe("Hash variations", function () {
    it("hashLeftRight(0, 0) returns non-zero", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.hashLeftRight(0n, 0n);
      expect(result).to.not.equal(0n);
    });

    it("hashLeftRight(1, 0) returns non-zero", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.hashLeftRight(1n, 0n);
      expect(result).to.not.equal(0n);
    });

    it("hashLeftRight(0, 1) returns non-zero", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.hashLeftRight(0n, 1n);
      expect(result).to.not.equal(0n);
    });

    it("hashLeftRight(1, 1) returns non-zero", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.hashLeftRight(1n, 1n);
      expect(result).to.not.equal(0n);
    });

    it("hashLeftRight is deterministic — same inputs same output", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const a = rc();
      const b = rc();
      const first = await mixer.hashLeftRight(a, b);
      const second = await mixer.hashLeftRight(a, b);
      expect(first).to.equal(second);
    });

    it("hashLeftRight is non-commutative — swap changes output", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const a = 1n;
      const b = 2n;
      const forward = await mixer.hashLeftRight(a, b);
      const swapped = await mixer.hashLeftRight(b, a);
      expect(forward).to.not.equal(swapped);
    });

    it("verifyCommitment matches hashLeftRight for same inputs", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const secret = rc();
      const nullifier = rc();
      const direct = await mixer.hashLeftRight(secret, nullifier);
      const via = await mixer.verifyCommitment(secret, nullifier);
      expect(via).to.equal(direct);
    });

    it("hash output is within field bounds", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.hashLeftRight(rc(), rc());
      expect(result).to.be.lt(FIELD_SIZE);
    });

    it("hashLeftRight(FIELD_SIZE - 1, FIELD_SIZE - 1) returns non-zero", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.hashLeftRight(FIELD_SIZE - 1n, FIELD_SIZE - 1n);
      expect(result).to.not.equal(0n);
    });

    it("five distinct input pairs produce five distinct outputs", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const inputs: [bigint, bigint][] = [
        [1n, 2n], [3n, 4n], [5n, 6n], [7n, 8n], [9n, 10n],
      ];
      const outputs = await Promise.all(inputs.map(([a, b]) => mixer.hashLeftRight(a, b)));
      const unique = new Set(outputs.map(String));
      expect(unique.size).to.equal(5);
    });
  });

  // -------------------------------------------------------------------------
  // View functions
  // -------------------------------------------------------------------------

  describe("View functions", function () {
    it("getStats returns 5 values — all zero initially", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const [dep, wit, cnt, wcnt, bal] = await mixer.getStats();
      expect(dep).to.equal(0n);
      expect(wit).to.equal(0n);
      expect(cnt).to.equal(0n);
      expect(wcnt).to.equal(0n);
      expect(bal).to.equal(0n);
    });

    it("getPoolHealth returns 4 values", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const [anon, util, bal, paused] = await mixer.getPoolHealth();
      expect(anon).to.equal(0n);
      expect(util).to.equal(0n);
      expect(bal).to.equal(0n);
      expect(paused).to.equal(false);
    });

    it("getAnonymitySetSize is 0 initially", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.getAnonymitySetSize()).to.equal(0n);
    });

    it("getTreeCapacity equals 2^levels", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const levels = await mixer.levels();
      const expected = 2n ** levels;
      expect(await mixer.getTreeCapacity()).to.equal(expected);
    });

    it("getTreeUtilization is 0 initially", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.getTreeUtilization()).to.equal(0n);
    });

    it("hasCapacity returns true on fresh deployment", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.hasCapacity()).to.equal(true);
    });

    it("getValidRootCount is 1 initially (first empty root)", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.getValidRootCount()).to.equal(1n);
    });

    it("getRemainingDeposits returns max uint256 when no limit", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const remaining = await mixer.getRemainingDeposits(await alice.getAddress());
      expect(remaining).to.equal(2n ** 256n - 1n);
    });

    it("getCommitments returns empty array for fresh tree", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.getCommitments(0, 10);
      expect(result.length).to.equal(0);
    });

    it("getCommitments returns inserted commitment at index 0", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = rc();
      await doDeposit(mixer, alice, commitment);
      const result = await mixer.getCommitments(0, 1);
      expect(result[0]).to.equal(commitment);
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("Constants", function () {
    it("VERSION returns '1.0.0'", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.VERSION()).to.equal("1.0.0");
    });

    it("TIMELOCK_DELAY equals 1 day in seconds", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.TIMELOCK_DELAY()).to.equal(BigInt(ONE_DAY));
    });

    it("ROOT_HISTORY_SIZE equals 30", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.ROOT_HISTORY_SIZE()).to.equal(30n);
    });

    it("FIELD_SIZE matches BN254 scalar field prime", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.FIELD_SIZE()).to.equal(FIELD_SIZE);
    });

    it("deployedChainId matches Hardhat chain ID 31337", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.deployedChainId()).to.equal(31337n);
    });

    it("denomination equals 0.1 ETH", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.denomination()).to.equal(DENOMINATION);
    });

    it("levels equals configured tree height", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.levels()).to.equal(BigInt(MERKLE_TREE_HEIGHT));
    });

    it("supportsInterface returns true for ERC165 selector", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.supportsInterface("0x01ffc9a7")).to.equal(true);
    });

    it("supportsInterface returns true for MIXER_INTERFACE_ID", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const id = await mixer.MIXER_INTERFACE_ID();
      expect(await mixer.supportsInterface(id)).to.equal(true);
    });

    it("supportsInterface returns false for random selector", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
