import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const MERKLE_TREE_HEIGHT = 5;
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
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

function maxDepositsHash(_max: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setMaxDepositsPerAddress", _max]
    )
  );
}

// ---------------------------------------------------------------------------
// Fixture
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Extended Edge Cases", function () {
  // -------------------------------------------------------------------------
  // Deposit edge cases
  // -------------------------------------------------------------------------

  describe("Deposit edge cases", function () {
    it("deposit with commitment = 1 (minimum valid)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = 1n;
      await expect(
        mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
      )
        .to.emit(mixer, "Deposit")
        .withArgs(commitment, 0, (ts: bigint) => ts > 0n);

      expect(await mixer.commitments(commitment)).to.be.true;
      expect(await mixer.nextIndex()).to.equal(1n);
    });

    it("deposit with commitment = FIELD_SIZE - 1 (maximum valid)", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      const commitment = FIELD_SIZE - 1n;
      await expect(
        mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
      ).to.emit(mixer, "Deposit");

      expect(await mixer.commitments(commitment)).to.be.true;
    });

    it("deposit from contract address (not EOA)", async function () {
      const { mixer } = await loadFixture(deployFixture);

      const ContractDepositorFactory =
        await ethers.getContractFactory("ContractDepositor");
      const contractDepositor = await ContractDepositorFactory.deploy();
      const depositorAddress = await contractDepositor.getAddress();

      // Fund the contract depositor
      const [funder] = await ethers.getSigners();
      await funder.sendTransaction({
        to: depositorAddress,
        value: DENOMINATION,
      });

      const commitment = randomCommitment();

      await expect(
        contractDepositor.deposit(
          await mixer.getAddress(),
          commitment,
          DENOMINATION,
          { value: DENOMINATION }
        )
      ).to.emit(mixer, "Deposit");

      expect(await mixer.commitments(commitment)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // Withdrawal edge cases
  // -------------------------------------------------------------------------

  describe("Withdrawal edge cases", function () {
    it("withdraw to same address that deposited", async function () {
      const { mixer, alice } = await loadFixture(deployFixture);

      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

      const root = await mixer.getLastRoot();
      const nullifier = randomCommitment();

      const aliceBalanceBefore = await ethers.provider.getBalance(
        alice.address
      );

      const tx = await mixer
        .connect(alice)
        .withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          alice.address,
          ethers.ZeroAddress,
          0n
        );
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);

      // alice sent gas, received denomination back (no fee)
      expect(aliceBalanceAfter).to.equal(
        aliceBalanceBefore + DENOMINATION - gasUsed
      );
      expect(await mixer.nullifierHashes(nullifier)).to.be.true;
    });

    it("withdraw with relayer == recipient (self-relay)", async function () {
      const { mixer, alice, bob } = await loadFixture(deployFixture);

      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

      const root = await mixer.getLastRoot();
      const nullifier = randomCommitment();
      const fee = 1000n;

      const bobBalanceBefore = await ethers.provider.getBalance(bob.address);

      // bob is both recipient and relayer
      await mixer
        .connect(alice)
        .withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          bob.address,
          bob.address,
          fee
        );

      const bobBalanceAfter = await ethers.provider.getBalance(bob.address);

      // bob receives denomination (both the main amount and the fee go to bob)
      expect(bobBalanceAfter).to.equal(bobBalanceBefore + DENOMINATION);
    });

    it("withdraw with fee = 1 wei (minimum non-zero fee)", async function () {
      const { mixer, alice, bob, relayer } = await loadFixture(deployFixture);

      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

      const root = await mixer.getLastRoot();
      const nullifier = randomCommitment();
      const fee = 1n;

      const relayerBalanceBefore = await ethers.provider.getBalance(
        relayer.address
      );
      const bobBalanceBefore = await ethers.provider.getBalance(bob.address);

      await mixer
        .connect(alice)
        .withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          bob.address,
          relayer.address,
          fee
        );

      const relayerBalanceAfter = await ethers.provider.getBalance(
        relayer.address
      );
      const bobBalanceAfter = await ethers.provider.getBalance(bob.address);

      expect(relayerBalanceAfter).to.equal(relayerBalanceBefore + fee);
      expect(bobBalanceAfter).to.equal(
        bobBalanceBefore + DENOMINATION - fee
      );
    });

    it("withdraw with fee = denomination - 1 wei (maximum fee)", async function () {
      const { mixer, alice, bob, relayer } = await loadFixture(deployFixture);

      const commitment = randomCommitment();
      await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

      const root = await mixer.getLastRoot();
      const nullifier = randomCommitment();
      const fee = DENOMINATION - 1n;

      const relayerBalanceBefore = await ethers.provider.getBalance(
        relayer.address
      );
      const bobBalanceBefore = await ethers.provider.getBalance(bob.address);

      await mixer
        .connect(alice)
        .withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          bob.address,
          relayer.address,
          fee
        );

      const relayerBalanceAfter = await ethers.provider.getBalance(
        relayer.address
      );
      const bobBalanceAfter = await ethers.provider.getBalance(bob.address);

      expect(relayerBalanceAfter).to.equal(relayerBalanceBefore + fee);
      // recipient gets exactly 1 wei
      expect(bobBalanceAfter).to.equal(bobBalanceBefore + 1n);
    });
  });

  // -------------------------------------------------------------------------
  // Timelock edge cases
  // -------------------------------------------------------------------------

  describe("Timelock edge cases", function () {
    it("queue action right at block.timestamp (executeAfter = timestamp + TIMELOCK_DELAY)", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash = maxDepositsHash(5n);

      const latestBlock = await ethers.provider.getBlock("latest");
      const blockTs = BigInt(latestBlock!.timestamp);
      const expectedExecuteAfter = blockTs + 1n + BigInt(ONE_DAY);

      const tx = await mixer.connect(owner).queueAction(hash);
      await tx.wait();

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash);
      expect(pending.executeAfter).to.equal(expectedExecuteAfter);
    });

    it("execute action exactly at executeAfter timestamp", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash = maxDepositsHash(5n);

      await mixer.connect(owner).queueAction(hash);
      const pending = await mixer.pendingAction();
      const executeAfter = pending.executeAfter;

      // Set block.timestamp to exactly executeAfter
      await time.setNextBlockTimestamp(executeAfter);

      await expect(mixer.connect(owner).setMaxDepositsPerAddress(5n))
        .to.emit(mixer, "ActionExecuted")
        .withArgs(hash);

      expect(await mixer.maxDepositsPerAddress()).to.equal(5n);
    });

    it("queue two different actions in sequence", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const hash1 = maxDepositsHash(3n);
      const hash2 = maxDepositsHash(7n);

      // Queue first action
      await mixer.connect(owner).queueAction(hash1);
      let pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash1);

      // Queue second action (replaces the first)
      await mixer.connect(owner).queueAction(hash2);
      pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash2);
      expect(pending.actionHash).to.not.equal(hash1);

      // Can execute the second action after delay
      await time.increase(ONE_DAY + 1);
      await expect(mixer.connect(owner).setMaxDepositsPerAddress(7n))
        .to.emit(mixer, "ActionExecuted")
        .withArgs(hash2);

      expect(await mixer.maxDepositsPerAddress()).to.equal(7n);
    });
  });

  // -------------------------------------------------------------------------
  // Stats edge cases
  // -------------------------------------------------------------------------

  describe("Stats edge cases", function () {
    it("getAnonymitySetSize returns 0 when all deposits withdrawn", async function () {
      const { mixer, alice, bob } = await loadFixture(deployFixture);

      // Make 3 deposits
      const nullifiers: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        const commitment = randomCommitment();
        await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
        nullifiers.push(randomCommitment());
      }

      // Withdraw all 3 — each uses the latest root
      for (const nullifier of nullifiers) {
        const root = await mixer.getLastRoot();
        await mixer
          .connect(alice)
          .withdraw(
            DUMMY_PA,
            DUMMY_PB,
            DUMMY_PC,
            root,
            nullifier,
            bob.address,
            ethers.ZeroAddress,
            0n
          );
      }

      expect(await mixer.getAnonymitySetSize()).to.equal(0n);

      const [, , depositCount, withdrawalCount] = await mixer.getStats();
      expect(depositCount).to.equal(3n);
      expect(withdrawalCount).to.equal(3n);
    });

    it("pool health reports 0% utilization with empty tree", async function () {
      const { mixer } = await loadFixture(deployFixture);

      const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
        await mixer.getPoolHealth();

      expect(anonymitySetSize).to.equal(0n);
      expect(treeUtilization).to.equal(0n);
      expect(poolBalance).to.equal(0n);
      expect(isPaused).to.be.false;
    });
  });
});
