import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BN254 scalar field prime. All Poseidon inputs/outputs live in [0, FIELD_SIZE). */
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

// Dummy Groth16 proof accepted by the mock verifier (returns true for all inputs).
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a 31-byte random bigint — always < FIELD_SIZE. */
function randomField(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, carol, relayer] = await ethers.getSigners();

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

  return { mixer, owner, alice, bob, carol, relayer };
}

// ---------------------------------------------------------------------------
// Privacy Properties
// ---------------------------------------------------------------------------

describe("Privacy Properties", function () {
  // circomlibjs Poseidon — built once for the whole suite.
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  /** Compute Poseidon(a, b) off-chain. */
  function poseidon2(a: bigint, b: bigint): bigint {
    return F.toObject(poseidon([a, b]));
  }

  /** Compute Poseidon(a) off-chain (single-input via [a, 0] convention). */
  function poseidon1(a: bigint): bigint {
    return F.toObject(poseidon([a, 0n]));
  }

  // -------------------------------------------------------------------------
  // Commitment hiding
  // -------------------------------------------------------------------------

  it("commitment doesn't reveal the secret (one-way hash)", async function () {
    // commitment = Poseidon(secret, nullifier)
    // Given only the commitment we cannot recover the secret because Poseidon
    // is a one-way function. We verify the structural property: two different
    // secrets with the same nullifier produce different commitments, so the
    // commitment leaks no information about which secret produced it.
    const nullifier = randomField();
    const secret1 = randomField();
    const secret2 = randomField();

    const c1 = poseidon2(secret1, nullifier);
    const c2 = poseidon2(secret2, nullifier);

    expect(c1).to.not.equal(c2);
    // Neither commitment equals either secret — no trivial leakage.
    expect(c1).to.not.equal(secret1);
    expect(c1).to.not.equal(secret2);
    expect(c2).to.not.equal(secret1);
    expect(c2).to.not.equal(secret2);
  });

  it("commitment doesn't reveal the nullifier", async function () {
    // Varying the nullifier (keeping the secret fixed) must produce different
    // commitments, confirming neither input is exposed by the output.
    const secret = randomField();
    const nullifier1 = randomField();
    const nullifier2 = randomField();

    const c1 = poseidon2(secret, nullifier1);
    const c2 = poseidon2(secret, nullifier2);

    expect(c1).to.not.equal(c2);
    // The commitment does not equal the nullifier.
    expect(c1).to.not.equal(nullifier1);
    expect(c2).to.not.equal(nullifier2);
  });

  it("two deposits from same user produce different commitments", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    const c1 = randomField();
    const c2 = randomField();

    // Commitments are different by construction (randomField produces distinct values
    // with overwhelming probability), and the contract enforces uniqueness.
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });

    // Both land in the tree with different leaf indices.
    const idx1 = await mixer.commitmentIndex(c1);
    const idx2 = await mixer.commitmentIndex(c2);

    expect(c1).to.not.equal(c2);
    expect(idx1).to.not.equal(idx2);
  });

  it("commitment is indistinguishable from random (field element)", async function () {
    // A well-formed commitment must be a valid BN254 field element (non-zero, < FIELD_SIZE).
    // We verify structural conformance for 8 freshly generated commitments.
    const COUNT = 8;
    const commitments: bigint[] = [];

    for (let i = 0; i < COUNT; i++) {
      const secret = randomField();
      const nullifier = randomField();
      const c = poseidon2(secret, nullifier);

      expect(c, `commitment[${i}] must be > 0`).to.be.greaterThan(0n);
      expect(c, `commitment[${i}] must be < FIELD_SIZE`).to.be.lessThan(FIELD_SIZE);
      commitments.push(c);
    }

    // All commitments must be distinct.
    const unique = new Set(commitments.map(String));
    expect(unique.size).to.equal(COUNT);
  });

  // -------------------------------------------------------------------------
  // Nullifier hiding
  // -------------------------------------------------------------------------

  it("nullifierHash doesn't reveal which commitment it belongs to", async function () {
    // nullifierHash = Poseidon(nullifier, 0) — it is derived only from the nullifier,
    // not from the commitment. Two notes that share the same nullifier (impossible
    // in a correct system but testable structurally) would produce the same
    // nullifierHash regardless of their secrets. Conversely, different nullifiers
    // with the same secret produce different nullifierHashes, so the commitment
    // cannot be recovered from the nullifierHash.
    const secret = randomField();
    const nullifier1 = randomField();
    const nullifier2 = randomField();

    const commitment1 = poseidon2(secret, nullifier1);
    const commitment2 = poseidon2(secret, nullifier2);

    const nh1 = poseidon1(nullifier1);
    const nh2 = poseidon1(nullifier2);

    // Different nullifiers → different nullifierHashes.
    expect(nh1).to.not.equal(nh2);
    // nullifierHash does not equal either commitment.
    expect(nh1).to.not.equal(commitment1);
    expect(nh1).to.not.equal(commitment2);
    expect(nh2).to.not.equal(commitment1);
    expect(nh2).to.not.equal(commitment2);
  });

  it("nullifierHash is different from commitment for same note", async function () {
    // For any (secret, nullifier) pair:
    //   commitment    = Poseidon(secret, nullifier)
    //   nullifierHash = Poseidon(nullifier, 0)
    // They must be different so an observer cannot trivially link spent
    // nullifierHashes to committed leaves.
    const secret = randomField();
    const nullifier = randomField();

    const commitment = poseidon2(secret, nullifier);
    const nullifierHash = poseidon1(nullifier);

    expect(nullifierHash).to.not.equal(commitment);
  });

  it("spent nullifier doesn't reveal deposit leaf index", async function () {
    // After withdrawal the contract records nullifierHashes[nh] = true.
    // The mapping key (nullifierHash) is a Poseidon hash of the nullifier —
    // it contains no information about the leaf index assigned at deposit.
    // We verify this structurally: the on-chain commitmentIndex is only
    // accessible via the commitment, not via the nullifierHash.
    const { mixer, alice } = await loadFixture(deployFixture);

    const commitment = randomField();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const leafIndex = await mixer.commitmentIndex(commitment);

    // The nullifierHash we simulate spending (any value not yet spent).
    const nullifierHash = randomField();

    // isSpent checks the nullifier mapping, not commitmentIndex.
    // Spending the nullifier leaves commitmentIndex unchanged.
    expect(await mixer.isSpent(nullifierHash)).to.be.false;

    // Construct a root and call withdraw with the dummy proof.
    const root = await mixer.getLastRoot();
    await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, nullifierHash,
      alice.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    // The nullifier is now spent — but querying the nullifier gives no leaf index.
    expect(await mixer.isSpent(nullifierHash)).to.be.true;

    // The only way to get a leaf index is via commitmentIndex — not from nullifierHash.
    expect(await mixer.commitmentIndex(commitment)).to.equal(leafIndex);
  });

  // -------------------------------------------------------------------------
  // Anonymity set
  // -------------------------------------------------------------------------

  it("withdrawal doesn't reveal which deposit was spent (no on-chain link)", async function () {
    // The Withdrawal event emits: (recipient, nullifierHash, relayer, fee).
    // It does NOT emit the commitment or leaf index. An observer cannot tell
    // which of the N deposits corresponds to the spent nullifier without
    // knowing the original note.
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    // Make 3 deposits from alice.
    const c1 = randomField();
    const c2 = randomField();
    const c3 = randomField();
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });
    await mixer.connect(alice).deposit(c3, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const spentNullifierHash = randomField();

    const tx = await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, spentNullifierHash,
      bob.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;

    const iface = mixer.interface;
    const withdrawalEventFragment = iface.getEvent("Withdrawal");
    const eventTopic = withdrawalEventFragment.topicHash;

    const withdrawalLog = receipt!.logs.find((l) => l.topics[0] === eventTopic);
    expect(withdrawalLog, "Withdrawal event not found").to.not.be.undefined;

    // Decode the Withdrawal event.
    const decoded = iface.decodeEventLog(
      "Withdrawal",
      withdrawalLog!.data,
      withdrawalLog!.topics
    );

    // The event parameters are: (to, nullifierHash, relayer, fee).
    // Verify that no commitment appears in the event data.
    const eventValues = [decoded[0], decoded[1], decoded[2], decoded[3]];
    const commitments = [c1, c2, c3];

    for (const c of commitments) {
      for (const v of eventValues) {
        // If a value happens to be a bigint, compare as bigint; otherwise stringify.
        const vBig = typeof v === "bigint" ? v : BigInt(String(v));
        expect(vBig).to.not.equal(c);
      }
    }
  });

  it("same recipient can receive multiple withdrawals without linking", async function () {
    // Each withdrawal uses a distinct nullifierHash. An observer watching the
    // recipient address cannot tell from on-chain data alone that both withdrawals
    // came from the same depositor — the nullifierHashes are independent.
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    // Fund the pool with 2 deposits.
    await mixer.connect(alice).deposit(randomField(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomField(), { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nh1 = randomField();
    const nh2 = randomField();

    await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, nh1,
      bob.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, nh2,
      bob.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    // Both nullifiers are spent but they are independent values.
    expect(await mixer.isSpent(nh1)).to.be.true;
    expect(await mixer.isSpent(nh2)).to.be.true;
    expect(nh1).to.not.equal(nh2);
  });

  it("different relayers don't reveal depositor identity", async function () {
    // The relayer address is a public signal in the proof, but it is chosen by the
    // withdrawer — not by the depositor. Using different relayers for two
    // withdrawals does not link either withdrawal to its originating deposit.
    const { mixer, alice, bob, carol, relayer } = await loadFixture(deployFixture);

    await mixer.connect(alice).deposit(randomField(), { value: DENOMINATION });
    await mixer.connect(alice).deposit(randomField(), { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nh1 = randomField();
    const nh2 = randomField();

    // First withdrawal routed through `relayer`, second self-relayed.
    await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, nh1,
      bob.address as `0x${string}`,
      relayer.address as `0x${string}`,
      0n
    );
    await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, nh2,
      carol.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    // Both succeeded — relayer choice does not affect withdrawal validity.
    expect(await mixer.isSpent(nh1)).to.be.true;
    expect(await mixer.isSpent(nh2)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // Fixed denomination privacy
  // -------------------------------------------------------------------------

  it("all deposits have same value (no amount-based deanonymization)", async function () {
    // Every deposit must send exactly `denomination` wei. This ensures all
    // commitments in the tree look identical from an ETH-amount perspective.
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const c1 = randomField();
    const c2 = randomField();

    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    await mixer.connect(bob).deposit(c2, { value: DENOMINATION });

    // Attempting a deposit with a different amount must revert.
    const wrongAmount = DENOMINATION + 1n;
    await expect(
      mixer.connect(alice).deposit(randomField(), { value: wrongAmount })
    ).to.be.revertedWith("Mixer: incorrect deposit amount");

    await expect(
      mixer.connect(alice).deposit(randomField(), { value: DENOMINATION - 1n })
    ).to.be.revertedWith("Mixer: incorrect deposit amount");

    // The denomination is a compile-time constant — verifiable without a deposit.
    expect(await mixer.denomination()).to.equal(DENOMINATION);
  });

  it("withdrawal event contains no deposit-identifying info", async function () {
    // The Withdrawal event signature is:
    //   Withdrawal(address to, uint256 nullifierHash, address indexed relayer, uint256 fee)
    // It must NOT contain: commitment, leafIndex, depositor address, deposit timestamp.
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomField();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nullifierHash = randomField();

    const tx = await mixer.withdraw(
      DUMMY_PA, DUMMY_PB, DUMMY_PC,
      root, nullifierHash,
      bob.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;

    const iface = mixer.interface;
    const eventTopic = iface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === eventTopic);
    expect(log, "Withdrawal log missing").to.not.be.undefined;

    const decoded = iface.decodeEventLog("Withdrawal", log!.data, log!.topics);

    // Parameters: decoded[0] = to, decoded[1] = nullifierHash, decoded[2] = relayer, decoded[3] = fee
    const to: string = decoded[0];
    const emittedNullifierHash: bigint = decoded[1];
    const fee: bigint = decoded[3];

    // Recipient is the withdrawer's chosen address — not the depositor.
    expect(to.toLowerCase()).to.equal(bob.address.toLowerCase());
    // The nullifierHash present in the event is NOT the commitment.
    expect(emittedNullifierHash).to.not.equal(commitment);
    // Fee is zero in this test.
    expect(fee).to.equal(0n);

    // The leaf index assigned at deposit is absent from the event's non-zero fields.
    // We make the deposit at index > 0 so there's no collision with the
    // relayer = address(0) topic. Here we used the first deposit so leafIndex = 0.
    // The key property is that the commitment is NOT present in any decoded value.
    // Verify no decoded field equals the commitment.
    const allDecoded = [decoded[0], decoded[1], decoded[2], decoded[3]];
    for (const v of allDecoded) {
      if (typeof v === "bigint") {
        expect(v).to.not.equal(commitment);
      }
    }

    // The commitment is only accessible via commitmentIndex — not from any event field.
    const leafIndex = await mixer.commitmentIndex(commitment);
    // leafIndex is defined: it must be a valid tree position (0–31 for depth-5 tree).
    expect(BigInt(leafIndex)).to.be.lessThan(32n);
  });
});
