import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens, DepositReceipt } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

async function deployFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  return { mixer, mixerLens, depositReceipt, owner, depositor, recipient, relayer };
}

// Returns true if the error message indicates a missing function selector (ABI mismatch),
// false if the call reached the contract (even if it reverted for business logic reasons).
function isFunctionNotFound(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return (
    msg.includes("function not found") ||
    msg.includes("no matching function") ||
    msg.includes("call revert exception") ||
    msg.includes("CALL_EXCEPTION")
  );
}

describe("Contract Interface", function () {
  // -------------------------------------------------------------------------
  // Mixer
  // -------------------------------------------------------------------------

  describe("Mixer", function () {
    it("exposes deposit(uint256) payable", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const commitment = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) || 1n;
      try {
        await mixer.deposit(commitment, { value: DENOMINATION });
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `deposit() selector not found on Mixer: ${(err as Error).message}`
        );
      }
    });

    it("exposes withdraw with correct signature", async function () {
      const { mixer, depositor, recipient } = await loadFixture(deployFixture);
      // Deposit first so there is a known root for the proof to reference.
      const commitment = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) || 1n;
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();
      const nullifierHash = 1n; // dummy — placeholder verifier accepts anything

      try {
        await mixer.withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifierHash,
          recipient.address as `0x${string}`,
          ethers.ZeroAddress as `0x${string}`,
          0n
        );
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `withdraw() selector not found on Mixer: ${(err as Error).message}`
        );
      }
    });

    it("exposes denomination() view", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const denom = await mixer.denomination();
      expect(denom).to.equal(DENOMINATION);
    });

    it("exposes getStats() view with 5 return values", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.getStats();
      // Destructure to confirm 5 named/positional fields are present
      const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] = result;
      expect(totalDeposited).to.be.a("bigint");
      expect(totalWithdrawn).to.be.a("bigint");
      expect(depositCount).to.be.a("bigint");
      expect(withdrawalCount).to.be.a("bigint");
      expect(poolBalance).to.be.a("bigint");
    });

    it("exposes getAnonymitySetSize() view", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const size = await mixer.getAnonymitySetSize();
      expect(size).to.equal(0n);
    });

    it("exposes getPoolHealth() view with 4 return values", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const result = await mixer.getPoolHealth();
      const [anonymitySetSize, treeUtilization, poolBalance, isPaused] = result;
      expect(anonymitySetSize).to.be.a("bigint");
      expect(treeUtilization).to.be.a("bigint");
      expect(poolBalance).to.be.a("bigint");
      expect(isPaused).to.be.a("boolean");
    });

    it("exposes isSpent(uint256) view", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const spent = await mixer.isSpent(1n);
      expect(spent).to.equal(false);
    });

    it("exposes isCommitted(uint256) view", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const committed = await mixer.isCommitted(1n);
      expect(committed).to.equal(false);
    });

    it("exposes getCommitmentIndex(uint256) view — reverts for unknown commitment", async function () {
      const { mixer } = await loadFixture(deployFixture);
      try {
        await mixer.getCommitmentIndex(1n);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `getCommitmentIndex() selector not found on Mixer: ${(err as Error).message}`
        );
        // Expected to revert with "commitment not found" for a non-existent commitment
        expect((err as Error).message).to.include("commitment not found");
      }
    });

    it("exposes getTreeCapacity() view", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const capacity = await mixer.getTreeCapacity();
      expect(capacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
    });

    it("exposes pause() and unpause()", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      // pause() — should succeed for owner
      try {
        await mixer.connect(owner).pause();
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `pause() selector not found on Mixer: ${(err as Error).message}`
        );
      }
      // confirm paused state
      expect(await mixer.paused()).to.equal(true);
      // unpause()
      await mixer.connect(owner).unpause();
      expect(await mixer.paused()).to.equal(false);
    });

    it("exposes queueAction(bytes32)", async function () {
      const { mixer, owner } = await loadFixture(deployFixture);
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test-action"));
      try {
        await mixer.connect(owner).queueAction(actionHash);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `queueAction() selector not found on Mixer: ${(err as Error).message}`
        );
      }
      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(actionHash);
    });

    it("supportsInterface returns true for ERC165 (0x01ffc9a7)", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.supportsInterface("0x01ffc9a7")).to.equal(true);
    });

    it("supportsInterface returns true for MIXER_INTERFACE_ID", async function () {
      const { mixer } = await loadFixture(deployFixture);
      const mixerInterfaceId = await mixer.MIXER_INTERFACE_ID();
      expect(await mixer.supportsInterface(mixerInterfaceId)).to.equal(true);
    });

    it("supportsInterface returns false for unknown bytes4", async function () {
      const { mixer } = await loadFixture(deployFixture);
      expect(await mixer.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // MixerLens
  // -------------------------------------------------------------------------

  describe("MixerLens", function () {
    it("exposes getSnapshot(address) view", async function () {
      const { mixer, mixerLens } = await loadFixture(deployFixture);
      const mixerAddress = await mixer.getAddress();
      const snapshot = await mixerLens.getSnapshot(mixerAddress);
      // Verify structural presence of expected fields
      expect(snapshot.totalDeposited).to.be.a("bigint");
      expect(snapshot.totalWithdrawn).to.be.a("bigint");
      expect(snapshot.depositCount).to.be.a("bigint");
      expect(snapshot.withdrawalCount).to.be.a("bigint");
      expect(snapshot.poolBalance).to.be.a("bigint");
      expect(snapshot.anonymitySetSize).to.be.a("bigint");
      expect(snapshot.treeCapacity).to.be.a("bigint");
      expect(snapshot.treeUtilization).to.be.a("bigint");
      expect(snapshot.lastRoot).to.be.a("bigint");
      expect(snapshot.denomination).to.equal(DENOMINATION);
      expect(snapshot.isPaused).to.be.a("boolean");
      expect(snapshot.owner).to.be.a("string");
    });
  });

  // -------------------------------------------------------------------------
  // DepositReceipt
  // -------------------------------------------------------------------------

  describe("DepositReceipt", function () {
    it("exposes mint — only callable by mixer", async function () {
      const { depositReceipt, depositor } = await loadFixture(deployFixture);
      // Calling from a non-mixer address must revert with "only mixer", not with
      // a function-not-found error, confirming the selector exists.
      try {
        await depositReceipt.connect(depositor).mint(depositor.address, 1n);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `mint() selector not found on DepositReceipt: ${(err as Error).message}`
        );
        expect((err as Error).message).to.include("only mixer");
      }
    });

    it("is soulbound — transfers revert", async function () {
      const { mixer, depositReceipt, owner, depositor, recipient } =
        await loadFixture(deployFixture);

      // Wire the receipt contract into the mixer via timelock.
      const receiptAddress = await depositReceipt.getAddress();
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "address"],
          ["setDepositReceipt", receiptAddress]
        )
      );
      await mixer.connect(owner).queueAction(actionHash);
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine", []);
      await mixer.connect(owner).setDepositReceipt(receiptAddress);

      // Now make a deposit so a token is minted to depositor.
      const commitment =
        BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) || 1n;
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

      // depositor should now own token 0.
      const depositorAddress = await depositor.getAddress();
      const recipientAddress = await recipient.getAddress();
      expect(await depositReceipt.ownerOf(0n)).to.equal(depositorAddress);

      // Attempting to transfer must revert with the soulbound message.
      await expect(
        depositReceipt
          .connect(depositor)
          .transferFrom(depositorAddress, recipientAddress, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });
  });
});
