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
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
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

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Receipt Enumeration
// ---------------------------------------------------------------------------

describe("Receipt Enumeration", function () {
  it("no receipts exist before any deposit", async function () {
    const { receipt, alice } = await loadFixture(deployFixture);

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(0n);
  });

  it("first deposit mints tokenId 0", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
  });

  it("second deposit mints tokenId 1", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.ownerOf(1n)).to.equal(await alice.getAddress());
  });

  it("tokenCommitment matches deposit commitment for each receipt", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    const c0 = randomCommitment();
    const c1 = randomCommitment();

    await mixer.connect(alice).deposit(c0, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });

    expect(await receipt.tokenCommitment(0n)).to.equal(c0);
    expect(await receipt.tokenCommitment(1n)).to.equal(c1);
  });

  it("tokenTimestamp is non-zero for minted tokens", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.tokenTimestamp(0n)).to.be.greaterThan(0n);
  });

  it("ownerOf returns depositor for each receipt", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const aliceAddr = await alice.getAddress();
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.ownerOf(1n)).to.equal(aliceAddr);
    expect(await receipt.ownerOf(2n)).to.equal(aliceAddr);
  });

  it("balanceOf returns 1 per deposit per user", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(2n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(3n);
  });

  it("multiple users have their own receipts", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();

    await mixer.connect(alice).deposit(commitmentAlice, { value: DENOMINATION });
    await mixer.connect(bob).deposit(commitmentBob, { value: DENOMINATION });

    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    expect(await receipt.balanceOf(aliceAddr)).to.equal(1n);
    expect(await receipt.balanceOf(bobAddr)).to.equal(1n);
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.ownerOf(1n)).to.equal(bobAddr);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitmentAlice);
    expect(await receipt.tokenCommitment(1n)).to.equal(commitmentBob);
  });

  it("tokenURI contains valid base64 JSON", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const uri = await receipt.tokenURI(0n);
    expect(uri).to.match(/^data:application\/json;base64,/);

    const base64Part = uri.replace("data:application/json;base64,", "");
    const decoded = Buffer.from(base64Part, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);

    expect(parsed).to.have.property("name");
    expect(parsed).to.have.property("description");
    expect(parsed).to.have.property("attributes");
    expect(Array.isArray(parsed.attributes)).to.be.true;
  });

  it("tokenURI contains correct tokenId in name field", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const uri0 = await receipt.tokenURI(0n);
    const decoded0 = Buffer.from(uri0.replace("data:application/json;base64,", ""), "base64").toString("utf8");
    expect(JSON.parse(decoded0).name).to.equal("Deposit Receipt #0");

    const uri1 = await receipt.tokenURI(1n);
    const decoded1 = Buffer.from(uri1.replace("data:application/json;base64,", ""), "base64").toString("utf8");
    expect(JSON.parse(decoded1).name).to.equal("Deposit Receipt #1");
  });
});
