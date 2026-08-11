import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CirclePause,
  Code2,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  TimerReset,
  WalletCards,
} from "lucide-react";

import { LandingMotion } from "@/components/landing/landing-motion";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const mandateControls = [
  {
    icon: WalletCards,
    title: "Keep custody",
    body: "Funds move from payer to merchant. Paymap never holds them.",
  },
  {
    icon: TimerReset,
    title: "Set the cadence",
    body: "Define start time, charge interval, period limits, and expiry.",
  },
  {
    icon: CirclePause,
    title: "Stop instantly",
    body: "Pause, resume, or revoke a mandate from the consumer dashboard.",
  },
];

function WordReveal({ children }: { children: string }) {
  return (
    <>
      {children.split(" ").map((word, index) => (
        <span className="reveal-word inline-block" key={`${word}-${index}`}>
          {word}
          {index < children.split(" ").length - 1 ? "\u00A0" : ""}
        </span>
      ))}
    </>
  );
}

export default function HomePage() {
  return (
    <LandingMotion>
      <main className="w-full max-w-full overflow-x-clip bg-background">
        <header className="absolute inset-x-0 top-0 z-20">
          <nav
            aria-label="Primary navigation"
            className="mx-auto flex h-18 max-w-[1400px] items-center justify-between px-5 sm:px-8 lg:px-12"
          >
            <Link
              className="flex items-center gap-2.5 text-sm font-semibold tracking-[-0.02em]"
              href="/"
            >
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground"
              >
                <span className="size-2 rounded-full bg-current" />
              </span>
              Paymap
            </Link>

            <div className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
              <a className="transition-colors hover:text-foreground" href="#how-it-works">
                How it works
              </a>
              <a className="transition-colors hover:text-foreground" href="#controls">
                Controls
              </a>
              <Link className="transition-colors hover:text-foreground" href="/merchant/connect">
                For merchants
              </Link>
            </div>

            <Link className={cn(buttonVariants({ size: "lg" }), "px-4")} href="/dashboard">
              Open dashboard
              <ArrowRight data-icon="inline-end" />
            </Link>
          </nav>
        </header>

        <section className="relative isolate min-h-[100dvh] overflow-hidden pt-18">
          <div className="landing-grid absolute inset-0 -z-20 opacity-70" />
          <div className="absolute inset-x-0 top-0 -z-10 h-[70%] bg-[radial-gradient(circle_at_70%_18%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent_48%)]" />

          <div className="mx-auto grid min-h-[calc(100dvh-4.5rem)] max-w-[1400px] items-center gap-10 px-5 py-12 sm:px-8 md:grid-cols-[0.88fr_1.12fr] lg:gap-16 lg:px-12">
            <div className="hero-copy flex max-w-2xl flex-col items-start gap-7">
              <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary">
                Non-custodial by design
              </Badge>
              <h1
                aria-label="Your payments. Your terms."
                className="max-w-[19ch] text-[clamp(3.35rem,5.6vw,5.8rem)] leading-[0.9] font-semibold tracking-[-0.075em]"
              >
                <span aria-hidden="true" className="block">
                  Your payments.
                </span>
                <span aria-hidden="true" className="block">
                  Your terms.
                </span>
              </h1>
              <p className="max-w-[39rem] text-base leading-relaxed text-muted-foreground sm:text-lg">
                Authorize exact limits. Keep custody, control every charge, and revoke access
                anytime.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link
                  className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 text-[0.95rem]")}
                  href="/dashboard"
                >
                  Open dashboard
                  <ArrowRight data-icon="inline-end" />
                </Link>
                <Link
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "h-11 px-5 text-[0.95rem]",
                  )}
                  href="/merchant/connect"
                >
                  Merchant access
                </Link>
              </div>
            </div>

            <div className="hero-visual relative min-h-[420px] overflow-hidden rounded-3xl border bg-card shadow-[0_35px_100px_color-mix(in_oklch,var(--foreground)_16%,transparent)] md:min-h-[620px]">
              <Image
                alt="Abstract orbital structure representing a bounded payment mandate"
                className="object-cover transition-transform duration-1000 ease-out hover:scale-[1.025]"
                fill
                priority
                sizes="(max-width: 767px) 100vw, 58vw"
                src="/landing/paymap-mandate-orbit.webp"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/70 via-transparent to-transparent" />
              <div className="absolute inset-x-0 bottom-0 grid gap-4 p-6 text-zinc-100 sm:grid-cols-2 sm:p-8">
                <div>
                  <p className="text-xs font-medium text-zinc-400">Authority</p>
                  <p className="mt-1 text-lg font-medium tracking-tight">Bounded by the mandate</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-400">Settlement</p>
                  <p className="mt-1 text-lg font-medium tracking-tight">Direct to the merchant</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-label="Trust boundaries" className="border-y bg-card/40">
          <div className="mx-auto grid max-w-[1400px] grid-cols-1 px-5 sm:grid-cols-3 sm:px-8 lg:px-12">
            {[
              ["Payer keeps custody", "The contract never holds user funds."],
              ["Relayer cannot spend", "It submits authorized requests only."],
              ["Limits live on-chain", "Amount, timing, count, and expiry are enforced."],
            ].map(([title, body], index) => (
              <div
                className={cn(
                  "reveal flex min-h-36 flex-col justify-center gap-2 py-7 sm:px-7",
                  index > 0 && "border-t sm:border-t-0 sm:border-l",
                )}
                key={title}
              >
                <p className="font-medium tracking-tight">{title}</p>
                <p className="max-w-[32ch] text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="px-5 py-32 sm:px-8 md:py-48 lg:px-12" id="how-it-works">
          <div className="mx-auto max-w-[1400px]">
            <div className="reveal flex max-w-4xl flex-col gap-5">
              <h2 className="text-4xl leading-[0.98] font-semibold tracking-[-0.055em] text-balance sm:text-6xl">
                The permission is the product.
              </h2>
              <p className="max-w-[58ch] text-base leading-relaxed text-muted-foreground sm:text-lg">
                Every mandate makes the merchant, asset, amount, cadence, caps, and expiry visible
                before signing.
              </p>
            </div>

            <div className="mt-16 grid grid-flow-dense grid-cols-1 gap-4 md:grid-cols-12">
              <Card className="reveal min-h-[360px] border-0 bg-primary text-primary-foreground ring-0 md:col-span-7">
                <CardHeader className="gap-5 p-7 sm:p-9">
                  <Badge
                    variant="secondary"
                    className="bg-primary-foreground/12 text-primary-foreground"
                  >
                    Payer control
                  </Badge>
                  <CardTitle className="max-w-[12ch] text-3xl leading-[0.98] tracking-[-0.05em] sm:text-5xl">
                    Sign once. Authorize only what you mean.
                  </CardTitle>
                  <CardDescription className="max-w-[48ch] text-primary-foreground/70">
                    No blanket approval. Every charge must match the mandate and its remaining
                    allowance.
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto grid grid-cols-2 gap-5 p-7 pt-0 sm:p-9 sm:pt-0">
                  <div>
                    <p className="text-xs text-primary-foreground/55">Maximum exposure</p>
                    <p className="mt-2 text-xl font-medium">Calculated before signing</p>
                  </div>
                  <div>
                    <p className="text-xs text-primary-foreground/55">Revocation</p>
                    <p className="mt-2 text-xl font-medium">Effective immediately</p>
                  </div>
                </CardContent>
              </Card>

              <figure className="reveal group relative min-h-[360px] overflow-hidden rounded-xl md:col-span-5">
                <Image
                  alt="Machined controls representing payment limits, pause, and revocation"
                  className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                  fill
                  sizes="(max-width: 767px) 100vw, 42vw"
                  src="/landing/paymap-controls.webp"
                />
              </figure>

              <Card className="reveal group min-h-[390px] border-0 bg-muted/40 p-0 ring-0 md:col-span-5">
                <CardHeader className="p-7 pb-4">
                  <CardTitle className="text-2xl tracking-[-0.04em]">Built for merchants</CardTitle>
                  <CardDescription>
                    Create checkout links, request eligible charges, and receive signed webhooks.
                  </CardDescription>
                </CardHeader>
                <CardContent className="relative mx-7 mb-7 min-h-[250px] overflow-hidden rounded-xl border bg-background p-0">
                  <Image
                    alt="Paymap merchant account connection screen"
                    className="object-cover object-left-top transition-transform duration-700 ease-out group-hover:scale-[1.03]"
                    fill
                    sizes="(max-width: 767px) 100vw, 42vw"
                    src="/landing/paymap-merchant-connect.png"
                  />
                </CardContent>
              </Card>

              <Card className="reveal min-h-[390px] border-0 bg-card ring-1 ring-foreground/10 md:col-span-7">
                <CardHeader className="p-7 sm:p-9">
                  <CardTitle className="text-3xl tracking-[-0.045em] sm:text-4xl">
                    The relayer moves transactions, not money.
                  </CardTitle>
                  <CardDescription className="max-w-[56ch] text-base leading-relaxed">
                    Merchant authorization is exact and transportable. The relayer cannot change the
                    merchant, asset, amount, or charge identifier.
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto grid gap-4 p-7 pt-0 sm:grid-cols-2 sm:p-9 sm:pt-0">
                  {(
                    [
                      { label: "Scoped API keys", icon: KeyRound },
                      { label: "Confirmed on-chain state", icon: BadgeCheck },
                    ] as const
                  ).map(({ label, icon: Icon }) => (
                    <div
                      className="flex items-center gap-3 rounded-xl border bg-background p-4"
                      key={label}
                    >
                      <Icon aria-hidden="true" className="text-primary" />
                      <span className="font-medium">{label}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="bg-muted/35 px-5 py-32 sm:px-8 md:py-48 lg:px-12" id="controls">
          <div className="mx-auto grid max-w-[1400px] gap-16 md:grid-cols-[0.72fr_1.28fr]">
            <div className="md:sticky md:top-24 md:h-fit">
              <ShieldCheck className="mb-8 text-primary" aria-hidden="true" />
              <h2 className="max-w-[10ch] text-4xl leading-[0.98] font-semibold tracking-[-0.055em] sm:text-6xl">
                Control does not expire after checkout.
              </h2>
            </div>

            <div className="landing-stack flex flex-col gap-8">
              {mandateControls.map(({ icon: Icon, title, body }) => (
                <Card
                  className="stack-card min-h-[58dvh] justify-between border-0 bg-card shadow-[0_28px_80px_color-mix(in_oklch,var(--foreground)_10%,transparent)] ring-1 ring-foreground/10"
                  key={title}
                  style={{ transformOrigin: "center top" }}
                >
                  <CardHeader className="gap-8 p-8 sm:p-12">
                    <Icon aria-hidden="true" className="text-primary" />
                    <CardTitle className="max-w-[11ch] text-4xl tracking-[-0.055em] sm:text-6xl">
                      {title}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-8 pt-0 sm:p-12 sm:pt-0">
                    <p className="max-w-[42ch] text-lg leading-relaxed text-muted-foreground">
                      {body}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 py-32 sm:px-8 md:py-48 lg:px-12">
          <div className="mx-auto max-w-[1400px]">
            <p className="reveal max-w-5xl text-[clamp(2.6rem,6vw,6.4rem)] leading-[0.97] font-medium tracking-[-0.065em] text-balance">
              <WordReveal>A payment permission</WordReveal>{" "}
              <span
                aria-hidden="true"
                className="relative mx-[0.08em] inline-block h-[0.7em] w-[1.35em] translate-y-[0.06em] overflow-hidden rounded-full"
              >
                <Image
                  alt=""
                  className="object-cover"
                  fill
                  sizes="160px"
                  src="/landing/paymap-mandate-orbit.webp"
                />
              </span>{" "}
              <WordReveal>
                should be small enough to understand and strong enough to enforce.
              </WordReveal>
            </p>

            <div className="mt-20 flex flex-col gap-3 md:h-[520px] md:flex-row">
              {[
                {
                  title: "Checkout",
                  body: "Show every term, calculate maximum exposure, then collect the payer signature.",
                  icon: WalletCards,
                },
                {
                  title: "Collection",
                  body: "Submit the exact authorized charge. Contract limits decide whether it can settle.",
                  icon: ShieldCheck,
                },
                {
                  title: "Recovery",
                  body: "Retry transient failures, preserve idempotency, and reconcile from confirmed chain state.",
                  icon: RotateCcw,
                },
              ].map(({ title, body, icon: Icon }) => (
                <article
                  className="group flex min-h-64 flex-1 flex-col justify-between overflow-hidden rounded-2xl border bg-card p-7 transition-[flex,background-color] duration-700 ease-out focus-within:flex-[1.75] hover:flex-[1.75] md:p-9"
                  key={title}
                  tabIndex={0}
                >
                  <Icon aria-hidden="true" className="text-primary" />
                  <div className="flex flex-col gap-4">
                    <h3 className="text-3xl font-medium tracking-[-0.045em]">{title}</h3>
                    <p className="max-w-[34ch] text-sm leading-relaxed text-muted-foreground opacity-100 transition-opacity duration-500 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                      {body}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 pb-8 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-[1400px] overflow-hidden rounded-3xl bg-primary px-6 py-20 text-primary-foreground sm:px-12 md:py-28 lg:px-20">
            <div className="reveal flex max-w-5xl flex-col items-start gap-8">
              <h2 className="text-5xl leading-[0.94] font-semibold tracking-[-0.06em] text-balance sm:text-7xl">
                Put recurring payments under user control.
              </h2>
              <p className="max-w-[48ch] text-lg leading-relaxed text-primary-foreground/70">
                Explore the consumer dashboard or connect a merchant account on Stellar testnet.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link
                  className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
                  href="/dashboard"
                >
                  Open dashboard
                  <ArrowRight data-icon="inline-end" />
                </Link>
                <Link
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "h-11 border-primary-foreground/30 bg-transparent px-5 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground",
                  )}
                  href="/merchant/connect"
                >
                  Merchant access
                </Link>
              </div>
            </div>
          </div>
        </section>

        <footer className="px-5 py-10 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-[1400px]">
            <Separator />
            <div className="flex flex-col gap-6 pt-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5 text-foreground">
                <span
                  aria-hidden="true"
                  className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground"
                >
                  <span className="size-2 rounded-full bg-current" />
                </span>
                <span className="font-semibold">Paymap</span>
              </div>
              <p>Non-custodial recurring payments on Stellar.</p>
              <a
                className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
                href="https://github.com/SachPlayZ/Paymap"
                rel="noreferrer"
                target="_blank"
              >
                <Code2 aria-hidden="true" />
                GitHub
              </a>
            </div>
          </div>
        </footer>
      </main>
    </LandingMotion>
  );
}
