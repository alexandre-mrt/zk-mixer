import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment?: bigint
): Promise<bigint> {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: string,
  caller?: Signer
): Promise<void> {
  const connected = caller ? mixer.connect(caller) : mixer;
  await connected.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient as `0x${string}`,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

async function timelockSetMaxDeposits(
  mixer: Mixer,
  owner: Signer,
  max: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setMaxDepositsPerAddress", max]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setMaxDepositsPerAddress(max);
}

async function timelockSetDepositReceipt(
  mixer: Mixer,
  owner: Signer,
  receiptAddress: string
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddress]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, user1, user2, user3, recipient, relayer] =
    await ethers.getSigners();

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

  return { mixer, owner, user1, user2, user3, recipient, relayer };
}

async function deployFixtureWithReceipt() {
  const base = await deployFixture();
  const { mixer, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Operation Ordering", function () {
  // -------------------------------------------------------------------------
  // 1. Deposit A then B has same set membership as deposit B then A (set, not order)
  // -------------------------------------------------------------------------

  it("deposit A then B has same set membership as deposit B then A (set, not order)", async function () {
    // Deploy two independent mixer instances side-by-side within one fixture
    // to avoid loadFixture state-restoration collisions.
    const signers = await ethers.getSigners();
    const [, user1, user2] = signers;

    const hasherAddress = await deployHasher();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier1 = await Verifier.deploy();
    const verifier2 = await Verifier.deploy();
    const MixerFactory = await ethers.getContractFactory("Mixer");

    const mixer1 = (await MixerFactory.deploy(
      await verifier1.getAddress(),
      DENOMINATION,
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as Mixer;

    const mixer2 = (await MixerFactory.deploy(
      await verifier2.getAddress(),
      DENOMINATION,
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as Mixer;

    const cA = randomCommitment();
    const cB = randomCommitment();

    // mixer1: A then B
    await doDeposit(mixer1, user1, cA);
    await doDeposit(mixer1, user2, cB);
    const rootAB = await mixer1.getLastRoot();

    // mixer2: B then A (reversed)
    await doDeposit(mixer2, user2, cB);
    await doDeposit(mixer2, user1, cA);
    const rootBA = await mixer2.getLastRoot();

    // Both commitments are present in each instance (set membership is order-independent)
    expect(await mixer1.commitments(cA)).to.be.true;
    expect(await mixer1.commitments(cB)).to.be.true;
    expect(await mixer2.commitments(cA)).to.be.true;
    expect(await mixer2.commitments(cB)).to.be.true;

    // Merkle root depends on insertion order — the roots differ
    expect(rootAB).to.not.equal(rootBA);

    // Both roots are known in their respective instances
    expect(await mixer1.isKnownRoot(rootAB)).to.be.true;
    expect(await mixer2.isKnownRoot(rootBA)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 2. Withdrawal order doesn't affect final pool balance
  // -------------------------------------------------------------------------

  it("withdrawal order doesn't affect final pool balance", async function () {
    const { mixer, user1, user2, user3, recipient } =
      await loadFixture(deployFixture);

    // Three deposits
    const n1 = randomCommitment();
    const n2 = randomCommitment();
    const n3 = randomCommitment();
    await doDeposit(mixer, user1);
    await doDeposit(mixer, user2);
    await doDeposit(mixer, user3);

    const root = await mixer.getLastRoot();
    const recipientAddr = await recipient.getAddress();

    const mixerAddr = await mixer.getAddress();
    expect(await ethers.provider.getBalance(mixerAddr)).to.equal(DENOMINATION * 3n);

    // Withdraw in a specific order: n3, n1, n2
    await doWithdraw(mixer, root, n3, recipientAddr);
    await doWithdraw(mixer, root, n1, recipientAddr);
    await doWithdraw(mixer, root, n2, recipientAddr);

    expect(await ethers.provider.getBalance(mixerAddr)).to.equal(0n);

    // Stats must be consistent regardless of the order
    const [, totalWithdrawn, , withdrawalCount] = await mixer.getStats();
    expect(totalWithdrawn).to.equal(DENOMINATION * 3n);
    expect(withdrawalCount).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // 3. Three deposits + 3 withdrawals in any order: balance always correct
  // -------------------------------------------------------------------------

  it("3 deposits + 3 withdrawals in any order: balance always correct", async function () {
    const { mixer, user1, user2, user3, recipient } =
      await loadFixture(deployFixture);

    // Deposit all three first
    await doDeposit(mixer, user1);
    await doDeposit(mixer, user2);
    await doDeposit(mixer, user3);

    const root = await mixer.getLastRoot();
    const recipientAddr = await recipient.getAddress();
    const mixerAddr = await mixer.getAddress();

    // Interleave: 1 deposit check, then withdrawals in reverse of deposit order
    const nh1 = randomCommitment();
    const nh2 = randomCommitment();
    const nh3 = randomCommitment();

    expect(await ethers.provider.getBalance(mixerAddr)).to.equal(DENOMINATION * 3n);

    // Withdraw out-of-deposit-order
    await doWithdraw(mixer, root, nh3, recipientAddr);
    expect(await ethers.provider.getBalance(mixerAddr)).to.equal(DENOMINATION * 2n);

    await doWithdraw(mixer, root, nh1, recipientAddr);
    expect(await ethers.provider.getBalance(mixerAddr)).to.equal(DENOMINATION * 1n);

    await doWithdraw(mixer, root, nh2, recipientAddr);
    expect(await ethers.provider.getBalance(mixerAddr)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // 4. Pause between deposits doesn't affect tree integrity
  // -------------------------------------------------------------------------

  it("pause between deposits doesn't affect tree integrity", async function () {
    const { mixer, owner, user1, user2, user3 } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await doDeposit(mixer, user1, c0); // index 0

    // Pause then unpause — tree must remain intact
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    await doDeposit(mixer, user2, c1); // index 1
    await doDeposit(mixer, user3, c2); // index 2

    expect(await mixer.nextIndex()).to.equal(3n);
    expect(await mixer.indexToCommitment(0)).to.equal(c0);
    expect(await mixer.indexToCommitment(1)).to.equal(c1);
    expect(await mixer.indexToCommitment(2)).to.equal(c2);
    expect(await mixer.commitmentIndex(c0)).to.equal(0n);
    expect(await mixer.commitmentIndex(c1)).to.equal(1n);
    expect(await mixer.commitmentIndex(c2)).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // 5. setMaxDepositsPerAddress between deposits works correctly
  // -------------------------------------------------------------------------

  it("setMaxDepositsPerAddress between deposits works correctly", async function () {
    const { mixer, owner, user1 } = await loadFixture(deployFixture);

    // First deposit succeeds with no limit
    const c0 = randomCommitment();
    await doDeposit(mixer, user1, c0);
    expect(await mixer.depositsPerAddress(user1.address)).to.equal(1n);

    // Set limit to 2
    await timelockSetMaxDeposits(mixer, owner, 2n);

    // Second deposit still allowed (1 < 2)
    const c1 = randomCommitment();
    await doDeposit(mixer, user1, c1);
    expect(await mixer.depositsPerAddress(user1.address)).to.equal(2n);

    // Third deposit must revert (2 == 2, not < 2)
    const c2 = randomCommitment();
    await expect(
      mixer.connect(user1).deposit(c2, { value: DENOMINATION })
    ).to.be.revertedWith("Mixer: deposit limit reached");

    // Tree indices are sequential from 0 regardless of the limit change
    expect(await mixer.indexToCommitment(0)).to.equal(c0);
    expect(await mixer.indexToCommitment(1)).to.equal(c1);
    expect(await mixer.nextIndex()).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // 6. Deposit + withdraw + deposit: indices are sequential (0, -, 1)
  // -------------------------------------------------------------------------

  it("deposit + withdraw + deposit: indices are sequential (0, -, 1)", async function () {
    const { mixer, user1, recipient } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    await doDeposit(mixer, user1, c0);
    expect(await mixer.nextIndex()).to.equal(1n);
    expect(await mixer.commitmentIndex(c0)).to.equal(0n);

    // Withdraw — nullifier consumed, nextIndex stays at 1
    const root = await mixer.getLastRoot();
    const nh0 = randomCommitment();
    await doWithdraw(mixer, root, nh0, await recipient.getAddress());
    expect(await mixer.nextIndex()).to.equal(1n);

    // New deposit gets index 1 (not 0)
    const c1 = randomCommitment();
    await doDeposit(mixer, user1, c1);
    expect(await mixer.nextIndex()).to.equal(2n);
    expect(await mixer.commitmentIndex(c1)).to.equal(1n);
    expect(await mixer.indexToCommitment(1)).to.equal(c1);

    // Original commitment at index 0 is unaffected
    expect(await mixer.indexToCommitment(0)).to.equal(c0);
  });

  // -------------------------------------------------------------------------
  // 7. Two deposits in same fixture produce different roots
  // -------------------------------------------------------------------------

  it("two deposits in same fixture produce different roots", async function () {
    const { mixer, user1, user2 } = await loadFixture(deployFixture);

    await doDeposit(mixer, user1);
    const rootAfterFirst = await mixer.getLastRoot();

    await doDeposit(mixer, user2);
    const rootAfterSecond = await mixer.getLastRoot();

    expect(rootAfterFirst).to.not.equal(rootAfterSecond);
    // Both roots are still in the history ring buffer
    expect(await mixer.isKnownRoot(rootAfterFirst)).to.be.true;
    expect(await mixer.isKnownRoot(rootAfterSecond)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 8. Withdrawal with older root still works after new deposits
  // -------------------------------------------------------------------------

  it("withdrawal with older root still works after new deposits", async function () {
    const { mixer, user1, user2, user3, recipient } =
      await loadFixture(deployFixture);

    // Deposit and capture root
    await doDeposit(mixer, user1);
    const oldRoot = await mixer.getLastRoot();

    // Add more deposits after the captured root
    await doDeposit(mixer, user2);
    await doDeposit(mixer, user3);

    const newRoot = await mixer.getLastRoot();
    expect(newRoot).to.not.equal(oldRoot);

    // Old root must still be recognized (within ROOT_HISTORY_SIZE = 30)
    expect(await mixer.isKnownRoot(oldRoot)).to.be.true;

    // Withdrawal using the old root must succeed
    const recipientAddr = await recipient.getAddress();
    const nh = randomCommitment();
    await expect(
      doWithdraw(mixer, oldRoot, nh, recipientAddr)
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // 9. getCommitments order matches deposit order regardless of timing
  // -------------------------------------------------------------------------

  it("getCommitments order matches deposit order regardless of timing", async function () {
    const { mixer, owner, user1, user2, user3 } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    // Deposit with a pause/unpause in between — timing variation
    await doDeposit(mixer, user1, c0);
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();
    await doDeposit(mixer, user2, c1);
    await doDeposit(mixer, user3, c2);

    const all = await mixer.getCommitments(0, 3);
    expect(all.length).to.equal(3);
    expect(all[0]).to.equal(c0);
    expect(all[1]).to.equal(c1);
    expect(all[2]).to.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 10. Receipt tokenIds are always sequential regardless of other operations
  // -------------------------------------------------------------------------

  it("receipt tokenIds are always sequential regardless of other operations", async function () {
    const { mixer, receipt, user1, user2, user3, recipient } =
      await loadFixture(deployFixtureWithReceipt);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await doDeposit(mixer, user1, c0);

    // Withdraw between deposits — receipt minting should not be affected
    const root0 = await mixer.getLastRoot();
    const nh0 = randomCommitment();
    await doWithdraw(mixer, root0, nh0, await recipient.getAddress());

    await doDeposit(mixer, user2, c1);
    await doDeposit(mixer, user3, c2);

    // Token IDs are assigned by _nextTokenId in DepositReceipt, always 0,1,2,...
    expect(await receipt.tokenCommitment(0)).to.equal(c0);
    expect(await receipt.tokenCommitment(1)).to.equal(c1);
    expect(await receipt.tokenCommitment(2)).to.equal(c2);

    // Total supply: 3 minted
    expect(await receipt.balanceOf(user1.address)).to.equal(1n);
    expect(await receipt.balanceOf(user2.address)).to.equal(1n);
    expect(await receipt.balanceOf(user3.address)).to.equal(1n);
  });
});
