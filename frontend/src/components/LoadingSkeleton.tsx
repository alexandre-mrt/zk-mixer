import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-zinc-800",
        className,
      )}
    />
  );
}

export function CardLoadingSkeleton() {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow">
      <div className="mb-4 space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
      <div className="mt-6">
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
