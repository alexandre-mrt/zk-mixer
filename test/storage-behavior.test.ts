import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ROOT_HISTORY_SIZE = 30;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, carol, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const verifierAddress = await verifier.getAddress();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, verifierAddress, hasherAddress, owner, alice, bob, carol, relayer };
}

// ---------------------------------------------------------------------------
// Storage Behavior
// ---------------------------------------------------------------------------

describe("Storage Behavior", function () {

  // -------------------------------------------------------------------------
  // commitments mapping
  // -------------------------------------------------------------------------

  it("commitments: false before deposit, true after", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();

    expect(await mixer.commitments(commitment)).to.equal(false);

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await mixer.commitments(commitment)).to.equal(true);
  });

  it("commitments: multiple distinct keys are independent", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    // None deposited yet
    expect(await mixer.commitments(c1)).to.equal(false);
    expect(await mixer.commitments(c2)).to.equal(false);
    expect(await mixer.commitments(c3)).to.equal(false);

    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });

    // Only c1 flips; c2 and c3 remain false
    expect(await mixer.commitments(c1)).to.equal(true);
    expect(await mixer.commitments(c2)).to.equal(false);
    expect(await mixer.commitments(c3)).to.equal(false);

    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });

    expect(await mixer.commitments(c2)).to.equal(true);
    expect(await mixer.commitments(c3)).to.equal(false);
  });

  it("commitments: querying a non-existent key returns false (default)", async () => {
    const { mixer } = await loadFixture(deployFixture);

    // Large arbitrary key that was never deposited
    const neverDeposited = BigInt("0x" + "ab".repeat(31));
    expect(await mixer.commitments(neverDeposited)).to.equal(false);

    // Key 1 (minimum non-zero value)
    expect(await mixer.commitments(1n)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // nullifierHashes mapping
  // -------------------------------------------------------------------------

  it("nullifierHashes: false before withdrawal, true after", async () => {
    const { mixer, alice, relayer } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const nullifierHash = randomCommitment();

    expect(await mixer.nullifierHashes(nullifierHash)).to.equal(false);

    const root = await mixer.getLastRoot();
    const recipientAddr = (await alice.getAddress()) as `0x${string}`;
    const relayerAddr = (await relayer.getAddress()) as `0x${string}`;

    await mixer.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifierHash,
      recipientAddr,
      relayerAddr,
      0n
    );

    expect(await mixer.nullifierHashes(nullifierHash)).to.equal(true);
  });

  it("nullifierHashes: independent keys do not affect each other", async () => {
    const { mixer, alice, relayer } = await loadFixture(deployFixture);

    // Deposit twice so we have a valid root for both withdrawals
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const nullifier1 = randomCommitment();
    const nullifier2 = randomCommitment();

    expect(await mixer.nullifierHashes(nullifier1)).to.equal(false);
    expect(await mixer.nullifierHashes(nullifier2)).to.equal(false);

    const root = await mixer.getLastRoot();
    const recipientAddr = (await alice.getAddress()) as `0x${string}`;
    const relayerAddr = (await relayer.getAddress()) as `0x${string}`;

    // Spend nullifier1 only
    await mixer.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier1,
      recipientAddr,
      relayerAddr,
      0n
    );

    expect(await mixer.nullifierHashes(nullifier1)).to.equal(true);
    // nullifier2 must still be unspent
    expect(await mixer.nullifierHashes(nullifier2)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // depositsPerAddress mapping
  // -------------------------------------------------------------------------

  it("depositsPerAddress: 0 initially for any address", async () => {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    expect(await mixer.depositsPerAddress(await alice.getAddress())).to.equal(0n);
    expect(await mixer.depositsPerAddress(await bob.getAddress())).to.equal(0n);
  });

  it("depositsPerAddress: increments once per deposit", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    const aliceAddr = await alice.getAddress();

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await mixer.depositsPerAddress(aliceAddr)).to.equal(1n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await mixer.depositsPerAddress(aliceAddr)).to.equal(2n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await mixer.depositsPerAddress(aliceAddr)).to.equal(3n);
  });

  it("depositsPerAddress: independent per address", async () => {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await mixer.depositsPerAddress(aliceAddr)).to.equal(2n);
    expect(await mixer.depositsPerAddress(bobAddr)).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // roots array (ring buffer)
  // -------------------------------------------------------------------------

  it("roots[0] is the initial empty tree root (non-zero)", async () => {
    const { mixer } = await loadFixture(deployFixture);

    const root0 = await mixer.roots(0);

    // MerkleTree constructor stores the empty-tree root at slot 0
    expect(root0).to.be.greaterThan(0n);
  });

  it("roots[currentRootIndex] equals getLastRoot()", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    // Check at deployment
    let idx = await mixer.currentRootIndex();
    expect(await mixer.roots(idx)).to.equal(await mixer.getLastRoot());

    // Check after several deposits
    for (let i = 0; i < 5; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      idx = await mixer.currentRootIndex();
      expect(await mixer.roots(idx)).to.equal(
        await mixer.getLastRoot(),
        `Mismatch after deposit ${i + 1}`
      );
    }
  });

  it("roots ring buffer wraps at ROOT_HISTORY_SIZE", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    // Capture the root written after the first deposit (stored at slot 1)
    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const firstDepositRoot = await mixer.roots(1);

    // Advance by ROOT_HISTORY_SIZE deposits — slot 1 will be overwritten
    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // Slot 1 now holds a different root
    const rootAtSlot1After = await mixer.roots(1);
    expect(rootAtSlot1After).to.not.equal(firstDepositRoot);

    // isKnownRoot confirms the old root is evicted
    expect(await mixer.isKnownRoot(firstDepositRoot)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // filledSubtrees array
  // -------------------------------------------------------------------------

  it("filledSubtrees has exactly `levels` entries", async () => {
    const { mixer } = await loadFixture(deployFixture);

    const levels = await mixer.levels();

    // filledSubtrees is a public dynamic array; read each index up to levels-1
    // and confirm the entry at levels does not exist (should revert or the loop
    // confirms we read exactly `levels` entries without error)
    for (let i = 0; i < Number(levels); i++) {
      // Reading a valid index must not throw
      await mixer.filledSubtrees(i);
    }

    // Reading index `levels` should revert (out-of-bounds access)
    await expect(mixer.filledSubtrees(levels)).to.be.reverted;
  });

  it("filledSubtrees[0] updates on every deposit", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    // Before any deposit filledSubtrees[0] is the zero value (0)
    const initialVal = await mixer.filledSubtrees(0);

    // First deposit inserts at index 0 (left child) → filledSubtrees[0] is set to the leaf
    const c1 = randomCommitment();
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    const afterFirst = await mixer.filledSubtrees(0);

    expect(afterFirst).to.not.equal(initialVal);

    // Second deposit inserts at index 1 (right child) → filledSubtrees[0] is unchanged
    const c2 = randomCommitment();
    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });
    const afterSecond = await mixer.filledSubtrees(0);
    expect(afterSecond).to.equal(afterFirst);

    // Third deposit inserts at index 2 (left child again) → filledSubtrees[0] changes
    const c3 = randomCommitment();
    await mixer.connect(alice).deposit(c3, { value: DENOMINATION });
    const afterThird = await mixer.filledSubtrees(0);
    expect(afterThird).to.not.equal(afterSecond);
  });

  // -------------------------------------------------------------------------
  // commitmentIndex + indexToCommitment
  // -------------------------------------------------------------------------

  it("commitmentIndex and indexToCommitment are inverse mappings", async () => {
    const { mixer, alice } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await mixer.connect(alice).deposit(c0, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });

    // commitmentIndex maps commitment → leaf index
    expect(await mixer.commitmentIndex(c0)).to.equal(0n);
    expect(await mixer.commitmentIndex(c1)).to.equal(1n);
    expect(await mixer.commitmentIndex(c2)).to.equal(2n);

    // indexToCommitment is the reverse
    expect(await mixer.indexToCommitment(0)).to.equal(c0);
    expect(await mixer.indexToCommitment(1)).to.equal(c1);
    expect(await mixer.indexToCommitment(2)).to.equal(c2);
  });

  it("commitmentIndex and indexToCommitment return 0 for unknown keys", async () => {
    const { mixer } = await loadFixture(deployFixture);

    const unknownCommitment = randomCommitment();

    // mapping(uint256 => uint32) defaults to 0
    expect(await mixer.commitmentIndex(unknownCommitment)).to.equal(0n);

    // mapping(uint32 => uint256) defaults to 0
    expect(await mixer.indexToCommitment(9999)).to.equal(0n);
  });
});
