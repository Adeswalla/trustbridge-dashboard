/**
 * Issue #556 — E2E coverage of the contributor register happy path with a
 * mocked Horizon.
 *
 * This spec names and documents the three Horizon account archetypes defined
 * in `tests/mocks/horizon-fixtures.ts` and drives the full UI flow for each:
 *
 *   FUNDED        → ready      (funded + authorized USDC trustline + sufficient reserve)
 *   LOW_BALANCE   → low_reserve (funded + authorized trustline, but XLM below threshold)
 *   NO_TRUSTLINE  → not_ready  (funded but no USDC trustline)
 *
 * No real Horizon, GitHub OAuth, or database is involved:
 *   • The session is a locally-signed NextAuth JWT (see `tests/e2e/env.ts`).
 *   • `/api/check` is intercepted by `page.route()` and returns fixtures
 *     derived from `HORIZON_TEST_ACCOUNTS` — the same addresses used by the
 *     integration and unit layers.  This is the correct seam: the frontend
 *     calls `/api/check` (a Next.js API route that would ordinarily call
 *     Horizon), so intercepting it is equivalent to mocking Horizon.
 *   • `/api/register` GET/POST is intercepted with a stateful fixture so the
 *     "current registration" card only appears after a real save + refetch.
 *
 * Selectors use `data-testid` throughout — copy on this page changes
 * frequently; ids are stable.
 */

import { test, expect, type Page } from "@playwright/test";

import { signInAsContributor, interceptApi } from "./helpers";
import { HORIZON_TEST_ACCOUNTS } from "../mocks/horizon-fixtures";

// ── /api/check response shapes derived from the shared Horizon fixtures ──────

/**
 * The FUNDED account has XLM + an authorized USDC trustline — fully ready.
 */
const FUNDED_CHECK_RESPONSE = {
  funded: true,
  trustline: true,
  trustline_authorized: true,
  verified: true,
  xlm_balance: "10.0000000",
  spendable_xlm_balance: "7.5000000",
  usdc_balance: "50.0000000",
  errors: [],
  readiness: "ready",
};

/**
 * The LOW_BALANCE account has a trustline but only 0.5 XLM spendable.
 * The reserve check fails → low_reserve.
 */
const LOW_BALANCE_CHECK_RESPONSE = {
  funded: true,
  trustline: true,
  trustline_authorized: true,
  verified: false,
  xlm_balance: "0.5000000",
  spendable_xlm_balance: "0.0000000",
  usdc_balance: "10.0000000",
  errors: [],
  readiness: "low_reserve",
};

/**
 * The NO_TRUSTLINE account has XLM but no USDC trustline.
 */
const NO_TRUSTLINE_CHECK_RESPONSE = {
  funded: true,
  trustline: false,
  trustline_authorized: false,
  verified: false,
  xlm_balance: "10.0000000",
  spendable_xlm_balance: "7.5000000",
  usdc_balance: "0",
  errors: [],
  readiness: "not_ready",
};

const NETWORK_FIXTURE = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  horizonNetwork: "testnet",
  sorobanUrl: "https://soroban-testnet.stellar.org",
  sorobanNetwork: "testnet",
  sorobanContractConfigured: false,
  mismatched: false,
  warnings: [],
};

// ── Route-mock helpers ────────────────────────────────────────────────────────

type CheckFixture = typeof FUNDED_CHECK_RESPONSE;

/**
 * Mount all the mocks the register page needs:
 *   - /api/settings/network
 *   - /api/stats
 *   - /api/check       → returns `checkFixture` for every call
 *   - /api/register    → stateful GET/POST so saving updates the card
 *
 * Returns a `savePayloads` array that fills as POSTs arrive, for assertion.
 */
async function mountRegisterMocks(
  page: Page,
  checkFixture: CheckFixture,
  existingRegistration: { stellarAddress: string; readiness: string } | null = null
): Promise<{ savePayloads: Array<Record<string, unknown>> }> {
  const savePayloads: Array<Record<string, unknown>> = [];
  const saved = { registration: existingRegistration as { stellarAddress: string; readiness: string } | null };

  await interceptApi(page, "**/api/settings/network", NETWORK_FIXTURE);
  await interceptApi(page, "**/api/stats", {
    totalContributors: 1,
    readyCount: 1,
    readyPercent: 100,
  });

  // /api/check — always returns the fixture for this scenario
  await page.route("**/api/check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(checkFixture),
    });
  });

  // /api/register — stateful: GET serves what was last saved, POST records it
  await page.route("**/api/register", async (route) => {
    const method = route.request().method();

    if (method === "POST") {
      const payload = (route.request().postDataJSON() ?? {}) as Record<
        string,
        unknown
      >;
      savePayloads.push(payload);

      const address = String(payload.stellarAddress ?? "");
      saved.registration = {
        stellarAddress: address,
        readiness: checkFixture.readiness,
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          registration: {
            stellarAddress: address,
            readiness: checkFixture.readiness,
            funded: checkFixture.funded,
            trustline: checkFixture.trustline,
            trustline_authorized: checkFixture.trustline_authorized,
            verified: checkFixture.verified,
            xlm_balance: checkFixture.xlm_balance,
            spendable_xlm_balance: checkFixture.spendable_xlm_balance,
            checklistCompleted: { register_address: true },
          },
          checklistCompleted: { register_address: true },
        }),
      });
      return;
    }

    // GET
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        saved.registration
          ? { registration: saved.registration }
          : { registration: null, checklistCompleted: {} }
      ),
    });
  });

  return { savePayloads };
}

