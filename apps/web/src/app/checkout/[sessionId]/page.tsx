import { notFound } from "next/navigation";
import { ApiError, fetchPublicCheckoutSession, type PublicCheckoutSession } from "@/lib/api";
import { resolveWebDeployment } from "@/lib/network";
import { CheckoutPageClient } from "@/components/checkout/checkout-page-client";
import { Card, CardContent } from "@/components/ui/card";

// A checkout session's status and expiry are live, merchant-controlled
// state — never statically cached (CLAUDE.md §2: the database/this page is
// never the final source of truth, but it must at least reflect the
// *current* backend state, not a stale build-time snapshot).
export const dynamic = "force-dynamic";

interface CheckoutSessionPageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function CheckoutSessionPage({ params }: CheckoutSessionPageProps) {
  const { sessionId } = await params;

  let session: PublicCheckoutSession;
  try {
    session = await fetchPublicCheckoutSession(sessionId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  if (session.status !== "pending") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-12">
        <NonPendingNotice session={session} />
      </main>
    );
  }

  const deployment = resolveWebDeployment();
  const nowUnixSeconds = String(Math.floor(Date.now() / 1000));

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-12">
      <CheckoutPageClient
        session={session}
        deployment={deployment}
        nowUnixSeconds={nowUnixSeconds}
      />
    </main>
  );
}

function nonPendingCopy(status: Exclude<PublicCheckoutSession["status"], "pending">): {
  title: string;
  body: string;
} {
  switch (status) {
    case "completed":
      return {
        title: "This checkout link has already been used",
        body: "The automatic payment for this checkout link was already set up. Check your payment dashboard to review it.",
      };
    case "expired":
      return {
        title: "This checkout link has expired",
        body: "Ask the merchant for a new checkout link to set up this automatic payment.",
      };
    case "canceled":
      return {
        title: "This checkout link was canceled",
        body: "The merchant canceled this checkout link. Ask them for a new one if you still want to proceed.",
      };
  }
}

function NonPendingNotice({ session }: { session: PublicCheckoutSession }) {
  const entry = nonPendingCopy(
    session.status as Exclude<PublicCheckoutSession["status"], "pending">,
  );

  return (
    <Card data-testid="non-pending-notice">
      <CardContent className="flex flex-col gap-2 pt-6">
        <h1 className="text-base font-semibold text-foreground">{entry.title}</h1>
        <p className="text-sm text-muted-foreground">{entry.body}</p>
        {session.mandateId ? (
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
            Automatic payment ID: {session.mandateId}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
