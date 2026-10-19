/**
 * Rate-limit header tests for POST /api/register (#552).
 *
 * Verifies that:
 *   - Standard RateLimit-* response headers are present on allowed requests.
 *   - A 429 with Retry-After is returned when the limit is exhausted.
 *   - The rate limiter is per-IP (a different IP starts a fresh window).
 *   - CSRF and auth checks still fire before the rate limit when the origin
 *     is wrong (i.e. rate-limit does not bypass CSRF).
 *
 * The rate-limit store is reset between each test via `resetRateLimit()` so
 * tests are independent regardless of execution order.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/register/route";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/horizon", () => ({
  checkStellarAddress: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    registrationConflict: {
      create: vi.fn().mockResolvedValue({}),
    },
    user: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn().mockResolvedValue({ success: true, errors: [] }),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ban-service", () => ({
  isUserBanned: vi.fn().mockResolvedValue({ banned: false }),
}));

vi.mock("@/lib/address-history", () => ({
  recordInitialAddress: vi.fn().mockResolvedValue(undefined),
  recordAddressChange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/address-anomaly", () => ({
  evaluateAndAuditAddressChangeAnomaly: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/analytics", () => ({
  trackServerRegistrationCreated: vi.fn(),
  trackServerRegistrationUpdated: vi.fn(),
}));

vi.mock("@/lib/freeze-window", () => ({
  enforceFreezeWindowGuard: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock("@/lib/maintainers", () => ({
  recordRegistrationConflict: vi.fn().mockResolvedValue(undefined),
}));

// Do NOT mock @/lib/rate-limit — we test the real implementation.
// We DO call resetRateLimit() between tests to keep state clean.

// ── Imports ───────────────────────────────────────────────────────────────────

import { getServerSession } from "next-auth";
import { checkStellarAddress } from "@/lib/horizon";
import { prisma } from "@/lib/prisma";
import { resetRateLimit } from "@/lib/rate-limit";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const VALID_ADDRESS =
  "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS";

const HORIZON_READY = {
  funded: true,
  trustline: true,
  trustline_authorized: true,
  verified: true,
  xlm_balance: "10",
  spendable_xlm_balance: "7.5",
  usdc_balance: "50",
  errors: [],
  readiness: "ready" as const,
};

const REGISTRATION_ROW = {
  id: "reg-1",
  userId: "user-1",
  stellarAddress: VALID_ADDRESS,
  funded: true,
  trustlineReady: true,
  trustlineAuthorized: true,
  xlmBalance: "10",
  spendableXlmBalance: "7.5",
  usdcBalance: "50",
  horizonLatencyMs: null,
  checklistCompleted: { register_address: true },
  notes: null,
  tags: [],
  lastCheckedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function makeRequest(ip: string = "1.2.3.4", body: unknown = { stellarAddress: VALID_ADDRESS }) {
  return new NextRequest("http://localhost:3000/api/register", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "content-type": "application/json",
      // Simulate a real client IP so the rate limiter keys on this, not "unknown".
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function mockAuthenticatedSession() {
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id: "user-1", githubUsername: "contributor" },
  } as never);
}

function mockHorizonAndDb() {
  vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
  vi.mocked(checkStellarAddress).mockResolvedValue(HORIZON_READY as never);
  vi.mocked(prisma.registration.upsert).mockResolvedValue(
    REGISTRATION_ROW as never
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/register — rate-limit headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset rate-limit counters between tests so they are independent.
    resetRateLimit();
  });

  it("includes RateLimit-Limit header on an allowed request", async () => {
    mockAuthenticatedSession();
    mockHorizonAndDb();

    const res = await POST(makeRequest("10.0.0.1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBeTruthy();
  });

  it("includes RateLimit-Remaining header on an allowed request", async () => {
    mockAuthenticatedSession();
    mockHorizonAndDb();

    const res = await POST(makeRequest("10.0.0.2"));
    expect(res.status).toBe(200);
    const remaining = res.headers.get("RateLimit-Remaining");
    expect(remaining).not.toBeNull();
    expect(Number(remaining)).toBeGreaterThanOrEqual(0);
  });

  it("includes RateLimit-Reset header on an allowed request", async () => {
    mockAuthenticatedSession();
    mockHorizonAndDb();

    const res = await POST(makeRequest("10.0.0.3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Reset")).not.toBeNull();
  });

  it("RateLimit-Remaining decrements with each request from the same IP", async () => {
    const IP = "10.0.1.1";
    mockAuthenticatedSession();
    mockHorizonAndDb();
    const first = await POST(makeRequest(IP));
    expect(first.status).toBe(200);
    const remainingAfterFirst = Number(first.headers.get("RateLimit-Remaining"));

    // Reset DB mocks for the second call but keep the rate-limit counter.
    mockAuthenticatedSession();
    mockHorizonAndDb();
    const second = await POST(makeRequest(IP));
    expect(second.status).toBe(200);
    const remainingAfterSecond = Number(second.headers.get("RateLimit-Remaining"));

    expect(remainingAfterSecond).toBe(remainingAfterFirst - 1);
  });

  it("returns 429 with Retry-After when the per-IP limit is exhausted", async () => {
    const IP = "10.0.2.1";
    const MAX = 10; // matches RATE_LIMIT_MAX_REQUESTS default

    // Exhaust the rate limit for this IP.
    for (let i = 0; i < MAX; i++) {
      mockAuthenticatedSession();
      mockHorizonAndDb();
      const res = await POST(makeRequest(IP));
      expect(res.status).toBe(200);
    }

    // Next request from the same IP should be blocked.
    mockAuthenticatedSession();
    const blocked = await POST(makeRequest(IP));
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("returns 429 with a machine-readable error body", async () => {
    const IP = "10.0.3.1";
    const MAX = 10;

    for (let i = 0; i < MAX; i++) {
      mockAuthenticatedSession();
      mockHorizonAndDb();
      await POST(makeRequest(IP));
    }

    mockAuthenticatedSession();
    const res = await POST(makeRequest(IP));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; code: string };
    expect(body.error).toMatch(/too many/i);
    expect(body.code).toBeTruthy();
  });

  it("does not share rate-limit state across different IPs", async () => {
    const IP_A = "10.0.4.1";
    const IP_B = "10.0.4.2";
    const MAX = 10;

    // Exhaust IP_A.
    for (let i = 0; i < MAX; i++) {
      mockAuthenticatedSession();
      mockHorizonAndDb();
      await POST(makeRequest(IP_A));
    }

    // IP_B should still be allowed.
    mockAuthenticatedSession();
    mockHorizonAndDb();
    const res = await POST(makeRequest(IP_B));
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Remaining")).not.toBeNull();
  });

  it("returns 403 (CSRF) before the rate limiter for cross-origin requests", async () => {
    // Cross-origin request should be rejected by CSRF, not rate limiter.
    const req = new NextRequest("http://localhost:3000/api/register", {
      method: "POST",
      headers: {
        origin: "https://evil.com",
        host: "localhost:3000",
        "content-type": "application/json",
        "x-forwarded-for": "10.0.5.1",
      },
      body: JSON.stringify({ stellarAddress: VALID_ADDRESS }),
    });

    const res = await POST(req);
    // CSRF fires before rate limiting — should be 403, not 429.
    expect(res.status).toBe(403);
    // getServerSession must not have been called (CSRF short-circuits).
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("rate-limit headers are not present on a 401 (unauthenticated) response", async () => {
    // 401 is returned after the rate-limit check passes (rate limit allows the
    // request through, then session check fails).  Headers should still be
    // present because the request was counted.
    vi.mocked(getServerSession).mockResolvedValue(null);

    const res = await POST(makeRequest("10.0.6.1"));
    expect(res.status).toBe(401);
    // The rate-limit check passed and incremented the counter, so the
    // 401 response is NOT the rate-limit guard — headers are on the 200
    // and 429 responses that the rate-limit guard itself emits.
    // Unauthenticated responses are produced by the session guard which
    // runs after the rate-limit check. That guard doesn't add RL headers
    // (by design — matching /api/check behaviour).
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });
});

// ── Cache-tag invalidation on successful save ─────────────────────────────────

describe("POST /api/register — contributor cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimit();
  });

  it("calls invalidateContributorListCaches after a successful save", async () => {
    // We test the side-effect by importing the real cache-tags module and
    // checking that the in-process stores are invalidated.
    const { contributorCache, statsCache } = await import("@/lib/cache");

    // Seed fake entries so we can verify they are evicted.
    contributorCache.set("contributor:test", { fake: true });
    statsCache.set("stats:dashboard", { fake: true });

    expect(contributorCache.getStats().size).toBe(1);
    expect(statsCache.getStats().size).toBe(1);

    mockAuthenticatedSession();
    mockHorizonAndDb();

    const res = await POST(makeRequest("10.1.0.1"));
    expect(res.status).toBe(200);

    // After a successful save both caches should be empty.
    expect(contributorCache.getStats().size).toBe(0);
    expect(statsCache.getStats().size).toBe(0);
  });
});
