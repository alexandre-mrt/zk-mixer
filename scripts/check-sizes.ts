import fs from "fs";
import path from "path";

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "contracts");
const MAX_SIZE = 24576; // 24KB EVM limit

function getContractSize(artifactPath: string): number {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as {
    deployedBytecode?: string;
  };
  const bytecode = artifact.deployedBytecode;
  if (!bytecode || bytecode === "0x") return 0;
  return (bytecode.length - 2) / 2; // remove 0x prefix, each byte = 2 hex chars
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (
      entry.name.endsWith(".json") &&
      !entry.name.endsWith(".dbg.json")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

const artifacts = walkDir(ARTIFACTS_DIR);
let hasOversize = false;

console.log("\nContract Sizes:");
console.log("-".repeat(60));

for (const artifact of artifacts) {
  const size = getContractSize(artifact);
  if (size === 0) continue;

  const name = path.basename(artifact, ".json");
  const pct = ((size / MAX_SIZE) * 100).toFixed(1);
  const status =
    size > MAX_SIZE ? "OVER" : size > MAX_SIZE * 0.9 ? "WARN" : "OK";

  if (status === "OVER") hasOversize = true;

  const icon = status === "OVER" ? "x" : status === "WARN" ? "!" : "v";
  console.log(
    `  ${icon} ${name.padEnd(30)} ${size.toLocaleString().padStart(8)} bytes (${pct}%)`,
  );
}

console.log("-".repeat(60));
console.log(`  Limit: ${MAX_SIZE.toLocaleString()} bytes (24 KB)\n`);

if (hasOversize) {
  console.error("ERROR: Some contracts exceed the 24KB EVM limit!");
  process.exit(1);
}
