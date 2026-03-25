import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";
import type { DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MixerState {
  // MerkleTree
  nextIndex: bigint;
  currentRootIndex: bigint;
  lastRoot: bigint;
  validRootCount: bigint;
  treeUtilization: bigint;
  hasCapacity: boolean;
  // Mixer accounting
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  depositCount: bigint;
  withdrawalCount: bigint;
  balance: bigint;
  // Derived
  anonymitySetSize: bigint;
  // Immutable / owner-controlled (should not change in normal ops)
  denomination: bigint;
  levels: bigint;
  owner: string;
  paused: boolean;
  maxDepositsPerAddress: bigint;
  depositCooldown: bigint;
  // Pending action
  pendingActionHash: string;
  pendingActionExecuteAfter: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function captureMixerState(mixer: Mixer): Promise<MixerState> {
  const [
    totalDeposited,
    totalWithdrawn,
    depositCount,
    withdrawalCount,
    balance,
  ] = await mixer.getStats();

  const [pendingHash, pendingExecuteAfter] = await mixer.pendingAction();

  return {
    nextIndex: BigInt(await mixer.getDepositCount()),
    currentRootIndex: BigInt(await mixer.currentRootIndex()),
    lastRoot: await mixer.getLastRoot(),
    validRootCount: BigInt(await mixer.getValidRootCount()),
    treeUtilization: await mixer.getTreeUtilization(),
    hasCapacity: await mixer.hasCapacity(),
    totalDeposited,
    totalWithdrawn,
    depositCount,
    withdrawalCount,
    balance,
    anonymitySetSize: await mixer.getAnonymitySetSize(),
    denomination: await mixer.denomination(),
    levels: BigInt(await mixer.levels()),
    owner: await mixer.owner(),
    paused: await mixer.paused(),
    maxDepositsPerAddress: await mixer.maxDepositsPerAddress(),
    depositCooldown: await mixer.depositCooldown(),
    pendingActionHash: pendingHash,
    pendingActionExecuteAfter: pendingExecuteAfter,
  };
}

async function doWithdraw(
  mixer: Mixer,
  recipient: { getAddress(): Promise<string> },
  relayer: { getAddress(): Promise<string> },
  nullifierHash: bigint,
  fee = 0n
) {
  const root = await mixer.getLastRoot();
  const recipientAddr = (await recipient.getAddress()) as `0x${string}`;
  const relayerAddr = (await relayer.getAddress()) as `0x${string}`;

  return mixer.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifierHash,
    recipientAddr,
    relayerAddr,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployFixture() {
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

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = await MixerLensFactory.deploy();

  return { mixer, mixerLens, owner, depositor, recipient, relayer };
}

async function deployWithReceiptFixture() {
  const { mixer, mixerLens, owner, depositor, recipient, relayer } =
    await deployFixture();

  const DepositReceiptFactory =
    await ethers.getContractFactory("DepositReceipt");
  const receiptContract = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  const receiptAddress = await receiptContract.getAddress();
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddress]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
  await ethers.provider.send("evm_mine", []);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);

  return {
    mixer,
    mixerLens,
    receiptContract,
    owner,
    depositor,
    recipient,
    relayer,
  };
}

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

describe("State Transitions", function () {
  // -------------------------------------------------------------------------
  // deposit transitions
  // -------------------------------------------------------------------------

  it("deposit: nextIndex +1, currentRootIndex +1, root changes, balance +denom, totalDeposited +denom, commitments[c]=true", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    const before = await captureMixerState(mixer);

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const after = await captureMixerState(mixer);

    // Changed fields
    expect(after.nextIndex).to.equal(before.nextIndex + 1n);
    expect(after.currentRootIndex).to.equal(before.currentRootIndex + 1n);
    expect(after.lastRoot).to.not.equal(before.lastRoot);
    expect(after.balance).to.equal(before.balance + DENOMINATION);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DENOMINATION);
    expect(after.depositCount).to.equal(before.depositCount + 1n);
    expect(after.validRootCount).to.equal(before.validRootCount + 1n);
    expect(after.treeUtilization).to.be.greaterThan(before.treeUtilization);
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize + 1n);

    // commitment is now stored
    expect(await mixer.isCommitted(commitment)).to.be.true;

    // Unchanged fields
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.levels).to.equal(before.levels);
    expect(after.owner).to.equal(before.owner);
    expect(after.paused).to.equal(before.paused);
    expect(after.maxDepositsPerAddress).to.equal(before.maxDepositsPerAddress);
    expect(after.depositCooldown).to.equal(before.depositCooldown);
    expect(after.pendingActionHash).to.equal(before.pendingActionHash);
  });

  it("deposit: denomination unchanged, levels unchanged, owner unchanged, paused unchanged", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    const after = await captureMixerState(mixer);

    expect(after.denomination).to.equal(before.denomination);
    expect(after.levels).to.equal(before.levels);
    expect(after.owner).to.equal(before.owner);
    expect(after.paused).to.equal(before.paused);
  });

  it("deposit: anonymitySetSize +1, treeUtilization increases, getValidRootCount +1", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    const after = await captureMixerState(mixer);

    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize + 1n);
    expect(after.treeUtilization).to.be.greaterThan(before.treeUtilization);
    expect(after.validRootCount).to.equal(before.validRootCount + 1n);
  });

  // -------------------------------------------------------------------------
  // withdraw transitions
  // -------------------------------------------------------------------------

  it("withdraw: withdrawalCount +1, totalWithdrawn +denom, balance -denom, nullifierHashes[n]=true", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

    const nullifier = randomCommitment();
    const before = await captureMixerState(mixer);

    await doWithdraw(mixer, recipient, relayer, nullifier);

    const after = await captureMixerState(mixer);

    // Changed fields
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + DENOMINATION);
    expect(after.balance).to.equal(before.balance - DENOMINATION);
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize - 1n);
    expect(await mixer.isSpent(nullifier)).to.be.true;

    // Unchanged fields
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.depositCount).to.equal(before.depositCount);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.levels).to.equal(before.levels);
    expect(after.owner).to.equal(before.owner);
    expect(after.paused).to.equal(before.paused);
  });

  it("withdraw: nextIndex unchanged, commitments unchanged, root unchanged", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const before = await captureMixerState(mixer);

    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const after = await captureMixerState(mixer);

    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.lastRoot).to.equal(before.lastRoot);
    expect(after.currentRootIndex).to.equal(before.currentRootIndex);
    // The commitment remains in the tree after withdrawal
    expect(await mixer.isCommitted(commitment)).to.be.true;
  });

  it("withdraw: anonymitySetSize -1", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

    const before = await captureMixerState(mixer);
    await doWithdraw(mixer, recipient, relayer, randomCommitment());
    const after = await captureMixerState(mixer);

    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize - 1n);
  });

  // -------------------------------------------------------------------------
  // pause transitions
  // -------------------------------------------------------------------------

  it("pause: paused=true, nothing else changes", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);
    await mixer.connect(owner).pause();
    const after = await captureMixerState(mixer);

    // Changed
    expect(before.paused).to.be.false;
    expect(after.paused).to.be.true;

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.currentRootIndex).to.equal(before.currentRootIndex);
    expect(after.lastRoot).to.equal(before.lastRoot);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.depositCount).to.equal(before.depositCount);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.balance).to.equal(before.balance);
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.levels).to.equal(before.levels);
    expect(after.owner).to.equal(before.owner);
    expect(after.maxDepositsPerAddress).to.equal(before.maxDepositsPerAddress);
  });

  it("unpause: paused=false, nothing else changes", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    await mixer.connect(owner).pause();
    const before = await captureMixerState(mixer);
    await mixer.connect(owner).unpause();
    const after = await captureMixerState(mixer);

    // Changed
    expect(before.paused).to.be.true;
    expect(after.paused).to.be.false;

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.balance).to.equal(before.balance);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.levels).to.equal(before.levels);
    expect(after.owner).to.equal(before.owner);
  });

  // -------------------------------------------------------------------------
  // timelock transitions
  // -------------------------------------------------------------------------

  it("queueAction: pendingAction set, nothing else changes", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);
    expect(before.pendingActionHash).to.equal(ethers.ZeroHash);
    expect(before.pendingActionExecuteAfter).to.equal(0n);

    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);

    const after = await captureMixerState(mixer);

    // Changed
    expect(after.pendingActionHash).to.equal(actionHash);
    expect(after.pendingActionExecuteAfter).to.be.greaterThan(0n);

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.balance).to.equal(before.balance);
    expect(after.paused).to.equal(before.paused);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.maxDepositsPerAddress).to.equal(before.maxDepositsPerAddress);
  });

  it("cancelAction: pendingAction cleared, nothing else changes", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);

    const before = await captureMixerState(mixer);
    expect(before.pendingActionHash).to.equal(actionHash);

    await mixer.connect(owner).cancelAction();

    const after = await captureMixerState(mixer);

    // Changed
    expect(after.pendingActionHash).to.equal(ethers.ZeroHash);
    expect(after.pendingActionExecuteAfter).to.equal(0n);

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.balance).to.equal(before.balance);
    expect(after.paused).to.equal(before.paused);
    expect(after.maxDepositsPerAddress).to.equal(before.maxDepositsPerAddress);
  });

  it("executeAction: target parameter changes, pendingAction cleared", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);

    const newMax = 5n;
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", newMax]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);

    // Advance time past delay
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    const before = await captureMixerState(mixer);
    await mixer.connect(owner).setMaxDepositsPerAddress(newMax);
    const after = await captureMixerState(mixer);

    // Changed: target parameter + pending action cleared
    expect(after.maxDepositsPerAddress).to.equal(newMax);
    expect(after.pendingActionHash).to.equal(ethers.ZeroHash);
    expect(after.pendingActionExecuteAfter).to.equal(0n);

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.balance).to.equal(before.balance);
    expect(after.paused).to.equal(before.paused);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.levels).to.equal(before.levels);
    expect(after.owner).to.equal(before.owner);
  });

  // -------------------------------------------------------------------------
  // deposit with receipt
  // -------------------------------------------------------------------------

  it("deposit with receipt: all mixer state changes + receipt.balanceOf +1", async function () {
    const { mixer, receiptContract, depositor } =
      await loadFixture(deployWithReceiptFixture);

    const commitment = randomCommitment();
    const depositoAddr = await depositor.getAddress();

    const before = await captureMixerState(mixer);
    const receiptBalanceBefore = await receiptContract.balanceOf(depositoAddr);

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const after = await captureMixerState(mixer);
    const receiptBalanceAfter = await receiptContract.balanceOf(depositoAddr);

    // Mixer state changes
    expect(after.nextIndex).to.equal(before.nextIndex + 1n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DENOMINATION);
    expect(after.balance).to.equal(before.balance + DENOMINATION);
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize + 1n);

    // Receipt minted
    expect(receiptBalanceAfter).to.equal(receiptBalanceBefore + 1n);

    // Receipt stores the commitment
    const tokenId = receiptBalanceBefore; // first token for this depositor
    expect(await receiptContract.tokenCommitment(tokenId)).to.equal(commitment);

    // Unchanged
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.paused).to.equal(before.paused);
  });

  // -------------------------------------------------------------------------
  // multi-operation transitions
  // -------------------------------------------------------------------------

  it("5 deposits: all cumulative state correct", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);

    for (let i = 0; i < 5; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const after = await captureMixerState(mixer);

    expect(after.nextIndex).to.equal(before.nextIndex + 5n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DENOMINATION * 5n);
    expect(after.balance).to.equal(before.balance + DENOMINATION * 5n);
    expect(after.depositCount).to.equal(before.depositCount + 5n);
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize + 5n);
    expect(after.treeUtilization).to.equal((5n * 100n) / TREE_CAPACITY);

    // Unchanged
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.denomination).to.equal(before.denomination);
    expect(after.paused).to.equal(before.paused);
  });

  it("3 deposits + 2 withdrawals: final state matches", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    for (let i = 0; i < 2; i++) {
      await doWithdraw(mixer, recipient, relayer, randomCommitment());
    }

    const after = await captureMixerState(mixer);

    expect(after.nextIndex).to.equal(before.nextIndex + 3n);
    expect(after.depositCount).to.equal(before.depositCount + 3n);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 2n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DENOMINATION * 3n);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + DENOMINATION * 2n);
    expect(after.balance).to.equal(before.balance + DENOMINATION * 3n - DENOMINATION * 2n);
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize + 1n); // 3 - 2
  });

  it("full cycle: deposit → withdraw → deposit: all counters correct", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    const before = await captureMixerState(mixer);

    // First deposit
    const c1 = randomCommitment();
    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });

    const afterFirstDeposit = await captureMixerState(mixer);
    expect(afterFirstDeposit.nextIndex).to.equal(before.nextIndex + 1n);
    expect(afterFirstDeposit.totalDeposited).to.equal(before.totalDeposited + DENOMINATION);

    // Withdraw
    const nullifier = randomCommitment();
    await doWithdraw(mixer, recipient, relayer, nullifier);

    const afterWithdraw = await captureMixerState(mixer);
    expect(afterWithdraw.nextIndex).to.equal(afterFirstDeposit.nextIndex); // nextIndex unchanged by withdraw
    expect(afterWithdraw.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(afterWithdraw.balance).to.equal(0n);
    expect(afterWithdraw.anonymitySetSize).to.equal(0n);

    // Second deposit
    const c2 = randomCommitment();
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });

    const afterSecondDeposit = await captureMixerState(mixer);
    expect(afterSecondDeposit.nextIndex).to.equal(before.nextIndex + 2n);
    expect(afterSecondDeposit.totalDeposited).to.equal(before.totalDeposited + DENOMINATION * 2n);
    expect(afterSecondDeposit.totalWithdrawn).to.equal(before.totalWithdrawn + DENOMINATION);
    expect(afterSecondDeposit.balance).to.equal(DENOMINATION);
    expect(afterSecondDeposit.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(afterSecondDeposit.anonymitySetSize).to.equal(1n);

    // Both commitments remain in tree
    expect(await mixer.isCommitted(c1)).to.be.true;
    expect(await mixer.isCommitted(c2)).to.be.true;
    expect(await mixer.isSpent(nullifier)).to.be.true;
  });
});
