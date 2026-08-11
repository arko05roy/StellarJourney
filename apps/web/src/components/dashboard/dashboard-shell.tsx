"use client";

/**
 * Orchestrates the whole consumer dashboard (PLAN.md §16.1): wallet
 * connection, mandate discovery (`lib/dashboard-api.ts`, DB-backed —
 * enrichment/discovery only), a live `get_mandate` read per discovered
 * mandate id (`lib/mandate-gateway.ts` — the *authoritative* source for
 * everything a card displays, CLAUDE.md §2), payment history, and every
 * payer-authorized control (pause/resume/cancel autopay).
 *
 * `wallet`/`gateway` are injected (mirrors `checkout-flow.tsx`'s pattern)
 * so the Playwright suite can supply deterministic stubs.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, PauseCircle, Sparkles } from "lucide-react";
import type { Mandate } from "@paymap/contract-client";
import type { DeploymentRecord } from "@paymap/contract-client";
import {
  fetchConsumerMandates,
  fetchConsumerPaymentHistory,
  type ConsumerMandateSummary,
  type ConsumerPaymentHistory,
} from "@/lib/dashboard-api";
import { deriveEffectiveStatus, computeNextEligibleChargeDate } from "@/lib/mandate-status";
import { toDisplayError, type DisplayError } from "@/lib/errors";
import { formatAssetSymbol } from "@/lib/format";
import type { MandateGateway } from "@/lib/mandate-gateway";
import type { WalletAdapter } from "@/lib/wallet";
import { DashboardNav, type DashboardTab } from "./dashboard-nav";
import { WalletGate } from "./wallet-gate";
import { EmptyState } from "./empty-state";
import { DashboardLoadingSkeleton, MandateCardSkeleton } from "./loading-skeleton";
import { MandateCard, type MandateCardActionState } from "./mandate-card";
import { PaymentHistoryList } from "./payment-history-list";
import { SettingsPanel } from "./settings-panel";
import { CancelAutopayDialog } from "./cancel-autopay-dialog";
import { ErrorBanner } from "@/components/checkout/error-banner";

export interface DashboardShellProps {
  deployment: DeploymentRecord;
  wallet: WalletAdapter;
  gateway: MandateGateway;
}

interface LiveMandateState {
  status: "loading" | "success" | "error";
  mandate?: Mandate;
  error?: DisplayError;
}

interface FetchState<T> {
  status: "idle" | "loading" | "success" | "error";
  data?: T;
  error?: DisplayError;
}

export function DashboardShell({ deployment, wallet, gateway }: DashboardShellProps) {
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState<string | undefined>(undefined);
  const [connectError, setConnectError] = useState<DisplayError | undefined>(undefined);
  const [tab, setTab] = useState<DashboardTab>("upcoming");
  const [discovery, setDiscovery] = useState<FetchState<ConsumerMandateSummary[]>>({
    status: "idle",
  });
  const [liveMandates, setLiveMandates] = useState<Record<string, LiveMandateState>>({});
  const [history, setHistory] = useState<FetchState<ConsumerPaymentHistory>>({ status: "idle" });
  const [actionStates, setActionStates] = useState<Record<string, MandateCardActionState>>({});
  const [cancelTargetId, setCancelTargetId] = useState<string | undefined>(undefined);
  const [nowUnixSeconds] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)));

  const signer = useMemo(
    () =>
      address
        ? {
            publicKey: address,
            signTransaction: wallet.signTransaction,
            signAuthEntry: wallet.signAuthEntry,
          }
        : undefined,
    [address, wallet],
  );

  const refreshMandate = useCallback(
    async (mandateId: string) => {
      setLiveMandates((prev) => ({ ...prev, [mandateId]: { status: "loading" } }));
      try {
        const mandate = await gateway.getMandate(mandateId);
        setLiveMandates((prev) => ({ ...prev, [mandateId]: { status: "success", mandate } }));
      } catch (error) {
        setLiveMandates((prev) => ({
          ...prev,
          [mandateId]: { status: "error", error: toDisplayError(error) },
        }));
      }
    },
    [gateway],
  );

  const loadDiscoveryAndHistory = useCallback(
    async (payerAddress: string) => {
      setDiscovery({ status: "loading" });
      setHistory({ status: "loading" });
      try {
        const summaries = await fetchConsumerMandates(payerAddress);
        setDiscovery({ status: "success", data: summaries });
        await Promise.all(summaries.map((summary) => refreshMandate(summary.mandateId)));
      } catch (error) {
        setDiscovery({ status: "error", error: toDisplayError(error) });
      }
      try {
        const paymentHistory = await fetchConsumerPaymentHistory(payerAddress);
        setHistory({ status: "success", data: paymentHistory });
      } catch (error) {
        setHistory({ status: "error", error: toDisplayError(error) });
      }
    },
    [refreshMandate],
  );

  useEffect(() => {
    if (address) void loadDiscoveryAndHistory(address);
    // Intentionally keyed on `address` alone — `loadDiscoveryAndHistory`
    // itself is stable enough (depends only on `refreshMandate`, which
    // depends only on the stable `gateway`) that this should run once per
    // newly-connected address, not on every render.
  }, [address, loadDiscoveryAndHistory]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(undefined);
    try {
      const { address: connected } = await wallet.connect();
      setAddress(connected);
    } catch (error) {
      setConnectError(toDisplayError(error));
    } finally {
      setConnecting(false);
    }
  }, [wallet]);

  const handleDisconnect = useCallback(() => {
    void wallet.disconnect();
    setAddress(undefined);
    setDiscovery({ status: "idle" });
    setLiveMandates({});
    setHistory({ status: "idle" });
    setTab("upcoming");
  }, [wallet]);

  const runAction = useCallback(
    async (mandateId: string, action: "pause" | "resume") => {
      if (!signer) return;
      setActionStates((prev) => ({ ...prev, [mandateId]: { pending: action } }));
      try {
        if (action === "pause") await gateway.pauseMandate(mandateId, signer);
        else await gateway.resumeMandate(mandateId, signer);
        setActionStates((prev) => ({ ...prev, [mandateId]: {} }));
      } catch (error) {
        // The mandate's on-chain state may have changed underneath the
        // user (e.g. someone else already revoked it) — refresh live state
        // alongside the error so the card's controls re-derive correctly
        // rather than staying stale (the task's explicit requirement).
        setActionStates((prev) => ({
          ...prev,
          [mandateId]: { error: { action, display: toDisplayError(error) } },
        }));
      } finally {
        await refreshMandate(mandateId);
      }
    },
    [gateway, signer, refreshMandate],
  );

  const summaryById = useMemo(() => {
    const map = new Map<string, ConsumerMandateSummary>();
    for (const summary of discovery.data ?? []) map.set(summary.mandateId, summary);
    return map;
  }, [discovery.data]);

  const cancelTargetSummary = cancelTargetId ? summaryById.get(cancelTargetId) : undefined;
  const cancelTargetMandate = cancelTargetId ? liveMandates[cancelTargetId]?.mandate : undefined;

  if (!address) {
    return (
      <div className="flex flex-col gap-4">
        {connectError ? (
          <ErrorBanner error={connectError} onRetry={() => void handleConnect()} />
        ) : null}
        <WalletGate connecting={connecting} onConnect={() => void handleConnect()} />
      </div>
    );
  }

  const mandateIds = discovery.data?.map((s) => s.mandateId) ?? [];
  const effectiveMandates = mandateIds
    .map((id) => ({ id, summary: summaryById.get(id), live: liveMandates[id] }))
    .filter(
      (entry): entry is { id: string; summary: ConsumerMandateSummary; live: LiveMandateState } =>
        entry.summary !== undefined && entry.live !== undefined,
    );

  const withStatus = effectiveMandates
    .filter((entry) => entry.live.status === "success" && entry.live.mandate)
    .map((entry) => ({
      ...entry,
      mandate: entry.live.mandate as Mandate,
      status: deriveEffectiveStatus(entry.live.mandate as Mandate, nowUnixSeconds),
    }));

  const upcoming = withStatus
    .filter((entry) => entry.status === "Active")
    .sort((a, b) => {
      const nextA = computeNextEligibleChargeDate({ ...a.mandate, status: a.status });
      const nextB = computeNextEligibleChargeDate({ ...b.mandate, status: b.status });
      if (nextA === undefined && nextB === undefined) return 0;
      if (nextA === undefined) return 1;
      if (nextB === undefined) return -1;
      return nextA < nextB ? -1 : nextA > nextB ? 1 : 0;
    });
  const active = withStatus
    .filter((entry) => entry.status === "Active")
    .sort((a, b) => a.summary.merchant.name.localeCompare(b.summary.merchant.name));
  const pausedEnded = withStatus.filter((entry) => entry.status !== "Active");

  const loadingCount = effectiveMandates.filter((entry) => entry.live.status === "loading").length;

  function renderMandateList(
    list: typeof withStatus,
    empty: { icon: ReactNode; title: string; description: string },
  ) {
    if (discovery.status === "loading" || loadingCount > 0) return <DashboardLoadingSkeleton />;
    if (list.length === 0)
      return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />;
    return (
      <div className="flex flex-col gap-4">
        {list.map((entry) => (
          <MandateCard
            key={entry.id}
            mandate={entry.mandate}
            merchantName={entry.summary.merchant.name}
            assetDecimals={entry.summary.assetDecimals}
            nowUnixSeconds={nowUnixSeconds}
            actionState={actionStates[entry.id]}
            onPause={() => void runAction(entry.id, "pause")}
            onResume={() => void runAction(entry.id, "resume")}
            onCancelAutopay={() => setCancelTargetId(entry.id)}
            onViewHistory={() => setTab("history")}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <DashboardNav value={tab} onChange={setTab} />

      {discovery.status === "error" && discovery.error ? (
        <ErrorBanner
          error={discovery.error}
          onRetry={() => void loadDiscoveryAndHistory(address)}
        />
      ) : null}

      {discovery.status === "success" && (discovery.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Sparkles className="size-6" />}
          title="No automatic payments yet"
          description="When you authorize a merchant's checkout, your automatic payment will show up here — with its exact limits, billing frequency, and status, always read straight from Stellar."
        />
      ) : (
        <>
          {tab === "upcoming"
            ? renderMandateList(upcoming, {
                icon: <CalendarClock className="size-6" />,
                title: "Nothing upcoming",
                description:
                  "Active automatic payments eligible for a future charge will appear here.",
              })
            : null}
          {tab === "active"
            ? renderMandateList(active, {
                icon: <Sparkles className="size-6" />,
                title: "No active automatic payments",
                description:
                  "Automatic payments you've authorized and that are currently active will appear here.",
              })
            : null}
          {tab === "paused-ended"
            ? renderMandateList(pausedEnded, {
                icon: <PauseCircle className="size-6" />,
                title: "Nothing paused or ended",
                description:
                  "Paused, cancelled, completed, or expired automatic payments will appear here.",
              })
            : null}
          {tab === "history" ? (
            history.status === "loading" ? (
              <MandateCardSkeleton />
            ) : history.status === "error" && history.error ? (
              <ErrorBanner
                error={history.error}
                onRetry={() => void loadDiscoveryAndHistory(address)}
              />
            ) : (
              <PaymentHistoryList
                payments={history.data?.payments ?? []}
                failedAttempts={history.data?.failedAttempts ?? []}
                network={deployment.network}
                assetDecimalsFor={(mandateId) => summaryById.get(mandateId)?.assetDecimals ?? 7}
              />
            )
          ) : null}
          {tab === "settings" ? (
            <SettingsPanel address={address} onDisconnect={handleDisconnect} />
          ) : null}
        </>
      )}

      {cancelTargetSummary ? (
        <CancelAutopayDialog
          mandateId={cancelTargetId}
          tokenContractId={cancelTargetSummary.assetAddress}
          mandateExpiresAt={cancelTargetMandate?.expiresAt ?? 0n}
          assetSymbol={formatAssetSymbol(cancelTargetSummary.assetAddress)}
          mandateContractId={deployment.contractId}
          gateway={gateway}
          // Non-null: `signer` is derived from `address` alone (see the
          // `useMemo` above), and this whole branch only renders once
          // `address` is set — reusing the memoized value (rather than a
          // fresh object literal here) keeps its identity stable across
          // renders, which matters for the dialog's own effect deps.
          signer={signer!}
          onClose={() => setCancelTargetId(undefined)}
          onRevoked={(mandateId) => void refreshMandate(mandateId)}
        />
      ) : null}
    </div>
  );
}
