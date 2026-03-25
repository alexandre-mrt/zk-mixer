import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const MERKLE_TREE_HEIGHT = 5;
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

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
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

  return { mixer, owner, alice, bob, carol };
}

async function deployWithReceiptFixture() {
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

  const DepositReceiptFactory =
    await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Boundary Tests
// ---------------------------------------------------------------------------

describe("Boundary Tests", function () {
  // -------------------------------------------------------------------------
  // Commitment value boundaries
  // -------------------------------------------------------------------------

  it("accepts commitment = 1 (minimum valid value)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    await expect(
      mixer.connect(alice).deposit(1n, { value: DENOMINATION })
    ).to.not.be.reverted;
  });

  it("accepts commitment = FIELD_SIZE - 1 (maximum valid value)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const maxValid = FIELD_SIZE - 1n;
    await expect(
      mixer.connect(alice).deposit(maxValid, { value: DENOMINATION })
    ).to.not.be.reverted;
  });

  it("reverts when commitment = FIELD_SIZE (out of field)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    await expect(
      mixer.connect(alice).deposit(FIELD_SIZE, { value: DENOMINATION })
    ).to.be.revertedWith("Mixer: commitment >= field size");
  });

  // -------------------------------------------------------------------------
  // Multi-deposit same address
  // -------------------------------------------------------------------------

  it("same address can deposit multiple times (no limit set)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.not.be.reverted;
    }

    expect(await mixer.nextIndex()).to.equal(3n);
    expect(await mixer.depositsPerAddress(alice.address)).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // Withdraw to the same address that deposited
  // -------------------------------------------------------------------------

  it("can withdraw to the depositing address", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();

    const balanceBefore = await ethers.provider.getBalance(alice.address);

    const tx = await mixer
      .connect(alice)
      .withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        alice.address,
        ethers.ZeroAddress,
        0n
      );

    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balanceAfter = await ethers.provider.getBalance(alice.address);

    // Balance increases by denomination minus gas
    expect(balanceAfter).to.be.greaterThan(balanceBefore - gasUsed);
  });

  // -------------------------------------------------------------------------
  // Zero fee withdrawal
  // -------------------------------------------------------------------------

  it("zero fee withdrawal sends full denomination to recipient", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();

    const balanceBefore = await ethers.provider.getBalance(bob.address);

    await mixer
      .connect(alice)
      .withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        bob.address,
        ethers.ZeroAddress,
        0n
      );

    const balanceAfter = await ethers.provider.getBalance(bob.address);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // Fee equals denomination
  // -------------------------------------------------------------------------

  it("fee equal to denomination sends everything to relayer, zero to recipient", async function () {
    const { mixer, alice, bob, carol } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();

    const bobBefore = await ethers.provider.getBalance(bob.address);
    const carolBefore = await ethers.provider.getBalance(carol.address);

    await mixer
      .connect(alice)
      .withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        bob.address,
        carol.address,
        DENOMINATION // fee == denomination
      );

    const bobAfter = await ethers.provider.getBalance(bob.address);
    const carolAfter = await ethers.provider.getBalance(carol.address);

    // Recipient receives denomination - fee = 0
    expect(bobAfter - bobBefore).to.equal(0n);
    // Relayer receives the full denomination as fee
    expect(carolAfter - carolBefore).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // Pause + unpause recovery
  // -------------------------------------------------------------------------

  it("operations resume after pause + unpause cycle", async function () {
    const { mixer, owner, alice, bob } = await loadFixture(deployFixture);

    // Deposit before pause
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();

    // Pause
    await mixer.connect(owner).pause();
    expect(await mixer.paused()).to.be.true;

    // Both deposit and withdraw fail
    await expect(
      mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");

    // Unpause
    await mixer.connect(owner).unpause();
    expect(await mixer.paused()).to.be.false;

    // Withdraw now succeeds
    await expect(
      mixer
        .connect(alice)
        .withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          bob.address,
          ethers.ZeroAddress,
          0n
        )
    ).to.not.be.reverted;

    // New deposit also succeeds
    await expect(
      mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // DepositReceipt — first tokenId is 0
  // -------------------------------------------------------------------------

  it("first deposit receipt has tokenId 0", async function () {
    const { mixer, receipt, alice } = await loadFixture(
      deployWithReceiptFixture
    );

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // getStats idempotency
  // -------------------------------------------------------------------------

  it("getStats is idempotent — multiple calls return identical values", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();
    await mixer
      .connect(alice)
      .withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        bob.address,
        ethers.ZeroAddress,
        0n
      );

    const stats1 = await mixer.getStats();
    const stats2 = await mixer.getStats();
    const stats3 = await mixer.getStats();

    expect(stats1[0]).to.equal(stats2[0]);
    expect(stats1[1]).to.equal(stats2[1]);
    expect(stats1[2]).to.equal(stats2[2]);
    expect(stats1[3]).to.equal(stats2[3]);
    expect(stats1[4]).to.equal(stats2[4]);

    expect(stats2[0]).to.equal(stats3[0]);
    expect(stats2[4]).to.equal(stats3[4]);
  });
});
