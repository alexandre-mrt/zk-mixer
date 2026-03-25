import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

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

// Helper to perform a withdrawal using the dummy verifier (which always returns true)
async function doWithdraw(
  mixer: Mixer,
  recipient: { getAddress(): Promise<string> },
  relayer: { getAddress(): Promise<string> },
  nullifierHash: bigint,
  fee = 0n
) {
  const root = await mixer.getLastRoot();
  const recipientAddr = await recipient.getAddress() as `0x${string}`;
  const relayerAddr = await relayer.getAddress() as `0x${string}`;

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
// State Consistency
// ---------------------------------------------------------------------------

describe("State Consistency", function () {
  // -------------------------------------------------------------------------
  // After deposit: all views agree
  // -------------------------------------------------------------------------

  it("after deposit: nextIndex, getLastRoot, isCommitted, getStats, balance, anonymitySetSize are consistent", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // nextIndex == 1 (via getDepositCount)
    expect(await mixer.getDepositCount()).to.equal(1);

    // getLastRoot must be non-zero and the root is known
    const root = await mixer.getLastRoot();
    expect(root).to.be.greaterThan(0n);
    expect(await mixer.isKnownRoot(root)).to.be.true;

    // commitment is stored
    expect(await mixer.isCommitted(commitment)).to.be.true;

    // getStats
    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();
    expect(totalDeposited).to.equal(DENOMINATION);
    expect(totalWithdrawn).to.equal(0n);
    expect(depositCount).to.equal(1n);
    expect(withdrawalCount).to.equal(0n);
    expect(poolBalance).to.equal(DENOMINATION);

    // balance matches
    const contractBalance = await ethers.provider.getBalance(await mixer.getAddress());
    expect(contractBalance).to.equal(DENOMINATION);
    expect(poolBalance).to.equal(contractBalance);

    // anonymity set
    expect(await mixer.getAnonymitySetSize()).to.equal(1n);

    // treeUtilization > 0
    const utilization = await mixer.getTreeUtilization();
    expect(utilization).to.be.greaterThan(0n);
    expect(utilization).to.equal((1n * 100n) / TREE_CAPACITY);

    // hasCapacity still true (1 of 32 used)
    expect(await mixer.hasCapacity()).to.be.true;

    // getRemainingDeposits stays max (no limit set)
    expect(await mixer.getRemainingDeposits(depositor.address)).to.equal(2n ** 256n - 1n);
  });

  it("after deposit: getCommitmentIndex and indexToCommitment agree", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const index = await mixer.getCommitmentIndex(commitment);
    expect(index).to.equal(0n);
    expect(await mixer.indexToCommitment(index)).to.equal(commitment);
    expect(await mixer.commitmentIndex(commitment)).to.equal(index);
  });

  it("after deposit: getCommitments(0,1) returns the deposited commitment", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const page = await mixer.getCommitments(0, 1);
    expect(page.length).to.equal(1);
    expect(page[0]).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // After withdrawal: all views agree
  // -------------------------------------------------------------------------

  it("after withdrawal: stats, balance, anonymitySetSize, isSpent are consistent", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const nullifierHash = randomCommitment();
    await doWithdraw(mixer, recipient, relayer, nullifierHash);

    // nullifier is spent
    expect(await mixer.isSpent(nullifierHash)).to.be.true;

    // getStats
    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();
    expect(totalDeposited).to.equal(DENOMINATION);
    expect(totalWithdrawn).to.equal(DENOMINATION);
    expect(depositCount).to.equal(1n);
    expect(withdrawalCount).to.equal(1n);
    expect(poolBalance).to.equal(0n);

    // contract balance is 0
    const contractBalance = await ethers.provider.getBalance(await mixer.getAddress());
    expect(contractBalance).to.equal(0n);
    expect(poolBalance).to.equal(contractBalance);

    // anonymity set is 0 (1 deposited - 1 withdrawn)
    expect(await mixer.getAnonymitySetSize()).to.equal(0n);

    // treeUtilization still reflects deposit count (not withdrawal count)
    const utilization = await mixer.getTreeUtilization();
    expect(utilization).to.equal((1n * 100n) / TREE_CAPACITY);
  });

  it("after withdrawal: getPoolHealth reflects drained balance and anonymitySetSize=0", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(anonymitySetSize).to.equal(0n);
    expect(treeUtilization).to.be.greaterThan(0n);
    expect(poolBalance).to.equal(0n);
    expect(isPaused).to.be.false;
  });

  // -------------------------------------------------------------------------
  // After pause: paused flag consistent across all observers
  // -------------------------------------------------------------------------

  it("after pause: paused(), getPoolHealth.isPaused, and MixerLens.isPaused all agree", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);

    await mixer.connect(owner).pause();

    expect(await mixer.paused()).to.be.true;

    const [, , , isPaused] = await mixer.getPoolHealth();
    expect(isPaused).to.be.true;

    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());
    expect(snapshot.isPaused).to.be.true;
  });

  it("after unpause: all paused views revert to false", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);

    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    expect(await mixer.paused()).to.be.false;

    const [, , , isPaused] = await mixer.getPoolHealth();
    expect(isPaused).to.be.false;

    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());
    expect(snapshot.isPaused).to.be.false;
  });

  // -------------------------------------------------------------------------
  // Multiple deposits: pagination and ordering consistency
  // -------------------------------------------------------------------------

  it("after 5 deposits: getCommitments pagination returns correct pages", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    // First page of 3
    const page0 = await mixer.getCommitments(0, 3);
    expect(page0.length).to.equal(3);
    expect(page0[0]).to.equal(commitments[0]);
    expect(page0[1]).to.equal(commitments[1]);
    expect(page0[2]).to.equal(commitments[2]);

    // Second page of 2
    const page1 = await mixer.getCommitments(3, 2);
    expect(page1.length).to.equal(2);
    expect(page1[0]).to.equal(commitments[3]);
    expect(page1[1]).to.equal(commitments[4]);

    // Full page
    const full = await mixer.getCommitments(0, 5);
    expect(full.length).to.equal(5);
    for (let i = 0; i < 5; i++) {
      expect(full[i]).to.equal(commitments[i]);
    }
  });

  it("after 5 deposits: getStats depositCount matches getDepositCount and getCommitments length", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const count = 5;
    for (let i = 0; i < count; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const [, , depositCount] = await mixer.getStats();
    expect(depositCount).to.equal(BigInt(count));
    expect(await mixer.getDepositCount()).to.equal(count);

    const all = await mixer.getCommitments(0, count);
    expect(all.length).to.equal(count);
  });

  it("after 3 deposits: anonymitySetSize == depositCount when no withdrawals", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const depositCount = await mixer.getDepositCount();
    const anonymitySetSize = await mixer.getAnonymitySetSize();
    expect(anonymitySetSize).to.equal(BigInt(depositCount));
  });

  // -------------------------------------------------------------------------
  // MixerLens snapshot vs. individual calls
  // -------------------------------------------------------------------------

  it("MixerLens snapshot matches individual view calls after 3 deposits", async function () {
    const { mixer, mixerLens, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(snapshot.totalDeposited).to.equal(totalDeposited);
    expect(snapshot.totalWithdrawn).to.equal(totalWithdrawn);
    expect(snapshot.depositCount).to.equal(depositCount);
    expect(snapshot.withdrawalCount).to.equal(withdrawalCount);
    expect(snapshot.poolBalance).to.equal(poolBalance);
    expect(snapshot.anonymitySetSize).to.equal(await mixer.getAnonymitySetSize());
    expect(snapshot.treeCapacity).to.equal(await mixer.getTreeCapacity());
    expect(snapshot.treeUtilization).to.equal(await mixer.getTreeUtilization());
    expect(snapshot.lastRoot).to.equal(await mixer.getLastRoot());
    expect(snapshot.denomination).to.equal(await mixer.denomination());
    expect(snapshot.isPaused).to.equal(await mixer.paused());
    expect(snapshot.maxDepositsPerAddress).to.equal(await mixer.maxDepositsPerAddress());
    expect(snapshot.owner).to.equal(await mixer.owner());
  });

  it("MixerLens snapshot stays consistent after deposit then withdrawal", async function () {
    const { mixer, mixerLens, depositor, recipient, relayer } = await loadFixture(deployFixture);

    // 3 deposits
    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // 1 withdrawal
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(snapshot.totalDeposited).to.equal(totalDeposited);
    expect(snapshot.totalWithdrawn).to.equal(totalWithdrawn);
    expect(snapshot.depositCount).to.equal(depositCount);
    expect(snapshot.withdrawalCount).to.equal(withdrawalCount);
    expect(snapshot.poolBalance).to.equal(poolBalance);
    expect(snapshot.anonymitySetSize).to.equal(await mixer.getAnonymitySetSize());
  });

  // -------------------------------------------------------------------------
  // Deposit receipt state matches mixer state
  // -------------------------------------------------------------------------

  it("deposit receipt tokenCommitment matches mixer isCommitted and commitmentIndex", async function () {
    const { mixer, owner, depositor } = await loadFixture(deployFixture);

    // Wire up the deposit receipt (no timelock in this fixture shortcut — use a fresh deploy)
    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = await DepositReceiptFactory.deploy(await mixer.getAddress());

    // Queue and execute the timelock action
    const receiptAddress = await receipt.getAddress();
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "address"],
        ["setDepositReceipt", receiptAddress]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);
    // Advance time past the timelock delay
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await mixer.connect(owner).setDepositReceipt(receiptAddress);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // Receipt NFT tokenId 0 stores the commitment
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);

    // Mixer state agrees
    expect(await mixer.isCommitted(commitment)).to.be.true;
    expect(await mixer.getCommitmentIndex(commitment)).to.equal(0n);
    expect(await mixer.indexToCommitment(0n)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // Root history consistency
  // -------------------------------------------------------------------------

  it("after each deposit root history grows and isKnownRoot is consistent", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const roots: bigint[] = [];

    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
      roots.push(await mixer.getLastRoot());
    }

    // All three roots are distinct
    expect(roots[0]).to.not.equal(roots[1]);
    expect(roots[1]).to.not.equal(roots[2]);

    // All three roots are still known (within ROOT_HISTORY_SIZE window)
    for (const r of roots) {
      expect(await mixer.isKnownRoot(r)).to.be.true;
    }

    // getValidRootCount includes initial empty-tree root + 3 deposit roots = 4
    expect(await mixer.getValidRootCount()).to.equal(4n);
  });

  // -------------------------------------------------------------------------
  // getPoolHealth internal consistency
  // -------------------------------------------------------------------------

  it("getPoolHealth values match their individual view counterparts", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 2; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(anonymitySetSize).to.equal(await mixer.getAnonymitySetSize());
    expect(treeUtilization).to.equal(await mixer.getTreeUtilization());
    expect(poolBalance).to.equal(
      await ethers.provider.getBalance(await mixer.getAddress())
    );
    expect(isPaused).to.equal(await mixer.paused());
  });

  // -------------------------------------------------------------------------
  // Deposit → withdraw → deposit cycle
  // -------------------------------------------------------------------------

  it("deposit → withdraw → deposit cycle keeps all views internally consistent", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    // First deposit
    const c1 = randomCommitment();
    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });

    // Withdraw
    const nullifier = randomCommitment();
    await doWithdraw(mixer, recipient, relayer, nullifier);

    // Second deposit
    const c2 = randomCommitment();
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(totalDeposited).to.equal(DENOMINATION * 2n);
    expect(totalWithdrawn).to.equal(DENOMINATION);
    expect(depositCount).to.equal(2n);
    expect(withdrawalCount).to.equal(1n);
    expect(poolBalance).to.equal(DENOMINATION);

    // anonymitySetSize = 2 deposits - 1 withdrawal
    expect(await mixer.getAnonymitySetSize()).to.equal(1n);

    // Both commitments are in the tree
    expect(await mixer.isCommitted(c1)).to.be.true;
    expect(await mixer.isCommitted(c2)).to.be.true;

    // Nullifier is spent
    expect(await mixer.isSpent(nullifier)).to.be.true;

    // nextIndex is 2
    expect(await mixer.getDepositCount()).to.equal(2);
  });
});
