"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies the full checkout link (this app's own origin, resolved client-side, + the session path) to the clipboard. */
export function CopyLinkButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="copy-checkout-link-button"
      onClick={() => {
        void navigator.clipboard.writeText(`${window.location.origin}${path}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? (
        <>
          <Check data-icon="inline-start" /> Copied
        </>
      ) : (
        <>
          <Copy data-icon="inline-start" /> Copy link
        </>
      )}
    </Button>
  );
}
