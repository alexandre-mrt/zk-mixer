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
const ONE_DAY = 86_400; // TIMELOCK_DELAY in seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

/** Compute the action hash the same way the contract does: keccak256(abi.encode(name, value)) */
function actionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function maxDepositsHash(max: bigint): string {
  return actionHash("setMaxDepositsPerAddress", max);
}

function depositCooldownHash(cooldown: bigint): string {
  return actionHash("setDepositCooldown", cooldown);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
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
  return { mixer, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Mixer — Timelock Interactions", function () {
  // -------------------------------------------------------------------------
  // Queueing during pause
  // -------------------------------------------------------------------------

  it("queuing during pause still works", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).pause();

    const hash = maxDepositsHash(5n);
    await expect(mixer.connect(owner).queueAction(hash)).to.emit(mixer, "ActionQueued");

    const pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(hash);
    expect(pending.executeAfter).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // Executing after unpause
  // -------------------------------------------------------------------------

  it("executing after unpause works", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const hash = maxDepositsHash(3n);
    await mixer.connect(owner).pause();
    await mixer.connect(owner).queueAction(hash);
    await time.increase(ONE_DAY + 1);

    // Unpause before executing
    await mixer.connect(owner).unpause();

    await expect(mixer.connect(owner).setMaxDepositsPerAddress(3n))
      .to.emit(mixer, "ActionExecuted")
      .withArgs(hash);

    expect(await mixer.maxDepositsPerAddress()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // Ownership transfer does not affect pending action
  // -------------------------------------------------------------------------

  it("ownership transfer does not affect pending action", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    const hash = maxDepositsHash(7n);
    await mixer.connect(owner).queueAction(hash);

    // Transfer ownership to alice
    await mixer.connect(owner).transferOwnership(alice.address);

    // The pending action slot must be unchanged
    const pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(hash);
    expect(pending.executeAfter).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // New owner can execute action queued by old owner
  // -------------------------------------------------------------------------

  it("new owner can execute action queued by old owner", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    const hash = maxDepositsHash(7n);
    await mixer.connect(owner).queueAction(hash);
    await mixer.connect(owner).transferOwnership(alice.address);
    await time.increase(ONE_DAY + 1);

    await expect(mixer.connect(alice).setMaxDepositsPerAddress(7n))
      .to.emit(mixer, "ActionExecuted")
      .withArgs(hash);

    expect(await mixer.maxDepositsPerAddress()).to.equal(7n);
  });

  // -------------------------------------------------------------------------
  // Cancel then queue new action: only new one is executable
  // -------------------------------------------------------------------------

  it("cancel then queue new action: only new one is executable", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const hash1 = maxDepositsHash(3n);
    const hash2 = maxDepositsHash(9n);

    await mixer.connect(owner).queueAction(hash1);
    await mixer.connect(owner).cancelAction();

    // Queue fresh action
    await mixer.connect(owner).queueAction(hash2);
    await time.increase(ONE_DAY + 1);

    // Old action value must revert
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(3n)
    ).to.be.revertedWith("Mixer: action not queued");

    // New action must succeed
    await expect(mixer.connect(owner).setMaxDepositsPerAddress(9n))
      .to.emit(mixer, "ActionExecuted")
      .withArgs(hash2);
  });

  // -------------------------------------------------------------------------
  // TIMELOCK_DELAY is a constant
  // -------------------------------------------------------------------------

  it("TIMELOCK_DELAY cannot be changed (it is a constant)", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const delay = await mixer.TIMELOCK_DELAY();
    expect(delay).to.equal(BigInt(ONE_DAY));

    // A second deployment should have the same constant
    const hasherAddress = await deployHasher();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    const MixerFactory = await ethers.getContractFactory("Mixer");
    const mixer2 = (await MixerFactory.deploy(
      await verifier.getAddress(),
      DENOMINATION,
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as Mixer;

    expect(await mixer2.TIMELOCK_DELAY()).to.equal(BigInt(ONE_DAY));
  });

  // -------------------------------------------------------------------------
  // Action hash is unique per function + parameter combo
  // -------------------------------------------------------------------------

  it("action hash is unique per function + parameter combo", async function () {
    const hash1 = maxDepositsHash(5n);
    const hash2 = depositCooldownHash(5n);
    expect(hash1).to.not.equal(hash2);
  });

  // -------------------------------------------------------------------------
  // Same function different params produces different hashes
  // -------------------------------------------------------------------------

  it("same function different params produces different hashes", async function () {
    const hash1 = maxDepositsHash(5n);
    const hash2 = maxDepositsHash(6n);
    expect(hash1).to.not.equal(hash2);
  });

  // -------------------------------------------------------------------------
  // Queuing overwrites previous pending action
  // -------------------------------------------------------------------------

  it("queuing overwrites previous pending action", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const hash1 = maxDepositsHash(3n);
    const hash2 = maxDepositsHash(8n);

    await mixer.connect(owner).queueAction(hash1);

    let pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(hash1);

    await mixer.connect(owner).queueAction(hash2);

    pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(hash2);

    await time.increase(ONE_DAY + 1);

    // hash1 is gone — execution must revert
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(3n)
    ).to.be.revertedWith("Mixer: action not queued");

    // hash2 executes correctly
    await expect(mixer.connect(owner).setMaxDepositsPerAddress(8n))
      .to.emit(mixer, "MaxDepositsPerAddressUpdated")
      .withArgs(8n);
  });

  // -------------------------------------------------------------------------
  // Execute at exactly executeAfter timestamp succeeds
  // -------------------------------------------------------------------------

  it("execute at exactly executeAfter timestamp succeeds", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const hash = maxDepositsHash(4n);
    await mixer.connect(owner).queueAction(hash);

    const pending = await mixer.pendingAction();
    const executeAfter = pending.executeAfter;

    // Set block timestamp to exactly executeAfter
    await time.setNextBlockTimestamp(executeAfter);

    await expect(mixer.connect(owner).setMaxDepositsPerAddress(4n))
      .to.emit(mixer, "ActionExecuted")
      .withArgs(hash);

    expect(await mixer.maxDepositsPerAddress()).to.equal(4n);
  });

  // -------------------------------------------------------------------------
  // Deposit during queuing period works; blocked just before expiry
  // -------------------------------------------------------------------------

  it("deposit works while action is queued but delay not yet elapsed", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    const hash = maxDepositsHash(2n);
    await mixer.connect(owner).queueAction(hash);
    // Do not advance time — delay not elapsed yet

    // Deposit should be unaffected
    const commitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    // Execution before delay must revert
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(2n)
    ).to.be.revertedWith("Mixer: timelock not expired");
  });
});

