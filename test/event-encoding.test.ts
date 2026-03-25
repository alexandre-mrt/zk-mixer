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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
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
// Event Encoding Tests
// ---------------------------------------------------------------------------

describe("Event Encoding", function () {
  // -------------------------------------------------------------------------
  // Deposit event — arg types
  // -------------------------------------------------------------------------

  it("Deposit.commitment is uint256", async function () {
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

    // uint256 comes back as bigint in ethers v6
    expect(typeof parsed!.args["commitment"]).to.equal("bigint");
  });

  it("Deposit.leafIndex is uint32", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = mixer.interface.parseLog(log!);

    // uint32 also comes back as bigint in ethers v6
    expect(typeof parsed!.args["leafIndex"]).to.equal("bigint");
    // uint32 max is 4294967295
    expect(parsed!.args["leafIndex"]).to.be.lessThanOrEqual(4294967295n);
  });

  it("Deposit.timestamp is uint256", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(typeof parsed!.args["timestamp"]).to.equal("bigint");
    expect(parsed!.args["timestamp"]).to.be.greaterThan(0n);
  });

  it("Deposit.commitment matches the deposited value exactly", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(parsed!.args["commitment"]).to.equal(commitment);
  });

  it("Deposit.leafIndex starts at 0 and increments", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);

    const tx0 = await mixer
      .connect(user1)
      .deposit(randomCommitment(), { value: DENOMINATION });
    const receipt0 = await tx0.wait();

    const tx1 = await mixer
      .connect(user1)
      .deposit(randomCommitment(), { value: DENOMINATION });
    const receipt1 = await tx1.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;

    const log0 = receipt0!.logs.find((l) => l.topics[0] === depositTopic);
    const log1 = receipt1!.logs.find((l) => l.topics[0] === depositTopic);

    const parsed0 = mixer.interface.parseLog(log0!);
    const parsed1 = mixer.interface.parseLog(log1!);

    expect(parsed0!.args["leafIndex"]).to.equal(0n);
    expect(parsed1!.args["leafIndex"]).to.equal(1n);
  });

  it("Deposit.timestamp is close to block.timestamp", async function () {
    const { mixer, user1 } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(user1)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = mixer.interface.parseLog(log!);

    const eventTimestamp = parsed!.args["timestamp"] as bigint;
    // Timestamp must match block.timestamp exactly (set in contract as block.timestamp)
    expect(eventTimestamp).to.equal(blockTimestamp);
  });

  // -------------------------------------------------------------------------
  // Withdrawal event — arg types
  // -------------------------------------------------------------------------

  it("Withdrawal.to is address", async function () {
    const { mixer, user1, user2 } = await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      randomCommitment(),
      user2.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    expect(log, "Withdrawal log not found").to.not.be.undefined;

    const parsed = mixer.interface.parseLog(log!);
    // address comes back as a string in ethers v6
    expect(typeof parsed!.args["to"]).to.equal("string");
    expect(ethers.isAddress(parsed!.args["to"])).to.equal(true);
  });

  it("Withdrawal.nullifierHash is uint256", async function () {
    const { mixer, user1, user2 } = await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      user2.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(typeof parsed!.args["nullifierHash"]).to.equal("bigint");
  });

  it("Withdrawal.relayer is address", async function () {
    const { mixer, user1, user2, relayer } = await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      randomCommitment(),
      user2.address as `0x${string}`,
      relayer.address as `0x${string}`,
      1000n
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(typeof parsed!.args["relayer"]).to.equal("string");
    expect(ethers.isAddress(parsed!.args["relayer"])).to.equal(true);
  });

  it("Withdrawal.fee is uint256", async function () {
    const { mixer, user1, user2, relayer } = await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const fee = 5000n;

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      randomCommitment(),
      user2.address as `0x${string}`,
      relayer.address as `0x${string}`,
      fee
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(typeof parsed!.args["fee"]).to.equal("bigint");
  });

  it("Withdrawal.fee matches the provided fee exactly", async function () {
    const { mixer, user1, user2, relayer } = await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const fee = 9999n;

    const tx = await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      randomCommitment(),
      user2.address as `0x${string}`,
      relayer.address as `0x${string}`,
      fee
    );
    const receipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(parsed!.args["fee"]).to.equal(fee);
  });

  // -------------------------------------------------------------------------
  // Admin events
  // -------------------------------------------------------------------------

  it("ActionQueued.actionHash is bytes32", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5n]
      )
    );

    const tx = await mixer.connect(owner).queueAction(actionHash);
    const receipt = await tx.wait();

    const actionQueuedTopic = mixer.interface.getEvent("ActionQueued").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === actionQueuedTopic);
    expect(log, "ActionQueued log not found").to.not.be.undefined;

    const parsed = mixer.interface.parseLog(log!);
    // bytes32 comes back as a 0x-prefixed hex string of length 66 in ethers v6
    expect(typeof parsed!.args["actionHash"]).to.equal("string");
    expect(parsed!.args["actionHash"]).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(parsed!.args["actionHash"]).to.equal(actionHash);
  });

  it("ActionQueued.executeAfter is uint256", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 3n]
      )
    );

    const tx = await mixer.connect(owner).queueAction(actionHash);
    const receipt = await tx.wait();

    const actionQueuedTopic = mixer.interface.getEvent("ActionQueued").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === actionQueuedTopic);
    const parsed = mixer.interface.parseLog(log!);

    expect(typeof parsed!.args["executeAfter"]).to.equal("bigint");
    expect(parsed!.args["executeAfter"]).to.be.greaterThan(0n);
  });

  it("Paused.account is address (msg.sender)", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    const tx = await mixer.connect(owner).pause();
    const receipt = await tx.wait();

    const pausedTopic = ethers.id("Paused(address)");
    const log = receipt!.logs.find((l) => l.topics[0] === pausedTopic);
    expect(log, "Paused log not found").to.not.be.undefined;

    // Paused(address account) — account is non-indexed, stored in data
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address"],
      log!.data
    );
    expect(ethers.isAddress(decoded[0])).to.equal(true);
    expect(decoded[0]).to.equal(owner.address);
  });

  it("OwnershipTransferred has old and new owner", async function () {
    const { mixer, owner, user1 } = await loadFixture(deployMixerFixture);

    const tx = await mixer.connect(owner).transferOwnership(user1.address);
    const receipt = await tx.wait();

    const ownershipTransferredTopic = ethers.id(
      "OwnershipTransferred(address,address)"
    );
    const log = receipt!.logs.find(
      (l) => l.topics[0] === ownershipTransferredTopic
    );
    expect(log, "OwnershipTransferred log not found").to.not.be.undefined;

    // Both previousOwner and newOwner are indexed (topics[1] and topics[2])
    expect(log!.topics).to.have.length(3);

    const prevOwner = ethers.getAddress(
      "0x" + log!.topics[1].slice(26)
    );
    const newOwner = ethers.getAddress(
      "0x" + log!.topics[2].slice(26)
    );

    expect(ethers.isAddress(prevOwner)).to.equal(true);
    expect(ethers.isAddress(newOwner)).to.equal(true);
    expect(prevOwner).to.equal(owner.address);
    expect(newOwner).to.equal(user1.address);
  });

  // -------------------------------------------------------------------------
  // Decodability — interface.parseLog round-trip
  // -------------------------------------------------------------------------

  it("Deposit event is decodable via interface.parseLog with named args", async function () {
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
    expect(parsed!.name).to.equal("Deposit");

    // Named args accessible
    expect(parsed!.args["commitment"]).to.equal(commitment);
    expect(parsed!.args["leafIndex"]).to.equal(0n);
    expect(parsed!.args["timestamp"]).to.be.greaterThan(0n);
  });

  it("Withdrawal event is decodable via interface.parseLog with named args", async function () {
    const { mixer, user1, user2, relayer } = await loadFixture(deployMixerFixture);

    await mixer.connect(user1).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    const fee = 1234n;

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

    const parsed = mixer.interface.parseLog(log!);
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("Withdrawal");

    // event Withdrawal(address to, uint256 nullifierHash, address indexed relayer, uint256 fee)
    expect(parsed!.args["to"]).to.equal(user2.address);
    expect(parsed!.args["nullifierHash"]).to.equal(nullifierHash);
    expect(parsed!.args["relayer"]).to.equal(relayer.address);
    expect(parsed!.args["fee"]).to.equal(fee);
  });
});
