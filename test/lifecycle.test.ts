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

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");
const ONE_DAY = 24 * 60 * 60;

// Placeholder proof values — stub verifier always returns true
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

function actionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [name, value]
    )
  );
}

async function queueAndWait(mixer: Mixer, hash: string): Promise<void> {
  await mixer.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Base fixture — fresh deployment, no configuration applied yet
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const [owner, user1, user2, user3, newOwner, recipient, relayer] =
    await ethers.getSigners();

  const hasherAddress = await deployHasher();
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, user1, user2, user3, newOwner, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Withdrawal helper
// ---------------------------------------------------------------------------

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: string,
  relayer: string,
  fee: bigint
) {
  return mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient as `0x${string}`,
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Protocol Lifecycle
// ---------------------------------------------------------------------------

describe("Protocol Lifecycle", function () {
  // -------------------------------------------------------------------------
  // Phase 1: Fresh deployment has correct initial state
  // -------------------------------------------------------------------------

  it("Phase 1: Fresh deployment has correct initial state", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    // Ownership
    expect(await mixer.owner()).to.equal(await owner.getAddress());

    // Denomination and tree setup
    expect(await mixer.denomination()).to.equal(DENOMINATION);
    expect(await mixer.levels()).to.equal(TREE_HEIGHT);

    // No deposits yet
    expect(await mixer.nextIndex()).to.equal(0);

    // Cumulative stats all zero
    expect(await mixer.totalDeposited()).to.equal(0n);
    expect(await mixer.totalWithdrawn()).to.equal(0n);
    expect(await mixer.withdrawalCount()).to.equal(0n);

    // Protocol not paused
    expect(await mixer.paused()).to.be.false;

    // Parameter defaults: no limit, no cooldown
    expect(await mixer.maxDepositsPerAddress()).to.equal(0n);
    expect(await mixer.depositCooldown()).to.equal(0n);

    // No receipt contract configured
    expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);

    // No pending timelock action
    const pending = await mixer.pendingAction();
    expect(pending.actionHash).to.equal(ethers.ZeroHash);
  });

  // -------------------------------------------------------------------------
  // Phase 2: Configure parameters (deposit limit, cooldown) via timelock
  // -------------------------------------------------------------------------

  it("Phase 2: Configure parameters (deposit limit, cooldown) via timelock", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    // --- setMaxDepositsPerAddress (requires timelock) ---
    const limitHash = actionHash("setMaxDepositsPerAddress", 3n);
    await queueAndWait(mixer.connect(owner) as unknown as Mixer, limitHash);

    await expect(mixer.connect(owner).setMaxDepositsPerAddress(3n))
      .to.emit(mixer, "MaxDepositsPerAddressUpdated")
      .withArgs(3n);

    expect(await mixer.maxDepositsPerAddress()).to.equal(3n);

    // --- setDepositCooldown (requires timelock) ---
    const cooldownHash = actionHash("setDepositCooldown", 3600n);
    await queueAndWait(
      mixer.connect(owner) as unknown as Mixer,
      cooldownHash
    );

    await expect(mixer.connect(owner).setDepositCooldown(3600n))
      .to.emit(mixer, "DepositCooldownUpdated")
      .withArgs(3600n);

    expect(await mixer.depositCooldown()).to.equal(3600n);
  });

  // -------------------------------------------------------------------------
  // Phase 3: First deposits build anonymity set
  // -------------------------------------------------------------------------

  it("Phase 3: First deposits build anonymity set", async function () {
    const { mixer, user1, user2, user3 } =
      await loadFixture(deployMixerFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    await mixer.connect(user1).deposit(c1, { value: DENOMINATION });
    await mixer.connect(user2).deposit(c2, { value: DENOMINATION });
    await mixer.connect(user3).deposit(c3, { value: DENOMINATION });

    // Three commitments are now in the tree
    expect(await mixer.nextIndex()).to.equal(3);
    expect(await mixer.commitments(c1)).to.be.true;
    expect(await mixer.commitments(c2)).to.be.true;
    expect(await mixer.commitments(c3)).to.be.true;

    // Stats updated
    expect(await mixer.totalDeposited()).to.equal(DENOMINATION * 3n);
    expect(await mixer.getAnonymitySetSize()).to.equal(3n);

    // Contract holds all deposited ETH
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 3n);
  });

  // -------------------------------------------------------------------------
  // Phase 4: Withdrawals reduce anonymity set
  // -------------------------------------------------------------------------

  it("Phase 4: Withdrawals reduce anonymity set", async function () {
    const { mixer, user1, user2, user3, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(user2).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(user3).deposit(randomCommitment(), { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment(); // stub verifier accepts any value
    const recipientAddr = await recipient.getAddress();
    const relayerAddr = await relayer.getAddress();

    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

    // Anonymity set shrinks by 1
    expect(await mixer.getAnonymitySetSize()).to.equal(2n);

    // Nullifier is now spent
    expect(await mixer.nullifierHashes(nullifierHash)).to.be.true;

    // Recipient received DENOMINATION
    const balanceAfter = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);

    // Contract balance reduced
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 2n);
  });

  // -------------------------------------------------------------------------
  // Phase 5: Stats reflect full history
  // -------------------------------------------------------------------------

  it("Phase 5: Stats reflect full history", async function () {
    const { mixer, user1, user2, user3, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    // 3 deposits
    for (const user of [user1, user2, user3]) {
      await mixer.connect(user).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // 2 withdrawals
    const root = await mixer.getLastRoot();
    const recipientAddr = await recipient.getAddress();
    const relayerAddr = await relayer.getAddress();

    await doWithdraw(mixer, root, randomCommitment(), recipientAddr, relayerAddr, 0n);
    await doWithdraw(mixer, root, randomCommitment(), recipientAddr, relayerAddr, 0n);

    const [totalDep, totalWith, depCount, withCount, poolBalance] =
      await mixer.getStats();

    expect(totalDep).to.equal(DENOMINATION * 3n);
    expect(totalWith).to.equal(DENOMINATION * 2n);
    expect(depCount).to.equal(3n);
    expect(withCount).to.equal(2n);
    expect(poolBalance).to.equal(DENOMINATION * 1n);

    // getPoolHealth mirrors the same state
    const [anonymitySize, , healthBalance, isPaused] =
      await mixer.getPoolHealth();
    expect(anonymitySize).to.equal(1n); // 3 deposits - 2 withdrawals
    expect(healthBalance).to.equal(DENOMINATION * 1n);
    expect(isPaused).to.be.false;
  });

  // -------------------------------------------------------------------------
  // Phase 6: Owner transfers ownership
  // -------------------------------------------------------------------------

  it("Phase 6: Owner transfers ownership", async function () {
    const { mixer, owner, newOwner } = await loadFixture(deployMixerFixture);

    const newOwnerAddr = await newOwner.getAddress();

    await expect(
      mixer.connect(owner).transferOwnership(newOwnerAddr)
    ).to.emit(mixer, "OwnershipTransferred");

    expect(await mixer.owner()).to.equal(newOwnerAddr);

    // Old owner loses access
    await expect(
      mixer.connect(owner).pause()
    ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
  });

  // -------------------------------------------------------------------------
  // Phase 7: New owner pauses for maintenance
  // -------------------------------------------------------------------------

  it("Phase 7: New owner pauses for maintenance", async function () {
    const { mixer, owner, newOwner, user1 } =
      await loadFixture(deployMixerFixture);

    await mixer.connect(owner).transferOwnership(await newOwner.getAddress());

    // New owner can pause without timelock
    await expect(mixer.connect(newOwner).pause())
      .to.emit(mixer, "Paused");

    expect(await mixer.paused()).to.be.true;

    // All operations blocked while paused
    await expect(
      mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
  });

  // -------------------------------------------------------------------------
  // Phase 8: Resume operations after unpause
  // -------------------------------------------------------------------------

  it("Phase 8: Resume operations after unpause", async function () {
    const { mixer, owner, newOwner, user1 } =
      await loadFixture(deployMixerFixture);

    await mixer.connect(owner).transferOwnership(await newOwner.getAddress());
    await mixer.connect(newOwner).pause();

    // Unpause restores full operation
    await expect(mixer.connect(newOwner).unpause())
      .to.emit(mixer, "Unpaused");

    expect(await mixer.paused()).to.be.false;

    // Deposit succeeds again
    const commitment = randomCommitment();
    await expect(
      mixer.connect(user1).deposit(commitment, { value: DENOMINATION })
    ).to.not.be.reverted;

    expect(await mixer.commitments(commitment)).to.be.true;
    expect(await mixer.nextIndex()).to.equal(1);
  });
});
