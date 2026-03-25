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
// Poseidon helpers
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
// Helpers
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

async function timelockSetDepositCooldown(
  mixer: Mixer,
  owner: Signer,
  cooldown: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setDepositCooldown", cooldown]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositCooldown(cooldown);
}

// ---------------------------------------------------------------------------
// Multi-User Interactions
// ---------------------------------------------------------------------------

describe("Multi-User Interactions", function () {
  it("10 users deposit simultaneously, all succeed", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);

    // signers[1..10] each deposit a unique commitment
    const depositTxs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mixer
          .connect(signers[i + 1])
          .deposit(randomCommitment(), { value: DENOMINATION })
      )
    );

    for (const tx of depositTxs) {
      await expect(tx).to.emit(mixer, "Deposit");
    }

    expect(await mixer.nextIndex()).to.equal(10n);
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 10n);
  });

  it("user A deposits, user B withdraws — independent operations", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const bob = signers[2];

    const nullifier = randomFieldElement();
    const secret = randomFieldElement();
    const commitment = computeCommitment(secret, nullifier);
    const nullifierHash = computeNullifierHash(nullifier);

    // Alice deposits
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const bobBalanceBefore = await ethers.provider.getBalance(bob.address);

    // Bob (different address) submits the withdrawal on behalf of himself as recipient
    await doWithdraw(mixer, root, nullifierHash, bob.address, ethers.ZeroAddress, 0n, owner);

    const bobBalanceAfter = await ethers.provider.getBalance(bob.address);
    expect(bobBalanceAfter - bobBalanceBefore).to.equal(DENOMINATION);

    // Alice's deposit count is still 1; Bob's is 0
    expect(await mixer.depositsPerAddress(alice.address)).to.equal(1n);
    expect(await mixer.depositsPerAddress(bob.address)).to.equal(0n);
  });

  it("two users deposit the same amount but different commitments", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const bob = signers[2];

    const commitmentA = randomCommitment();
    const commitmentB = randomCommitment();

    // Both commitments are unique by construction (randomBytes) — both deposits succeed
    await expect(
      mixer.connect(alice).deposit(commitmentA, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    await expect(
      mixer.connect(bob).deposit(commitmentB, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    expect(await mixer.commitments(commitmentA)).to.be.true;
    expect(await mixer.commitments(commitmentB)).to.be.true;
    expect(await mixer.nextIndex()).to.equal(2n);
  });

  it("after 5 deposits by different users, any can withdraw", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    const notes: Array<{ nullifierHash: bigint }> = [];

    for (let i = 1; i <= 5; i++) {
      const nullifier = randomFieldElement();
      const secret = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await mixer
        .connect(signers[i])
        .deposit(commitment, { value: DENOMINATION });
      notes.push({ nullifierHash });
    }

    const root = await mixer.getLastRoot();

    // Withdrawer for note[2] is a fresh address (signers[10])
    const recipient = signers[10];
    const balanceBefore = await ethers.provider.getBalance(recipient.address);

    await doWithdraw(
      mixer,
      root,
      notes[2].nullifierHash,
      recipient.address,
      ethers.ZeroAddress,
      0n,
      owner
    );

    const balanceAfter = await ethers.provider.getBalance(recipient.address);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
  });

  it("user cannot withdraw with another user's nullifier that's already spent", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const bob = signers[2];

    const nullifier = randomFieldElement();
    const secret = randomFieldElement();
    const commitment = computeCommitment(secret, nullifier);
    const nullifierHash = computeNullifierHash(nullifier);

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    // First withdrawal by alice's note succeeds
    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      signers[5].address,
      ethers.ZeroAddress,
      0n,
      owner
    );

    // Bob attempts to re-use the same nullifierHash — must revert
    await expect(
      doWithdraw(
        mixer,
        root,
        nullifierHash,
        bob.address,
        ethers.ZeroAddress,
        0n,
        bob
      )
    ).to.be.revertedWith("Mixer: already spent");
  });

  it("deposit receipt correctly tracks which user deposited which commitment", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const bob = signers[2];

    // Deploy and wire DepositReceipt
    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = await DepositReceiptFactory.deploy(await mixer.getAddress());

    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "address"],
        ["setDepositReceipt", await receipt.getAddress()]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);
    await time.increase(ONE_DAY + 1);
    await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());

    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();

    await mixer.connect(alice).deposit(commitmentAlice, { value: DENOMINATION });
    await mixer.connect(bob).deposit(commitmentBob, { value: DENOMINATION });

    // Each depositor holds exactly 1 receipt
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.balanceOf(bob.address)).to.equal(1n);

    // Token 0 → Alice, Token 1 → Bob
    expect(await receipt.ownerOf(0)).to.equal(alice.address);
    expect(await receipt.ownerOf(1)).to.equal(bob.address);
  });

  it("getStats correctly reflects multi-user deposit + withdrawal mix", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    // 4 different users deposit
    const nullifiers: bigint[] = [];
    for (let i = 1; i <= 4; i++) {
      const nullifier = randomFieldElement();
      const secret = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      nullifiers.push(computeNullifierHash(nullifier));
      await mixer.connect(signers[i]).deposit(commitment, { value: DENOMINATION });
    }

    const root = await mixer.getLastRoot();

    // 2 withdrawals
    await doWithdraw(mixer, root, nullifiers[0], signers[10].address, ethers.ZeroAddress, 0n, owner);
    await doWithdraw(mixer, root, nullifiers[1], signers[11].address, ethers.ZeroAddress, 0n, owner);

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(totalDeposited).to.equal(DENOMINATION * 4n);
    expect(totalWithdrawn).to.equal(DENOMINATION * 2n);
    expect(depositCount).to.equal(4n);
    expect(withdrawalCount).to.equal(2n);
    expect(poolBalance).to.equal(DENOMINATION * 2n);
  });

  it("anonymity set grows with each new depositor", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);

    for (let i = 1; i <= 5; i++) {
      await mixer
        .connect(signers[i])
        .deposit(randomCommitment(), { value: DENOMINATION });

      expect(await mixer.getAnonymitySetSize()).to.equal(BigInt(i));
    }
  });

  it("withdrawal doesn't reveal which deposit was withdrawn", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    // 5 users each deposit unique commitments
    const commitments: bigint[] = [];
    for (let i = 1; i <= 5; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(signers[i]).deposit(c, { value: DENOMINATION });
    }

    // Create a note for user 3 with known nullifier
    const targetNullifier = randomFieldElement();
    const targetSecret = randomFieldElement();
    const targetCommitment = computeCommitment(targetSecret, targetNullifier);
    const targetNullifierHash = computeNullifierHash(targetNullifier);
    await mixer.connect(signers[3]).deposit(targetCommitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const recipient = signers[12];

    // Withdraw using the target note — all commitments remain in the tree
    await doWithdraw(mixer, root, targetNullifierHash, recipient.address, ethers.ZeroAddress, 0n, owner);

    // All original commitments are still recorded in the tree (no removal)
    for (const c of commitments) {
      expect(await mixer.commitments(c)).to.be.true;
    }
    // The withdrawn nullifier is now spent
    expect(await mixer.nullifierHashes(targetNullifierHash)).to.be.true;
  });

  it("pool balance tracks correctly with interleaved deposits and withdrawals", async function () {
    const { mixer, owner, signers } = await loadFixture(deployMixerFixture);

    const alice = signers[1];
    const bob = signers[2];
    const charlie = signers[3];

    const aliceNullifier = randomFieldElement();
    const aliceCommitment = computeCommitment(randomFieldElement(), aliceNullifier);
    const aliceNullifierHash = computeNullifierHash(aliceNullifier);

    // Alice deposits
    await mixer.connect(alice).deposit(aliceCommitment, { value: DENOMINATION });
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION);

    const root1 = await mixer.getLastRoot();

    // Alice withdraws
    await doWithdraw(mixer, root1, aliceNullifierHash, signers[10].address, ethers.ZeroAddress, 0n, owner);
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(0n);

    // Bob and Charlie deposit
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(charlie).deposit(randomCommitment(), { value: DENOMINATION });
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 2n);

    const root2 = await mixer.getLastRoot();

    const bobNullifier = randomFieldElement();
    const bobCommitment = computeCommitment(randomFieldElement(), bobNullifier);
    const bobNullifierHash = computeNullifierHash(bobNullifier);
    await mixer.connect(bob).deposit(bobCommitment, { value: DENOMINATION });

    const root3 = await mixer.getLastRoot();
    await doWithdraw(mixer, root3, bobNullifierHash, signers[11].address, ethers.ZeroAddress, 0n, owner);

    // 3 total deposits after Alice's withdrawal, 1 withdrawal of Bob's note → 2 remain
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 2n);

    // Suppress unused warning — root2 was captured but bob's explicit note used root3
    void root2;
  });
});
