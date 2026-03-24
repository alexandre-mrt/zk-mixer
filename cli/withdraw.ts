import "dotenv/config";
import path from "path";
import { Command } from "commander";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";
import { loadMixerAbi, loadDeploymentAddress, DEFAULT_RPC_URL } from "./config";
import {
  parseNote,
  buildMerkleTree,
  generateProof,
  parseCallData,
  getMixerContract,
  getMixerContractReadOnly,
  resolveMixerAddress,
  resolvePrivateKey,
  toHex,
  log,
} from "./utils";

const WASM_PATH = path.resolve("build/circuits/withdraw_js/withdraw.wasm");
const ZKEY_PATH = path.resolve("build/circuits/withdraw_final.zkey");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const withdrawCommand = new Command("withdraw")
  .description("Withdraw from the mixer using a previously generated note")
  .requiredOption("--note <noteString>", "Note string from the deposit command")
  .requiredOption("--recipient <address>", "Address to receive ETH")
  .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
  .option("--key <privateKey>", "Withdrawer private key (or set PRIVATE_KEY in .env)")
  .option("--mixer <address>", "Mixer contract address (or auto-read from deployment.json)")
  .option("--relayer <address>", "Relayer address", ZERO_ADDRESS)
  .option("--fee <wei>", "Relayer fee in wei", "0")
  .addHelpText("after", `
Examples:
  $ zk-mixer withdraw --note zk-mixer-<secret>-<nullifier> --recipient 0x... --key 0x...
  $ zk-mixer withdraw --note zk-mixer-<secret>-<nullifier> --recipient 0x... (reads mixer address from deployment.json)
`)
  .action(
    async (opts: {
      note: string;
      recipient: string;
      rpc: string;
      key?: string;
      mixer?: string;
      relayer: string;
      fee: string;
    }) => {
      try {
        // Validate addresses before any heavy operations
        if (!ethers.isAddress(opts.recipient)) {
          throw new Error(`Invalid recipient address: "${opts.recipient}"`);
        }
        if (opts.mixer !== undefined && !ethers.isAddress(opts.mixer)) {
          throw new Error(`Invalid mixer address: "${opts.mixer}"`);
        }
        if (opts.relayer !== ZERO_ADDRESS && !ethers.isAddress(opts.relayer)) {
          throw new Error(`Invalid relayer address: "${opts.relayer}"`);
        }

        // Validate note format before attempting to parse
        const noteParts = opts.note.trim().split("-");
        if (
          noteParts.length !== 4 ||
          noteParts[0] !== "zk" ||
          noteParts[1] !== "mixer" ||
          !/^[0-9a-f]{64}$/.test(noteParts[2]) ||
          !/^[0-9a-f]{64}$/.test(noteParts[3])
        ) {
          throw new Error(
            "Invalid note format. Expected: zk-mixer-<secret_hex>-<nullifier_hex>"
          );
        }

        const privateKey = resolvePrivateKey(opts.key);
        const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
        const mixerAbi = loadMixerAbi();
        const fee = BigInt(opts.fee);
        const relayer = opts.relayer;

        // 1. Parse note
        log.info("Parsing note...");
        const note = await parseNote(opts.note);
        log.step(`Commitment:    ${toHex(note.commitment)}`);
        log.step(`NullifierHash: ${toHex(note.nullifierHash)}`);

        // 2. Check the nullifier has not already been spent
        let readContract: ReturnType<typeof getMixerContractReadOnly>["contract"];
        let provider: ReturnType<typeof getMixerContractReadOnly>["provider"];
        try {
          const result = getMixerContractReadOnly(opts.rpc, mixerAddress, mixerAbi);
          readContract = result.contract;
          provider = result.provider;
        } catch (err) {
          throw new Error(`Failed to connect to RPC at ${opts.rpc}: ${(err as Error).message}`);
        }

        const alreadySpent: boolean = await readContract.nullifierHashes(
          note.nullifierHash.toString()
        );
        if (alreadySpent) {
          throw new Error("This note has already been spent (nullifier hash is known to the contract).");
        }

        // 3. Build Merkle tree from on-chain Deposit events
        log.info("Fetching deposit history and building Merkle tree...");
        const tree = await buildMerkleTree(provider, mixerAddress, mixerAbi);

        // 4. Find leaf index for our commitment
        const leafIndex = tree.leaves.findIndex((l) => l === note.commitment);
        if (leafIndex === -1) {
          throw new Error(
            `Commitment ${toHex(note.commitment)} not found in on-chain deposits. ` +
            "Make sure you are connected to the correct network and mixer address."
          );
        }
        log.step(`Commitment found at leaf index: ${leafIndex}`);

        // 5. Get Merkle proof
        const { pathElements, pathIndices } = tree.getProof(leafIndex);
        const merkleRoot = tree.getRoot();
        log.step(`Merkle root: ${toHex(merkleRoot)}`);

        // 6. Prepare circuit input
        // recipient and relayer are encoded as bigint (uint160 of the address)
        const recipientBigInt = BigInt(opts.recipient);
        const relayerBigInt = BigInt(relayer);

        const circuitInput = {
          root: merkleRoot.toString(),
          nullifierHash: note.nullifierHash.toString(),
          recipient: recipientBigInt.toString(),
          relayer: relayerBigInt.toString(),
          fee: fee.toString(),
          secret: note.secret.toString(),
          nullifier: note.nullifier.toString(),
          pathElements: pathElements.map((e) => e.toString()),
          pathIndices: pathIndices.map((i) => i.toString()),
        };

        // 7. Generate Groth16 proof
        log.info("Generating ZK proof (this may take a moment)...");
        const { proof, publicSignals } = await generateProof(
          circuitInput,
          WASM_PATH,
          ZKEY_PATH
        );

        // 8. Format proof for contract call
        const calldata = await snarkjs.groth16.exportSolidityCallData(
          proof,
          publicSignals
        );
        const { pA, pB, pC } = parseCallData(calldata);

        // 9. Submit withdrawal transaction
        const contract = getMixerContract(opts.rpc, privateKey, mixerAddress, mixerAbi);
        log.info(`Submitting withdrawal to ${opts.recipient}...`);

        const tx = await contract.withdraw(
          [pA[0].toString(), pA[1].toString()],
          [
            [pB[0][0].toString(), pB[0][1].toString()],
            [pB[1][0].toString(), pB[1][1].toString()],
          ],
          [pC[0].toString(), pC[1].toString()],
          merkleRoot.toString(),
          note.nullifierHash.toString(),
          opts.recipient,
          relayer,
          fee.toString()
        );

        log.step(`Transaction sent: ${tx.hash}`);
        log.step("Waiting for confirmation...");

        const receipt = await tx.wait();

        console.log("\n====================================================");
        log.success("WITHDRAWAL SUCCESSFUL");
        console.log("====================================================");
        log.step(`Block:      ${receipt?.blockNumber}`);
        log.step(`Tx hash:    ${receipt?.hash ?? tx.hash}`);
        log.step(`Recipient:  ${opts.recipient}`);
        if (fee > 0n) {
          log.step(`Relayer:    ${relayer}`);
          log.step(`Fee:        ${fee.toString()} wei`);
        }
        console.log("====================================================");
      } catch (err) {
        log.error(`Withdrawal failed: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  );
