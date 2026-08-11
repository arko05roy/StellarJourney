import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HomePage from "./page";

vi.mock("@/components/landing/landing-motion", () => ({
  LandingMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("landing page", () => {
  it("replaces the scaffold with working product entry points", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Your payments. Your terms." }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Phase 0 scaffold/i)).not.toBeInTheDocument();

    const dashboardLinks = screen.getAllByRole("link", { name: /Open dashboard/i });
    const merchantLinks = screen.getAllByRole("link", { name: "Merchant access" });

    expect(dashboardLinks.every((link) => link.getAttribute("href") === "/dashboard")).toBe(true);
    expect(merchantLinks.every((link) => link.getAttribute("href") === "/merchant/connect")).toBe(
      true,
    );
  });
});
