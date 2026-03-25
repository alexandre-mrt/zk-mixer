import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier, MerkleTree } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
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

  return { mixer, verifier, owner, alice, bob };
}

async function deployMixerWithReceiptFixture() {
  const base = await deployMixerFixture();
  const { mixer, owner } = base;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  // setDepositReceipt requires timelock
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", await receipt.getAddress()]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
  await ethers.provider.send("evm_mine", []);
  await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

async function deployMerkleTreeFixture() {
  const [owner, alice] = await ethers.getSigners();
  const hasherAddress = await deployHasher();

  // MerkleTree is abstract — deploy via Mixer which inherits it
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, alice };
}

// ---------------------------------------------------------------------------
// ETH Handling Tests
// ---------------------------------------------------------------------------

describe("ETH Handling", function () {
  // -------------------------------------------------------------------------
  // Receive / fallback guard
  // -------------------------------------------------------------------------

  it("direct ETH send to Mixer reverts (no receive function)", async function () {
    const { mixer, alice } = await loadFixture(deployMixerFixture);

    await expect(
      alice.sendTransaction({
        to: await mixer.getAddress(),
        value: ethers.parseEther("1"),
      })
    ).to.be.revertedWithoutReason();
  });

  it("direct ETH send to MerkleTree reverts", async function () {
    // MerkleTree is abstract — test via the concrete Mixer contract
    const { mixer, alice } = await loadFixture(deployMerkleTreeFixture);

    await expect(
      alice.sendTransaction({
        to: await mixer.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithoutReason();
  });

  it("Mixer only accepts ETH via deposit()", async function () {
    const { mixer, alice } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    // Raw send must revert
    await expect(
      alice.sendTransaction({
        to: await mixer.getAddress(),
        value: DENOMINATION,
      })
    ).to.be.revertedWithoutReason();

    // Deposit via deposit() must succeed
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.not.be.reverted;
  });

  it("excess ETH beyond denomination in deposit reverts", async function () {
    const { mixer, alice } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION + 1n })
    ).to.be.revertedWith("Mixer: incorrect deposit amount");
  });

  it("zero ETH deposit reverts", async function () {
    const { mixer, alice } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await expect(
      mixer.connect(alice).deposit(commitment, { value: 0n })
    ).to.be.revertedWith("Mixer: incorrect deposit amount");
  });

  it("withdrawal sends exact amount to recipient", async function () {
    const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    // Make a deposit so the pool has funds
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const recipientAddr = await bob.getAddress();
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment(); // dummy — verifier always returns true

    const recipientBefore = await ethers.provider.getBalance(recipientAddr);

    const tx = await mixer.connect(alice).withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      recipientAddr as unknown as Parameters<typeof mixer.withdraw>[5],
      ethers.ZeroAddress as unknown as Parameters<typeof mixer.withdraw>[6],
      0n
    );
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const recipientAfter = await ethers.provider.getBalance(recipientAddr);

    // Bob is recipient — he did not pay gas (alice did)
    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION);
  });

  it("contract balance matches sum of unspent deposits", async function () {
    const { mixer, alice } = await loadFixture(deployMixerFixture);

    const depositCount = 3n;
    for (let i = 0; i < Number(depositCount); i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const balance = await ethers.provider.getBalance(await mixer.getAddress());
    expect(balance).to.equal(DENOMINATION * depositCount);
  });

  it("DepositReceipt rejects direct ETH", async function () {
    const { receipt, alice } = await loadFixture(deployMixerWithReceiptFixture);

    await expect(
      alice.sendTransaction({
        to: await receipt.getAddress(),
        value: ethers.parseEther("0.1"),
      })
    ).to.be.revertedWithoutReason();
  });
});
