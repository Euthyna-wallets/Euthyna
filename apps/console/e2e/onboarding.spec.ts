import { expect, test } from "@playwright/test";

/**
 * Funded path only. Requires the API and PostgreSQL to be running, plus:
 *   E2E=1
 *   VITE_E2E_NEAR_ACCOUNT_ID / VITE_E2E_NEAR_PRIVATE_KEY (funded, >= 10 NEAR)
 *   VITE_E2E_EVM_PRIVATE_KEY (Base Sepolia funded)
 * The full treasury + mandate + payment journey is documented in
 * docs/uat-console.md and runs once #6 provides the payment worker.
 */
test.describe("injected signers", () => {
  test.skip(process.env.E2E !== "1", "set E2E=1 and funded test keys");

  test("signs DAO creation with the injected NEAR/EVM signers", async ({ page, request }) => {
    const email = `e2e-${Date.now()}@acme.test`;
    const password = "e2e-password-123";
    await request.post("http://localhost:3000/api/auth/sign-up/email", {
      headers: { origin: "http://localhost:5173", "content-type": "application/json" },
      data: { email, password, name: "E2E Founder" },
    });

    await page.goto("/");
    await page.evaluate(
      async ({ email, password }) => {
        await fetch("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
      },
      { email, password },
    );
    await page.reload();
    await expect(page.getByText("Create your company")).toBeVisible();

    const daoName = `e2e-${Date.now().toString(36)}`;
    await page.getByPlaceholder("Company name").fill(daoName);
    await page.getByRole("button", { name: "Create company" }).click();
    await expect(page.getByText("2. Member wallets")).toBeVisible();

    const nearAccount = process.env.VITE_E2E_NEAR_ACCOUNT_ID!;
    const evmAddress = await page.evaluate(async () => {
      const provider = window.ethereum;
      if (!provider) throw new Error("EVM provider missing");
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      return accounts[0]!;
    });
    await page.getByPlaceholder("alice.testnet").fill(nearAccount);
    await page.getByPlaceholder("0x…").fill(evmAddress);
    await page.getByRole("button", { name: "Link my wallets" }).click();

    await page.getByPlaceholder("founder.testnet").last().fill(nearAccount);
    await page.getByRole("button", { name: "Build plan" }).click();
    await expect(page.getByText("Treasury transactions")).toBeVisible({ timeout: 90_000 });
    await page.getByPlaceholder("founder.testnet").last().fill(nearAccount);
    await page.getByRole("button", { name: "Sign DAO creation" }).click();
    await expect(page.getByText("1 transaction(s) signed")).toBeVisible({ timeout: 90_000 });
  });
});