// ── Full happy path — FUNDED account (ready) ─────────────────────────────────

test.describe("Register happy path — FUNDED account (Horizon: ready)", () => {
  test.beforeEach(async ({ page, context }) => {
    await signInAsContributor(context, page);
  });

  test("pasting the funded address shows the ready badge", async ({ page }) => {
    await mountRegisterMocks(page, FUNDED_CHECK_RESPONSE);
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.FUNDED
    );

    await expect(page.getByTestId("readiness-badge-ready")).toBeVisible();
  });

  test("the check request carries the correct Horizon test address", async ({
    page,
  }) => {
    await mountRegisterMocks(page, FUNDED_CHECK_RESPONSE);
    await page.goto("/register");

    const checkRequest = page.waitForRequest(
      (req) =>
        req.url().includes("/api/check") && req.method() === "POST"
    );

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.FUNDED
    );

    const req = await checkRequest;
    expect(req.postDataJSON()).toMatchObject({
      address: HORIZON_TEST_ACCOUNTS.FUNDED,
    });
  });

  test("full end-to-end: fill → check → save → confirmation banner → card", async ({
    page,
  }) => {
    const { savePayloads } = await mountRegisterMocks(page, FUNDED_CHECK_RESPONSE);
    await page.goto("/register");

    // Step 1: address input renders and save is disabled before typing
    await expect(page.getByTestId("register-page")).toBeVisible();
    await expect(page.getByTestId("save-registration")).toBeDisabled();

    // Step 2: paste the funded address — /api/check fires, ready badge appears
    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.FUNDED
    );
    await expect(page.getByTestId("readiness-badge-ready")).toBeVisible();
    await expect(page.getByTestId("save-registration")).toBeEnabled();

    // Step 3: click Save — /api/register POST fires
    await page.getByTestId("save-registration").click();

    // Step 4: success banner appears
    await expect(page.getByTestId("registration-saved")).toBeVisible();
    await expect(page.getByTestId("registration-saved")).toContainText(
      /saved successfully/i
    );

    // Step 5: POST payload carried the right address
    expect(savePayloads).toHaveLength(1);
    expect(savePayloads[0]).toMatchObject({
      stellarAddress: HORIZON_TEST_ACCOUNTS.FUNDED,
    });

    // Step 6: current-registration card shows the saved address (mutation
    // invalidated the query and the stateful GET now returns the saved row)
    await expect(
      page.getByTestId("current-registration-address")
    ).toHaveText(HORIZON_TEST_ACCOUNTS.FUNDED);
  });

  test("readiness panel shows spendable XLM balance for a ready account", async ({
    page,
  }) => {
    await mountRegisterMocks(page, FUNDED_CHECK_RESPONSE);
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.FUNDED
    );

    const result = page.getByTestId("address-check-result");
    await expect(result).toBeVisible();
    // The spendable balance from the fixture is 7.5 XLM
    await expect(result).toContainText("7.5");
  });

  test("no registration error banner on a successful save", async ({ page }) => {
    await mountRegisterMocks(page, FUNDED_CHECK_RESPONSE);
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.FUNDED
    );
    await page.getByTestId("save-registration").click();

    await expect(page.getByTestId("registration-saved")).toBeVisible();
    await expect(page.getByTestId("registration-error")).toHaveCount(0);
  });
});

// ── Low-reserve path ─────────────────────────────────────────────────────────

