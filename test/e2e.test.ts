import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");

// Placeholder proof values — placeholder verifier always returns true
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("Mixer E2E", function () {
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

  async function deployMixerFixture() {
    const [owner, user1, user2, user3, recipient, relayer] =
      await ethers.getSigners();

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

    return { mixer, owner, user1, user2, user3, recipient, relayer };
  }

  type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

  async function deposit(
    mixer: Mixer,
    signer: Signer,
    commitment: bigint
  ): Promise<void> {
    await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
  }

  async function withdraw(
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
  // 1. Full deposit → withdraw with real Poseidon hashes
  // ---------------------------------------------------------------------------

  describe("Full deposit → withdraw with real hashes", function () {
    it("recipient receives denomination after a deposit-withdraw cycle", async function () {
      const { mixer, user1, recipient, relayer, owner } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await deposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();
      const balanceBefore = await ethers.provider.getBalance(recipientAddr);

      await withdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n, owner);

      const balanceAfter = await ethers.provider.getBalance(recipientAddr);
      expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    });

    it("nullifierHash is marked spent after withdrawal", async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await deposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await withdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      expect(await mixer.nullifierHashes(nullifierHash)).to.be.true;
    });

    it("contract balance is zero after single deposit-withdraw cycle", async function () {
      const { mixer, user1, recipient, relayer, owner } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await deposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await withdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n, owner);

      const mixerBalance = await ethers.provider.getBalance(
        await mixer.getAddress()
      );
      expect(mixerBalance).to.equal(0n);
    });

    it("double-spend with same nullifierHash reverts", async function () {
      const { mixer, user1, user2, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await deposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await withdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      // Re-fund so the contract has balance for the second withdraw attempt
      const secret2 = randomFieldElement();
      const nullifier2 = randomFieldElement();
      await deposit(mixer, user2, computeCommitment(secret2, nullifier2));
      const root2 = await mixer.getLastRoot();

      await expect(
        withdraw(mixer, root2, nullifierHash, recipientAddr, relayerAddr, 0n)
      ).to.be.revertedWith("Mixer: already spent");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Multiple deposits, selective withdrawal
  // ---------------------------------------------------------------------------

  describe("Multiple deposits, selective withdrawal", function () {
    it("only user2's nullifier is spent after user2 withdraws", async function () {
      const { mixer, user1, user2, user3, recipient, relayer, owner } =
        await loadFixture(deployMixerFixture);

      const s1 = randomFieldElement();
      const n1 = randomFieldElement();
      const commitment1 = computeCommitment(s1, n1);
      const nullifierHash1 = computeNullifierHash(n1);

      const s2 = randomFieldElement();
      const n2 = randomFieldElement();
      const commitment2 = computeCommitment(s2, n2);
      const nullifierHash2 = computeNullifierHash(n2);

      const s3 = randomFieldElement();
      const n3 = randomFieldElement();
      const commitment3 = computeCommitment(s3, n3);
      const nullifierHash3 = computeNullifierHash(n3);

      await deposit(mixer, user1, commitment1);
      await deposit(mixer, user2, commitment2);
      await deposit(mixer, user3, commitment3);

      const root = await mixer.getLastRoot();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await withdraw(mixer, root, nullifierHash2, recipientAddr, relayerAddr, 0n, owner);

      expect(await mixer.nullifierHashes(nullifierHash1)).to.be.false;
      expect(await mixer.nullifierHashes(nullifierHash2)).to.be.true;
      expect(await mixer.nullifierHashes(nullifierHash3)).to.be.false;
    });

    it("contract balance decreases by exactly one denomination after selective withdrawal", async function () {
      const { mixer, user1, user2, user3, recipient, relayer, owner } =
        await loadFixture(deployMixerFixture);

      const commitments = [
        computeCommitment(randomFieldElement(), randomFieldElement()),
        computeCommitment(randomFieldElement(), randomFieldElement()),
        computeCommitment(randomFieldElement(), randomFieldElement()),
      ];

      for (let i = 0; i < 3; i++) {
        await deposit(mixer, [user1, user2, user3][i], commitments[i]);
      }

      const mixerAddr = await mixer.getAddress();
      const balanceBefore = await ethers.provider.getBalance(mixerAddr);
      expect(balanceBefore).to.equal(DENOMINATION * 3n);

      const root = await mixer.getLastRoot();
      const withdrawNullifier = randomFieldElement();
      const withdrawNullifierHash = computeNullifierHash(withdrawNullifier);
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await withdraw(mixer, root, withdrawNullifierHash, recipientAddr, relayerAddr, 0n, owner);

      const balanceAfter = await ethers.provider.getBalance(mixerAddr);
      expect(balanceBefore - balanceAfter).to.equal(DENOMINATION);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Commitment determinism
  // ---------------------------------------------------------------------------

  describe("Commitment determinism", function () {
    it("same (secret, nullifier) pair always produces the same commitment", function () {
      const secret = randomFieldElement();
      const nullifier = randomFieldElement();

      const c1 = computeCommitment(secret, nullifier);
      const c2 = computeCommitment(secret, nullifier);
      const c3 = computeCommitment(secret, nullifier);

      expect(c1).to.equal(c2);
      expect(c2).to.equal(c3);
    });

    it("different (secret, nullifier) pairs produce different commitments", function () {
      const pairs = Array.from({ length: 5 }, () => ({
        secret: randomFieldElement(),
        nullifier: randomFieldElement(),
      }));

      const commitments = pairs.map(({ secret, nullifier }) =>
        computeCommitment(secret, nullifier)
      );

      const unique = new Set(commitments.map(String));
      expect(unique.size).to.equal(5);
    });

    it("changing only the secret changes the commitment", function () {
      const secret1 = randomFieldElement();
      const secret2 = randomFieldElement();
      const nullifier = randomFieldElement();

      const c1 = computeCommitment(secret1, nullifier);
      const c2 = computeCommitment(secret2, nullifier);

      expect(c1).to.not.equal(c2);
    });

    it("changing only the nullifier changes the commitment", function () {
      const secret = randomFieldElement();
      const n1 = randomFieldElement();
      const n2 = randomFieldElement();

      const c1 = computeCommitment(secret, n1);
      const c2 = computeCommitment(secret, n2);

      expect(c1).to.not.equal(c2);
    });

    it("commitment and nullifierHash are different values for the same nullifier", function () {
      const secret = randomFieldElement();
      const nullifier = randomFieldElement();

      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      expect(commitment).to.not.equal(nullifierHash);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. NullifierHash correctness
  // ---------------------------------------------------------------------------

  describe("NullifierHash correctness", function () {
    it("nullifierHash is Poseidon(nullifier), not Poseidon(secret, nullifier)", function () {
      const secret = randomFieldElement();
      const nullifier = randomFieldElement();

      const nullifierHash = computeNullifierHash(nullifier);
      const commitment = computeCommitment(secret, nullifier);

      // The nullifierHash must differ from the commitment
      expect(nullifierHash).to.not.equal(commitment);

      // Verifying explicit computation: Poseidon([nullifier]) === Poseidon([nullifier])
      const recomputed = F.toObject(poseidon([nullifier]));
      expect(nullifierHash).to.equal(recomputed);
    });

    it("nullifierHash is deterministic for the same nullifier regardless of secret", function () {
      const nullifier = randomFieldElement();
      const secret1 = randomFieldElement();
      const secret2 = randomFieldElement();

      const nh1 = computeNullifierHash(nullifier);
      const nh2 = computeNullifierHash(nullifier);

      // Different secrets don't affect the nullifierHash
      expect(nh1).to.equal(nh2);

      const commitment1 = computeCommitment(secret1, nullifier);
      const commitment2 = computeCommitment(secret2, nullifier);
      expect(commitment1).to.not.equal(commitment2);
    });

    it("spent mapping reflects the correct nullifierHash after withdrawal", async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      // The commitment hash should not be marked as spent
      expect(await mixer.nullifierHashes(commitment)).to.be.false;

      await deposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await withdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      // nullifierHash is spent, commitment is not tracked by nullifierHashes
      expect(await mixer.nullifierHashes(nullifierHash)).to.be.true;
      expect(await mixer.nullifierHashes(commitment)).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Real hash integrity across deposit and withdrawal events
  // ---------------------------------------------------------------------------

  describe("Real hash integrity across deposit and withdrawal events", function () {
    it("Deposit event commitment matches off-chain Poseidon computation", async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);

      const tx = await mixer
        .connect(user1)
        .deposit(commitment, { value: DENOMINATION });
      const receipt = await tx.wait();

      const event = receipt!.logs
        .map((l) => {
          try {
            return mixer.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "Deposit");

      expect(event).to.not.be.null;
      expect(event!.args.commitment).to.equal(commitment);
    });

    it("Withdrawal event nullifierHash matches off-chain Poseidon(nullifier)", async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      await deposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await expect(
        withdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n)
      )
        .to.emit(mixer, "Withdrawal")
        .withArgs(recipientAddr, nullifierHash, relayerAddr, 0n);
    });

    it("commitment stored in contract matches off-chain computation", async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);

      // Not yet deposited
      expect(await mixer.commitments(commitment)).to.be.false;

      await deposit(mixer, user1, commitment);

      // Now it should be recorded
      expect(await mixer.commitments(commitment)).to.be.true;
    });

    it("full flow: deposit event commitment and withdrawal event nullifierHash both match off-chain values", async function () {
      const { mixer, user1, recipient, relayer, owner } =
        await loadFixture(deployMixerFixture);

      const secret = randomFieldElement();
      const nullifier = randomFieldElement();
      const commitment = computeCommitment(secret, nullifier);
      const nullifierHash = computeNullifierHash(nullifier);

      const depositTx = await mixer
        .connect(user1)
        .deposit(commitment, { value: DENOMINATION });
      const depositReceipt = await depositTx.wait();

      const depositEvent = depositReceipt!.logs
        .map((l) => {
          try {
            return mixer.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "Deposit");

      expect(depositEvent!.args.commitment).to.equal(commitment);

      const root = await mixer.getLastRoot();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      const withdrawTx = await withdraw(
        mixer,
        root,
        nullifierHash,
        recipientAddr,
        relayerAddr,
        0n,
        owner
      );
      const withdrawReceipt = await withdrawTx.wait();

      const withdrawalEvent = withdrawReceipt!.logs
        .map((l) => {
          try {
            return mixer.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "Withdrawal");

      expect(withdrawalEvent!.args.nullifierHash).to.equal(nullifierHash);
      expect(withdrawalEvent!.args.to).to.equal(recipientAddr);
    });
  });
});
