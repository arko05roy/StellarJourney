import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
}

/** A real, tab-specific empty state — never a bare "no results" (CLAUDE.md §13). */
export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <Card data-testid="dashboard-empty-state">
      <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
        <div className="text-muted-foreground">{icon}</div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
