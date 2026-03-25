import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ONE_DAY = 86_400;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
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
  return { mixer, verifier, hasherAddress, owner, alice, bob, relayer };
}

async function deployMixerWithLensFixture() {
  const base = await deployMixerFixture();
  const LensFactory = await ethers.getContractFactory("MixerLens");
  const lens = (await LensFactory.deploy()) as unknown as MixerLens;
  return { ...base, lens };
}

async function deployReceiptFixture() {
  const base = await deployMixerFixture();
  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await base.mixer.getAddress()
  )) as unknown as DepositReceipt;
  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment?: bigint
): Promise<bigint> {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: string,
  relayer: string,
  fee: bigint,
  caller: Signer
) {
  return mixer.connect(caller).withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient as `0x${string}`,
    relayer as `0x${string}`,
    fee
  );
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function timelockHashAddr(name: string, addr: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], [name, addr])
  );
}

async function queueAndWait(mixer: Mixer, hash: string, owner: Signer) {
  await mixer.connect(owner).queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Regression Suite
// ---------------------------------------------------------------------------

describe("Regression Suite", function () {
  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------

  describe("deposit", function () {
    it("deposit: happy path emits event", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const c = randomCommitment();
      await expect(mixer.connect(alice).deposit(c, { value: DENOMINATION }))
        .to.emit(mixer, "Deposit")
        .withArgs(c, 0, await ethers.provider.getBlock("latest").then((b) => b!.timestamp + 1));
    });

    it("deposit: wrong amount reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION - 1n })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it("deposit: zero commitment reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(alice).deposit(0n, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment is zero");
    });

    it("deposit: duplicate commitment reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const c = randomCommitment();
      await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: duplicate commitment");
    });

    it("deposit: field overflow reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(alice).deposit(FIELD_SIZE, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment >= field size");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------

  describe("withdraw", function () {
    it("withdraw: happy path transfers ETH", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, alice);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await bob.getAddress();
      const balanceBefore = await ethers.provider.getBalance(recipientAddr);
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, ZERO_ADDRESS, 0n, alice);
      const balanceAfter = await ethers.provider.getBalance(recipientAddr);
      expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    });

    it("withdraw: double spend reverts", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, alice);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await bob.getAddress();
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, ZERO_ADDRESS, 0n, alice);
      await expect(
        doWithdraw(mixer, root, nullifierHash, recipientAddr, ZERO_ADDRESS, 0n, alice)
      ).to.be.revertedWith("Mixer: already spent");
    });

    it("withdraw: unknown root reverts", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
      const unknownRoot = randomCommitment();
      const nullifierHash = randomCommitment();
      await expect(
        doWithdraw(mixer, unknownRoot, nullifierHash, await bob.getAddress(), ZERO_ADDRESS, 0n, alice)
      ).to.be.revertedWith("Mixer: unknown root");
    });

    it("withdraw: zero recipient reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, alice);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      await expect(
        doWithdraw(mixer, root, nullifierHash, ZERO_ADDRESS, ZERO_ADDRESS, 0n, alice)
      ).to.be.revertedWith("Mixer: recipient is zero address");
    });

    it("withdraw: fee > denomination reverts", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, alice);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      await expect(
        doWithdraw(mixer, root, nullifierHash, await bob.getAddress(), ZERO_ADDRESS, DENOMINATION + 1n, alice)
      ).to.be.revertedWith("Mixer: fee exceeds denomination");
    });

    it("withdraw: zero relayer with non-zero fee reverts", async function () {
      const { mixer, alice, bob } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, alice);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      await expect(
        doWithdraw(mixer, root, nullifierHash, await bob.getAddress(), ZERO_ADDRESS, 1000n, alice)
      ).to.be.revertedWith("Mixer: relayer is zero address for non-zero fee");
    });
  });

  // -------------------------------------------------------------------------
  // admin
  // -------------------------------------------------------------------------

  describe("admin", function () {
    it("pause: owner succeeds", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(mixer.connect(owner).pause()).to.emit(mixer, "Paused");
    });

    it("pause: non-owner reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(alice).pause()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("unpause: owner succeeds", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await expect(mixer.connect(owner).unpause()).to.emit(mixer, "Unpaused");
    });

    it("unpause: non-owner reverts", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await expect(
        mixer.connect(alice).unpause()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("queueAction: owner succeeds", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await expect(mixer.connect(owner).queueAction(hash))
        .to.emit(mixer, "ActionQueued");
    });

    it("queueAction: non-owner reverts", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await expect(
        mixer.connect(alice).queueAction(hash)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("cancelAction: owner succeeds", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await mixer.connect(owner).queueAction(hash);
      await expect(mixer.connect(owner).cancelAction())
        .to.emit(mixer, "ActionCancelled");
    });

    it("cancelAction: non-owner reverts", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await mixer.connect(owner).queueAction(hash);
      await expect(
        mixer.connect(alice).cancelAction()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // timelocked setters
  // -------------------------------------------------------------------------

  describe("timelocked setters", function () {
    it("setMaxDepositsPerAddress: happy path via timelock", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 3n);
      await queueAndWait(mixer, hash, owner);
      await expect(mixer.connect(owner).setMaxDepositsPerAddress(3n))
        .to.emit(mixer, "MaxDepositsPerAddressUpdated")
        .withArgs(3n);
      expect(await mixer.maxDepositsPerAddress()).to.equal(3n);
    });

    it("setMaxDepositsPerAddress: without queue reverts", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("setDepositReceipt: happy path via timelock", async function () {
      const { mixer, owner, hasherAddress } = await loadFixture(deployMixerFixture);
      const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt = await ReceiptFactory.deploy(await mixer.getAddress());
      const receiptAddr = await receipt.getAddress();
      const hash = timelockHashAddr("setDepositReceipt", receiptAddr);
      await queueAndWait(mixer, hash, owner);
      await mixer.connect(owner).setDepositReceipt(receiptAddr);
      expect(await mixer.depositReceipt()).to.equal(receiptAddr);
    });

    it("setDepositReceipt: without queue reverts", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt = await ReceiptFactory.deploy(await mixer.getAddress());
      await expect(
        mixer.connect(owner).setDepositReceipt(await receipt.getAddress())
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("setDepositCooldown: happy path via timelock", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = timelockHash("setDepositCooldown", 3600n);
      await queueAndWait(mixer, hash, owner);
      await expect(mixer.connect(owner).setDepositCooldown(3600n))
        .to.emit(mixer, "DepositCooldownUpdated")
        .withArgs(3600n);
      expect(await mixer.depositCooldown()).to.equal(3600n);
    });

    it("setDepositCooldown: without queue reverts", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(owner).setDepositCooldown(3600n)
      ).to.be.revertedWith("Mixer: action not queued");
    });
  });

  // -------------------------------------------------------------------------
  // view functions
  // -------------------------------------------------------------------------

  describe("view functions", function () {
    it("denomination returns correct value", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.denomination()).to.equal(DENOMINATION);
    });

    it("levels returns correct value", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.levels()).to.equal(MERKLE_TREE_HEIGHT);
    });

    it("getLastRoot is non-zero", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.getLastRoot()).to.not.equal(0n);
    });

    it("isKnownRoot(getLastRoot) is true", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const root = await mixer.getLastRoot();
      expect(await mixer.isKnownRoot(root)).to.be.true;
    });

    it("isKnownRoot(0) is false", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.isKnownRoot(0n)).to.be.false;
    });

    it("getStats returns 5 values", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const stats = await mixer.getStats();
      expect(stats).to.have.length(5);
    });

    it("getAnonymitySetSize is 0 initially", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.getAnonymitySetSize()).to.equal(0n);
    });

    it("getPoolHealth returns 4 values", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const health = await mixer.getPoolHealth();
      expect(health).to.have.length(4);
    });

    it("getTreeCapacity is 2^levels", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.getTreeCapacity()).to.equal(2n ** BigInt(MERKLE_TREE_HEIGHT));
    });

    it("getTreeUtilization is 0 initially", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.getTreeUtilization()).to.equal(0n);
    });

    it("hasCapacity is true initially", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.hasCapacity()).to.be.true;
    });

    it("getRootHistory length is 30", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const history = await mixer.getRootHistory();
      expect(history).to.have.length(30);
    });

    it("getValidRootCount is 1 initially", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.getValidRootCount()).to.equal(1);
    });

    it("getRemainingDeposits is max uint initially", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      expect(await mixer.getRemainingDeposits(await alice.getAddress())).to.equal(
        ethers.MaxUint256
      );
    });

    it("deployedChainId is 31337", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.deployedChainId()).to.equal(31337n);
    });
  });

  // -------------------------------------------------------------------------
  // MixerLens
  // -------------------------------------------------------------------------

  describe("MixerLens", function () {
    it("MixerLens.getSnapshot returns valid struct", async function () {
      const { mixer, lens } = await loadFixture(deployMixerWithLensFixture);
      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.denomination).to.equal(DENOMINATION);
    });

    it("snapshot.version is 1.0.0", async function () {
      const { mixer, lens } = await loadFixture(deployMixerWithLensFixture);
      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.version).to.equal("1.0.0");
    });

    it("snapshot.owner is deployer", async function () {
      const { mixer, lens, owner } = await loadFixture(deployMixerWithLensFixture);
      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.owner).to.equal(await owner.getAddress());
    });
  });

  // -------------------------------------------------------------------------
  // DepositReceipt
  // -------------------------------------------------------------------------

  describe("DepositReceipt", function () {
    it("name is correct", async function () {
      const { receipt } = await loadFixture(deployReceiptFixture);
      expect(await receipt.name()).to.equal("ZK Mixer Deposit Receipt");
    });

    it("symbol is correct", async function () {
      const { receipt } = await loadFixture(deployReceiptFixture);
      expect(await receipt.symbol()).to.equal("ZKDR");
    });

    it("soulbound: transfer reverts", async function () {
      const { mixer, alice, bob, owner } = await loadFixture(deployMixerFixture);
      const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt = (await ReceiptFactory.deploy(
        await mixer.getAddress()
      )) as unknown as DepositReceipt;
      // Wire the receipt via timelock
      const receiptAddr = await receipt.getAddress();
      const hash = timelockHashAddr("setDepositReceipt", receiptAddr);
      await queueAndWait(mixer, hash, owner);
      await mixer.connect(owner).setDepositReceipt(receiptAddr);
      // Deposit to mint token 0
      await doDeposit(mixer, alice);
      // Attempt transfer
      await expect(
        receipt.connect(alice).transferFrom(await alice.getAddress(), await bob.getAddress(), 0)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });

    it("mint: non-mixer reverts", async function () {
      const { receipt, alice, bob } = await loadFixture(deployReceiptFixture);
      await expect(
        receipt.connect(alice).mint(await bob.getAddress(), randomCommitment())
      ).to.be.revertedWith("DepositReceipt: only mixer");
    });
  });

  // -------------------------------------------------------------------------
  // ERC165
  // -------------------------------------------------------------------------

  describe("ERC165", function () {
    it("supportsInterface ERC165 returns true", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.supportsInterface("0x01ffc9a7")).to.be.true;
    });

    it("supportsInterface random returns false", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.supportsInterface("0xdeadbeef")).to.be.false;
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("Constants", function () {
    it("VERSION is 1.0.0", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.VERSION()).to.equal("1.0.0");
    });

    it("TIMELOCK_DELAY is 86400", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.TIMELOCK_DELAY()).to.equal(86400n);
    });

    it("ROOT_HISTORY_SIZE is 30", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.ROOT_HISTORY_SIZE()).to.equal(30);
    });
  });

  // -------------------------------------------------------------------------
  // Hash functions
  // -------------------------------------------------------------------------

  describe("Hash", function () {
    it("verifyCommitment matches off-chain Poseidon result type", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const secret = 123456n;
      const nullifier = 789012n;
      const result = await mixer.verifyCommitment(secret, nullifier);
      expect(result).to.not.equal(0n);
    });

    it("hashLeftRight is deterministic", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const a = randomCommitment();
      const b = randomCommitment();
      const r1 = await mixer.hashLeftRight(a, b);
      const r2 = await mixer.hashLeftRight(a, b);
      expect(r1).to.equal(r2);
    });

    it("hashLeftRight is non-commutative", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const a = 1n;
      const b = 2n;
      const r1 = await mixer.hashLeftRight(a, b);
      const r2 = await mixer.hashLeftRight(b, a);
      expect(r1).to.not.equal(r2);
    });
  });
});
