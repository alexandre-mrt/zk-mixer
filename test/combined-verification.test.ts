import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const TREE_CAPACITY = BigInt(2 ** MERKLE_TREE_HEIGHT); // 32

// The test verifier always returns true for any proof input.
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
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function randomNullifierHash(): bigint {
  return BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) + 1n;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

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
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployBaseFixture() {
  const [owner, alice, bob, recipient] = await ethers.getSigners();

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
  const lens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  return { mixer, lens, owner, alice, bob, recipient };
}

async function deployWithReceiptFixture() {
  const base = await deployBaseFixture();

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await base.mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(base.mixer, base.owner, await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Combined Verification Tests
// ---------------------------------------------------------------------------

describe("Combined Verification", function () {
  // -----------------------------------------------------------------------
  // 1. Lens.depositCount == receipt count == event count
  // -----------------------------------------------------------------------

  it("after 3 deposits: Lens.depositCount == receipt count == event count", async function () {
    const { mixer, lens, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    const mixerAddress = await mixer.getAddress();
    const receiptAddress = await receipt.getAddress();

    const commitments: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(alice).deposit(c, { value: DENOMINATION });
    }

    // Source 1: Lens snapshot
    const snapshot = await lens.getSnapshot(mixerAddress);
    expect(snapshot.depositCount).to.equal(3n);

    // Source 2: DepositReceipt NFT balance (receipt count)
    const receiptBalance = await receipt.balanceOf(alice.address);
    expect(receiptBalance).to.equal(3n);

    // Source 3: Deposit events emitted by the contract
    const filter = mixer.filters.Deposit();
    const events = await mixer.queryFilter(filter);
    expect(events.length).to.equal(3);

    // Cross-reference all three sources agree
    expect(snapshot.depositCount).to.equal(receiptBalance);
    expect(snapshot.depositCount).to.equal(BigInt(events.length));
  });

  // -----------------------------------------------------------------------
  // 2. Lens.withdrawalCount matches isSpent count
  // -----------------------------------------------------------------------

  it("after withdrawal: Lens.withdrawalCount matches isSpent count", async function () {
    const { mixer, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const mixerAddress = await mixer.getAddress();

    // Two deposits then two withdrawals with distinct nullifiers
    const nullifiers: bigint[] = [];
    for (let i = 0; i < 2; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    for (let i = 0; i < 2; i++) {
      const root = await mixer.getLastRoot();
      const nullifierHash = randomNullifierHash();
      nullifiers.push(nullifierHash);
      await mixer.withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        recipient.address as `0x${string}`,
        ethers.ZeroAddress as `0x${string}`,
        0n
      );
    }

    // Source 1: Lens snapshot
    const snapshot = await lens.getSnapshot(mixerAddress);
    expect(snapshot.withdrawalCount).to.equal(2n);

    // Source 2: isSpent mapping on-chain
    let spentCount = 0n;
    for (const n of nullifiers) {
      if (await mixer.isSpent(n)) spentCount++;
    }
    expect(spentCount).to.equal(2n);

    // Source 3: Withdrawal events
    const filter = mixer.filters.Withdrawal();
    const events = await mixer.queryFilter(filter);
    expect(BigInt(events.length)).to.equal(2n);

    // All three agree
    expect(snapshot.withdrawalCount).to.equal(spentCount);
    expect(snapshot.withdrawalCount).to.equal(BigInt(events.length));
  });

  // -----------------------------------------------------------------------
  // 3. Lens.poolBalance == provider.getBalance == totalDeposited - totalWithdrawn
  // -----------------------------------------------------------------------

  it("Lens.poolBalance == provider.getBalance == totalDeposited - totalWithdrawn", async function () {
    const { mixer, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const mixerAddress = await mixer.getAddress();

    // 3 deposits, 1 withdrawal
    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }
    const root = await mixer.getLastRoot();
    await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      randomNullifierHash(),
      recipient.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    // Source 1: Lens snapshot poolBalance
    const snapshot = await lens.getSnapshot(mixerAddress);
    const lensBalance = snapshot.poolBalance;

    // Source 2: ethers provider on-chain balance
    const providerBalance = await ethers.provider.getBalance(mixerAddress);

    // Source 3: derived from totalDeposited - totalWithdrawn
    const computedBalance = snapshot.totalDeposited - snapshot.totalWithdrawn;

    expect(lensBalance).to.equal(providerBalance);
    expect(lensBalance).to.equal(computedBalance);
    expect(lensBalance).to.equal(DENOMINATION * 2n);
  });

  // -----------------------------------------------------------------------
  // 4. Lens.anonymitySetSize == depositCount - withdrawalCount
  // -----------------------------------------------------------------------

  it("Lens.anonymitySetSize == depositCount - withdrawalCount", async function () {
    const { mixer, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const mixerAddress = await mixer.getAddress();

    // 4 deposits, 2 withdrawals
    for (let i = 0; i < 4; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }
    for (let i = 0; i < 2; i++) {
      const root = await mixer.getLastRoot();
      await mixer.withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        randomNullifierHash(),
        recipient.address as `0x${string}`,
        ethers.ZeroAddress as `0x${string}`,
        0n
      );
    }

    const snapshot = await lens.getSnapshot(mixerAddress);

    // Source 1: Lens.anonymitySetSize
    const lensAnonymitySet = snapshot.anonymitySetSize;

    // Source 2: derived from Lens counts
    const derivedAnonymitySet = snapshot.depositCount - snapshot.withdrawalCount;

    // Source 3: direct contract getter
    const contractAnonymitySet = await mixer.getAnonymitySetSize();

    expect(lensAnonymitySet).to.equal(derivedAnonymitySet);
    expect(lensAnonymitySet).to.equal(contractAnonymitySet);
    expect(lensAnonymitySet).to.equal(2n);
  });

  // -----------------------------------------------------------------------
  // 5. Lens.treeUtilization matches manual computation
  // -----------------------------------------------------------------------

  it("Lens.treeUtilization matches manual computation", async function () {
    const { mixer, lens, alice } = await loadFixture(deployBaseFixture);

    const mixerAddress = await mixer.getAddress();

    const depositCount = 5n;
    for (let i = 0n; i < depositCount; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const snapshot = await lens.getSnapshot(mixerAddress);

    // Source 1: Lens treeUtilization
    const lensUtilization = snapshot.treeUtilization;

    // Source 2: manual formula — (depositCount * 100) / treeCapacity
    const manualUtilization = (depositCount * 100n) / TREE_CAPACITY;

    // Source 3: direct contract getter
    const contractUtilization = await mixer.getTreeUtilization();

    expect(lensUtilization).to.equal(manualUtilization);
    expect(lensUtilization).to.equal(contractUtilization);
  });

  // -----------------------------------------------------------------------
  // 6. receipt tokenURI JSON contains matching commitment from Lens data
  // -----------------------------------------------------------------------

  it("receipt tokenURI JSON contains matching commitment from Lens data", async function () {
    const { mixer, lens, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    const mixerAddress = await mixer.getAddress();

    // Make a deposit with a known commitment
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    // Source 1: tokenURI from DepositReceipt NFT
    const uri = await receipt.tokenURI(0n);
    const base64Part = uri.replace("data:application/json;base64,", "");
    const decoded = Buffer.from(base64Part, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);

    const commitmentAttr = parsed.attributes.find(
      (a: { trait_type: string; value: string }) => a.trait_type === "Commitment"
    );
    expect(commitmentAttr).to.not.be.undefined;
    const tokenUriCommitment = BigInt(commitmentAttr.value);

    // Source 2: on-chain tokenCommitment
    const onChainCommitment = await receipt.tokenCommitment(0n);

    // Source 3: Lens snapshot confirms 1 deposit happened
    const snapshot = await lens.getSnapshot(mixerAddress);
    expect(snapshot.depositCount).to.equal(1n);

    // All three agree on the commitment value
    expect(tokenUriCommitment).to.equal(commitment);
    expect(onChainCommitment).to.equal(commitment);
  });

  // -----------------------------------------------------------------------
  // 7. All view functions return identical values when called twice
  // -----------------------------------------------------------------------

  it("all view functions return identical values when called twice", async function () {
    const { mixer, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const mixerAddress = await mixer.getAddress();

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      randomNullifierHash(),
      recipient.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    // Call lens twice with no state change in between
    const snapshot1 = await lens.getSnapshot(mixerAddress);
    const snapshot2 = await lens.getSnapshot(mixerAddress);

    expect(snapshot1.totalDeposited).to.equal(snapshot2.totalDeposited);
    expect(snapshot1.totalWithdrawn).to.equal(snapshot2.totalWithdrawn);
    expect(snapshot1.depositCount).to.equal(snapshot2.depositCount);
    expect(snapshot1.withdrawalCount).to.equal(snapshot2.withdrawalCount);
    expect(snapshot1.poolBalance).to.equal(snapshot2.poolBalance);
    expect(snapshot1.anonymitySetSize).to.equal(snapshot2.anonymitySetSize);
    expect(snapshot1.treeUtilization).to.equal(snapshot2.treeUtilization);
    expect(snapshot1.lastRoot).to.equal(snapshot2.lastRoot);

    // Also verify direct contract calls are stable
    const [td1, tw1, dc1, wc1, pb1] = await mixer.getStats();
    const [td2, tw2, dc2, wc2, pb2] = await mixer.getStats();
    expect(td1).to.equal(td2);
    expect(tw1).to.equal(tw2);
    expect(dc1).to.equal(dc2);
    expect(wc1).to.equal(wc2);
    expect(pb1).to.equal(pb2);
  });

  // -----------------------------------------------------------------------
  // 8. Full cycle: all data sources agree at every step
  // -----------------------------------------------------------------------

  it("full cycle: all data sources agree at every step", async function () {
    const { mixer, lens, receipt, alice, recipient } = await loadFixture(
      deployWithReceiptFixture
    );

    const mixerAddress = await mixer.getAddress();

    // --- Step 0: empty pool ---
    let snapshot = await lens.getSnapshot(mixerAddress);
    let [, , dc, wc] = await mixer.getStats();
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(mixerAddress));

    // --- Step 1: 2 deposits ---
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });

    snapshot = await lens.getSnapshot(mixerAddress);
    [, , dc, wc] = await mixer.getStats();

    // Lens vs direct contract
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(mixerAddress));
    expect(snapshot.depositCount).to.equal(2n);

    // Lens vs receipt NFT balance
    expect(snapshot.depositCount).to.equal(await receipt.balanceOf(alice.address));

    // Lens vs Deposit events
    const depositEvents = await mixer.queryFilter(mixer.filters.Deposit());
    expect(snapshot.depositCount).to.equal(BigInt(depositEvents.length));

    // anonymitySetSize at this point
    expect(snapshot.anonymitySetSize).to.equal(2n);
    expect(snapshot.anonymitySetSize).to.equal(snapshot.depositCount - snapshot.withdrawalCount);

    // --- Step 2: 1 withdrawal ---
    const root = await mixer.getLastRoot();
    const nullifierHash = randomNullifierHash();
    await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      recipient.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    snapshot = await lens.getSnapshot(mixerAddress);
    [, , dc, wc] = await mixer.getStats();

    // Lens vs direct contract
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.withdrawalCount).to.equal(1n);

    // Lens vs isSpent
    expect(await mixer.isSpent(nullifierHash)).to.equal(true);

    // Lens vs Withdrawal events
    const withdrawalEvents = await mixer.queryFilter(mixer.filters.Withdrawal());
    expect(snapshot.withdrawalCount).to.equal(BigInt(withdrawalEvents.length));

    // Balance cross-check: lens == provider == totalDeposited - totalWithdrawn
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(mixerAddress));
    expect(snapshot.poolBalance).to.equal(snapshot.totalDeposited - snapshot.totalWithdrawn);
    expect(snapshot.poolBalance).to.equal(DENOMINATION);

    // anonymitySetSize after withdrawal: 2 deposits - 1 withdrawal = 1
    expect(snapshot.anonymitySetSize).to.equal(1n);
    expect(snapshot.anonymitySetSize).to.equal(snapshot.depositCount - snapshot.withdrawalCount);
  });
});