test.describe("Register happy path — LOW_BALANCE account (Horizon: low_reserve)", () => {
  test.beforeEach(async ({ page, context }) => {
    await signInAsContributor(context, page);
  });

  test("pasting the low-balance address shows the low_reserve badge", async ({
    page,
  }) => {
    await mountRegisterMocks(page, LOW_BALANCE_CHECK_RESPONSE);
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.LOW_BALANCE
    );

    await expect(
      page.getByTestId("readiness-badge-low_reserve")
    ).toBeVisible();
  });

  test("save still completes with a low-reserve address", async ({ page }) => {
    const { savePayloads } = await mountRegisterMocks(
      page,
      LOW_BALANCE_CHECK_RESPONSE
    );
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.LOW_BALANCE
    );
    await page.getByTestId("save-registration").click();

    await expect(page.getByTestId("registration-saved")).toBeVisible();
    expect(savePayloads[0]).toMatchObject({
      stellarAddress: HORIZON_TEST_ACCOUNTS.LOW_BALANCE,
    });

    await expect(
      page.getByTestId("current-registration-address")
    ).toHaveText(HORIZON_TEST_ACCOUNTS.LOW_BALANCE);
  });

  test("check request sends the low-balance Horizon address", async ({
    page,
  }) => {
    await mountRegisterMocks(page, LOW_BALANCE_CHECK_RESPONSE);
    await page.goto("/register");

    const checkRequest = page.waitForRequest(
      (req) => req.url().includes("/api/check") && req.method() === "POST"
    );

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.LOW_BALANCE
    );

    const req = await checkRequest;
    expect(req.postDataJSON()).toMatchObject({
      address: HORIZON_TEST_ACCOUNTS.LOW_BALANCE,
    });
  });
});

// ── No-trustline path ─────────────────────────────────────────────────────────

test.describe("Register happy path — NO_TRUSTLINE account (Horizon: not_ready)", () => {
  test.beforeEach(async ({ page, context }) => {
    await signInAsContributor(context, page);
  });

  test("pasting the no-trustline address shows the not_ready badge", async ({
    page,
  }) => {
    await mountRegisterMocks(page, NO_TRUSTLINE_CHECK_RESPONSE);
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE
    );

    await expect(
      page.getByTestId("readiness-badge-not_ready")
    ).toBeVisible();
  });

  test("the guidance panel is visible for an account with no trustline", async ({
    page,
  }) => {
    await mountRegisterMocks(page, NO_TRUSTLINE_CHECK_RESPONSE);
    await page.goto("/register");

    // TrustlineGuidancePanel is always visible on /register
    const guidance = page.getByTestId("trustline-guidance");
    await expect(guidance).toBeVisible();
    await expect(guidance).toContainText(/usdc/i);
  });

  test("save still completes for a not-ready address (contributors can fix later)", async ({
    page,
  }) => {
    const { savePayloads } = await mountRegisterMocks(
      page,
      NO_TRUSTLINE_CHECK_RESPONSE
    );
    await page.goto("/register");

    await page.getByTestId("stellar-address-input").fill(
      HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE
    );
    await page.getByTestId("save-registration").click();

    await expect(page.getByTestId("registration-saved")).toBeVisible();
    expect(savePayloads[0]).toMatchObject({
      stellarAddress: HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE,
    });

    await expect(
      page.getByTestId("current-registration-address")
    ).toHaveText(HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE);
  });
});

// ── Address-switching: existing registration pre-populated ───────────────────

test.describe("Register happy path — pre-existing registration", () => {
  test.beforeEach(async ({ page, context }) => {
    await signInAsContributor(context, page);
  });

  test("current-registration card shows the pre-existing address on load", async ({
    page,
  }) => {
    await mountRegisterMocks(
      page,
      FUNDED_CHECK_RESPONSE,
      {
        stellarAddress: HORIZON_TEST_ACCOUNTS.FUNDED,
        readiness: "ready",
      }
    );
    await page.goto("/register");

    // Card should appear even before any input because GET /api/register
    // already returns a saved registration.
    await expect(
      page.getByTestId("current-registration-address")
    ).toHaveText(HORIZON_TEST_ACCOUNTS.FUNDED);
  });

  test("switching to another address replaces the registration card", async ({
    page,
  }) => {
    const { savePayloads } = await mountRegisterMocks(
      page,
      NO_TRUSTLINE_CHECK_RESPONSE,
      {
        stellarAddress: HORIZON_TEST_ACCOUNTS.FUNDED,
        readiness: "ready",
      }
    );
    await page.goto("/register");

    // Existing registration card shows FUNDED address
    await expect(
      page.getByTestId("current-registration-address")
    ).toHaveText(HORIZON_TEST_ACCOUNTS.FUNDED);

    // Fill the NO_TRUSTLINE address and save
    await page
      .getByTestId("stellar-address-input")
      .fill(HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE);
    await page.getByTestId("save-registration").click();

    await expect(page.getByTestId("registration-saved")).toBeVisible();
    expect(savePayloads[0]).toMatchObject({
      stellarAddress: HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE,
    });

    // Card now shows the new address
    await expect(
      page.getByTestId("current-registration-address")
    ).toHaveText(HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE);
  });
});
