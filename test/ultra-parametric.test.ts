import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const CAPACITY = 2 ** MERKLE_TREE_HEIGHT; // 32
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const [owner, user1, user2, recipient, relayer] = await ethers.getSigners();
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

  return { mixer, owner, user1, user2, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function doDeposit(
  mixer: Mixer,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  commitment: bigint
): Promise<void> {
  await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipientAddr: string,
  relayerAddr: string,
  fee: bigint
): Promise<void> {
  await mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipientAddr as `0x${string}`,
    relayerAddr as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Ultra Parametric
// ---------------------------------------------------------------------------

describe("Ultra Parametric", function () {
  // -------------------------------------------------------------------------
  // 40 deposit + verify + receipt cycles
  // -------------------------------------------------------------------------

  for (let i = 0; i < 40; i++) {
    it(`cycle #${i}: deposit + verify commitment + check receipt`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const commitment = BigInt(i + 1) * 317n + BigInt(i) * 2200n + 50_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
      expect(await mixer.getCommitmentIndex(commitment)).to.equal(0);
      expect(await mixer.getLastRoot()).to.not.equal(0n);
    });
  }

  // -------------------------------------------------------------------------
  // 30 withdrawal balance accounting checks
  // d deposits, w withdrawals: balance == (d - w) * denomination
  // -------------------------------------------------------------------------

  for (let d = 1; d <= 10; d++) {
    for (let w = 0; w <= Math.min(d, 2); w++) {
      it(`${d} deposits, ${w} withdrawals: balance == ${d - w} * denom`, async function () {
        const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);
        const recipientAddr = await recipient.getAddress();

        for (let k = 0; k < d; k++) {
          const c = BigInt(k + 1) * 331n + BigInt(d) * 1100n + BigInt(w) * 700n + 51_000_000n;
          await doDeposit(mixer, user1, c);
        }

        for (let j = 0; j < w; j++) {
          const root = await mixer.getLastRoot();
          const nullifierHash = BigInt(j + 1) * 337n + BigInt(d) * 900n + BigInt(w) * 500n + 52_000_000n;
          await doWithdraw(mixer, root, nullifierHash, recipientAddr, ethers.ZeroAddress, 0n);
        }

        const contractBalance = await ethers.provider.getBalance(await mixer.getAddress());
        expect(contractBalance).to.equal(DENOMINATION * BigInt(d - w));
      });
    }
  }

  // -------------------------------------------------------------------------
  // 30 root tracking after N deposits
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 30; n++) {
    it(`after ${n} deposits: getLastRoot is non-zero and in history`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let k = 0; k < n; k++) {
        const c = BigInt(k + 1) * 347n + BigInt(n) * 1300n + 53_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const lastRoot = await mixer.getLastRoot();
      expect(lastRoot).to.not.equal(0n);
      expect(await mixer.isKnownRoot(lastRoot)).to.be.true;
    });
  }
});
