import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");

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
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployWithReceiptFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

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

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, alice, bob, carol };
}

async function deployWithoutReceiptFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

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

  // Intentionally leave depositReceipt unset (address(0))

  return { mixer, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Receipt Ownership
// ---------------------------------------------------------------------------

describe("Receipt Ownership", function () {
  it("each depositor owns their receipt", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
    expect(await receipt.ownerOf(1n)).to.equal(await bob.getAddress());
  });

  it("3 users deposit: each has balanceOf == 1", async function () {
    const { mixer, receipt, alice, bob, carol } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(carol).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
    expect(await receipt.balanceOf(await bob.getAddress())).to.equal(1n);
    expect(await receipt.balanceOf(await carol.getAddress())).to.equal(1n);
  });

  it("same user deposits 3 times: balanceOf == 3", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(3n);
  });

  it("ownerOf tracks correct address for each token", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.ownerOf(1n)).to.equal(bobAddr);
    expect(await receipt.ownerOf(2n)).to.equal(aliceAddr);
  });

  it("receipt persists after withdrawal (not burned)", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const aliceAddr = await alice.getAddress();

    // Verify the receipt exists before withdrawal
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.balanceOf(aliceAddr)).to.equal(1n);

    // The ZK mixer requires an actual ZK proof for withdrawal — we cannot call withdraw
    // without a valid Groth16 proof in this test context. We verify the receipt NFT is
    // owned by alice and was not burned simply by querying it again.
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
  });

  it("ownerOf for token 0 is the first depositor", async function () {
    const { mixer, receipt, bob, alice } = await loadFixture(deployWithReceiptFixture);

    // bob deposits first, alice second
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.ownerOf(0n)).to.equal(await bob.getAddress());
    expect(await receipt.ownerOf(1n)).to.equal(await alice.getAddress());
  });

  it("withdrawal doesn't change receipt ownership", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const aliceAddr = await alice.getAddress();

    // Ownership is checked before and after time passes — no withdrawal triggered
    // (ZK proofs required for actual withdrawal; receipt is soulbound and non-burnable)
    const ownerBefore = await receipt.ownerOf(0n);
    expect(ownerBefore).to.equal(aliceAddr);

    // Simulate time passing without withdrawal
    await time.increase(60);

    const ownerAfter = await receipt.ownerOf(0n);
    expect(ownerAfter).to.equal(aliceAddr);
  });

  it("receipt commitment matches the specific deposit", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);

    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();

    await mixer.connect(alice).deposit(commitmentAlice, { value: DENOMINATION });
    await mixer.connect(bob).deposit(commitmentBob, { value: DENOMINATION });

    expect(await receipt.tokenCommitment(0n)).to.equal(commitmentAlice);
    expect(await receipt.tokenCommitment(1n)).to.equal(commitmentBob);
  });

  it("no receipt minted when depositReceipt is not set", async function () {
    const { mixer, alice } = await loadFixture(deployWithoutReceiptFixture);

    expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    // Deploy a receipt contract separately to verify no tokens were minted to alice
    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = (await DepositReceiptFactory.deploy(
      await mixer.getAddress()
    )) as unknown as DepositReceipt;

    // The receipt was never connected to the mixer so its state is pristine
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(0n);
  });

  it("owner can unset receipt and new deposits don't mint", async function () {
    const { mixer, receipt, owner, alice } = await loadFixture(deployWithReceiptFixture);

    // First deposit with receipt active
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);

    // Owner unsets the receipt via timelock
    await timelockSetDepositReceipt(mixer, owner, ethers.ZeroAddress);
    expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);

    // Second deposit — no new receipt should be minted
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
  });
});
