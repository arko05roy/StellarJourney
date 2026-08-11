import { Skeleton } from "@/components/ui/skeleton";
import { DashboardLoadingSkeleton } from "@/components/dashboard/loading-skeleton";

export default function DashboardLoading() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-8 w-64 rounded-lg" />
      <DashboardLoadingSkeleton />
    </main>
  );
}
