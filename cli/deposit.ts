import "dotenv/config";
import { Command } from "commander";
import { loadMixerAbi, loadDeploymentAddress, DENOMINATION, DEFAULT_RPC_URL } from "./config";
import {
  generateNote,
  encodeNote,
  getMixerContract,
  resolveMixerAddress,
  resolvePrivateKey,
  saveNote,
  toHex,
} from "./utils";

export const depositCommand = new Command("deposit")
  .description("Deposit 0.1 ETH into the mixer and receive a withdrawal note")
  .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
  .option("--key <privateKey>", "Depositor private key (or set PRIVATE_KEY in .env)")
  .option("--mixer <address>", "Mixer contract address (or auto-read from deployment.json)")
  .action(async (opts: { rpc: string; key?: string; mixer?: string }) => {
    try {
      const privateKey = resolvePrivateKey(opts.key);
      const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
      const mixerAbi = loadMixerAbi();

      console.log("Generating note...");
      const note = await generateNote();
      const noteString = encodeNote(note);

      const contract = getMixerContract(opts.rpc, privateKey, mixerAddress, mixerAbi);
      const denomination = await contract.denomination() as bigint;

      console.log(`Depositing ${DENOMINATION} ETH to mixer at ${mixerAddress}...`);

      const tx = await contract.deposit(note.commitment.toString(), {
        value: denomination,
      });

      console.log(`Transaction sent: ${tx.hash}`);
      console.log("Waiting for confirmation...");

      const receipt = await tx.wait();

      // Parse the Deposit event to get leafIndex and timestamp
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const depositLog = receipt?.logs?.find((log: any) => {
        try {
          const parsed = contract.interface.parseLog(log);
          return parsed?.name === "Deposit";
        } catch {
          return false;
        }
      });

      let leafIndex = -1;
      let timestamp = Math.floor(Date.now() / 1000);

      if (depositLog) {
        const parsed = contract.interface.parseLog(depositLog);
        leafIndex = Number(parsed?.args?.leafIndex ?? -1);
        timestamp = Number(parsed?.args?.timestamp ?? timestamp);
      }

      const savedPath = saveNote({
        ...note,
        txHash: receipt?.hash ?? tx.hash,
        leafIndex,
        timestamp,
      });

      console.log("\n====================================================");
      console.log("DEPOSIT SUCCESSFUL");
      console.log("====================================================");
      console.log(`Block:       ${receipt?.blockNumber}`);
      console.log(`Tx hash:     ${receipt?.hash ?? tx.hash}`);
      console.log(`Leaf index:  ${leafIndex}`);
      console.log(`Commitment:  ${toHex(note.commitment)}`);
      console.log("\n*** SAVE THIS NOTE — IT IS YOUR WITHDRAWAL KEY ***");
      console.log(`\n  ${noteString}\n`);
      console.log("*** LOSING THIS NOTE MEANS LOSING YOUR FUNDS ***");
      console.log("====================================================");
      console.log(`\nNote also saved to: ${savedPath}`);
    } catch (err) {
      console.error("Deposit failed:", (err as Error).message);
      process.exit(1);
    }
  });
