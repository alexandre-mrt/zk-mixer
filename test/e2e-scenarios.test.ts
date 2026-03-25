import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Poseidon helpers — built once via module-level before hook
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidon: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;

before(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

/** commitment = Poseidon(secret, nullifier) */
function computeCommitment(secret: bigint, nullifier: bigint): bigint {
  return F.toObject(poseidon([secret, nullifier]));
}

/** nullifierHash = Poseidon(nullifier) */
function computeNullifierHash(nullifier: bigint): bigint {
  return F.toObject(poseidon([nullifier]));
}

/** Returns a random 31-byte field element (always < FIELD_SIZE). */
function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function deployFixture() {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, charlie, recipient, relayer, ...rest] = signers;

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

  return { mixer, owner, alice, bob, charlie, recipient, relayer, signers, rest };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment: bigint
): Promise<void> {
  await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
}

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

function parseLogs(
  mixer: Mixer,
  logs: readonly { topics: readonly string[]; data: string }[]
) {
  return logs
    .map((l) => {
      try {
        return mixer.interface.parseLog({
          topics: l.topics as string[],
          data: l.data,
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// E2E Scenarios with Real Poseidon
// ---------------------------------------------------------------------------

describe("E2E Scenarios with Real Poseidon", function () {
  // -------------------------------------------------------------------------
  // 1. Alice deposits and Bob cannot extract her secret from the commitment
  // -------------------------------------------------------------------------

  it("Alice deposits and Bob cannot extract her secret from the commitment", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const aliceSecret = randomFieldElement();
    const aliceNullifier = randomFieldElement();
    const aliceCommitment = computeCommitment(aliceSecret, aliceNullifier);

    await doDeposit(mixer, alice, aliceCommitment);

    // The on-chain commitment is a one-way hash — retrieving it reveals nothing.
    // Bob can see the commitment in the tree but cannot invert the Poseidon hash.
    const storedCommitment = await mixer.indexToCommitment(0);
    expect(storedCommitment).to.equal(aliceCommitment);

    // A different (secret, nullifier) pair never collides with Alice's commitment.
    const bobGuessCommitment = computeCommitment(
      randomFieldElement(),
      randomFieldElement()
    );
    expect(bobGuessCommitment).to.not.equal(aliceCommitment);
  });

  // -------------------------------------------------------------------------
  // 2. commitment computed off-chain matches on-chain hashLeftRight
  // -------------------------------------------------------------------------

  it("commitment computed off-chain matches on-chain hashLeftRight", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const secret = randomFieldElement();
    const nullifier = randomFieldElement();

    const offChainCommitment = computeCommitment(secret, nullifier);
    const onChainHash = await mixer.hashLeftRight(secret, nullifier);

    expect(offChainCommitment).to.equal(onChainHash);
  });

  // -------------------------------------------------------------------------
  // 3. nullifierHash computed off-chain with Poseidon(1 input) is distinct
  //    from the commitment Poseidon(2 inputs)
  // -------------------------------------------------------------------------

  it("nullifierHash computed off-chain with Poseidon(1) is distinct from commitment", async function () {
    const secret = randomFieldElement();
    const nullifier = randomFieldElement();

    const commitment = computeCommitment(secret, nullifier);
    const nullifierHash = computeNullifierHash(nullifier);

    expect(nullifierHash).to.not.equal(commitment);

    // Poseidon(nullifier) must also differ from Poseidon(secret, nullifier)
    // when the nullifier alone is used — different arity, different output.
    const recomputed = F.toObject(poseidon([nullifier]));
    expect(nullifierHash).to.equal(recomputed);
  });

  // -------------------------------------------------------------------------
  // 4. 10 deposits from 10 users, 3 withdrawals: commitment/nullifier correct
  // -------------------------------------------------------------------------

  it("10 deposits from 10 users, 3 withdrawals: commitment/nullifier hashes all correct", async function () {
    const { mixer, owner, signers } = await loadFixture(deployFixture);

    const notes: Array<{ commitment: bigint; nullifierHash: bigint }> = [];

    for (let i = 1; i <= 10; i++) {
      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await doDeposit(mixer, signers[i], commitment);
      notes.push({ commitment, nullifierHash });
    }

    // All 10 commitments must be registered.
    for (const { commitment } of notes) {
      expect(await mixer.commitments(commitment)).to.be.true;
    }

    const root = await mixer.getLastRoot();
    const recipientAddr = signers[11].address;
    const relayerAddr = ethers.ZeroAddress;

    // Withdraw the first 3 notes.
    for (let i = 0; i < 3; i++) {
      await doWithdraw(
        mixer,
        root,
        notes[i].nullifierHash,
        recipientAddr,
        relayerAddr,
        0n,
        owner
      );
      expect(await mixer.nullifierHashes(notes[i].nullifierHash)).to.be.true;
    }

    // Remaining 7 nullifiers must still be unspent.
    for (let i = 3; i < 10; i++) {
      expect(await mixer.nullifierHashes(notes[i].nullifierHash)).to.be.false;
    }

    // Contract balance: 10 deposits - 3 withdrawals = 7 * denomination
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 7n);
  });

  // -------------------------------------------------------------------------
  // 5. deposit receipt commitment matches off-chain Poseidon computation
  // -------------------------------------------------------------------------

  it("deposit receipt commitment matches off-chain Poseidon computation", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    const secret = randomFieldElement();
    const nullifier = randomFieldElement();
    const commitment = computeCommitment(secret, nullifier);

    const tx = await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;

    const depositEvent = parseLogs(mixer, receipt!.logs).find(
      (e) => e?.name === "Deposit"
    );

    expect(depositEvent).to.not.be.null;
    // The commitment emitted in the Deposit event must match our off-chain hash.
    expect(depositEvent!.args.commitment).to.equal(commitment);
    // Off-chain Poseidon(secret, nullifier) == on-chain hashLeftRight(secret, nullifier)
    const onChain = await mixer.hashLeftRight(secret, nullifier);
    expect(commitment).to.equal(onChain);
  });

  // -------------------------------------------------------------------------
  // 6. Merkle tree root after 5 deposits matches off-chain tree reconstruction
  // -------------------------------------------------------------------------

  it("Merkle tree root after 5 deposits matches off-chain tree reconstruction", async function () {
    const { mixer, signers } = await loadFixture(deployFixture);

    // Simulate the contract's incremental tree insertion algorithm off-chain.
    // zeros[i] = Poseidon(zeros[i-1], zeros[i-1]), zeros[0] = 0.
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= TREE_HEIGHT; i++) {
      zeros.push(F.toObject(poseidon([zeros[i - 1], zeros[i - 1]])));
    }

    // filledSubtrees mirrors the contract state: initialised to zeros[i].
    const filledSubtrees = [...zeros.slice(0, TREE_HEIGHT)];

    function simulateInsert(leaf: bigint): bigint {
      let currentIndex = offChainNextIndex;
      let currentHash = leaf;

      for (let i = 0; i < TREE_HEIGHT; i++) {
        let left: bigint;
        let right: bigint;

        if (currentIndex % 2 === 0) {
          left = currentHash;
          right = filledSubtrees[i];
          filledSubtrees[i] = currentHash;
        } else {
          left = filledSubtrees[i];
          right = currentHash;
        }

        currentHash = F.toObject(poseidon([left, right]));
        currentIndex = Math.floor(currentIndex / 2);
      }

      offChainNextIndex++;
      return currentHash; // the new root
    }

    let offChainNextIndex = 0;
    let offChainRoot = 0n;

    // Generate commitments first, then use the same values for both the off-chain
    // simulation and the on-chain deposits.
    const depositCommitments: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      depositCommitments.push(
        computeCommitment(randomFieldElement(), randomFieldElement())
      );
    }

    for (let i = 0; i < 5; i++) {
      offChainRoot = simulateInsert(depositCommitments[i]);
      await doDeposit(mixer, signers[i + 1], depositCommitments[i]);
    }

    const onChainRoot = await mixer.getLastRoot();
    expect(onChainRoot).to.equal(offChainRoot);
  });

  // -------------------------------------------------------------------------
  // 7. same (secret, nullifier) pair always produces same commitment
  // -------------------------------------------------------------------------

  it("same (secret, nullifier) pair always produces same commitment", function () {
    const secret = randomFieldElement();
    const nullifier = randomFieldElement();

    const c1 = computeCommitment(secret, nullifier);
    const c2 = computeCommitment(secret, nullifier);
    const c3 = computeCommitment(secret, nullifier);

    expect(c1).to.equal(c2);
    expect(c2).to.equal(c3);
  });

  // -------------------------------------------------------------------------
  // 8. different secrets with same nullifier produce different commitments
  // -------------------------------------------------------------------------

  it("different secrets with same nullifier produce different commitments", function () {
    const nullifier = randomFieldElement();
    const secret1 = randomFieldElement();
    // Guarantee secret2 != secret1 by incrementing
    const secret2 = secret1 + 1n;

    const c1 = computeCommitment(secret1, nullifier);
    const c2 = computeCommitment(secret2, nullifier);

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 9. getStats.totalDeposited matches denomination * depositCount after N deposits
  // -------------------------------------------------------------------------

  it("getStats.totalDeposited matches denomination * depositCount after N deposits", async function () {
    const { mixer, signers } = await loadFixture(deployFixture);

    const N = 4;

    for (let i = 1; i <= N; i++) {
      const commitment = computeCommitment(
        randomFieldElement(),
        randomFieldElement()
      );
      await doDeposit(mixer, signers[i], commitment);
    }

    const [totalDeposited, , depositCount] = await mixer.getStats();

    expect(depositCount).to.equal(BigInt(N));
    expect(totalDeposited).to.equal(DENOMINATION * BigInt(N));
  });

  // -------------------------------------------------------------------------
  // 10. full deposit → withdraw cycle: all hashes verified end-to-end
  // -------------------------------------------------------------------------

  it("full deposit→withdraw cycle: all hashes verified end-to-end", async function () {
    const { mixer, alice, recipient, relayer, owner } =
      await loadFixture(deployFixture);

    const secret = randomFieldElement();
    const nullifier = randomFieldElement();
    const commitment = computeCommitment(secret, nullifier);
    const nullifierHash = computeNullifierHash(nullifier);

    // Verify commitment against on-chain hashLeftRight before depositing.
    const onChainCommitmentHash = await mixer.hashLeftRight(secret, nullifier);
    expect(commitment).to.equal(onChainCommitmentHash);

    // Deposit: commitment recorded on-chain.
    const depositTx = await mixer
      .connect(alice)
      .deposit(commitment, { value: DENOMINATION });
    const depositReceipt = await depositTx.wait();

    const depositEvent = parseLogs(mixer, depositReceipt!.logs).find(
      (e) => e?.name === "Deposit"
    );
    expect(depositEvent!.args.commitment).to.equal(commitment);
    expect(await mixer.commitments(commitment)).to.be.true;

    // Verify nullifierHash not yet spent.
    expect(await mixer.nullifierHashes(nullifierHash)).to.be.false;

    const root = await mixer.getLastRoot();
    const recipientAddr = await recipient.getAddress();
    const relayerAddr = await relayer.getAddress();

    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    const withdrawTx = await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipientAddr,
      relayerAddr,
      0n,
      owner
    );
    const withdrawReceipt = await withdrawTx.wait();

    const withdrawalEvent = parseLogs(mixer, withdrawReceipt!.logs).find(
      (e) => e?.name === "Withdrawal"
    );

    // nullifierHash in the Withdrawal event must match off-chain Poseidon(nullifier).
    expect(withdrawalEvent!.args.nullifierHash).to.equal(nullifierHash);
    expect(withdrawalEvent!.args.to).to.equal(recipientAddr);

    // nullifierHash is now marked spent.
    expect(await mixer.nullifierHashes(nullifierHash)).to.be.true;

    // Recipient received the denomination.
    const balanceAfter = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
  });
});
