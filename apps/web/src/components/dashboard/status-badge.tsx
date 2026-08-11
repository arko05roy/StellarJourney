import { Badge } from "@/components/ui/badge";
import type { MandateStatus } from "@paymap/contract-client";

/** Consumer-friendly label + visual weight per status (CLAUDE.md §13 — "Cancel autopay" language extends naturally to "Cancelled" rather than the technical "Revoked"). Technical status is still exposed via the `title` attribute for anyone who wants it. */
const STATUS_COPY: Record<MandateStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  Active: { label: "Active", variant: "default" },
  Paused: { label: "Paused", variant: "secondary" },
  Revoked: { label: "Cancelled", variant: "outline" },
  Completed: { label: "Completed", variant: "outline" },
  Expired: { label: "Expired", variant: "outline" },
};

export function MandateStatusBadge({ status }: { status: MandateStatus }) {
  const { label, variant } = STATUS_COPY[status];
  return (
    <Badge variant={variant} title={`On-chain status: ${status}`} data-testid="mandate-status-badge">
      {label}
    </Badge>
  );
}
