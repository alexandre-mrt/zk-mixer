import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function makeActionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function makeAddressActionHash(name: string, addr: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], [name, addr])
  );
}

async function queueAndWait(
  mixer: Mixer,
  hash: string
): Promise<void> {
  await mixer.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, newAdmin, alice, bob] = await ethers.getSigners();

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

  return { mixer, owner, newAdmin, alice, bob };
}

async function deployFixtureWithReceipt() {
  const base = await deployFixture();

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await base.mixer.getAddress()
  )) as unknown as DepositReceipt;

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Admin Workflows
// ---------------------------------------------------------------------------

describe("Admin Workflows", function () {
  // -------------------------------------------------------------------------
  // Emergency: pause / unpause
  // -------------------------------------------------------------------------

  it("emergency: pause stops deposits and withdrawals", async function () {
    const { mixer, owner, alice } = await loadFixture(deployFixture);

    // Owner pauses immediately — no timelock required
    await mixer.connect(owner).pause();

    // Verify pool health reflects paused state
    const [, , , isPaused] = await mixer.getPoolHealth();
    expect(isPaused).to.equal(true);

    // Deposit is blocked
    const commitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
  });

  it("emergency: unpause resumes all operations", async function () {
    const { mixer, owner, alice } = await loadFixture(deployFixture);

    // Pause then unpause
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    // Pool should report not paused
    const [, , , isPaused] = await mixer.getPoolHealth();
    expect(isPaused).to.equal(false);

    // Deposit succeeds after unpause
    const commitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // Governance: timelocked parameter changes
  // -------------------------------------------------------------------------

  it("governance: queue + wait + execute deposit limit change", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const newLimit = 3n;
    const hash = makeActionHash("setMaxDepositsPerAddress", newLimit);

    // Queue the action
    await expect(mixer.connect(owner).queueAction(hash))
      .to.emit(mixer, "ActionQueued")
      .withArgs(hash, (v: bigint) => v > 0n);

    // Cannot execute before delay
    await time.increase(ONE_DAY - 60);
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(newLimit)
    ).to.be.revertedWith("Mixer: timelock not expired");

    // Advance past the full delay
    await time.increase(61);

    // Now executes and emits both events
    await expect(mixer.connect(owner).setMaxDepositsPerAddress(newLimit))
      .to.emit(mixer, "ActionExecuted").withArgs(hash)
      .and.to.emit(mixer, "MaxDepositsPerAddressUpdated").withArgs(newLimit);

    // State updated
    expect(await mixer.maxDepositsPerAddress()).to.equal(newLimit);

    // Pending action cleared
    const pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(ethers.ZeroHash);
  });

  it("governance: cancel a queued action before execution", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const hash = makeActionHash("setMaxDepositsPerAddress", 5n);
    await mixer.connect(owner).queueAction(hash);

    // Cancel
    await expect(mixer.connect(owner).cancelAction())
      .to.emit(mixer, "ActionCancelled")
      .withArgs(hash);

    // Pending slot is cleared
    const pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(ethers.ZeroHash);

    // Even after waiting, execution is rejected
    await time.increase(ONE_DAY + 1);
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(5n)
    ).to.be.revertedWith("Mixer: action not queued");
  });

  it("governance: queue new action replaces pending one", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const hash1 = makeActionHash("setMaxDepositsPerAddress", 3n);
    const hash2 = makeActionHash("setMaxDepositsPerAddress", 7n);

    // Queue first action
    await mixer.connect(owner).queueAction(hash1);
    expect((await mixer.pendingAction()).actionHash).to.equal(hash1);

    // Queue second action — replaces the first
    await mixer.connect(owner).queueAction(hash2);
    expect((await mixer.pendingAction()).actionHash).to.equal(hash2);

    // After delay, only the second action can execute
    await time.increase(ONE_DAY + 1);
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(3n)
    ).to.be.revertedWith("Mixer: action not queued");

    await expect(mixer.connect(owner).setMaxDepositsPerAddress(7n))
      .to.not.be.reverted;
    expect(await mixer.maxDepositsPerAddress()).to.equal(7n);
  });

  // -------------------------------------------------------------------------
  // Ownership: transfer
  // -------------------------------------------------------------------------

  it("ownership: full transfer from deployer to new admin", async function () {
    const { mixer, owner, newAdmin } = await loadFixture(deployFixture);

    // Transfer ownership
    await mixer.connect(owner).transferOwnership(await newAdmin.getAddress());
    expect(await mixer.owner()).to.equal(await newAdmin.getAddress());

    // Old owner is locked out of admin functions
    await expect(
      mixer.connect(owner).pause()
    ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");

    // New admin can pause
    await expect(mixer.connect(newAdmin).pause()).to.not.be.reverted;
  });

  it("ownership: new admin can queue and execute timelocked actions", async function () {
    const { mixer, owner, newAdmin } = await loadFixture(deployFixture);

    // Transfer to new admin
    await mixer.connect(owner).transferOwnership(await newAdmin.getAddress());

    // New admin queues and executes a timelocked parameter change
    const newLimit = 10n;
    const hash = makeActionHash("setMaxDepositsPerAddress", newLimit);

    await mixer.connect(newAdmin).queueAction(hash);
    await time.increase(ONE_DAY + 1);

    await expect(mixer.connect(newAdmin).setMaxDepositsPerAddress(newLimit))
      .to.emit(mixer, "MaxDepositsPerAddressUpdated")
      .withArgs(newLimit);

    expect(await mixer.maxDepositsPerAddress()).to.equal(newLimit);
  });

  // -------------------------------------------------------------------------
  // Configuration: deposit receipt
  // -------------------------------------------------------------------------

  it("configuration: set deposit receipt, verify minting works", async function () {
    const { mixer, owner, alice } = await loadFixture(deployFixture);

    // Deploy receipt contract
    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = (await DepositReceiptFactory.deploy(
      await mixer.getAddress()
    )) as unknown as DepositReceipt;
    const receiptAddr = await receipt.getAddress();

    // Queue and execute setDepositReceipt via timelock
    const hash = makeAddressActionHash("setDepositReceipt", receiptAddr);
    await queueAndWait(mixer.connect(owner) as unknown as Mixer, hash);
    await mixer.connect(owner).setDepositReceipt(receiptAddr);

    // Verify receipt is registered
    expect(await mixer.depositReceipt()).to.equal(receiptAddr);

    // Deposit should now mint an NFT
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
    expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
  });
});
