"use client";

import { useActionState, useMemo, useState } from "react";
import { CheckCircle2, LoaderCircle, ShieldCheck, WalletCards } from "lucide-react";
import {
  completeMerchantAuthAction,
  createMerchantChallengeAction,
  registerMerchantProfileAction,
} from "@/lib/merchant-actions";
import {
  createFreighterMerchantWalletAdapter,
  createStubMerchantWalletAdapter,
} from "@/lib/merchant-wallet";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const USE_STUBS = process.env.NEXT_PUBLIC_E2E_STUBS === "1";

type AuthPhase = "idle" | "connecting" | "signing" | "profile";

export function MerchantAuthPanel({ networkPassphrase }: { networkPassphrase: string }) {
  const wallet = useMemo(
    () =>
      USE_STUBS
        ? createStubMerchantWalletAdapter()
        : createFreighterMerchantWalletAdapter(networkPassphrase),
    [networkPassphrase],
  );
  const [phase, setPhase] = useState<AuthPhase>("idle");
  const [walletAddress, setWalletAddress] = useState<string>();
  const [error, setError] = useState<string>();
  const [profileState, profileAction, profilePending] = useActionState(
    registerMerchantProfileAction,
    undefined,
  );

  async function authenticate(): Promise<void> {
    setError(undefined);
    setPhase("connecting");
    try {
      const connected = await wallet.connect();
      setWalletAddress(connected.address);
      const challengeResult = await createMerchantChallengeAction(connected.address);
      if (!challengeResult.ok) {
        setError(challengeResult.error);
        setPhase("idle");
        return;
      }
      if (challengeResult.challenge.networkPassphrase !== networkPassphrase) {
        setError("Paymap returned a challenge for the wrong Stellar network.");
        setPhase("idle");
        return;
      }
      setPhase("signing");
      const signed = await wallet.signMessage(challengeResult.challenge.message, {
        address: connected.address,
        networkPassphrase,
      });
      const completed = await completeMerchantAuthAction({
        challengeId: challengeResult.challenge.challengeId,
        message: challengeResult.challenge.message,
        signature: signed.signature,
        signerAddress: signed.signerAddress,
      });
      if (!completed.ok) {
        setError(completed.error);
        setPhase("idle");
        return;
      }
      setWalletAddress(completed.walletAddress);
      setPhase("profile");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wallet authentication failed.");
      setPhase("idle");
    }
  }

  if (phase === "profile") {
    return (
      <div className="flex flex-col gap-5" data-testid="merchant-profile-step">
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Wallet ownership verified</AlertTitle>
        </Alert>
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">Connected Stellar wallet</p>
          <p
            className="mt-1 break-all font-mono text-xs text-foreground"
            data-testid="merchant-connected-address"
          >
            {walletAddress}
          </p>
        </div>
        <form action={profileAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="merchant-name">Business name</Label>
            <Input
              id="merchant-name"
              name="name"
              required
              autoComplete="organization"
              data-testid="merchant-profile-name-input"
            />
          </div>
          {profileState && !profileState.ok ? (
            <Alert variant="destructive">
              <AlertTitle>{profileState.error}</AlertTitle>
            </Alert>
          ) : null}
          <Button
            type="submit"
            disabled={profilePending}
            data-testid="merchant-profile-submit-button"
          >
            {profilePending ? "Creating merchant…" : "Create merchant profile"}
          </Button>
        </form>
      </div>
    );
  }

  const busy = phase === "connecting" || phase === "signing";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <WalletCards className="size-5" />
        </span>
        <div>
          <p className="font-medium text-foreground">Connect your merchant wallet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Paymap uses a signed message to prove this payout address belongs to you.
          </p>
        </div>
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground">
        <p className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          No transaction is submitted
        </p>
        <p className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          No funds or wallet secret are requested
        </p>
        <p className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          Session expires after 24 hours
        </p>
      </div>
      {error ? (
        <Alert variant="destructive" data-testid="merchant-auth-error">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      <Button
        type="button"
        size="lg"
        disabled={busy}
        onClick={() => void authenticate()}
        data-testid="merchant-wallet-connect-button"
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <WalletCards />}
        {phase === "connecting"
          ? "Connecting Freighter…"
          : phase === "signing"
            ? "Waiting for signature…"
            : "Connect Freighter and sign in"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Freighter is required for merchant authentication in this release.
      </p>
    </div>
  );
}
