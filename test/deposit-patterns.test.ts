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

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const ONE_DAY = 24 * 60 * 60;

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Minimum valid commitment (non-zero field element)
const COMMITMENT_MIN = 1n;
// Maximum valid commitment (FIELD_SIZE - 1)
const COMMITMENT_MAX = FIELD_SIZE - 1n;

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment?: bigint
): Promise<{ commitment: bigint }> {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return { commitment: c };
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
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const signers = await ethers.getSigners();
  const [owner, user1, user2, user3, user4, user5] = signers;

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

  return { mixer, owner, user1, user2, user3, user4, user5 };
}

async function deployMixerWithReceiptFixture() {
  const signers = await ethers.getSigners();
  const [owner, user1, user2] = signers;

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

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, user1, user2 };
}

async function deployMixerWithoutReceiptFixture() {
  const signers = await ethers.getSigners();
  const [owner, user1] = signers;

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

  // Intentionally do NOT set depositReceipt — leave it as address(0)

  return { mixer, owner, user1 };
}

// ---------------------------------------------------------------------------
// Deposit Patterns
// ---------------------------------------------------------------------------

describe("Deposit Patterns", function () {
  // -------------------------------------------------------------------------
  // 1. Single deposit by one user
  // -------------------------------------------------------------------------

  it("single deposit by one user", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await expect(
      mixer.connect(user1).deposit(commitment, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    expect(await mixer.commitments(commitment)).to.be.true;
    expect(await mixer.nextIndex()).to.equal(1n);
    expect(await mixer.depositsPerAddress(await user1.getAddress())).to.equal(1n);
    expect(await mixer.totalDeposited()).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // 2. 5 rapid deposits by same user
  // -------------------------------------------------------------------------

  it("5 rapid deposits by same user", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    for (let i = 0; i < 5; i++) {
      await doDeposit(mixer, user1);
    }

    expect(await mixer.nextIndex()).to.equal(5n);
    expect(await mixer.depositsPerAddress(await user1.getAddress())).to.equal(5n);
    expect(await mixer.totalDeposited()).to.equal(DENOMINATION * 5n);
  });

  // -------------------------------------------------------------------------
  // 3. Deposits from 5 different users
  // -------------------------------------------------------------------------

  it("deposits from 5 different users", async function () {
    const { mixer, user1, user2, user3, user4, user5 } =
      await loadFixture(deployMixerFixture);

    const users = [user1, user2, user3, user4, user5];
    for (const user of users) {
      await doDeposit(mixer, user);
    }

    expect(await mixer.nextIndex()).to.equal(5n);

    for (const user of users) {
      expect(
        await mixer.depositsPerAddress(await user.getAddress())
      ).to.equal(1n);
    }

    expect(await mixer.totalDeposited()).to.equal(DENOMINATION * 5n);
  });

  // -------------------------------------------------------------------------
  // 4. Deposit with receipt mints NFT
  // -------------------------------------------------------------------------

  it("deposit with receipt mints NFT", async function () {
    const { mixer, receipt, user1 } = await loadFixture(
      deployMixerWithReceiptFixture
    );

    expect(await receipt.balanceOf(await user1.getAddress())).to.equal(0n);

    const commitment = randomCommitment();
    await mixer.connect(user1).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.balanceOf(await user1.getAddress())).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 5. Deposit without receipt (receipt not set)
  // -------------------------------------------------------------------------

  it("deposit without receipt (receipt not set)", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerWithoutReceiptFixture);

    // depositReceipt address should be zero (not configured)
    expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);

    const commitment = randomCommitment();

    // Deposit must still succeed and produce the Deposit event
    await expect(
      mixer.connect(user1).deposit(commitment, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    expect(await mixer.commitments(commitment)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 6. Deposit at commitment boundary — min = 1
  // -------------------------------------------------------------------------

  it("deposit at commitment boundary (min = 1)", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    await expect(
      mixer.connect(user1).deposit(COMMITMENT_MIN, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    expect(await mixer.commitments(COMMITMENT_MIN)).to.be.true;
    expect(await mixer.commitmentIndex(COMMITMENT_MIN)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // 7. Deposit at commitment boundary — max = FIELD_SIZE - 1
  // -------------------------------------------------------------------------

  it("deposit at commitment boundary (max = FIELD_SIZE - 1)", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    await expect(
      mixer.connect(user1).deposit(COMMITMENT_MAX, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    expect(await mixer.commitments(COMMITMENT_MAX)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 8. Deposit updates all stats correctly
  // -------------------------------------------------------------------------

  it("deposit updates all stats correctly", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    // Baseline
    const [
      totalDepositedBefore,
      totalWithdrawnBefore,
      depositCountBefore,
      withdrawalCountBefore,
      poolBalanceBefore,
    ] = await mixer.getStats();

    expect(totalDepositedBefore).to.equal(0n);
    expect(totalWithdrawnBefore).to.equal(0n);
    expect(depositCountBefore).to.equal(0n);
    expect(withdrawalCountBefore).to.equal(0n);
    expect(poolBalanceBefore).to.equal(0n);

    const commitment = randomCommitment();
    await mixer.connect(user1).deposit(commitment, { value: DENOMINATION });

    const [
      totalDepositedAfter,
      totalWithdrawnAfter,
      depositCountAfter,
      withdrawalCountAfter,
      poolBalanceAfter,
    ] = await mixer.getStats();

    expect(totalDepositedAfter).to.equal(DENOMINATION);
    expect(totalWithdrawnAfter).to.equal(0n);
    expect(depositCountAfter).to.equal(1n);
    expect(withdrawalCountAfter).to.equal(0n);
    expect(poolBalanceAfter).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // 9. Deposit updates anonymity set size
  // -------------------------------------------------------------------------

  it("deposit updates anonymity set size", async function () {
    const { mixer, user1, user2, user3 } = await loadFixture(deployMixerFixture);

    expect(await mixer.getAnonymitySetSize()).to.equal(0n);

    await doDeposit(mixer, user1);
    expect(await mixer.getAnonymitySetSize()).to.equal(1n);

    await doDeposit(mixer, user2);
    expect(await mixer.getAnonymitySetSize()).to.equal(2n);

    await doDeposit(mixer, user3);
    expect(await mixer.getAnonymitySetSize()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // 10. Deposit changes Merkle root
  // -------------------------------------------------------------------------

  it("deposit changes Merkle root", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    const rootBefore = await mixer.getLastRoot();

    await doDeposit(mixer, user1);

    const rootAfter = await mixer.getLastRoot();

    expect(rootAfter).to.not.equal(rootBefore);
    expect(rootAfter).to.not.equal(0n);
    expect(await mixer.isKnownRoot(rootAfter)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 11. Deposit emits event with correct leafIndex
  // -------------------------------------------------------------------------

  it("deposit emits event with correct leafIndex", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await expect(
      mixer.connect(user1).deposit(c0, { value: DENOMINATION })
    )
      .to.emit(mixer, "Deposit")
      .withArgs(c0, 0n, (v: bigint) => v > 0n);

    await expect(
      mixer.connect(user1).deposit(c1, { value: DENOMINATION })
    )
      .to.emit(mixer, "Deposit")
      .withArgs(c1, 1n, (v: bigint) => v > 0n);

    await expect(
      mixer.connect(user1).deposit(c2, { value: DENOMINATION })
    )
      .to.emit(mixer, "Deposit")
      .withArgs(c2, 2n, (v: bigint) => v > 0n);

    // Commitments are accessible at the returned indices
    expect(await mixer.indexToCommitment(0)).to.equal(c0);
    expect(await mixer.indexToCommitment(1)).to.equal(c1);
    expect(await mixer.indexToCommitment(2)).to.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 12. Interleaved deposits from 3 users maintain correct ordering
  // -------------------------------------------------------------------------

  it("interleaved deposits from 3 users maintain correct ordering", async function () {
    const { mixer, user1, user2, user3 } = await loadFixture(deployMixerFixture);

    const c1a = randomCommitment();
    const c2a = randomCommitment();
    const c3a = randomCommitment();
    const c1b = randomCommitment();
    const c2b = randomCommitment();
    const c3b = randomCommitment();

    // Interleaved sequence: user1, user2, user3, user1, user2, user3
    await mixer.connect(user1).deposit(c1a, { value: DENOMINATION }); // index 0
    await mixer.connect(user2).deposit(c2a, { value: DENOMINATION }); // index 1
    await mixer.connect(user3).deposit(c3a, { value: DENOMINATION }); // index 2
    await mixer.connect(user1).deposit(c1b, { value: DENOMINATION }); // index 3
    await mixer.connect(user2).deposit(c2b, { value: DENOMINATION }); // index 4
    await mixer.connect(user3).deposit(c3b, { value: DENOMINATION }); // index 5

    expect(await mixer.nextIndex()).to.equal(6n);

    // Verify tree ordering is insertion-ordered regardless of sender
    expect(await mixer.indexToCommitment(0)).to.equal(c1a);
    expect(await mixer.indexToCommitment(1)).to.equal(c2a);
    expect(await mixer.indexToCommitment(2)).to.equal(c3a);
    expect(await mixer.indexToCommitment(3)).to.equal(c1b);
    expect(await mixer.indexToCommitment(4)).to.equal(c2b);
    expect(await mixer.indexToCommitment(5)).to.equal(c3b);

    // Per-address counts are independent
    expect(
      await mixer.depositsPerAddress(await user1.getAddress())
    ).to.equal(2n);
    expect(
      await mixer.depositsPerAddress(await user2.getAddress())
    ).to.equal(2n);
    expect(
      await mixer.depositsPerAddress(await user3.getAddress())
    ).to.equal(2n);

    // commitmentIndex reverse-maps correctly
    expect(await mixer.commitmentIndex(c1a)).to.equal(0n);
    expect(await mixer.commitmentIndex(c3b)).to.equal(5n);
  });
});
