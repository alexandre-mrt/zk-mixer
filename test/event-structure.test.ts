import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
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
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

type MixerFixture = {
  mixer: Mixer;
  owner: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  user1: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  user2: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  relayer: Awaited<ReturnType<typeof ethers.getSigners>>[number];
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture(): Promise<MixerFixture> {
  const [owner, user1, user2, relayer] = await ethers.getSigners();

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

  return { mixer, owner, user1, user2, relayer };
}

// ---------------------------------------------------------------------------
// Event Structure & Topic Encoding Tests
// ---------------------------------------------------------------------------

describe("Event Structure", function () {
  // -------------------------------------------------------------------------
  // Deposit event — indexed fields
  // -------------------------------------------------------------------------

  it("Deposit event has commitment as indexed topic", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);

    expect(log, "Deposit log not found").to.not.be.undefined;

    // topics[0] = event selector
    // topics[1] = first indexed param: commitment
    const expectedTopic1 = ethers.zeroPadValue(ethers.toBeHex(commitment), 32);
    expect(log!.topics[1]).to.equal(expectedTopic1);
  });

  it("Deposit event has 3 non-indexed args (commitment, leafIndex, timestamp)", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);

    expect(log, "Deposit log not found").to.not.be.undefined;

    const parsed = mixer.interface.parseLog(log!);
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("Deposit");

    // args[0] = commitment (indexed — value recovered via parseLog)
    // args[1] = leafIndex (non-indexed)
    // args[2] = timestamp (non-indexed)
    expect(parsed!.args[0]).to.equal(commitment);
    expect(parsed!.args[1]).to.equal(0n); // first deposit → index 0
    expect(parsed!.args[2]).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // Withdrawal event — indexed fields
  // -------------------------------------------------------------------------

  it("Withdrawal event has relayer as indexed topic", async function () {
    const { mixer, user1, user2, relayer } =
      await loadFixture(deployMixerFixture);

    // Deposit first
    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    const fee = 1000n;

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      user2.address as `0x${string}`,
      relayer.address as `0x${string}`,
      fee
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);

    expect(log, "Withdrawal log not found").to.not.be.undefined;

    // topics[1] = first indexed param: relayer address
    const expectedRelayerTopic = ethers.zeroPadValue(
      relayer.address.toLowerCase(),
      32
    );
    expect(log!.topics[1].toLowerCase()).to.equal(
      expectedRelayerTopic.toLowerCase()
    );
  });

  it("Withdrawal event has 4 non-indexed args (to, nullifierHash, relayer, fee)", async function () {
    const { mixer, user1, user2, relayer } =
      await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    const fee = 0n;

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      user2.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      fee
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);

    expect(log, "Withdrawal log not found").to.not.be.undefined;

    const parsed = mixer.interface.parseLog(log!);
    expect(parsed!.name).to.equal("Withdrawal");

    // event Withdrawal(address to, uint256 nullifierHash, address indexed relayer, uint256 fee)
    expect(parsed!.args[0]).to.equal(user2.address);     // to
    expect(parsed!.args[1]).to.equal(nullifierHash);      // nullifierHash
    expect(parsed!.args[2]).to.equal(ethers.ZeroAddress); // relayer (indexed, still recoverable)
    expect(parsed!.args[3]).to.equal(fee);                // fee
  });

  // -------------------------------------------------------------------------
  // Deposit events — topic uniqueness across multiple txs
  // -------------------------------------------------------------------------

  it("Deposit events from multiple txs have unique topics[1] (distinct commitments)", async function () {
    const { mixer, user1, user2 } = await loadFixture(deployMixerFixture);

    const commitmentA = randomCommitment();
    const commitmentB = randomCommitment();
    // Ensure they're different to get distinct topics
    expect(commitmentA).to.not.equal(commitmentB);

    const txA = await mixer
      .connect(user1)
      .deposit(commitmentA, { value: DENOMINATION });
    const receiptA = await txA.wait();

    const txB = await mixer
      .connect(user2)
      .deposit(commitmentB, { value: DENOMINATION });
    const receiptB = await txB.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;

    const logA = receiptA!.logs.find((l) => l.topics[0] === depositTopic);
    const logB = receiptB!.logs.find((l) => l.topics[0] === depositTopic);

    expect(logA, "Deposit log A not found").to.not.be.undefined;
    expect(logB, "Deposit log B not found").to.not.be.undefined;

    // Different commitments → different indexed topics[1]
    expect(logA!.topics[1]).to.not.equal(logB!.topics[1]);
  });

  // -------------------------------------------------------------------------
  // Event count matches operation count
  // -------------------------------------------------------------------------

  it("event count matches operation count after 5 deposits", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const mixerAddress = await mixer.getAddress();
    let totalDepositEvents = 0;

    for (let i = 0; i < 5; i++) {
      const tx = await mixer
        .connect(user1)
        .deposit(randomCommitment(), { value: DENOMINATION });
      const receipt = await tx.wait();
      totalDepositEvents += receipt!.logs.filter(
        (l) =>
          l.address.toLowerCase() === mixerAddress.toLowerCase() &&
          l.topics[0] === depositTopic
      ).length;
    }

    expect(totalDepositEvents).to.equal(5);
  });

  // -------------------------------------------------------------------------
  // Recoverable args via interface.parseLog
  // -------------------------------------------------------------------------

  it("event args are recoverable via interface.parseLog", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);

    const parsed = mixer.interface.parseLog(log!);
    expect(parsed).to.not.be.null;

    // Recover all args by name
    expect(parsed!.args["commitment"]).to.equal(commitment);
    expect(parsed!.args["leafIndex"]).to.equal(0n);
    expect(parsed!.args["timestamp"]).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // ActionQueued event — actionHash indexed
  // -------------------------------------------------------------------------

  it("ActionQueued event has actionHash as indexed topic", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5n]
      )
    );

    const tx = await mixer.connect(owner).queueAction(actionHash);
    const receipt = await tx.wait();

    const actionQueuedTopic =
      mixer.interface.getEvent("ActionQueued").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === actionQueuedTopic);

    expect(log, "ActionQueued log not found").to.not.be.undefined;

    // topics[1] = indexed actionHash
    expect(log!.topics[1]).to.equal(actionHash);
  });

  // -------------------------------------------------------------------------
  // Paused event — emitted on pause
  // -------------------------------------------------------------------------

  it("Paused event emitted on pause", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const tx = await mixer.connect(owner).pause();
    const receipt = await tx.wait();

    const pausedTopic = ethers.id("Paused(address)");
    const log = receipt!.logs.find((l) => l.topics[0] === pausedTopic);

    expect(log, "Paused log not found").to.not.be.undefined;
  });

  // -------------------------------------------------------------------------
  // OwnershipTransferred event — emitted on transfer
  // -------------------------------------------------------------------------

  it("OwnershipTransferred event emitted on transfer", async function () {
    const { mixer, owner, user1 } = await loadFixture(deployMixerFixture);

    const ownershipTransferredTopic = ethers.id(
      "OwnershipTransferred(address,address)"
    );

    const tx = await mixer.connect(owner).transferOwnership(user1.address);
    const receipt = await tx.wait();

    const log = receipt!.logs.find(
      (l) => l.topics[0] === ownershipTransferredTopic
    );

    expect(log, "OwnershipTransferred log not found").to.not.be.undefined;

    // topics[1] = indexed previous owner, topics[2] = indexed new owner
    const prevOwnerTopic = ethers.zeroPadValue(
      owner.address.toLowerCase(),
      32
    );
    const newOwnerTopic = ethers.zeroPadValue(user1.address.toLowerCase(), 32);

    expect(log!.topics[1].toLowerCase()).to.equal(prevOwnerTopic.toLowerCase());
    expect(log!.topics[2].toLowerCase()).to.equal(newOwnerTopic.toLowerCase());
  });

  // -------------------------------------------------------------------------
  // Topic hash encoding — selector matches keccak256 of signature
  // -------------------------------------------------------------------------

  it("Deposit event topic[0] matches keccak256 of its ABI signature", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const expectedTopic = ethers.id(
      "Deposit(uint256,uint32,uint256)"
    );
    const actualTopic = mixer.interface.getEvent("Deposit").topicHash;

    expect(actualTopic).to.equal(expectedTopic);
  });

  it("Withdrawal event topic[0] matches keccak256 of its ABI signature", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const expectedTopic = ethers.id(
      "Withdrawal(address,uint256,address,uint256)"
    );
    const actualTopic = mixer.interface.getEvent("Withdrawal").topicHash;

    expect(actualTopic).to.equal(expectedTopic);
  });
});
