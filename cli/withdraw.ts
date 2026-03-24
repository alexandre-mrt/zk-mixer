import "dotenv/config";
import path from "path";
import { Command } from "commander";
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
        const privateKey = resolvePrivateKey(opts.key);
        const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
        const mixerAbi = loadMixerAbi();
        const fee = BigInt(opts.fee);
        const relayer = opts.relayer;

        // 1. Parse note
        console.log("Parsing note...");
        const note = await parseNote(opts.note);
        console.log(`Commitment:    ${toHex(note.commitment)}`);
        console.log(`NullifierHash: ${toHex(note.nullifierHash)}`);

        // 2. Check the nullifier has not already been spent
        const { contract: readContract, provider } = getMixerContractReadOnly(
          opts.rpc,
          mixerAddress,
          mixerAbi
        );
        const alreadySpent: boolean = await readContract.nullifierHashes(
          note.nullifierHash.toString()
        );
        if (alreadySpent) {
          throw new Error("This note has already been spent (nullifier hash is known to the contract).");
        }

        // 3. Build Merkle tree from on-chain Deposit events
        console.log("Fetching deposit history and building Merkle tree...");
        const tree = await buildMerkleTree(provider, mixerAddress, mixerAbi);

        // 4. Find leaf index for our commitment
        const leafIndex = tree.leaves.findIndex((l) => l === note.commitment);
        if (leafIndex === -1) {
          throw new Error(
            `Commitment ${toHex(note.commitment)} not found in on-chain deposits. ` +
            "Make sure you are connected to the correct network and mixer address."
          );
        }
        console.log(`Commitment found at leaf index: ${leafIndex}`);

        // 5. Get Merkle proof
        const { pathElements, pathIndices } = tree.getProof(leafIndex);
        const merkleRoot = tree.getRoot();
        console.log(`Merkle root: ${toHex(merkleRoot)}`);

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
        console.log("Generating ZK proof (this may take a moment)...");
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
        console.log(`Submitting withdrawal to ${opts.recipient}...`);

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

        console.log(`Transaction sent: ${tx.hash}`);
        console.log("Waiting for confirmation...");

        const receipt = await tx.wait();

        console.log("\n====================================================");
        console.log("WITHDRAWAL SUCCESSFUL");
        console.log("====================================================");
        console.log(`Block:      ${receipt?.blockNumber}`);
        console.log(`Tx hash:    ${receipt?.hash ?? tx.hash}`);
        console.log(`Recipient:  ${opts.recipient}`);
        if (fee > 0n) {
          console.log(`Relayer:    ${relayer}`);
          console.log(`Fee:        ${fee.toString()} wei`);
        }
        console.log("====================================================");
      } catch (err) {
        console.error("Withdrawal failed:", (err as Error).message);
        process.exit(1);
      }
    }
  );
