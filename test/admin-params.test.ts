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
const ONE_YEAR_SECONDS = 365n * 24n * 60n * 60n; // 31_536_000 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function deployMixerFixture() {
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

async function deployMixerWithReceiptFixture() {
  const base = await deployMixerFixture();
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await base.mixer.getAddress()
  )) as unknown as DepositReceipt;
  return { ...base, receipt };
}

function maxDepositsHash(value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setMaxDepositsPerAddress", value])
  );
}

function cooldownHash(value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setDepositCooldown", value])
  );
}

function depositReceiptHash(addr: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], ["setDepositReceipt", addr])
  );
}

async function timelockSetMaxDeposits(mixer: Mixer, owner: Signer, value: bigint): Promise<void> {
  await mixer.connect(owner).queueAction(maxDepositsHash(value));
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setMaxDepositsPerAddress(value);
}

async function timelockSetCooldown(mixer: Mixer, owner: Signer, value: bigint): Promise<void> {
  await mixer.connect(owner).queueAction(cooldownHash(value));
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setDepositCooldown(value);
}

async function timelockSetDepositReceipt(mixer: Mixer, owner: Signer, addr: string): Promise<void> {
  await mixer.connect(owner).queueAction(depositReceiptHash(addr));
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setDepositReceipt(addr);
}

async function doDeposit(mixer: Mixer, signer: Signer) {
  const c = randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Admin Parameter Ranges", function () {
  // -------------------------------------------------------------------------
  // maxDepositsPerAddress
  // -------------------------------------------------------------------------

  describe("maxDepositsPerAddress", function () {
    it("can be set to 1 (minimum useful value)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetMaxDeposits(mixer, owner, 1n);
      expect(await mixer.maxDepositsPerAddress()).to.equal(1n);
    });

    it("can be set to max uint256", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetMaxDeposits(mixer, owner, ethers.MaxUint256);
      expect(await mixer.maxDepositsPerAddress()).to.equal(ethers.MaxUint256);
    });

    it("can be reset to 0 (unlimited)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetMaxDeposits(mixer, owner, 5n);
      await timelockSetMaxDeposits(mixer, owner, 0n);
      expect(await mixer.maxDepositsPerAddress()).to.equal(0n);
    });

    it("maxDepositsPerAddress = 1 allows only 1 deposit per address", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetMaxDeposits(mixer, owner, 1n);

      // First deposit succeeds
      await doDeposit(mixer, alice);
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(1n);

      // Second deposit reverts
      const c = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: deposit limit reached");
    });

    it("emits MaxDepositsPerAddressUpdated when setting to 1", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).queueAction(maxDepositsHash(1n));
      await time.increase(24 * 60 * 60 + 1);
      await expect(mixer.connect(owner).setMaxDepositsPerAddress(1n))
        .to.emit(mixer, "MaxDepositsPerAddressUpdated")
        .withArgs(1n);
    });

    it("emits MaxDepositsPerAddressUpdated when resetting to 0", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetMaxDeposits(mixer, owner, 3n);
      await mixer.connect(owner).queueAction(maxDepositsHash(0n));
      await time.increase(24 * 60 * 60 + 1);
      await expect(mixer.connect(owner).setMaxDepositsPerAddress(0n))
        .to.emit(mixer, "MaxDepositsPerAddressUpdated")
        .withArgs(0n);
    });
  });

  // -------------------------------------------------------------------------
  // depositCooldown
  // -------------------------------------------------------------------------

  describe("depositCooldown", function () {
    it("can be set to 1 second (minimum non-zero value)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, 1n);
      expect(await mixer.depositCooldown()).to.equal(1n);
    });

    it("can be set to 365 days (large value)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, ONE_YEAR_SECONDS);
      expect(await mixer.depositCooldown()).to.equal(ONE_YEAR_SECONDS);
    });

    it("can be reset to 0 (no cooldown)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, 3600n);
      await timelockSetCooldown(mixer, owner, 0n);
      expect(await mixer.depositCooldown()).to.equal(0n);
    });

    it("depositCooldown = 2 blocks a deposit before cooldown expires", async function () {
      // Use 2-second cooldown: in Hardhat automine mode each tx advances the clock by
      // exactly 1 second, so the immediate next tx sits at lastDepositTime + 1 which
      // is still within the 2-second window.
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, 2n);

      await doDeposit(mixer, alice);

      // Next automine'd tx is at lastDepositTime + 1, still within 2-second cooldown
      const c = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: deposit cooldown active");
    });

    it("depositCooldown = 1 allows deposit after 1 second has elapsed", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, 1n);

      await doDeposit(mixer, alice);
      await time.increase(2); // advance past 1-second cooldown
      await doDeposit(mixer, alice);

      expect(await mixer.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("emits DepositCooldownUpdated when setting to 1", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).queueAction(cooldownHash(1n));
      await time.increase(24 * 60 * 60 + 1);
      await expect(mixer.connect(owner).setDepositCooldown(1n))
        .to.emit(mixer, "DepositCooldownUpdated")
        .withArgs(1n);
    });

    it("emits DepositCooldownUpdated when resetting to 0", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, 60n);
      await mixer.connect(owner).queueAction(cooldownHash(0n));
      await time.increase(24 * 60 * 60 + 1);
      await expect(mixer.connect(owner).setDepositCooldown(0n))
        .to.emit(mixer, "DepositCooldownUpdated")
        .withArgs(0n);
    });
  });

  // -------------------------------------------------------------------------
  // depositReceipt
  // -------------------------------------------------------------------------

  describe("depositReceipt", function () {
    it("depositReceipt can be set to a valid contract address", async function () {
      const { mixer, owner, receipt } = await loadFixture(deployMixerWithReceiptFixture);
      const receiptAddr = await receipt.getAddress();

      await timelockSetDepositReceipt(mixer, owner, receiptAddr);

      expect(await mixer.depositReceipt()).to.equal(receiptAddr);
    });

    it("depositReceipt can be unset to address(0)", async function () {
      const { mixer, owner, receipt } = await loadFixture(deployMixerWithReceiptFixture);
      await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

      await timelockSetDepositReceipt(mixer, owner, ethers.ZeroAddress);

      expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);
    });

    it("setting depositReceipt to EOA does not revert on setDepositReceipt call", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      const eoaAddress = alice.address;

      // Setting to an EOA should not revert — validation only happens at mint time
      await expect(timelockSetDepositReceipt(mixer, owner, eoaAddress)).to.not.be.reverted;
      expect(await mixer.depositReceipt()).to.equal(eoaAddress);
    });

    it("setting depositReceipt to EOA reverts on deposit (mint call fails)", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      const eoaAddress = alice.address;

      await timelockSetDepositReceipt(mixer, owner, eoaAddress);

      // Depositing when receipt is set to an EOA reverts because the mint call fails
      const c = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.be.reverted;
    });

    it("changing depositReceipt to a new contract works", async function () {
      const { mixer, owner, receipt } = await loadFixture(deployMixerWithReceiptFixture);
      const firstAddr = await receipt.getAddress();

      // Set to first receipt contract
      await timelockSetDepositReceipt(mixer, owner, firstAddr);
      expect(await mixer.depositReceipt()).to.equal(firstAddr);

      // Deploy a second receipt contract and switch to it
      const hasherAddress = await deployHasher();
      const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt2 = (await DepositReceiptFactory.deploy(
        await mixer.getAddress()
      )) as unknown as DepositReceipt;
      const secondAddr = await receipt2.getAddress();

      await timelockSetDepositReceipt(mixer, owner, secondAddr);
      expect(await mixer.depositReceipt()).to.equal(secondAddr);
    });
  });
});
