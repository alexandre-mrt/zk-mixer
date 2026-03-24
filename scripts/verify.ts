import { run } from "hardhat";
import fs from "fs";

async function main(): Promise<void> {
  if (!fs.existsSync("deployment.json")) {
    console.error("deployment.json not found. Run deploy script first.");
    process.exit(1);
  }
  const addresses = JSON.parse(fs.readFileSync("deployment.json", "utf-8"));

  // Verify Groth16Verifier
  try {
    console.log("Verifying Groth16Verifier...");
    await run("verify:verify", { address: addresses.verifier, constructorArguments: [] });
    console.log("Verified!\n");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(msg.includes("Already Verified") ? "Already verified.\n" : `Failed: ${msg}\n`);
  }

  // Verify Mixer
  try {
    console.log("Verifying Mixer...");
    await run("verify:verify", {
      address: addresses.mixer,
      constructorArguments: [
        addresses.verifier,
        addresses.denomination || "100000000000000000",
        addresses.merkleTreeHeight || 20,
        addresses.hasher,
      ],
    });
    console.log("Verified!\n");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(msg.includes("Already Verified") ? "Already verified.\n" : `Failed: ${msg}\n`);
  }
}

main().catch(console.error);
