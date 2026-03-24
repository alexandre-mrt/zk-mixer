import "dotenv/config";
import { Command } from "commander";
import { ethers } from "ethers";
import { loadMixerAbi, loadDeploymentAddress, DENOMINATION, DEFAULT_RPC_URL } from "./config";
import {
  generateNote,
  encodeNote,
  getMixerContract,
  resolveMixerAddress,
  resolvePrivateKey,
  saveNote,
  toHex,
  log,
} from "./utils";

export const depositCommand = new Command("deposit")
  .description("Deposit 0.1 ETH into the mixer and receive a withdrawal note")
  .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
  .option("--key <privateKey>", "Depositor private key (or set PRIVATE_KEY in .env)")
  .option("--mixer <address>", "Mixer contract address (or auto-read from deployment.json)")
  .addHelpText("after", `
Examples:
  $ zk-mixer deposit --key 0x... --mixer 0x...
  $ zk-mixer deposit --key 0x... (reads mixer address from deployment.json)
`)
  .action(async (opts: { rpc: string; key?: string; mixer?: string }) => {
    try {
      if (opts.mixer !== undefined && !ethers.isAddress(opts.mixer)) {
        throw new Error(`Invalid mixer address: "${opts.mixer}"`);
      }

      const privateKey = resolvePrivateKey(opts.key);
      const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
      const mixerAbi = loadMixerAbi();

      log.info("Generating note...");
      const note = await generateNote();
      const noteString = encodeNote(note);

      let contract;
      try {
        contract = getMixerContract(opts.rpc, privateKey, mixerAddress, mixerAbi);
      } catch (err) {
        throw new Error(`Failed to connect to RPC at ${opts.rpc}: ${(err as Error).message}`);
      }

      const denomination = await contract.denomination() as bigint;

      log.info(`Depositing ${DENOMINATION} ETH to mixer at ${mixerAddress}...`);

      const tx = await contract.deposit(note.commitment.toString(), {
        value: denomination,
      });

      log.step(`Transaction sent: ${tx.hash}`);
      log.step("Waiting for confirmation...");

      const receipt = await tx.wait();

      // Parse the Deposit event to get leafIndex and timestamp
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const depositLog = receipt?.logs?.find((l: any) => {
        try {
          const parsed = contract.interface.parseLog(l);
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
      log.success("DEPOSIT SUCCESSFUL");
      console.log("====================================================");
      log.step(`Block:       ${receipt?.blockNumber}`);
      log.step(`Tx hash:     ${receipt?.hash ?? tx.hash}`);
      log.step(`Leaf index:  ${leafIndex}`);
      log.step(`Commitment:  ${toHex(note.commitment)}`);
      console.log("\n*** SAVE THIS NOTE — IT IS YOUR WITHDRAWAL KEY ***");
      console.log(`\n  ${noteString}\n`);
      console.log("*** LOSING THIS NOTE MEANS LOSING YOUR FUNDS ***");
      console.log("====================================================");
      log.step(`Note also saved to: ${savedPath}`);
    } catch (err) {
      log.error(`Deposit failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
