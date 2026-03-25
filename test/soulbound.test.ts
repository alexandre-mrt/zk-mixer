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
const SOULBOUND_ERROR = "DepositReceipt: soulbound, non-transferable";

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

// ---------------------------------------------------------------------------
// Fixture — deploys Mixer + DepositReceipt with timelock
// ---------------------------------------------------------------------------

async function deployFixture() {
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

// Fixture that also pre-mints a token to alice (tokenId = 0)
async function deployFixtureWithToken() {
  const base = await deployFixture();
  await base.mixer.connect(base.alice).deposit(randomCommitment(), { value: DENOMINATION });
  return base;
}

// ---------------------------------------------------------------------------
// Soulbound Restrictions
// ---------------------------------------------------------------------------

describe("Soulbound Restrictions — DepositReceipt (zk-mixer)", function () {
  it("transferFrom owner to other reverts", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("safeTransferFrom owner to other reverts", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("safeTransferFrom with data reverts", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address,
          bob.address,
          0n,
          ethers.toUtf8Bytes("arbitrary data")
        )
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("approve does not enable transfer", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    // Approve succeeds — approvals are not blocked by soulbound logic
    await receipt.connect(alice).approve(bob.address, 0n);
    expect(await receipt.getApproved(0n)).to.equal(bob.address);

    // But the approved operator still cannot transfer
    await expect(
      receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("setApprovalForAll does not enable transfer", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await receipt.connect(alice).setApprovalForAll(bob.address, true);
    expect(await receipt.isApprovedForAll(alice.address, bob.address)).to.be.true;

    // Operator approval does not bypass soulbound restriction
    await expect(
      receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("token stays with original owner after failed transfer attempt", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("balanceOf remains unchanged after failed transfer", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    const aliceBalanceBefore = await receipt.balanceOf(alice.address);
    const bobBalanceBefore = await receipt.balanceOf(bob.address);

    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);

    expect(await receipt.balanceOf(alice.address)).to.equal(aliceBalanceBefore);
    expect(await receipt.balanceOf(bob.address)).to.equal(bobBalanceBefore);
  });

  it("multiple tokens: none are transferable", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);

    // Mint 3 tokens to alice
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    for (const tokenId of [0n, 1n, 2n]) {
      await expect(
        receipt.connect(alice).transferFrom(alice.address, bob.address, tokenId)
      ).to.be.revertedWith(SOULBOUND_ERROR);
    }
  });

  it("mint is allowed (from == address(0))", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployFixture);

    // Deposit triggers a mint — must not revert
    await expect(
      mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.not.be.reverted;

    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("soulbound message is descriptive", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    // Verify the exact revert string so callers can identify the reason
    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
  });
});
