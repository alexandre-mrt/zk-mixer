import { useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useContractEvents,
} from "wagmi";
import { isAddress } from "viem";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseNote, computeCommitment, computeNullifierHash } from "@/lib/crypto";
import { buildTreeFromLeaves } from "@/lib/merkle-tree";
import { generateWithdrawalProof } from "@/lib/proof";
import { MIXER_ABI, getMixerAddress, DEPLOY_BLOCK } from "@/lib/constants";

type WithdrawStep =
  | "idle"
  | "parsing"
  | "building-tree"
  | "generating-proof"
  | "submitting"
  | "success"
  | "error";

const STEP_LABELS: Record<WithdrawStep, string> = {
  idle: "",
  parsing: "Parsing note...",
  "building-tree": "Building Merkle tree from deposit history...",
  "generating-proof": "Generating zero-knowledge proof (this may take 10-30s)...",
  submitting: "Submitting withdrawal transaction...",
  success: "Withdrawal complete!",
  error: "Error",
};

export function WithdrawCard() {
  const { isConnected } = useAccount();
  const [noteInput, setNoteInput] = useState("");
  const [recipientInput, setRecipientInput] = useState("");
  const [step, setStep] = useState<WithdrawStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync } = useWriteContract();

  const { isLoading: isWaiting, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  const { data: depositEvents } = useContractEvents({
    address: getMixerAddress(),
    abi: MIXER_ABI,
    eventName: "Deposit",
    fromBlock: DEPLOY_BLOCK,
  });

  const handleWithdraw = async () => {
    if (!isConnected) {
      setError("Please connect your wallet first.");
      return;
    }

    const recipient = recipientInput.trim();
    if (!isAddress(recipient)) {
      setError("Please enter a valid recipient address.");
      return;
    }

    if (!noteInput.trim()) {
      setError("Please enter your note string.");
      return;
    }

    try {
      setError(null);

      // Step 1: Parse note
      setStep("parsing");
      const { secret, nullifier } = parseNote(noteInput.trim());
      const commitment = await computeCommitment(secret, nullifier);
      const nullifierHash = await computeNullifierHash(nullifier);

      // Step 2: Build Merkle tree from on-chain events
      setStep("building-tree");

      const sortedEvents = depositEvents
        ? [...depositEvents].sort((a, b) => {
            const aIndex = Number(
              (a.args as { leafIndex?: number }).leafIndex ?? 0,
            );
            const bIndex = Number(
              (b.args as { leafIndex?: number }).leafIndex ?? 0,
            );
            return aIndex - bIndex;
          })
        : [];

      const commitments: bigint[] = sortedEvents.map((event) => {
        const args = event.args as { commitment?: bigint };
        if (args.commitment === undefined) {
          throw new Error("Deposit event missing commitment field");
        }
        return args.commitment;
      });

      if (!commitments.includes(commitment)) {
        throw new Error(
          "Commitment not found in deposit history. Make sure your note is correct.",
        );
      }

      const tree = await buildTreeFromLeaves(commitments);
      const leafIndex = commitments.indexOf(commitment);
      const merkleProof = tree.getProof(leafIndex);

      // Step 3: Generate ZK proof
      setStep("generating-proof");
      const recipientBigInt = BigInt(recipient);
      const relayerAddress = "0x0000000000000000000000000000000000000000";
      const relayerBigInt = BigInt(relayerAddress);
      const fee = BigInt(0);

      const proofData = await generateWithdrawalProof({
        root: merkleProof.root,
        nullifierHash,
        recipient: recipientBigInt,
        relayer: relayerBigInt,
        fee,
        secret,
        nullifier,
        pathElements: merkleProof.pathElements,
        pathIndices: merkleProof.pathIndices,
      });

      // Step 4: Submit withdrawal
      setStep("submitting");

      const hash = await writeContractAsync({
        address: getMixerAddress(),
        abi: MIXER_ABI,
        functionName: "withdraw",
        args: [
          proofData.pA,
          proofData.pB,
          proofData.pC,
          merkleProof.root,
          nullifierHash,
          recipient as `0x${string}`,
          "0x0000000000000000000000000000000000000000",
          fee,
        ],
      });

      setTxHash(hash);
      setStep("success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Withdrawal failed";
      setError(message);
      setStep("error");
    }
  };

  const handleReset = () => {
    setStep("idle");
    setError(null);
    setTxHash(undefined);
  };

  const isActive =
    step !== "idle" && step !== "success" && step !== "error";
  const isProcessing = isActive || isWaiting;

  const activeSteps: WithdrawStep[] = [
    "parsing",
    "building-tree",
    "generating-proof",
    "submitting",
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdraw</CardTitle>
        <CardDescription>
          Paste your note and provide a recipient address to withdraw your 0.1
          ETH privately.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm text-zinc-400">Note</label>
          <Input
            placeholder="zk-mixer-<secret>-<nullifier>"
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            disabled={isProcessing}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm text-zinc-400">Recipient Address</label>
          <Input
            placeholder="0x..."
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            disabled={isProcessing}
            className="font-mono text-xs"
          />
        </div>

        {isActive && (
          <div className="space-y-1.5">
            {activeSteps.map((s) => {
              const current = activeSteps.indexOf(step);
              const index = activeSteps.indexOf(s);
              const isDone = index < current;
              const isCurrent = s === step;

              return (
                <div
                  key={s}
                  className={`flex items-center gap-2 text-sm ${
                    isCurrent
                      ? "text-emerald-400"
                      : isDone
                        ? "text-zinc-500"
                        : "text-zinc-700"
                  }`}
                >
                  <span className="text-xs">
                    {isDone ? "✓" : isCurrent ? "→" : "·"}
                  </span>
                  {STEP_LABELS[s]}
                </div>
              );
            })}
          </div>
        )}

        {isWaiting && txHash && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-zinc-300">
            Waiting for confirmation...{" "}
            <span className="font-mono text-xs text-zinc-400">
              {txHash.slice(0, 10)}...
            </span>
          </div>
        )}

        {isConfirmed && step === "success" && txHash && (
          <div className="rounded-lg border border-emerald-700 bg-emerald-950 p-3 text-sm text-emerald-300">
            Withdrawal confirmed!{" "}
            <span className="font-mono text-xs text-zinc-400">
              {txHash.slice(0, 10)}...
            </span>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-700 bg-red-950 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </CardContent>

      <CardFooter>
        {step === "success" ? (
          <Button variant="secondary" onClick={handleReset} className="w-full">
            Make Another Withdrawal
          </Button>
        ) : (
          <Button
            onClick={handleWithdraw}
            disabled={isProcessing || !isConnected}
            className="w-full"
          >
            {isProcessing
              ? STEP_LABELS[step] || "Processing..."
              : "Withdraw"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
