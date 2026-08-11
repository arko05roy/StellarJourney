"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("dashboard failed to load", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-12">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <h1 className="text-base font-semibold text-foreground">We could not load your automatic payments</h1>
          <p className="text-sm text-muted-foreground">This is usually a temporary connection problem. Check your connection and try again.</p>
          <Button type="button" onClick={reset} className="self-start">
            Try again
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
