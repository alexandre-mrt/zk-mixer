import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");
const ONE_DAY = 24 * 60 * 60;
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
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
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function baseFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;
  await mixer.waitForDeployment();

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;
  await mixerLens.waitForDeployment();

  return { owner, alice, bob, relayer, hasherAddress, verifierAddress, verifier, mixer, mixerLens };
}

async function fixtureWithReceipt() {
  const base = await baseFixture();
  const { mixer, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;
  await receipt.waitForDeployment();

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Cross-Contract Interactions
// ---------------------------------------------------------------------------

describe("Cross-Contract Interactions", function () {
  // -------------------------------------------------------------------------
  // Mixer <-> Hasher
  // -------------------------------------------------------------------------

  it("Mixer.hashLeftRight delegates to hasher contract", async function () {
    const { mixer, hasherAddress } = await loadFixture(baseFixture);

    // Call the hasher contract directly using the uint256[2] overload selector
    const uint256ArrAbi = ["function poseidon(uint256[2] inputs) external pure returns (uint256)"];
    const hasherContract = new ethers.Contract(hasherAddress, uint256ArrAbi, await ethers.provider.getSigner());

    const left = 42n;
    const right = 99n;

    const mixerHash = await mixer.hashLeftRight(left, right);
    const directHash = await hasherContract.poseidon([left, right]);

    expect(mixerHash).to.equal(directHash);
  });

  it("Mixer.hashLeftRight matches direct hasher.poseidon call", async function () {
    const { mixer } = await loadFixture(baseFixture);

    const a = 1n;
    const b = 2n;
    const hashAB = await mixer.hashLeftRight(a, b);
    const hashBA = await mixer.hashLeftRight(b, a);

    // Poseidon is not symmetric — different inputs must yield different hashes
    expect(hashAB).to.not.equal(hashBA);
    expect(hashAB).to.be.gt(0n);
    expect(hashBA).to.be.gt(0n);
    // Both outputs must be field elements
    expect(hashAB).to.be.lt(FIELD_SIZE);
    expect(hashBA).to.be.lt(FIELD_SIZE);
  });

  it("hasher address is immutable in Mixer", async function () {
    const { mixer, hasherAddress } = await loadFixture(baseFixture);
    expect(await mixer.hasher()).to.equal(hasherAddress);

    // Re-read after a deposit to confirm it didn't change
    await mixer.connect((await ethers.getSigners())[1]).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await mixer.hasher()).to.equal(hasherAddress);
  });

  // -------------------------------------------------------------------------
  // Mixer <-> Verifier
  // -------------------------------------------------------------------------

  it("Mixer.withdraw calls verifier.verifyProof — proof accepted on Hardhat network", async function () {
    const { mixer, alice, bob } = await loadFixture(baseFixture);

    // Deposit first so tree has a root
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    // Placeholder verifier always returns true on chainId 31337
    await expect(
      mixer.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifierHash,
        bob.address as `0x${string}`,
        ethers.ZeroAddress as `0x${string}`,
        0n
      )
    ).to.not.be.reverted;
  });

  it("verifier address is immutable in Mixer", async function () {
    const { mixer, verifierAddress } = await loadFixture(baseFixture);
    expect(await mixer.verifier()).to.equal(verifierAddress);

    // Still immutable after a deposit
    await mixer.connect((await ethers.getSigners())[1]).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await mixer.verifier()).to.equal(verifierAddress);
  });

  it("placeholder verifier only works on chainId 31337", async function () {
    const { verifier } = await loadFixture(baseFixture);

    // On Hardhat (chainId 31337), the placeholder always returns true
    const network = await ethers.provider.getNetwork();
    expect(network.chainId).to.equal(31337n);

    const result = await verifier.verifyProof(
      [0n, 0n],
      [[0n, 0n], [0n, 0n]],
      [0n, 0n],
      [0n, 0n, 0n, 0n, 0n]
    );
    expect(result).to.be.true;
  });

  // -------------------------------------------------------------------------
  // Mixer <-> DepositReceipt
  // -------------------------------------------------------------------------

  it("Mixer.deposit triggers receipt.mint when configured", async function () {
    const { mixer, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitment = randomCommitment();
    expect(await receipt.balanceOf(alice.address)).to.equal(0n);

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("receipt.mint reverts when called directly (not via mixer)", async function () {
    const { receipt, alice } = await loadFixture(fixtureWithReceipt);

    await expect(
      receipt.connect(alice).mint(alice.address, randomCommitment())
    ).to.be.revertedWith("DepositReceipt: only mixer");
  });

  it("receipt.mixer() returns Mixer address", async function () {
    const { mixer, receipt } = await loadFixture(fixtureWithReceipt);
    expect(await receipt.mixer()).to.equal(await mixer.getAddress());
  });

  it("unset receipt: deposit does not call any external contract for mint (no revert, no token minted)", async function () {
    // baseFixture has no receipt configured — depositReceipt is address(0)
    const { mixer, alice } = await loadFixture(baseFixture);

    // Deploy a fresh receipt not wired to this mixer
    const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const orphanReceipt = (await ReceiptFactory.deploy(
      await mixer.getAddress()
    )) as unknown as DepositReceipt;
    await orphanReceipt.waitForDeployment();

    // Deposit should succeed with no receipt minted
    const commitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.not.be.reverted;

    // The orphan receipt (not wired) has no tokens
    expect(await orphanReceipt.balanceOf(alice.address)).to.equal(0n);
    // depositReceipt is still zero address
    expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);
  });

  // -------------------------------------------------------------------------
  // Mixer <-> MixerLens
  // -------------------------------------------------------------------------

  it("MixerLens reads from Mixer without modifying state", async function () {
    const { mixer, mixerLens, alice } = await loadFixture(baseFixture);
    const mixerAddress = await mixer.getAddress();

    const rootBefore = await mixer.getLastRoot();
    const countBefore = await mixer.getDepositCount();

    await mixerLens.getSnapshot(mixerAddress);

    // State unchanged after a pure read via Lens
    expect(await mixer.getLastRoot()).to.equal(rootBefore);
    expect(await mixer.getDepositCount()).to.equal(countBefore);
  });

  it("MixerLens snapshot matches Mixer individual getters", async function () {
    const { mixer, mixerLens, alice, owner } = await loadFixture(fixtureWithReceipt);
    const mixerAddress = await mixer.getAddress();

    // Make a deposit so stats are non-trivial
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    const [td, tw, dc, wc, pb] = await mixer.getStats();
    expect(snapshot.totalDeposited).to.equal(td);
    expect(snapshot.totalWithdrawn).to.equal(tw);
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.poolBalance).to.equal(pb);
    expect(snapshot.denomination).to.equal(await mixer.denomination());
    expect(snapshot.isPaused).to.equal(await mixer.paused());
    expect(snapshot.owner).to.equal(await mixer.owner());
    expect(snapshot.lastRoot).to.equal(await mixer.getLastRoot());
    expect(snapshot.treeCapacity).to.equal(await mixer.getTreeCapacity());
  });

  it("MixerLens works with any Mixer address (re-deployed instance)", async function () {
    const { mixerLens, hasherAddress, verifierAddress } = await loadFixture(baseFixture);

    // Deploy a second independent Mixer
    const MixerFactory = await ethers.getContractFactory("Mixer");
    const mixer2 = (await MixerFactory.deploy(
      verifierAddress,
      ethers.parseEther("1"),
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as Mixer;
    await mixer2.waitForDeployment();

    const snapshot = await mixerLens.getSnapshot(await mixer2.getAddress());
    expect(snapshot.denomination).to.equal(ethers.parseEther("1"));
    expect(snapshot.depositCount).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Multi-contract state consistency
  // -------------------------------------------------------------------------

  it("deposit updates Mixer state AND mints receipt atomically", async function () {
    const { mixer, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitment = randomCommitment();
    const countBefore = await mixer.getDepositCount();
    const balanceBefore = await receipt.balanceOf(alice.address);

    const tx = await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    await tx.wait();

    // Both state updates happened in the same transaction
    expect(await mixer.getDepositCount()).to.equal(countBefore + 1n);
    expect(await receipt.balanceOf(alice.address)).to.equal(balanceBefore + 1n);
    expect(await mixer.isCommitted(commitment)).to.be.true;
    expect(await receipt.tokenCommitment(balanceBefore)).to.equal(commitment);
  });

  it("failed deposit reverts both Mixer state AND receipt mint", async function () {
    const { mixer, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitment = randomCommitment();
    const countBefore = await mixer.getDepositCount();
    const receiptBalanceBefore = await receipt.balanceOf(alice.address);

    // Sending wrong ETH value must revert the whole transaction
    await expect(
      mixer.connect(alice).deposit(commitment, { value: ethers.parseEther("0.05") })
    ).to.be.revertedWith("Mixer: incorrect deposit amount");

    // Neither state should have changed
    expect(await mixer.getDepositCount()).to.equal(countBefore);
    expect(await receipt.balanceOf(alice.address)).to.equal(receiptBalanceBefore);
    expect(await mixer.isCommitted(commitment)).to.be.false;
  });
});
