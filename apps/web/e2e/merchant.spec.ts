import { expect, test } from "@playwright/test";

/**
 * Merchant dashboard happy path: authenticate a merchant wallet,
 * create a product, generate a checkout link, view the resulting mandate,
 * view a failed collection with its human-readable reason, then create a
 * scoped integration key.
 */
const VALID_ASSET_ADDRESS = "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L";

test.describe("merchant dashboard — happy path", () => {
  test("wallet auth, product, checkout link, mandate, failed collection, scoped API key", async ({
    page,
  }) => {
    await page.goto("/merchant/connect");

    await page.getByTestId("merchant-wallet-connect-button").click();
    await expect(page.getByTestId("merchant-profile-step")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("merchant-profile-name-input").fill("Acme Coffee Roasters");
    await page.getByTestId("merchant-profile-submit-button").click();
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
    await expect(page.getByTestId("failed-collections-list")).toContainText(
      /exceeding your maximum charge/i,
    );
    await expect(page.getByTestId("failed-collections-list")).toContainText(
      "AmountExceedsChargeLimit",
    );

    // --- Create a scoped integration key ---
    await page.getByTestId("merchant-nav-developers").click();
    await page.getByTestId("api-key-name-input").fill("Checkout backend");
    await page.locator('input[name="scopes"][value="checkout_sessions:write"]').check();
    await page.getByTestId("create-api-key-button").click();

    await expect(page.getByTestId("new-scoped-api-key-banner")).toBeVisible({ timeout: 10_000 });
    const integrationKey = await page.getByTestId("new-scoped-api-key-value").innerText();
    expect(integrationKey.startsWith("sk_live_e2e_")).toBe(true);
  });
});

test.describe("merchant dashboard — accessibility", () => {
  test("the connect form and nav are operable with keyboard only, with focus always visible", async ({
    page,
  }) => {
    await page.goto("/merchant/connect");

    const connectButton = page.getByTestId("merchant-wallet-connect-button");
    await connectButton.focus();
    await expect(connectButton).toBeFocused();
    const outlineOrRing = await connectButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.outlineWidth !== "0px" || style.boxShadow !== "none";
    });
    expect(outlineOrRing).toBe(true);

    await page.keyboard.press("Enter");
    const nameInput = page.getByTestId("merchant-profile-name-input");
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill("Acme Coffee Roasters");
    const submitButton = page.getByTestId("merchant-profile-submit-button");
    await submitButton.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/merchant\/products$/, { timeout: 10_000 });

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
