import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { DisplayError } from "@/lib/errors";

export interface ErrorBannerProps {
  error: DisplayError;
  /** Rendered next to the message when the failure could plausibly succeed on retry (e.g. "top up your balance"). */
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
}

export function ErrorBanner({ error, onRetry, retryLabel = "Try again" }: ErrorBannerProps) {
  return (
    <Alert variant="destructive" data-testid="error-banner">
      <AlertTriangle />
      <AlertTitle>{error.message}</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Reference: {error.code}</span>
        {onRetry && error.retryable ? (
          <button type="button" onClick={onRetry} className="text-xs font-medium text-foreground underline underline-offset-2 hover:no-underline">
            {retryLabel}
          </button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
