import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");
const ONE_DAY = 24 * 60 * 60;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Poseidon helpers (real hashes)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidon: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;

before(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

function computeCommitment(secret: bigint, nullifier: bigint): bigint {
  return F.toObject(poseidon([secret, nullifier]));
}

function computeNullifierHash(nullifier: bigint): bigint {
  return F.toObject(poseidon([nullifier]));
}

function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const signers = await ethers.getSigners();
  const [owner, ...rest] = signers;
  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, signers: [owner, ...rest] };
}

// ---------------------------------------------------------------------------
// Shared withdraw helper
// ---------------------------------------------------------------------------

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: string,
  relayer: string,
  fee: bigint,
  caller?: Signer
) {
  const connected = caller ? mixer.connect(caller) : mixer;
  return connected.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient,
    relayer,
    fee
  );
}

// ---------------------------------------------------------------------------
// Timelock helper (mirrors depositLimit.test.ts pattern)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Usage Scenarios
// ---------------------------------------------------------------------------

describe("Usage Scenarios", function () {
  // -------------------------------------------------------------------------
  // Scenario 1: 10 users deposit, 5 withdraw to fresh addresses
  // -------------------------------------------------------------------------

  it("Scenario: 10 users deposit, 5 withdraw to fresh addresses", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    // 10 unique commitments from 10 different signers (signers[1..10])
    const notes: Array<{ nullifier: bigint; nullifierHash: bigint }> = [];

    for (let i = 1; i <= 10; i++) {
      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await mixer
        .connect(signers[i])
        .deposit(commitment, { value: DENOMINATION });

      notes.push({ nullifier, nullifierHash });
    }

    // Grab fresh addresses for the 5 withdrawers (re-use signers beyond index 10)
    const root = await mixer.getLastRoot();
    const relayerAddr = ethers.ZeroAddress;

    for (let i = 0; i < 5; i++) {
      const freshAddr = signers[11 + i].address;
      await doWithdraw(
        mixer,
        root,
        notes[i].nullifierHash,
        freshAddr,
        relayerAddr,
        0n,
        owner
      );
    }

    // Balance should equal 5 * denomination (5 deposits remain unspent)
    const expectedBalance = DENOMINATION * 5n;
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(expectedBalance);

    // Anonymity set size = deposits - withdrawals
    expect(await mixer.getAnonymitySetSize()).to.equal(5n);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: deposit, withdraw with 10% fee to relayer
  // -------------------------------------------------------------------------

  it("Scenario: deposit, wait, withdraw with fee to relayer", async function () {
    const { mixer, signers, owner } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const recipient = signers[2];
    const relayer = signers[3];

    const secret = randomFieldElement();
    const nullifier = randomFieldElement();
    const commitment = computeCommitment(secret, nullifier);
    const nullifierHash = computeNullifierHash(nullifier);

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const fee = DENOMINATION / 10n; // 10%
    const recipientAddr = recipient.address;
    const relayerAddr = relayer.address;

    const recipientBefore = await ethers.provider.getBalance(recipientAddr);
    const relayerBefore = await ethers.provider.getBalance(relayerAddr);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipientAddr,
      relayerAddr,
      fee,
      owner
    );

    const recipientAfter = await ethers.provider.getBalance(recipientAddr);
    const relayerAfter = await ethers.provider.getBalance(relayerAddr);

    // Recipient receives denomination minus fee (90%)
    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION - fee);
    // Relayer receives fee (10%)
    expect(relayerAfter - relayerBefore).to.equal(fee);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: deposit, pause, withdraw fails, unpause, withdraw succeeds
  // -------------------------------------------------------------------------

  it("Scenario: deposit, pause, unpause, withdraw succeeds", async function () {
    const { mixer, signers, owner } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const recipient = signers[2];

    const secret = randomFieldElement();
    const nullifier = randomFieldElement();
    const commitment = computeCommitment(secret, nullifier);
    const nullifierHash = computeNullifierHash(nullifier);

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    // Owner pauses the contract
    await mixer.connect(owner).pause();

    // Withdrawal while paused must revert
    await expect(
      doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipient.address,
        ethers.ZeroAddress,
        0n,
        owner
      )
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");

    // Owner unpauses
    await mixer.connect(owner).unpause();

    // Withdrawal after unpause must succeed
    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      ethers.ZeroAddress,
      0n,
      owner
    );

    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: rapid deposits up to address limit
  // -------------------------------------------------------------------------

  it("Scenario: rapid deposits up to address limit", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const bob = signers[2];

    // Set per-address limit to 3 via timelock
    await timelockSetMaxDeposits(mixer, owner, 3n);

    // Alice deposits exactly 3 times — all succeed
    for (let i = 0; i < 3; i++) {
      await mixer
        .connect(alice)
        .deposit(randomCommitment(), { value: DENOMINATION });
    }

    // Alice's 4th deposit must revert
    await expect(
      mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.be.revertedWith("Mixer: deposit limit reached");

    // Bob is a different address — his first deposit must still succeed
    await expect(
      mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.not.be.reverted;

    expect(await mixer.depositsPerAddress(bob.address)).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: admin parameter change with timelock
  // -------------------------------------------------------------------------

  it("Scenario: admin parameter change with timelock", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const targetMax = 5n;
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", targetMax]
      )
    );

    // Queue the action
    await mixer.connect(owner).queueAction(actionHash);

    // Attempt to execute before delay elapses — must revert
    await time.increase(ONE_DAY - 60); // 1 minute short of the delay
    await expect(
      mixer.connect(owner).setMaxDepositsPerAddress(targetMax)
    ).to.be.revertedWith("Mixer: timelock not expired");

    // Advance past the full delay
    await time.increase(61);

    // Execution must now succeed
    await expect(mixer.connect(owner).setMaxDepositsPerAddress(targetMax))
      .to.emit(mixer, "MaxDepositsPerAddressUpdated")
      .withArgs(targetMax);

    expect(await mixer.maxDepositsPerAddress()).to.equal(targetMax);

    // Limit is applied: a user may deposit at most 5 times
    const [depositor] = await ethers.getSigners();
    for (let i = 0; i < 5; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomCommitment(), { value: DENOMINATION });
    }

    await expect(
      mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION })
    ).to.be.revertedWith("Mixer: deposit limit reached");
  });
});
