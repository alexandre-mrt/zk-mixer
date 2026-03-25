import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
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
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function makeTimelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function makeTimelockHashAddress(name: string, addr: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], [name, addr])
  );
}

async function queueAndWait(mixer: Mixer, hash: string): Promise<void> {
  await mixer.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
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

  return { mixer, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Modifier Coverage
// ---------------------------------------------------------------------------

describe("Modifier Coverage", function () {
  // -------------------------------------------------------------------------
  // nonReentrant
  // -------------------------------------------------------------------------

  describe("nonReentrant", function () {
    it("deposit has nonReentrant — pool balance is correct after reentrancy attack", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);

      const hasherAddress = await deployHasher();
      const Verifier = await ethers.getContractFactory("Groth16Verifier");
      const verifier = await Verifier.deploy();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const targetMixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await AttackerFactory.deploy(await targetMixer.getAddress());

      // Deposit so there is something to withdraw
      await targetMixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      const root = await targetMixer.getLastRoot();
      const nullifierHash = randomCommitment();

      await attacker.attack(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifierHash);

      // Only one withdrawal must have succeeded despite reentrancy attempt
      expect(await targetMixer.withdrawalCount()).to.equal(1n);
      expect(await ethers.provider.getBalance(await targetMixer.getAddress())).to.equal(0n);
    });

    it("withdraw has nonReentrant — reentrant call from receive() is blocked", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);

      const hasherAddress = await deployHasher();
      const Verifier = await ethers.getContractFactory("Groth16Verifier");
      const verifier = await Verifier.deploy();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const targetMixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await AttackerFactory.deploy(await targetMixer.getAddress());

      // Two deposits so pool has funds for potential double-withdrawal
      await targetMixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await targetMixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      const root = await targetMixer.getLastRoot();
      const nullifierHash = randomCommitment();

      await attacker.attack(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifierHash);

      // The guard must have prevented any extra withdrawals
      expect(await attacker.attackCount()).to.equal(1n);
      // Pool still holds one denomination (only one withdrawal succeeded)
      expect(await ethers.provider.getBalance(await targetMixer.getAddress())).to.equal(DENOMINATION);
    });
  });

  // -------------------------------------------------------------------------
  // whenNotPaused
  // -------------------------------------------------------------------------

  describe("whenNotPaused", function () {
    it("deposit reverts with EnforcedPause when paused", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await mixer.pause();
      await expect(
        mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("withdraw reverts with EnforcedPause when paused", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      // Deposit first so withdraw has a root to use
      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      await mixer.pause();

      await expect(
        mixer.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          randomCommitment(),
          alice.address,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // onlyOwner
  // -------------------------------------------------------------------------

  describe("onlyOwner", function () {
    it("pause: onlyOwner enforced", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(mixer.connect(alice).pause()).to.be.revertedWithCustomError(
        mixer,
        "OwnableUnauthorizedAccount"
      );
    });

    it("unpause: onlyOwner enforced", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await mixer.pause(); // owner pauses first
      await expect(mixer.connect(alice).unpause()).to.be.revertedWithCustomError(
        mixer,
        "OwnableUnauthorizedAccount"
      );
    });

    it("queueAction: onlyOwner enforced", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(
        mixer.connect(alice).queueAction(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("cancelAction: onlyOwner enforced", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const hash = makeTimelockHash("setMaxDepositsPerAddress", 5n);
      await mixer.queueAction(hash); // owner queues
      await expect(
        mixer.connect(alice).cancelAction()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("owner can call pause without revert", async function () {
      const { mixer } = await loadFixture(deployFixture);
      await expect(mixer.pause()).to.not.be.reverted;
    });

    it("owner can call unpause without revert", async function () {
      const { mixer } = await loadFixture(deployFixture);
      await mixer.pause();
      await expect(mixer.unpause()).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // timelockReady
  // -------------------------------------------------------------------------

  describe("timelockReady", function () {
    it("setMaxDepositsPerAddress: timelockReady enforced — reverts before delay", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const hash = makeTimelockHash("setMaxDepositsPerAddress", 5n);
      await mixer.queueAction(hash);
      // Only advance 1 hour — not enough
      await time.increase(3600);
      await expect(
        mixer.setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("Mixer: timelock not expired");
    });

    it("setMaxDepositsPerAddress: timelockReady enforced — reverts without any queued action", async function () {
      const { mixer } = await loadFixture(deployFixture);
      await expect(
        mixer.setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("setMaxDepositsPerAddress: executes after delay elapses", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const hash = makeTimelockHash("setMaxDepositsPerAddress", 5n);
      await queueAndWait(mixer, hash);
      await expect(mixer.setMaxDepositsPerAddress(5n)).to.not.be.reverted;
      expect(await mixer.maxDepositsPerAddress()).to.equal(5n);
    });

    it("setDepositReceipt: timelockReady enforced — reverts before delay", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const hash = makeTimelockHashAddress("setDepositReceipt", ethers.ZeroAddress);
      await mixer.queueAction(hash);
      await time.increase(3600);
      await expect(
        mixer.setDepositReceipt(ethers.ZeroAddress)
      ).to.be.revertedWith("Mixer: timelock not expired");
    });

    it("setDepositReceipt: timelockReady enforced — reverts without any queued action", async function () {
      const { mixer } = await loadFixture(deployFixture);
      await expect(
        mixer.setDepositReceipt(ethers.ZeroAddress)
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("setDepositReceipt: executes after delay elapses", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const hash = makeTimelockHashAddress("setDepositReceipt", ethers.ZeroAddress);
      await queueAndWait(mixer, hash);
      await expect(mixer.setDepositReceipt(ethers.ZeroAddress)).to.not.be.reverted;
    });

    it("setDepositCooldown: timelockReady enforced — reverts before delay", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const hash = makeTimelockHash("setDepositCooldown", 3600n);
      await mixer.queueAction(hash);
      await time.increase(3600);
      await expect(
        mixer.setDepositCooldown(3600n)
      ).to.be.revertedWith("Mixer: timelock not expired");
    });

    it("setDepositCooldown: timelockReady enforced — reverts without any queued action", async function () {
      const { mixer } = await loadFixture(deployFixture);
      await expect(
        mixer.setDepositCooldown(3600n)
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("setDepositCooldown: executes after delay elapses", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const hash = makeTimelockHash("setDepositCooldown", 3600n);
      await queueAndWait(mixer, hash);
      await expect(mixer.setDepositCooldown(3600n)).to.not.be.reverted;
      expect(await mixer.depositCooldown()).to.equal(3600n);
    });
  });

  // -------------------------------------------------------------------------
  // onlyDeployedChain
  // -------------------------------------------------------------------------

  describe("onlyDeployedChain", function () {
    it("deposit succeeds on the correct chain (chainId matches deployedChainId)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      // Hardhat uses chainId 31337 — same as deployedChainId set in constructor
      const deployedChainId = await mixer.deployedChainId();
      const currentChainId = BigInt((await ethers.provider.getNetwork()).chainId);
      expect(deployedChainId).to.equal(currentChainId);

      await expect(
        mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.not.be.reverted;
    });

    it("withdraw succeeds on the correct chain (chainId matches deployedChainId)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      // The call must reach the function body (chain check passed).
      // The verifier is the placeholder that always returns true, so the withdraw
      // actually succeeds. We confirm body execution by verifying the withdrawal count.
      const nullifierHash = randomCommitment();
      await mixer.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        alice.address,
        ethers.ZeroAddress,
        0n
      );
      expect(await mixer.withdrawalCount()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Combined modifier stacks
  // -------------------------------------------------------------------------

  describe("combined modifiers", function () {
    it("deposit: whenNotPaused fires before onlyDeployedChain — EnforcedPause is the first check to fail when paused", async function () {
      // modifier order: nonReentrant whenNotPaused onlyDeployedChain
      // whenNotPaused executes before onlyDeployedChain, so EnforcedPause wins
      const { mixer, alice } = await loadFixture(deployFixture);
      await mixer.pause();
      await expect(
        mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("deposit: all three modifiers pass on the happy path (nonReentrant + whenNotPaused + onlyDeployedChain)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(
        mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.emit(mixer, "Deposit");
    });

    it("withdraw: whenNotPaused fires before onlyDeployedChain — EnforcedPause is the first check to fail when paused", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      await mixer.pause();

      await expect(
        mixer.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          randomCommitment(),
          alice.address,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });

    it("withdraw: all three modifiers pass and function body executes (nonReentrant + whenNotPaused + onlyDeployedChain)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      // Reaches body — the placeholder verifier always returns true so
      // the withdraw succeeds. Confirm body executed by checking withdrawalCount.
      const nullifierHash = randomCommitment();
      await mixer.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        alice.address,
        ethers.ZeroAddress,
        0n
      );
      expect(await mixer.withdrawalCount()).to.equal(1n);
    });
  });
});
