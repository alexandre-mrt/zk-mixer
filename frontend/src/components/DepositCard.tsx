import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { generateNote, type Note } from "@/lib/crypto";
import { MIXER_ABI, getMixerAddress, DENOMINATION } from "@/lib/constants";

type DepositState = "idle" | "generating" | "confirming" | "success" | "error";

export function DepositCard() {
  const { isConnected } = useAccount();
  const [state, setState] = useState<DepositState>("idle");
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNote, setShowNote] = useState(false);
  const [copied, setCopied] = useState(false);

  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { isLoading: isWaiting, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  const handleDeposit = async () => {
    if (!isConnected) {
      setError("Please connect your wallet first.");
      return;
    }

    try {
      setState("generating");
      setError(null);
      setNote(null);

      const generatedNote = await generateNote();
      setNote(generatedNote);

      setState("confirming");

      const hash = await writeContractAsync({
        address: getMixerAddress(),
        abi: MIXER_ABI,
        functionName: "deposit",
        args: [generatedNote.commitment],
        value: DENOMINATION,
      });

      setTxHash(hash);
      setState("success");
      setShowNote(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Transaction failed";
      setError(message);
      setState("error");
    }
  };

  const handleCopyNote = async () => {
    if (!note) return;
    await navigator.clipboard.writeText(note.noteString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setState("idle");
    setNote(null);
    setError(null);
    setTxHash(undefined);
    setShowNote(false);
  };

  const isLoading =
    state === "generating" || state === "confirming" || isWaiting;

  if (!isConnected) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-sm text-zinc-400">Connect your wallet to continue</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>Deposit</CardTitle>
        <CardDescription>
          Deposit exactly 0.1 ETH into the privacy pool. Save your note — you
          will need it to withdraw.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {state === "generating" && (
          <StatusMessage type="info">Generating cryptographic note...</StatusMessage>
        )}
        {state === "confirming" && (
          <StatusMessage type="info">
            Please confirm the transaction in your wallet...
          </StatusMessage>
        )}
        {isWaiting && txHash && (
          <StatusMessage type="info">
            Waiting for confirmation...{" "}
            <TxLink hash={txHash} />
          </StatusMessage>
        )}
        {isConfirmed && txHash && state === "success" && (
          <StatusMessage type="success">
            Deposit confirmed! <TxLink hash={txHash} />
          </StatusMessage>
        )}
        {error && <StatusMessage type="error">{error}</StatusMessage>}

        {showNote && note && (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-700 bg-amber-950 p-4">
              <p className="mb-2 text-sm font-semibold text-amber-400">
                Save your note — this is the ONLY way to withdraw your funds.
                Do not share it.
              </p>
              <div className="rounded-md bg-zinc-900 p-3 font-mono text-xs text-zinc-300 break-all">
                {note.noteString}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyNote}
              className="w-full"
            >
              {copied ? "Copied!" : "Copy Note to Clipboard"}
            </Button>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex gap-2">
        {state === "success" ? (
          <Button variant="secondary" onClick={handleReset} className="w-full text-sm sm:text-base">
            Make Another Deposit
          </Button>
        ) : (
          <Button
            onClick={handleDeposit}
            disabled={isLoading || !isConnected}
            className="w-full text-sm sm:text-base"
          >
            {isLoading ? "Processing..." : "Deposit 0.1 ETH"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

type StatusMessageType = "info" | "success" | "error";

function StatusMessage({
  type,
  children,
}: {
  type: StatusMessageType;
  children: React.ReactNode;
}) {
  const colorMap: Record<StatusMessageType, string> = {
    info: "border-zinc-700 bg-zinc-800 text-zinc-300",
    success: "border-emerald-700 bg-emerald-950 text-emerald-300",
    error: "border-red-700 bg-red-950 text-red-300",
  };
  return (
    <div className={`rounded-lg border p-3 text-sm ${colorMap[type]}`}>
      {children}
    </div>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <span className="font-mono text-xs text-zinc-400">
      {hash.slice(0, 10)}...
    </span>
  );
}
