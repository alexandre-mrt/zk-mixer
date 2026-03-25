import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

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
  await time.increase(24 * 60 * 60 + 1); // 1 day + 1 second
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

interface TokenMetadata {
  name: string;
  description: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

function decodeTokenURI(uri: string): TokenMetadata {
  const prefix = "data:application/json;base64,";
  const base64Part = uri.replace(prefix, "");
  const decoded = Buffer.from(base64Part, "base64").toString("utf8");
  return JSON.parse(decoded) as TokenMetadata;
}

function getAttributeValue(
  meta: TokenMetadata,
  traitType: string
): string | undefined {
  const attr = meta.attributes.find((a) => a.trait_type === traitType);
  return attr?.value;
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
// Receipt Metadata
// ---------------------------------------------------------------------------

describe("Receipt Metadata", function () {
  // -------------------------------------------------------------------------
  // 1. URI format
  // -------------------------------------------------------------------------

  it("tokenURI starts with data:application/json;base64,", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const uri = await receipt.tokenURI(0n);
    expect(uri).to.match(/^data:application\/json;base64,/);
  });

  // -------------------------------------------------------------------------
  // 2. JSON name field
  // -------------------------------------------------------------------------

  it("decoded JSON has name field with correct tokenId", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const meta0 = decodeTokenURI(await receipt.tokenURI(0n));
    const meta1 = decodeTokenURI(await receipt.tokenURI(1n));

    expect(meta0.name).to.equal("Deposit Receipt #0");
    expect(meta1.name).to.equal("Deposit Receipt #1");
  });

  // -------------------------------------------------------------------------
  // 3. Description mentions 'soulbound'
  // -------------------------------------------------------------------------

  it("decoded JSON has description mentioning 'soulbound'", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    expect(meta.description).to.include("soulbound");
  });

  // -------------------------------------------------------------------------
  // 4. Attributes array present
  // -------------------------------------------------------------------------

  it("decoded JSON has attributes array", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    expect(meta.attributes).to.be.an("array");
    expect(meta.attributes.length).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 5. Commitment attribute — 0x-prefixed 64-char hex
  // -------------------------------------------------------------------------

  it("Commitment attribute value is hex string of correct length", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const commitmentValue = getAttributeValue(meta, "Commitment");

    expect(commitmentValue).to.not.be.undefined;
    // Strings.toHexString(value, 32) produces "0x" + 64 hex chars
    expect(commitmentValue).to.match(/^0x[0-9a-f]{64}$/i);
  });

  // -------------------------------------------------------------------------
  // 6. Commitment attribute — correct value
  // -------------------------------------------------------------------------

  it("Commitment attribute value matches the deposited commitment", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const commitmentValue = getAttributeValue(meta, "Commitment");

    const expected = "0x" + commitment.toString(16).padStart(64, "0");
    expect(commitmentValue?.toLowerCase()).to.equal(expected.toLowerCase());
  });

  // -------------------------------------------------------------------------
  // 7. Timestamp attribute — non-zero number string
  // -------------------------------------------------------------------------

  it("Timestamp attribute value is non-zero number", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const timestampValue = getAttributeValue(meta, "Timestamp");

    expect(timestampValue).to.not.be.undefined;
    const ts = Number(timestampValue);
    expect(Number.isNaN(ts)).to.equal(false);
    expect(ts).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 8. Different tokens have different commitment attributes
  // -------------------------------------------------------------------------

  it("different tokens have different commitment attributes", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    const c0 = randomCommitment();
    const c1 = randomCommitment();
    await mixer.connect(alice).deposit(c0, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });

    const meta0 = decodeTokenURI(await receipt.tokenURI(0n));
    const meta1 = decodeTokenURI(await receipt.tokenURI(1n));

    const cv0 = getAttributeValue(meta0, "Commitment");
    const cv1 = getAttributeValue(meta1, "Commitment");

    expect(cv0).to.not.equal(cv1);
  });

  // -------------------------------------------------------------------------
  // 9. tokenURI changes between tokens (not cached/shared)
  // -------------------------------------------------------------------------

  it("tokenURI changes between tokens (not cached/shared)", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const uri0 = await receipt.tokenURI(0n);
    const uri1 = await receipt.tokenURI(1n);

    expect(uri0).to.not.equal(uri1);
  });

  // -------------------------------------------------------------------------
  // 10. Very first token (id 0) has valid metadata
  // -------------------------------------------------------------------------

  it("very first token (id 0) has valid metadata", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const uri = await receipt.tokenURI(0n);
    expect(uri).to.match(/^data:application\/json;base64,/);

    const meta = decodeTokenURI(uri);
    expect(meta.name).to.equal("Deposit Receipt #0");
    expect(meta.attributes).to.be.an("array");
    expect(getAttributeValue(meta, "Commitment")).to.match(/^0x[0-9a-f]{64}$/i);
    expect(Number(getAttributeValue(meta, "Timestamp"))).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 11. Token after 10 deposits has correct metadata
  // -------------------------------------------------------------------------

  it("token after 10 deposits has correct metadata", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);

    // MERKLE_TREE_HEIGHT = 5, capacity = 2^5 = 32 slots — 10 deposits is safe
    for (let i = 0; i < 10; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const uri = await receipt.tokenURI(9n);
    const meta = decodeTokenURI(uri);

    expect(meta.name).to.equal("Deposit Receipt #9");
    expect(meta.attributes).to.be.an("array");
    expect(getAttributeValue(meta, "Commitment")).to.match(/^0x[0-9a-f]{64}$/i);
    expect(Number(getAttributeValue(meta, "Timestamp"))).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 12. Soulbound — approve does not bypass transfer restriction
  // -------------------------------------------------------------------------

  it("soulbound: approve does not bypass transfer restriction", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    // approve should succeed
    await expect(receipt.connect(alice).approve(bob.address, 0n)).to.not.be.reverted;

    // but the approved party still cannot transfer
    await expect(
      receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
  });

  // -------------------------------------------------------------------------
  // 13. Soulbound — safeTransferFrom with bytes data reverts
  // -------------------------------------------------------------------------

  it("soulbound: safeTransferFrom(address,address,uint256,bytes) reverts", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address,
          bob.address,
          0n,
          "0x"
        )
    ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
  });

  // -------------------------------------------------------------------------
  // 14. Soulbound — setApprovalForAll does not bypass restriction
  // -------------------------------------------------------------------------

  it("soulbound: setApprovalForAll does not bypass transfer restriction", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    // granting operator approval should not revert
    await expect(
      receipt.connect(alice).setApprovalForAll(bob.address, true)
    ).to.not.be.reverted;

    // but the operator still cannot transfer
    await expect(
      receipt
        .connect(bob)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
  });
});
