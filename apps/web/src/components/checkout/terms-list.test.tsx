import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TermsList } from "./terms-list";
import { deriveMandateTerms } from "@/lib/mandate-terms";
import type { PublicProduct } from "@/lib/api";

const product: PublicProduct = {
  id: "prod-1",
  name: "Pro Plan",
  description: "Monthly access to the Pro tier",
  assetAddress: "CATESTASSETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  assetDecimals: 7,
  amountType: "fixed",
  fixedAmount: "15.00",
  maxPerPeriod: "15.00",
  periodSeconds: 2_592_000,
  minIntervalSeconds: 86_400,
  maxSuccessfulCharges: 12,
  defaultDurationSeconds: 31_536_000,
  active: true,
  createdAt: new Date().toISOString(),
};

const terms = deriveMandateTerms(product, 1_800_000_000n);

describe("TermsList", () => {
  it("renders every required mandate term, all visible at once (CLAUDE.md §13)", () => {
    render(<TermsList merchantName="Acme Studio" productName={product.name} assetSymbol="Asset CATE…XXXX" terms={terms} />);

    // Required labels — every one CLAUDE.md/PLAN.md §16.2 mandate the review screen must show.
    expect(screen.getByText("Merchant")).toBeInTheDocument();
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getByText("Payment asset")).toBeInTheDocument();
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("Maximum per billing period")).toBeInTheDocument();
    expect(screen.getByText("Billing frequency")).toBeInTheDocument();
    expect(screen.getByText("Minimum time between charges")).toBeInTheDocument();
    expect(screen.getByText("Start date")).toBeInTheDocument();
    expect(screen.getByText("Expiry date")).toBeInTheDocument();
    expect(screen.getByText("Maximum number of charges")).toBeInTheDocument();

    // The actual values, not just labels.
    expect(screen.getByText("Acme Studio")).toBeInTheDocument();
    // Fixed amount and maxPerPeriod are equal in this fixture, so both terms render the same text.
    expect(screen.getAllByText("15 Asset CATE…XXXX")).toHaveLength(2);
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("renders the unlimited-charge-count case in plain language, not as a raw 0", () => {
    const unlimitedTerms = deriveMandateTerms({ ...product, maxSuccessfulCharges: 0 }, 1_800_000_000n);
    render(<TermsList merchantName="Acme Studio" productName={product.name} assetSymbol="Asset" terms={unlimitedTerms} />);
    expect(screen.getByText("No limit")).toBeInTheDocument();
    expect(screen.queryByText("0", { selector: "dd" })).not.toBeInTheDocument();
  });

  it("never hides a critical term inside a collapsed or hidden element", () => {
    const { container } = render(<TermsList merchantName="Acme Studio" productName={product.name} assetSymbol="Asset" terms={terms} />);

    // No accordion/disclosure primitives anywhere in the tree.
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.querySelectorAll("summary")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-expanded]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-state="closed"]')).toHaveLength(0);
    expect(container.querySelectorAll('[hidden]')).toHaveLength(0);

    // Every dt/dd pair is visible (no zero-height/clipped/visually-hidden containers).
    const terms_ = container.querySelectorAll("dt, dd");
    expect(terms_.length).toBeGreaterThan(0);
    for (const el of Array.from(terms_)) {
      expect(el).toBeVisible();
    }
  });
});
