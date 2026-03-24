import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// Use a shallow tree to keep deployment gas low in tests
const MERKLE_TREE_HEIGHT = 5;

// 0.1 ETH expressed as a BigInt literal — avoids calling ethers.parseEther at module level
// before the Hardhat environment is initialised.
// 0.1 ETH = 100000000000000000 wei = 1e17
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

// BN254 field size — commitments must be strictly less than this
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Proof values — placeholder verifier always returns true, so any values work
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Generate a random field element usable as a commitment.
 * Uses 31 bytes to stay well below FIELD_SIZE (BN254 prime is ~254 bits).
 * Returns a non-zero value.
 */
function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" +
      Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  return {
    mixer,
    verifier,
    hasherAddress,
    owner,
    depositor,
    recipient,
    relayer,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment?: bigint
): Promise<{ commitment: bigint }> {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return { commitment: c };
}

function doWithdraw(
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
// 1. Deployment
// ---------------------------------------------------------------------------

describe("Mixer", function () {
  describe("Deployment", function () {
    it("deploys successfully and stores denomination", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.denomination()).to.equal(DENOMINATION);
    });

    it("stores the configured tree height", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.levels()).to.equal(MERKLE_TREE_HEIGHT);
    });

    it("initialises nextIndex to 0", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.nextIndex()).to.equal(0);
    });

    it("sets an initial non-zero root", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const root = await mixer.getLastRoot();
      expect(root).to.not.equal(0n);
    });

    it("recognises the initial root as known", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const root = await mixer.getLastRoot();
      expect(await mixer.isKnownRoot(root)).to.be.true;
    });

    it("stores the deployment chain ID (31337 for Hardhat)", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.deployedChainId()).to.equal(31337n);
    });

    it("deposit succeeds on the correct chain", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      await expect(
        mixer.connect(depositor).deposit(commitment, { value: DENOMINATION })
      ).to.emit(mixer, "Deposit");
    });

    it("reverts when verifier is the zero address", async function () {
      const { hasherAddress } = await loadFixture(deployMixerFixture);
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(
          ZERO_ADDRESS,
          DENOMINATION,
          MERKLE_TREE_HEIGHT,
          hasherAddress
        )
      ).to.be.revertedWith("Mixer: verifier is zero address");
    });

    it("reverts when denomination is zero", async function () {
      const { hasherAddress, verifier } = await loadFixture(deployMixerFixture);
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          0n,
          MERKLE_TREE_HEIGHT,
          hasherAddress
        )
      ).to.be.revertedWith("Mixer: denomination must be > 0");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Deposit
  // -------------------------------------------------------------------------

  describe("Deposit", function () {
    it("accepts a valid deposit and increments nextIndex", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, depositor);
      expect(await mixer.nextIndex()).to.equal(1);
    });

    it("emits Deposit event for first deposit with leafIndex 0", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      const tx = await mixer
        .connect(depositor)
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
      expect(event!.args.leafIndex).to.equal(0);
    });

    it("records the commitment in the commitments mapping", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const { commitment } = await doDeposit(mixer, depositor);
      expect(await mixer.commitments(commitment)).to.be.true;
    });

    it("changes the Merkle root after deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const rootBefore = await mixer.getLastRoot();
      await doDeposit(mixer, depositor);
      const rootAfter = await mixer.getLastRoot();
      expect(rootAfter).to.not.equal(rootBefore);
    });

    it("reverts when ETH sent is less than denomination", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      await expect(
        mixer
          .connect(depositor)
          .deposit(commitment, { value: DENOMINATION - 1n })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it("reverts when ETH sent is more than denomination", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      await expect(
        mixer
          .connect(depositor)
          .deposit(commitment, { value: DENOMINATION + 1n })
      ).to.be.revertedWith("Mixer: incorrect deposit amount");
    });

    it("reverts on duplicate commitment", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      await mixer
        .connect(depositor)
        .deposit(commitment, { value: DENOMINATION });
      await expect(
        mixer.connect(depositor).deposit(commitment, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: duplicate commitment");
    });

    it("reverts when commitment is zero", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(depositor).deposit(0n, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: commitment is zero");
    });

    it("assigns sequential leaf indices for multiple deposits", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const commitments = [
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
      ];

      for (let i = 0; i < commitments.length; i++) {
        const tx = await mixer
          .connect(depositor)
          .deposit(commitments[i], { value: DENOMINATION });
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
        expect(event!.args.leafIndex).to.equal(i);
      }
      expect(await mixer.nextIndex()).to.equal(3);
    });

    it("increases the contract ETH balance by denomination per deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const addr = await mixer.getAddress();

      await doDeposit(mixer, depositor);
      expect(await ethers.provider.getBalance(addr)).to.equal(DENOMINATION);

      await doDeposit(mixer, depositor);
      expect(await ethers.provider.getBalance(addr)).to.equal(DENOMINATION * 2n);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Merkle tree
  // -------------------------------------------------------------------------

  describe("MerkleTree", function () {
    it("isKnownRoot returns true for the current root after a deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, depositor);
      const root = await mixer.getLastRoot();
      expect(await mixer.isKnownRoot(root)).to.be.true;
    });

    it("isKnownRoot returns false for an arbitrary unknown root", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.isKnownRoot(12345678901234567890n)).to.be.false;
    });

    it("isKnownRoot returns false for zero", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.isKnownRoot(0n)).to.be.false;
    });

    it("previous root remains known after subsequent deposit (within ROOT_HISTORY_SIZE)", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);

      await doDeposit(mixer, depositor);
      const rootAfterFirst = await mixer.getLastRoot();

      await doDeposit(mixer, depositor);
      const rootAfterSecond = await mixer.getLastRoot();

      expect(rootAfterFirst).to.not.equal(rootAfterSecond);
      expect(await mixer.isKnownRoot(rootAfterFirst)).to.be.true;
      expect(await mixer.isKnownRoot(rootAfterSecond)).to.be.true;
    });

    it("getLastRoot changes after each deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const r0 = await mixer.getLastRoot();
      await doDeposit(mixer, depositor);
      const r1 = await mixer.getLastRoot();
      await doDeposit(mixer, depositor);
      const r2 = await mixer.getLastRoot();

      expect(r0).to.not.equal(r1);
      expect(r1).to.not.equal(r2);
    });

    it("hashLeftRight is deterministic for the same inputs", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const h1 = await mixer.hashLeftRight(1n, 2n);
      const h2 = await mixer.hashLeftRight(1n, 2n);
      expect(h1).to.equal(h2);
    });

    it("hashLeftRight reverts when left is >= FIELD_SIZE", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      await expect(mixer.hashLeftRight(FIELD_SIZE, 0n)).to.be.revertedWith(
        "MerkleTree: left overflow"
      );
    });

    it("hashLeftRight reverts when right is >= FIELD_SIZE", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      await expect(mixer.hashLeftRight(0n, FIELD_SIZE)).to.be.revertedWith(
        "MerkleTree: right overflow"
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Withdrawal
  // -------------------------------------------------------------------------

  describe("Withdrawal", function () {
    /**
     * Deposit once and return the current root + a fresh nullifier hash.
     * The nullifier hash is independent of the commitment in this placeholder
     * setup because the verifier always returns true.
     */
    async function fundAndGetWithdrawParams(
      mixer: Mixer,
      depositor: Signer
    ): Promise<{ root: bigint; nullifierHash: bigint }> {
      await doDeposit(mixer, depositor);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      return { root, nullifierHash };
    }

    it("transfers denomination to recipient on successful withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      const balanceBefore = await ethers.provider.getBalance(recipientAddr);
      // Use owner as the tx sender so recipient gas cost is zero
      const [owner] = await ethers.getSigners();
      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipientAddr,
        relayerAddr,
        0n,
        owner
      );
      const balanceAfter = await ethers.provider.getBalance(recipientAddr);

      expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    });

    it("emits Withdrawal event with correct arguments", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await expect(
        doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n)
      )
        .to.emit(mixer, "Withdrawal")
        .withArgs(recipientAddr, nullifierHash, relayerAddr, 0n);
    });

    it("marks nullifierHash as spent after withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);
      expect(await mixer.nullifierHashes(nullifierHash)).to.be.true;
    });

    it("distributes fee correctly between recipient and relayer", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();
      const fee = 10_000_000_000_000_000n; // 0.01 ETH

      const recipientBefore = await ethers.provider.getBalance(recipientAddr);
      const relayerBefore = await ethers.provider.getBalance(relayerAddr);

      // Use owner (index 0) as caller so recipient/relayer pay no gas
      const [owner] = await ethers.getSigners();
      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipientAddr,
        relayerAddr,
        fee,
        owner
      );

      const recipientAfter = await ethers.provider.getBalance(recipientAddr);
      const relayerAfter = await ethers.provider.getBalance(relayerAddr);

      expect(recipientAfter - recipientBefore).to.equal(DENOMINATION - fee);
      expect(relayerAfter - relayerBefore).to.equal(fee);
    });

    it("decreases contract balance by denomination on withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const mixerAddr = await mixer.getAddress();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      const balanceBefore = await ethers.provider.getBalance(mixerAddr);
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);
      const balanceAfter = await ethers.provider.getBalance(mixerAddr);

      expect(balanceBefore - balanceAfter).to.equal(DENOMINATION);
    });

    it("reverts on double-spend (already spent nullifier)", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      // Second deposit to refund the contract
      await doDeposit(mixer, depositor);
      const root2 = await mixer.getLastRoot();

      await expect(
        doWithdraw(mixer, root2, nullifierHash, recipientAddr, relayerAddr, 0n)
      ).to.be.revertedWith("Mixer: already spent");
    });

    it("reverts when root is not in history", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      await doDeposit(mixer, depositor); // fund the contract
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();
      const fakeRoot = 999999999999999999n;
      const nullifierHash = randomCommitment();

      await expect(
        doWithdraw(mixer, fakeRoot, nullifierHash, recipientAddr, relayerAddr, 0n)
      ).to.be.revertedWith("Mixer: unknown root");
    });

    it("reverts when fee exceeds denomination", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await expect(
        doWithdraw(
          mixer,
          root,
          nullifierHash,
          recipientAddr,
          relayerAddr,
          DENOMINATION + 1n
        )
      ).to.be.revertedWith("Mixer: fee exceeds denomination");
    });

    it("reverts when recipient is the zero address", async function () {
      const { mixer, depositor, relayer } = await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const relayerAddr = await relayer.getAddress();

      await expect(
        doWithdraw(
          mixer,
          root,
          nullifierHash,
          ZERO_ADDRESS,
          relayerAddr,
          0n
        )
      ).to.be.revertedWith("Mixer: recipient is zero address");
    });

    it("reverts when fee > 0 and relayer is the zero address", async function () {
      const { mixer, depositor, recipient } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const fee = 10_000_000_000_000_000n; // 0.01 ETH

      await expect(
        doWithdraw(
          mixer,
          root,
          nullifierHash,
          recipientAddr,
          ZERO_ADDRESS,
          fee
        )
      ).to.be.revertedWith("Mixer: relayer is zero address for non-zero fee");
    });

    it("accepts fee == denomination (full fee to relayer)", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await fundAndGetWithdrawParams(
        mixer,
        depositor
      );
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      // fee == denomination means recipient gets 0, relayer gets all
      await expect(
        doWithdraw(
          mixer,
          root,
          nullifierHash,
          recipientAddr,
          relayerAddr,
          DENOMINATION
        )
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // 5. View / Getter functions
  // -------------------------------------------------------------------------

  describe("View functions", function () {
    it("isSpent returns false before withdrawal", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const nullifierHash = randomCommitment();
      expect(await mixer.isSpent(nullifierHash)).to.be.false;
    });

    it("isSpent returns true after withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const { root, nullifierHash } = await (async () => {
        await doDeposit(mixer, depositor);
        const root = await mixer.getLastRoot();
        const nullifierHash = randomCommitment();
        return { root, nullifierHash };
      })();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);
      expect(await mixer.isSpent(nullifierHash)).to.be.true;
    });

    it("isCommitted returns false before deposit", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      expect(await mixer.isCommitted(commitment)).to.be.false;
    });

    it("isCommitted returns true after deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      const { commitment } = await doDeposit(mixer, depositor);
      expect(await mixer.isCommitted(commitment)).to.be.true;
    });

    it("getDepositCount returns 0 before any deposit", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.getDepositCount()).to.equal(0);
    });

    it("getDepositCount increments with each deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, depositor);
      expect(await mixer.getDepositCount()).to.equal(1);
      await doDeposit(mixer, depositor);
      expect(await mixer.getDepositCount()).to.equal(2);
    });

    it("getDepositCount matches nextIndex", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, depositor);
      await doDeposit(mixer, depositor);
      expect(await mixer.getDepositCount()).to.equal(await mixer.nextIndex());
    });
  });

  // -------------------------------------------------------------------------
  // 6. Cumulative Stats
  // -------------------------------------------------------------------------

  describe("Cumulative Stats", function () {
    it("totalDeposited starts at 0", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.totalDeposited()).to.equal(0n);
    });

    it("totalWithdrawn starts at 0", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.totalWithdrawn()).to.equal(0n);
    });

    it("withdrawalCount starts at 0", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.withdrawalCount()).to.equal(0n);
    });

    it("totalDeposited increases by denomination per deposit", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, depositor);
      expect(await mixer.totalDeposited()).to.equal(DENOMINATION);
      await doDeposit(mixer, depositor);
      expect(await mixer.totalDeposited()).to.equal(DENOMINATION * 2n);
    });

    it("totalWithdrawn increases by denomination per withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doDeposit(mixer, depositor);
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const [owner] = await ethers.getSigners();
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n, owner);

      expect(await mixer.totalWithdrawn()).to.equal(DENOMINATION);
    });

    it("withdrawalCount increments with each withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();
      const [owner] = await ethers.getSigners();

      // First withdrawal
      await doDeposit(mixer, depositor);
      const root1 = await mixer.getLastRoot();
      const nullifier1 = randomCommitment();
      await doWithdraw(mixer, root1, nullifier1, recipientAddr, relayerAddr, 0n, owner);
      expect(await mixer.withdrawalCount()).to.equal(1n);

      // Second withdrawal
      await doDeposit(mixer, depositor);
      const root2 = await mixer.getLastRoot();
      const nullifier2 = randomCommitment();
      await doWithdraw(mixer, root2, nullifier2, recipientAddr, relayerAddr, 0n, owner);
      expect(await mixer.withdrawalCount()).to.equal(2n);
    });

    it("getStats returns correct values after deposit + withdraw cycle", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();
      const mixerAddr = await mixer.getAddress();
      const [owner] = await ethers.getSigners();

      // Deposit twice
      await doDeposit(mixer, depositor);
      await doDeposit(mixer, depositor);

      // Withdraw once
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n, owner);

      const [
        _totalDeposited,
        _totalWithdrawn,
        _depositCount,
        _withdrawalCount,
        _poolBalance,
      ] = await mixer.getStats();

      expect(_totalDeposited).to.equal(DENOMINATION * 2n);
      expect(_totalWithdrawn).to.equal(DENOMINATION);
      expect(_depositCount).to.equal(2n);
      expect(_withdrawalCount).to.equal(1n);
      expect(_poolBalance).to.equal(await ethers.provider.getBalance(mixerAddr));
    });
  });

  // -------------------------------------------------------------------------
  // 7. Integration
  // -------------------------------------------------------------------------

  describe("Integration", function () {
    it("full deposit-then-withdraw flow leaves contract with zero balance", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      await mixer
        .connect(depositor)
        .deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      expect(
        await ethers.provider.getBalance(await mixer.getAddress())
      ).to.equal(0n);
    });

    it("multiple deposits then single withdrawal leaves correct balance", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      for (let i = 0; i < 3; i++) {
        await doDeposit(mixer, depositor);
      }
      expect(
        await ethers.provider.getBalance(await mixer.getAddress())
      ).to.equal(DENOMINATION * 3n);

      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      expect(
        await ethers.provider.getBalance(await mixer.getAddress())
      ).to.equal(DENOMINATION * 2n);
    });

    it("each nullifier can only be used once across multiple deposits", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      await doDeposit(mixer, depositor);
      await doDeposit(mixer, depositor);

      const root = await mixer.getLastRoot();
      const nullifierHash = randomCommitment();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, 0n);

      await doDeposit(mixer, depositor);
      const root2 = await mixer.getLastRoot();

      await expect(
        doWithdraw(mixer, root2, nullifierHash, recipientAddr, relayerAddr, 0n)
      ).to.be.revertedWith("Mixer: already spent");
    });

    it("a root from within ROOT_HISTORY_SIZE remains usable for withdrawal", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      await doDeposit(mixer, depositor);
      const rootAfterFirst = await mixer.getLastRoot();

      // Add 5 more deposits — well within the 30-root ring buffer
      for (let i = 0; i < 5; i++) {
        await doDeposit(mixer, depositor);
      }

      expect(await mixer.isKnownRoot(rootAfterFirst)).to.be.true;

      const nullifierHash = randomCommitment();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await expect(
        doWithdraw(
          mixer,
          rootAfterFirst,
          nullifierHash,
          recipientAddr,
          relayerAddr,
          0n
        )
      ).to.not.be.reverted;
    });

    it("two independent withdrawals from the same tree succeed", async function () {
      const { mixer, depositor, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      // Two deposits
      await doDeposit(mixer, depositor);
      await doDeposit(mixer, depositor);
      const root = await mixer.getLastRoot();

      const n1 = randomCommitment();
      const n2 = randomCommitment();
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = await relayer.getAddress();

      await doWithdraw(mixer, root, n1, recipientAddr, relayerAddr, 0n);
      await doWithdraw(mixer, root, n2, recipientAddr, relayerAddr, 0n);

      expect(
        await ethers.provider.getBalance(await mixer.getAddress())
      ).to.equal(0n);
    });
  });
});
