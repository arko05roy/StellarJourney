import { loadDeployment } from "@paymap/contract-client";
import { resolveNetwork } from "@/lib/network";
import { DashboardPageClient } from "@/components/dashboard/dashboard-page-client";

// Every mandate's status/limits/usage is a live on-chain read (CLAUDE.md
// §2) — never statically cached.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const deployment = loadDeployment(resolveNetwork());

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Your automatic payments</h1>
        <p className="text-sm text-muted-foreground">
          Pause, resume, or cancel any automatic payment you've authorized — every limit and status shown here comes straight from
          Stellar.
        </p>
      </div>
      <DashboardPageClient deployment={deployment} />
    </main>
  );
}
