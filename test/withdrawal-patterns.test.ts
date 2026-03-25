import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  mine,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");
const ONE_WEI = 1n;

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

interface Note {
  commitment: bigint;
  nullifierHash: bigint;
}

function makeNote(): Note {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  return {
    commitment: computeCommitment(secret, nullifier),
    nullifierHash: computeNullifierHash(nullifier),
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, charlie, relayer, recipient, ...extras] = signers;

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

  return { mixer, owner, alice, bob, charlie, relayer, recipient, extras, signers };
}

// ---------------------------------------------------------------------------
// Shared withdraw helper
// ---------------------------------------------------------------------------

async function doWithdraw(
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
    recipientAddr,
    relayerAddr,
    fee
  );
}

// ---------------------------------------------------------------------------
// Withdrawal Patterns
// ---------------------------------------------------------------------------

describe("Withdrawal Patterns", function () {
  // -------------------------------------------------------------------------
  // 1. simple: deposit then withdraw to different address
  // -------------------------------------------------------------------------
  it("simple: deposit then withdraw to different address", async function () {
    const { mixer, alice, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const recipientAddr = recipient.address;
    const relayerAddr = relayer.address;
    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    await doWithdraw(mixer, root, note.nullifierHash, recipientAddr, relayerAddr, 0n);

    const balanceAfter = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    expect(await mixer.nullifierHashes(note.nullifierHash)).to.be.true;

    // Alice's address and the recipient are distinct
    expect(alice.address.toLowerCase()).to.not.equal(recipientAddr.toLowerCase());
  });

  // -------------------------------------------------------------------------
  // 2. self-withdraw: deposit and withdraw to own address
  // -------------------------------------------------------------------------
  it("self-withdraw: deposit and withdraw to own address", async function () {
    const { mixer, alice, owner } = await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const aliceAddr = alice.address;
    const balanceBefore = await ethers.provider.getBalance(aliceAddr);

    // owner submits the tx so alice's gas costs don't affect her balance check
    await doWithdraw(mixer, root, note.nullifierHash, aliceAddr, ethers.ZeroAddress, 0n, owner);

    const balanceAfter = await ethers.provider.getBalance(aliceAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    expect(await mixer.nullifierHashes(note.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 3. delayed: deposit, wait 100 blocks, then withdraw
  // -------------------------------------------------------------------------
  it("delayed: deposit, wait 100 blocks, then withdraw", async function () {
    const { mixer, alice, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    // Advance 100 blocks — the root must still be valid (ROOT_HISTORY_SIZE = 30,
    // but no new deposits are made so the root does not rotate out)
    await mine(100);

    expect(await mixer.isKnownRoot(root)).to.be.true;

    const recipientAddr = recipient.address;
    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    await doWithdraw(mixer, root, note.nullifierHash, recipientAddr, relayer.address, 0n);

    const balanceAfter = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // 4. batch-deposit then single withdraw
  // -------------------------------------------------------------------------
  it("batch-deposit then single withdraw", async function () {
    const { mixer, alice, bob, charlie, recipient, relayer, owner } =
      await loadFixture(deployMixerFixture);

    const notes = [makeNote(), makeNote(), makeNote()];
    await mixer.connect(alice).deposit(notes[0].commitment, { value: DENOMINATION });
    await mixer.connect(bob).deposit(notes[1].commitment, { value: DENOMINATION });
    await mixer.connect(charlie).deposit(notes[2].commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const mixerBalanceBefore = await ethers.provider.getBalance(await mixer.getAddress());
    expect(mixerBalanceBefore).to.equal(DENOMINATION * 3n);

    const recipientAddr = recipient.address;
    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    // Only withdraw one note (bob's)
    await doWithdraw(mixer, root, notes[1].nullifierHash, recipientAddr, relayer.address, 0n, owner);

    const balanceAfter = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);

    // Mixer still holds 2 denomination worth
    const mixerBalanceAfter = await ethers.provider.getBalance(await mixer.getAddress());
    expect(mixerBalanceAfter).to.equal(DENOMINATION * 2n);

    // Only bob's nullifier is spent
    expect(await mixer.nullifierHashes(notes[0].nullifierHash)).to.be.false;
    expect(await mixer.nullifierHashes(notes[1].nullifierHash)).to.be.true;
    expect(await mixer.nullifierHashes(notes[2].nullifierHash)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 5. 5 deposits, withdraw all 5 sequentially
  // -------------------------------------------------------------------------
  it("5 deposits, withdraw all 5 sequentially", async function () {
    const { mixer, signers, owner } = await loadFixture(deployMixerFixture);

    const COUNT = 5;
    const notes: Note[] = [];

    for (let i = 0; i < COUNT; i++) {
      const note = makeNote();
      notes.push(note);
      await mixer.connect(signers[i + 1]).deposit(note.commitment, { value: DENOMINATION });
    }

    // Use a fresh address as recipient for each withdrawal to isolate balance deltas
    for (let i = 0; i < COUNT; i++) {
      const recipientSigner = signers[10 + i];
      const root = await mixer.getLastRoot();
      const balanceBefore = await ethers.provider.getBalance(recipientSigner.address);

      await doWithdraw(
        mixer,
        root,
        notes[i].nullifierHash,
        recipientSigner.address,
        ethers.ZeroAddress,
        0n,
        owner
      );

      const balanceAfter = await ethers.provider.getBalance(recipientSigner.address);
      expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
      expect(await mixer.nullifierHashes(notes[i].nullifierHash)).to.be.true;
    }

    // Mixer is empty after all 5 withdrawals
    expect(await ethers.provider.getBalance(await mixer.getAddress())).to.equal(0n);
    expect(await mixer.withdrawalCount()).to.equal(BigInt(COUNT));
  });

  // -------------------------------------------------------------------------
  // 6. relayed: withdraw with fee to third-party relayer
  // -------------------------------------------------------------------------
  it("relayed: withdraw with fee to third-party relayer", async function () {
    const { mixer, alice, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const fee = ethers.parseEther("0.01"); // 10% of denomination
    const recipientAddr = recipient.address;
    const relayerAddr = relayer.address;

    const recipientBefore = await ethers.provider.getBalance(recipientAddr);
    const relayerBefore = await ethers.provider.getBalance(relayerAddr);

    await doWithdraw(mixer, root, note.nullifierHash, recipientAddr, relayerAddr, fee);

    const recipientAfter = await ethers.provider.getBalance(recipientAddr);
    const relayerAfter = await ethers.provider.getBalance(relayerAddr);

    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION - fee);
    expect(relayerAfter - relayerBefore).to.equal(fee);
    expect(await mixer.nullifierHashes(note.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 7. max-fee: withdraw with fee == denomination
  // -------------------------------------------------------------------------
  it("max-fee: withdraw with fee == denomination", async function () {
    const { mixer, alice, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const recipientAddr = recipient.address;
    const relayerAddr = relayer.address;

    const recipientBefore = await ethers.provider.getBalance(recipientAddr);
    const relayerBefore = await ethers.provider.getBalance(relayerAddr);

    await doWithdraw(mixer, root, note.nullifierHash, recipientAddr, relayerAddr, DENOMINATION);

    const recipientAfter = await ethers.provider.getBalance(recipientAddr);
    const relayerAfter = await ethers.provider.getBalance(relayerAddr);

    // Recipient gets nothing; relayer gets everything
    expect(recipientAfter - recipientBefore).to.equal(0n);
    expect(relayerAfter - relayerBefore).to.equal(DENOMINATION);
    expect(await mixer.nullifierHashes(note.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 8. min-fee: withdraw with 1 wei fee
  // -------------------------------------------------------------------------
  it("min-fee: withdraw with 1 wei fee", async function () {
    const { mixer, alice, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const recipientAddr = recipient.address;
    const relayerAddr = relayer.address;

    const recipientBefore = await ethers.provider.getBalance(recipientAddr);
    const relayerBefore = await ethers.provider.getBalance(relayerAddr);

    await doWithdraw(mixer, root, note.nullifierHash, recipientAddr, relayerAddr, ONE_WEI);

    const recipientAfter = await ethers.provider.getBalance(recipientAddr);
    const relayerAfter = await ethers.provider.getBalance(relayerAddr);

    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION - ONE_WEI);
    expect(relayerAfter - relayerBefore).to.equal(ONE_WEI);
  });

  // -------------------------------------------------------------------------
  // 9. withdraw to contract address (non-EOA recipient)
  // -------------------------------------------------------------------------
  it("withdraw to contract address (non-EOA recipient)", async function () {
    const { mixer, alice } = await loadFixture(deployMixerFixture);

    // Deploy a contract that has a receive() fallback to accept ETH
    const ContractDepositorFactory = await ethers.getContractFactory("ContractDepositor");
    const contractRecipient = await ContractDepositorFactory.deploy();
    const contractRecipientAddr = await contractRecipient.getAddress();

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    const balanceBefore = await ethers.provider.getBalance(contractRecipientAddr);

    await doWithdraw(
      mixer,
      root,
      note.nullifierHash,
      contractRecipientAddr,
      ethers.ZeroAddress,
      0n
    );

    const balanceAfter = await ethers.provider.getBalance(contractRecipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    expect(await mixer.nullifierHashes(note.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 10. two different users withdraw from same anonymity set
  // -------------------------------------------------------------------------
  it("two different users withdraw from same anonymity set", async function () {
    const { mixer, alice, bob, charlie, signers, owner } =
      await loadFixture(deployMixerFixture);

    // Build an anonymity set of 5 deposits
    const noteAlice = makeNote();
    const noteBob = makeNote();

    await mixer.connect(alice).deposit(noteAlice.commitment, { value: DENOMINATION });
    await mixer.connect(bob).deposit(noteBob.commitment, { value: DENOMINATION });
    await mixer.connect(charlie).deposit(makeNote().commitment, { value: DENOMINATION });
    await mixer.connect(signers[4]).deposit(makeNote().commitment, { value: DENOMINATION });
    await mixer.connect(signers[5]).deposit(makeNote().commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();

    const recipientAlice = signers[10];
    const recipientBob = signers[11];

    const balanceAliceBefore = await ethers.provider.getBalance(recipientAlice.address);
    const balanceBobBefore = await ethers.provider.getBalance(recipientBob.address);

    await doWithdraw(mixer, root, noteAlice.nullifierHash, recipientAlice.address, ethers.ZeroAddress, 0n, owner);
    await doWithdraw(mixer, root, noteBob.nullifierHash, recipientBob.address, ethers.ZeroAddress, 0n, owner);

    const balanceAliceAfter = await ethers.provider.getBalance(recipientAlice.address);
    const balanceBobAfter = await ethers.provider.getBalance(recipientBob.address);

    expect(balanceAliceAfter - balanceAliceBefore).to.equal(DENOMINATION);
    expect(balanceBobAfter - balanceBobBefore).to.equal(DENOMINATION);

    expect(await mixer.nullifierHashes(noteAlice.nullifierHash)).to.be.true;
    expect(await mixer.nullifierHashes(noteBob.nullifierHash)).to.be.true;
    expect(await mixer.withdrawalCount()).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // 11. withdraw uses stale root (within ROOT_HISTORY_SIZE)
  // -------------------------------------------------------------------------
  it("withdraw uses stale root (within ROOT_HISTORY_SIZE)", async function () {
    const { mixer, alice, bob, recipient, relayer, owner } =
      await loadFixture(deployMixerFixture);

    const note = makeNote();
    await mixer.connect(alice).deposit(note.commitment, { value: DENOMINATION });

    // Capture the root after alice's deposit — this will become stale
    const staleRoot = await mixer.getLastRoot();

    // Add ROOT_HISTORY_SIZE - 1 more deposits to rotate the root ring buffer
    // but keep the stale root in history. ROOT_HISTORY_SIZE = 30, so 29 more deposits.
    const ROOT_HISTORY_SIZE = 30;
    for (let i = 0; i < ROOT_HISTORY_SIZE - 1; i++) {
      const filler = makeNote();
      await mixer.connect(bob).deposit(filler.commitment, { value: DENOMINATION });
    }

    // The stale root is the oldest entry in the ring buffer — still valid
    expect(await mixer.isKnownRoot(staleRoot)).to.be.true;

    const recipientAddr = recipient.address;
    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    await doWithdraw(mixer, staleRoot, note.nullifierHash, recipientAddr, relayer.address, 0n, owner);

    const balanceAfter = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // 12. withdrawal order doesn't matter (last depositor can withdraw first)
  // -------------------------------------------------------------------------
  it("withdrawal order doesn't matter (last depositor can withdraw first)", async function () {
    const { mixer, alice, bob, charlie, recipient, relayer, owner } =
      await loadFixture(deployMixerFixture);

    const noteAlice = makeNote();
    const noteBob = makeNote();
    const noteCharlie = makeNote();

    await mixer.connect(alice).deposit(noteAlice.commitment, { value: DENOMINATION });
    await mixer.connect(bob).deposit(noteBob.commitment, { value: DENOMINATION });
    await mixer.connect(charlie).deposit(noteCharlie.commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();

    // Charlie deposited last — she withdraws first
    const recipientAddr = recipient.address;
    const balanceBefore = await ethers.provider.getBalance(recipientAddr);

    await doWithdraw(mixer, root, noteCharlie.nullifierHash, recipientAddr, relayer.address, 0n, owner);

    const balanceAfterCharlie = await ethers.provider.getBalance(recipientAddr);
    expect(balanceAfterCharlie - balanceBefore).to.equal(DENOMINATION);
    expect(await mixer.nullifierHashes(noteCharlie.nullifierHash)).to.be.true;

    // Alice and Bob can still withdraw using the same root
    await doWithdraw(mixer, root, noteAlice.nullifierHash, alice.address, ethers.ZeroAddress, 0n, owner);
    await doWithdraw(mixer, root, noteBob.nullifierHash, bob.address, ethers.ZeroAddress, 0n, owner);

    expect(await mixer.nullifierHashes(noteAlice.nullifierHash)).to.be.true;
    expect(await mixer.nullifierHashes(noteBob.nullifierHash)).to.be.true;

    // Mixer fully drained
    expect(await ethers.provider.getBalance(await mixer.getAddress())).to.equal(0n);
  });
});
