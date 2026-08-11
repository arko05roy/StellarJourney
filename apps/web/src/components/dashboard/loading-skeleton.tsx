import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Skeleton shaped like the real mandate-card layout, not a generic spinner (CLAUDE.md §13 / task requirement for real loading states). */
export function MandateCardSkeleton() {
  return (
    <Card data-testid="mandate-card-skeleton">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-5 w-14 rounded-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
        <Skeleton className="h-8 w-full rounded-lg" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-20 rounded-lg" />
          <Skeleton className="h-7 w-28 rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-loading">
      <MandateCardSkeleton />
      <MandateCardSkeleton />
    </div>
  );
}
