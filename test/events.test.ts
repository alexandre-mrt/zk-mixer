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

async function deployMixerFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  return { mixer, verifier, owner, depositor, recipient, relayer };
}

async function deployMixerWithReceiptFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  // Wire up receipt — requires timelock
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", await receipt.getAddress()]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { mixer, receipt, owner, depositor, recipient, relayer };
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

function buildWithdrawCall(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipientAddr: string,
  relayerAddr: string,
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
    recipientAddr as `0x${string}`,
    relayerAddr as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Event Emission Tests
// ---------------------------------------------------------------------------

describe("Event Emission", function () {
  // -------------------------------------------------------------------------
  // deposit — single event
  // -------------------------------------------------------------------------

  it("deposit emits exactly 1 Deposit event with correct args", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(depositor)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    // Filter for the Deposit event emitted by the Mixer
    const mixerAddress = await mixer.getAddress();
    const depositEventTopic = mixer.interface.getEvent("Deposit").topicHash;
    const depositLogs = receipt!.logs.filter(
      (log) =>
        log.address.toLowerCase() === mixerAddress.toLowerCase() &&
        log.topics[0] === depositEventTopic
    );

    expect(depositLogs).to.have.length(1);

    await expect(
      mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION })
    )
      .to.emit(mixer, "Deposit")
      .withArgs(
        // commitment is indexed — any value accepted
        (v: bigint) => v > 0n,
        1n, // second deposit → leafIndex 1 (previous was 0)
        (v: bigint) => v > 0n // timestamp
      );
  });

  // -------------------------------------------------------------------------
  // withdraw — single event
  // -------------------------------------------------------------------------

  it("withdraw emits exactly 1 Withdrawal event with correct args", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { commitment } = await doDeposit(mixer, depositor);
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    const fee = 0n;

    const tx = await buildWithdrawCall(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      ethers.ZeroAddress,
      fee
    );
    const rxReceipt = await (await Promise.resolve(tx)).wait();

    const mixerAddress = await mixer.getAddress();
    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const withdrawalLogs = rxReceipt!.logs.filter(
      (log) =>
        log.address.toLowerCase() === mixerAddress.toLowerCase() &&
        log.topics[0] === withdrawalTopic
    );
    expect(withdrawalLogs).to.have.length(1);

    // Verify args via decoded event
    const parsed = mixer.interface.parseLog(withdrawalLogs[0]);
    expect(parsed!.args[0]).to.equal(recipient.address); // to
    expect(parsed!.args[1]).to.equal(nullifierHash);      // nullifierHash
    expect(parsed!.args[2]).to.equal(ethers.ZeroAddress); // relayer
    expect(parsed!.args[3]).to.equal(fee);                // fee
  });

  // -------------------------------------------------------------------------
  // deposit with receipt — Deposit + Transfer (ERC721 mint)
  // -------------------------------------------------------------------------

  it("deposit with receipt emits both Deposit and Transfer (ERC721 mint) events", async function () {
    const { mixer, receipt, depositor } = await loadFixture(
      deployMixerWithReceiptFixture
    );
    const commitment = randomCommitment();

    const tx = await mixer
      .connect(depositor)
      .deposit(commitment, { value: DENOMINATION });
    const rxReceipt = await tx.wait();

    const mixerAddress = await mixer.getAddress();
    const receiptAddress = await receipt.getAddress();
    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;

    // ERC721 Transfer event topic (Transfer(address,address,uint256))
    const erc721TransferTopic = ethers.id(
      "Transfer(address,address,uint256)"
    );

    const depositLogs = rxReceipt!.logs.filter(
      (log) =>
        log.address.toLowerCase() === mixerAddress.toLowerCase() &&
        log.topics[0] === depositTopic
    );
    const transferLogs = rxReceipt!.logs.filter(
      (log) =>
        log.address.toLowerCase() === receiptAddress.toLowerCase() &&
        log.topics[0] === erc721TransferTopic
    );

    expect(depositLogs).to.have.length(1);
    expect(transferLogs).to.have.length(1);

    // ERC721 Transfer: from == address(0) (mint), to == depositor
    const transferLog = transferLogs[0];
    const fromPadded = ethers.zeroPadValue(ethers.ZeroAddress, 32);
    const toPadded = ethers.zeroPadValue(depositor.address, 32);
    expect(transferLog.topics[1].toLowerCase()).to.equal(
      fromPadded.toLowerCase()
    );
    expect(transferLog.topics[2].toLowerCase()).to.equal(
      toPadded.toLowerCase()
    );
  });

  // -------------------------------------------------------------------------
  // pause / unpause
  // -------------------------------------------------------------------------

  it("pause emits Paused event", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);

    await expect(mixer.connect(owner).pause())
      .to.emit(mixer, "Paused")
      .withArgs(owner.address);
  });

  it("unpause emits Unpaused event", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).pause();

    await expect(mixer.connect(owner).unpause())
      .to.emit(mixer, "Unpaused")
      .withArgs(owner.address);
  });

  // -------------------------------------------------------------------------
  // 5 deposits → exactly 5 Deposit events
  // -------------------------------------------------------------------------

  it("5 deposits emit exactly 5 Deposit events", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    const mixerAddress = await mixer.getAddress();
    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    let depositLogCount = 0;

    for (let i = 0; i < 5; i++) {
      const tx = await mixer
        .connect(depositor)
        .deposit(randomCommitment(), { value: DENOMINATION });
      const rxReceipt = await tx.wait();
      depositLogCount += rxReceipt!.logs.filter(
        (log) =>
          log.address.toLowerCase() === mixerAddress.toLowerCase() &&
          log.topics[0] === depositTopic
      ).length;
    }

    expect(depositLogCount).to.equal(5);
  });

  // -------------------------------------------------------------------------
  // timelock: queue then execute emits ActionQueued then ActionExecuted
  // -------------------------------------------------------------------------

  it("timelock queue/execute emits ActionQueued then ActionExecuted", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    const newMax = 10n;
    const hash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", newMax]
      )
    );

    // queue — expect ActionQueued
    await expect(mixer.connect(owner).queueAction(hash))
      .to.emit(mixer, "ActionQueued")
      .withArgs(hash, (v: bigint) => v > 0n);

    // advance past timelock
    await time.increase(ONE_DAY + 1);

    // execute — expect ActionExecuted
    await expect(mixer.connect(owner).setMaxDepositsPerAddress(newMax))
      .to.emit(mixer, "ActionExecuted")
      .withArgs(hash);
  });

  // -------------------------------------------------------------------------
  // ownership transfer
  // -------------------------------------------------------------------------

  it("ownership transfer emits OwnershipTransferred", async function () {
    const { mixer, owner, depositor } = await loadFixture(deployMixerFixture);

    await expect(
      mixer.connect(owner).transferOwnership(depositor.address)
    )
      .to.emit(mixer, "OwnershipTransferred")
      .withArgs(owner.address, depositor.address);
  });
});
