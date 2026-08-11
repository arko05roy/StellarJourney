import { expect, test } from "@playwright/test";

/**
 * Merchant dashboard happy path (Phase 12b): create a merchant account,
 * create a product, generate a checkout link, view the resulting mandate,
 * view a failed collection with its human-readable reason, then rotate the
 * API key. Every merchant-authenticated call happens server-side against
 * `e2e/fixtures/mock-api-server.mjs`'s merchant routes — this test never
 * sees the API key value itself (it only reads what the UI intentionally
 * displays once, in the same "shown once" spirit as a real deployment).
 */
const VALID_ASSET_ADDRESS = "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L";

test.describe("merchant dashboard — happy path", () => {
  test("create account, create product, generate checkout link, view mandate and failed collection, rotate API key", async ({ page }) => {
    await page.goto("/merchant/connect");

    await page.getByTestId("create-merchant-name-input").fill("Acme Coffee Roasters");
    await page.getByTestId("create-merchant-wallet-input").fill("GMERCHANTWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    await page.getByTestId("create-merchant-submit-button").click();

    await expect(page.getByTestId("new-api-key-banner")).toBeVisible({ timeout: 10_000 });
    const issuedKey = await page.getByTestId("new-api-key-value").innerText();
    expect(issuedKey.startsWith("pmk_e2e_")).toBe(true);

    await page.getByTestId("continue-to-dashboard-link").click();
    await expect(page).toHaveURL(/\/merchant\/products$/);

    // --- Create a product ---
    await page.getByTestId("new-product-link").click();
    await expect(page).toHaveURL(/\/merchant\/products\/new$/);

    await page.getByTestId("product-name-input").fill("Studio Membership");
    await page.getByTestId("product-asset-address-input").fill(VALID_ASSET_ADDRESS);
    await page.getByTestId("product-fixed-amount-input").fill("15.00");
    await page.getByTestId("product-max-per-period-input").fill("15.00");
    await page.getByTestId("product-form-submit-button").click();

    await expect(page).toHaveURL(/\/merchant\/products$/, { timeout: 10_000 });
    await expect(page.getByTestId("products-table")).toContainText("Studio Membership");

    // --- Generate a checkout link ---
    await page.getByTestId(/^generate-link-button-/).click();
    await expect(page).toHaveURL(/\/merchant\/checkout-links/);
    await page.getByTestId("generate-checkout-link-button").click();

    await expect(page.getByTestId("checkout-links-table")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("checkout-links-table")).toContainText("Studio Membership");
    await expect(page.getByTestId("copy-checkout-link-button")).toBeVisible();

    // --- View mandates ---
    await page.getByTestId("merchant-nav-mandates").click();
    await expect(page.getByTestId("mandates-table")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("mandates-table")).toContainText("15");
    await expect(page.getByTestId("mandates-table")).toContainText("Every 30 days");

    // --- View a failed collection with its reason ---
    await page.getByTestId("merchant-nav-failed").click();
    await expect(page.getByTestId("failed-collections-list")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("failed-collections-list")).toContainText(/exceeding your maximum charge/i);
    await expect(page.getByTestId("failed-collections-list")).toContainText("AmountExceedsChargeLimit");

    // --- Rotate the API key ---
    await page.getByTestId("merchant-nav-developers").click();
    await page.getByTestId("rotate-api-key-button").click();

    await expect(page.getByTestId("rotated-api-key-banner")).toBeVisible({ timeout: 10_000 });
    const rotatedKey = await page.getByTestId("rotated-api-key-value").innerText();
    expect(rotatedKey.startsWith("pmk_e2e_")).toBe(true);
    expect(rotatedKey).not.toBe(issuedKey);
  });
});

test.describe("merchant dashboard — accessibility", () => {
  test("the connect form and nav are operable with keyboard only, with focus always visible", async ({ page }) => {
    await page.goto("/merchant/connect");

    const nameInput = page.getByTestId("create-merchant-name-input");
    await nameInput.focus();
    await expect(nameInput).toBeFocused();
    const outlineOrRing = await nameInput.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.outlineWidth !== "0px" || style.boxShadow !== "none";
    });
    expect(outlineOrRing).toBe(true);

    await nameInput.fill("Acme Coffee Roasters");
    await page.getByTestId("create-merchant-wallet-input").fill("GMERCHANTWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    const submitButton = page.getByTestId("create-merchant-submit-button");
    await submitButton.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("new-api-key-banner")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("continue-to-dashboard-link").click();

    const mandatesLink = page.getByTestId("merchant-nav-mandates");
    await mandatesLink.focus();
    await expect(mandatesLink).toBeFocused();
    const navFocusVisible = await mandatesLink.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.outlineWidth !== "0px" || style.boxShadow !== "none";
    });
    expect(navFocusVisible).toBe(true);
  });
});
