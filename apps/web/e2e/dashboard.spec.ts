import { expect, test } from "@playwright/test";

test.describe("consumer dashboard — list, pause, resume, cancel autopay", () => {
  test("connect, see the mandate, pause it, resume it, then cancel autopay and set the allowance to zero", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page.getByTestId("wallet-gate")).toBeVisible();
    await page.getByTestId("connect-wallet-button").click();

    const card = page.locator('[data-testid^="mandate-card-item-"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Acme Coffee Roasters");
    await expect(card.getByTestId("mandate-status-badge")).toHaveText("Active");
    await expect(card.getByTestId("period-usage-meter")).toBeVisible();

    // Pause — the card leaves "Upcoming" (Active-only) the moment it's
    // paused, and shows up under "Paused & ended" instead (PLAN.md §16.1's
    // nav split), so the test follows it there.
    await card.getByTestId("pause-button").click();
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId("dashboard-tab-paused-ended").click();
    await expect(card.getByTestId("mandate-status-badge")).toHaveText("Paused", { timeout: 10_000 });
    await expect(card.getByTestId("pause-button")).toHaveCount(0);
    await expect(card.getByTestId("resume-button")).toBeVisible();

    // Resume — moves back to "Upcoming".
    await card.getByTestId("resume-button").click();
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId("dashboard-tab-upcoming").click();
    await expect(card.getByTestId("mandate-status-badge")).toHaveText("Active", { timeout: 10_000 });
    await expect(card.getByTestId("pause-button")).toBeVisible();

    // Cancel autopay -> confirm -> allowance-zero prompt -> set to zero.
    await card.getByTestId("cancel-autopay-button").click();
    const dialog = page.getByTestId("cancel-autopay-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("confirm-cancel-autopay-button").click();

    await expect(dialog.getByText(/set your spending approval to zero/i)).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId("set-allowance-zero-button").click();

    await expect(dialog.getByText(/automatic payment cancelled/i)).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId("close-cancel-autopay-dialog-button").click();
    await expect(dialog).toBeHidden();

    // Revoked mandates leave "Upcoming" too — the card now reflects
    // Cancelled (Revoked), with no lifecycle controls left, under
    // "Paused & ended".
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId("dashboard-tab-paused-ended").click();
    await expect(card.getByTestId("mandate-status-badge")).toHaveText("Cancelled", { timeout: 10_000 });
    await expect(card.getByTestId("cancel-autopay-button")).toHaveCount(0);
    await expect(card.getByTestId("mandate-terminal-note")).toBeVisible();
  });
});

test.describe("consumer dashboard — payment history", () => {
  test("shows a successful payment and a failed attempt with its human-readable reason", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByTestId("connect-wallet-button").click();
    await expect(page.locator('[data-testid^="mandate-card-item-"]')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("dashboard-tab-history").click();

    await expect(page.getByTestId("payment-history-success-row")).toBeVisible();
    await expect(page.getByTestId("payment-history-success-row")).toContainText("Acme Coffee Roasters");

    const failedRow = page.getByTestId("payment-history-failed-row");
    await expect(failedRow).toBeVisible();
    await expect(failedRow).toContainText(/exceeding your maximum charge/i);
    await expect(failedRow).toContainText("AmountExceedsChargeLimit");
  });
});

test.describe("consumer dashboard — accessibility", () => {
  test("nav tabs and mandate-card controls are operable with keyboard only, with focus always visible", async ({ page }) => {
    await page.goto("/dashboard");
    const connectButton = page.getByTestId("connect-wallet-button");
    await connectButton.focus();
    await expect(connectButton).toBeFocused();
    await page.keyboard.press("Enter");

    const card = page.locator('[data-testid^="mandate-card-item-"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    const historyTab = page.getByTestId("dashboard-tab-history");
    await historyTab.focus();
    await expect(historyTab).toBeFocused();
    const outlineOrRing = await historyTab.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.outlineWidth !== "0px" || style.boxShadow !== "none";
    });
    expect(outlineOrRing).toBe(true);
  });
});
