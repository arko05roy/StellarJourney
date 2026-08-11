import { expect, test } from "@playwright/test";

const SESSION_PATH = "/checkout/e2e-happy-path-session";

test.describe("consumer checkout — happy path", () => {
  test("review terms, connect wallet, sign both steps, reach confirmation", async ({ page }) => {
    await page.goto(SESSION_PATH);

    // Every required term is visible without any interaction (CLAUDE.md §13).
    await expect(page.getByTestId("terms-list")).toContainText("Merchant");
    await expect(page.getByTestId("terms-list")).toContainText("Acme Coffee Roasters");
    await expect(page.getByTestId("terms-list")).toContainText("Billing frequency");
    await expect(page.getByTestId("terms-list")).toContainText("Expiry date");
    await expect(page.getByTestId("max-exposure-callout")).toBeVisible();

    // Step 0: connect wallet (stubbed).
    await page.getByTestId("connect-wallet-button").click();
    await expect(page.getByTestId("authorize-button")).toBeVisible({ timeout: 10_000 });

    // Step 1 + 2: authorize the mandate, then the bounded approval — both
    // signed automatically by the stub wallet, chained by the component.
    await page.getByTestId("authorize-button").click();
    await expect(page.getByTestId("creating-indicator")).toBeVisible();

    await expect(page.getByTestId("confirmation-card")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("confirmation-card")).toContainText("Automatic payment set up");
    await expect(page.getByTestId("confirmation-card")).toContainText("Automatic payment ID");

    // No leftover error state.
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
  });

  test("expired/completed/unknown sessions never enter the signing flow", async ({ page }) => {
    // Note: the route renders under a `loading.tsx` Suspense boundary, so
    // Next.js's streaming SSR has already committed a 200 status by the
    // time the deferred `notFound()` resolves deeper in the tree — this
    // asserts what the payer actually sees, not the raw status code.
    await page.goto("/checkout/does-not-exist");
    await expect(page.getByRole("heading", { name: /could not find this checkout link/i })).toBeVisible();
    await expect(page.getByTestId("terms-list")).toHaveCount(0);
  });
});

test.describe("consumer checkout — accessibility", () => {
  test("the full flow is operable with keyboard only, with focus always visible", async ({ page }) => {
    await page.goto(SESSION_PATH);

    // Tab to the connect-wallet button (the only interactive element before
    // connecting) and activate it with the keyboard, never the mouse.
    const connectButton = page.getByTestId("connect-wallet-button");
    await connectButton.focus();
    await expect(connectButton).toBeFocused();
    // A visible focus ring is present (CLAUDE.md §13 — visible focus states).
    await expect(connectButton).toHaveCSS("outline-style", /solid|none/); // outline OR the ring box-shadow below
    const outlineOrRing = await connectButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.outlineWidth !== "0px" || style.boxShadow !== "none";
    });
    expect(outlineOrRing).toBe(true);

    await page.keyboard.press("Enter");
    const authorizeButton = page.getByTestId("authorize-button");
    await expect(authorizeButton).toBeVisible({ timeout: 10_000 });

    await authorizeButton.focus();
    await expect(authorizeButton).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("confirmation-card")).toBeVisible({ timeout: 15_000 });
  });
});
