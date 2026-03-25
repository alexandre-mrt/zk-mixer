import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;

// Gas regression thresholds — set at 2x observed cost on Hardhat local network.
// These are regression guards: they catch O(N) blow-ups and accidental extra
// storage writes, not micro-optimisations. Tighten them when the implementation
// is intentionally changed and the new cost is accepted.
const GAS_LIMITS = {
  DEPOSIT: 500_000n,
  WITHDRAW: 250_000n,
  WITHDRAW_WITH_FEE: 250_000n,
  PAUSE: 50_000n,
  UNPAUSE: 50_000n,
  QUEUE_ACTION: 80_000n,
  CANCEL_ACTION: 50_000n,
  GET_LAST_ROOT: 30_000n,
  IS_KNOWN_ROOT: 50_000n,
  HASH_LEFT_RIGHT: 80_000n,
  DEPOSIT_WITH_RECEIPT: 600_000n,
  VERIFY_COMMITMENT: 80_000n,
} as const;

// Dummy zero-proof — the test verifier (Groth16Verifier) always returns true.
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
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type MixerSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockSetDepositReceipt(
  mixer: Mixer,
  owner: MixerSigner,
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
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, alice, bob, relayer };
}

async function deployFixtureWithReceipt() {
  const { mixer, owner, alice, bob, relayer } = await deployFixture();

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Gas Regression Guards
// ---------------------------------------------------------------------------

describe("Gas Regression Guards", function () {
  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------

  it("deposit gas < 500K", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    const tx = await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    deposit gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.DEPOSIT,
      `deposit used ${gas} gas, limit is ${GAS_LIMITS.DEPOSIT}`
    );
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------

  it("withdraw gas < 250K", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    const tx = await mixer.connect(alice).withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      bob.address,
      ethers.ZeroAddress,
      0n
    );
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    withdraw gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.WITHDRAW,
      `withdraw used ${gas} gas, limit is ${GAS_LIMITS.WITHDRAW}`
    );
  });

  it("withdraw with fee gas < 250K", async function () {
    const { mixer, alice, bob, relayer } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    const fee = 1_000_000_000_000_000n; // 0.001 ETH

    const tx = await mixer.connect(alice).withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      bob.address,
      relayer.address,
      fee
    );
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    withdraw with fee gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.WITHDRAW_WITH_FEE,
      `withdraw with fee used ${gas} gas, limit is ${GAS_LIMITS.WITHDRAW_WITH_FEE}`
    );
  });

  // -------------------------------------------------------------------------
  // pause / unpause
  // -------------------------------------------------------------------------

  it("pause gas < 50K", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    const tx = await mixer.connect(owner).pause();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    pause gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.PAUSE,
      `pause used ${gas} gas, limit is ${GAS_LIMITS.PAUSE}`
    );
  });

  it("unpause gas < 50K", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    await mixer.connect(owner).pause();
    const tx = await mixer.connect(owner).unpause();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    unpause gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.UNPAUSE,
      `unpause used ${gas} gas, limit is ${GAS_LIMITS.UNPAUSE}`
    );
  });

  // -------------------------------------------------------------------------
  // timelock: queueAction / cancelAction
  // -------------------------------------------------------------------------

  it("queueAction gas < 80K", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 10n]
      )
    );
    const tx = await mixer.connect(owner).queueAction(actionHash);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    queueAction gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.QUEUE_ACTION,
      `queueAction used ${gas} gas, limit is ${GAS_LIMITS.QUEUE_ACTION}`
    );
  });

  it("cancelAction gas < 50K", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 10n]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);
    const tx = await mixer.connect(owner).cancelAction();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    cancelAction gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.CANCEL_ACTION,
      `cancelAction used ${gas} gas, limit is ${GAS_LIMITS.CANCEL_ACTION}`
    );
  });

  // -------------------------------------------------------------------------
  // view functions (static calls — gas measured via estimateGas)
  // -------------------------------------------------------------------------

  it("getLastRoot gas < 30K (view call)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const gas = await mixer.getLastRoot.estimateGas();
    console.log(`    getLastRoot estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.GET_LAST_ROOT,
      `getLastRoot used ${gas} gas, limit is ${GAS_LIMITS.GET_LAST_ROOT}`
    );
  });

  it("isKnownRoot gas < 50K (view call with loop)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const gas = await mixer.isKnownRoot.estimateGas(root);
    console.log(`    isKnownRoot estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.IS_KNOWN_ROOT,
      `isKnownRoot used ${gas} gas, limit is ${GAS_LIMITS.IS_KNOWN_ROOT}`
    );
  });

  it("hashLeftRight gas < 80K", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const left = randomCommitment();
    const right = randomCommitment();
    const gas = await mixer.hashLeftRight.estimateGas(left, right);
    console.log(`    hashLeftRight estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.HASH_LEFT_RIGHT,
      `hashLeftRight used ${gas} gas, limit is ${GAS_LIMITS.HASH_LEFT_RIGHT}`
    );
  });

  // -------------------------------------------------------------------------
  // deposit with receipt (extra NFT mint)
  // -------------------------------------------------------------------------

  it("deposit with receipt gas < 600K (extra NFT mint)", async function () {
    const { mixer, alice } = await loadFixture(deployFixtureWithReceipt);
    const commitment = randomCommitment();
    const tx = await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    deposit with receipt gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.DEPOSIT_WITH_RECEIPT,
      `deposit with receipt used ${gas} gas, limit is ${GAS_LIMITS.DEPOSIT_WITH_RECEIPT}`
    );
  });

  // -------------------------------------------------------------------------
  // verifyCommitment (view)
  // -------------------------------------------------------------------------

  it("verifyCommitment gas < 80K", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const secret = randomCommitment();
    const nullifier = randomCommitment();
    const gas = await mixer.verifyCommitment.estimateGas(secret, nullifier);
    console.log(`    verifyCommitment estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.VERIFY_COMMITMENT,
      `verifyCommitment used ${gas} gas, limit is ${GAS_LIMITS.VERIFY_COMMITMENT}`
    );
  });
});
