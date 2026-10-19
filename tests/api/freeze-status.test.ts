/**
 * API tests for GET /api/freeze-status — issue #519
 *
 * Validates:
 *   - 200 with freeze state when under the rate limit
 *   - 429 with JSON error body when the per-IP limit is exceeded
 *   - RateLimit-Limit / RateLimit-Remaining headers present on 200 and 429
 *   - Retry-After header present on 429
 *   - Cache-Control is preserved (unchanged) on 200 responses
 *   - Cache-Control is absent on 429 responses
 *   - Rate limits are per-IP (different IPs are independent)
 *   - Unknown client IP uses safe fallback — route does not crash
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimit } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/freeze-window", () => ({
  isFreezeWindowActive: vi.fn(() => ({
    active: false,
    reason: undefined,
    start: undefined,
    end: undefined,
  })),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn().mockResolvedValue(false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(ip?: string, origin?: string): NextRequest {
  const headers = new Headers();
  if (ip) headers.set("x-forwarded-for", ip);
  if (origin) headers.set("origin", origin);
  return new NextRequest("http://localhost/api/freeze-status", { headers });
}

async function callGet(req: NextRequest) {
  // Dynamic import after mocks are applied
  const { GET } = await import("@/app/api/freeze-status/route");
  return GET(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/freeze-status — rate limiting (#519)", () => {
  beforeEach(() => {
    resetRateLimit();
    vi.resetModules();
  });

  afterEach(() => {
    resetRateLimit();
    vi.restoreAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns 200 with active:false when freeze is inactive", async () => {
    const res = await callGet(makeRequest("1.2.3.4"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ active: false });
  });

  it("allows only the configured origin to read freeze status cross-origin", async () => {
    const allowed = await callGet(
      makeRequest("1.2.3.6", "https://github.com")
    );
    const denied = await callGet(
      makeRequest("1.2.3.7", "https://untrusted.example")
    );

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://github.com"
    );
    expect(allowed.headers.get("vary")).toContain("Origin");
    expect(denied.status).toBe(200);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("vary")).toContain("Origin");
  });

  it("returns 200 with active:true when freeze is active", async () => {
    const { isFreezeWindowActive } = await import("@/lib/freeze-window");
    vi.mocked(isFreezeWindowActive).mockReturnValueOnce({
      active: true,
      reason: "Wave payout freeze",
      start: new Date("2026-09-24T18:00:00.000Z"),
      end: new Date("2026-09-25T06:00:00.000Z"),
    });
    const res = await callGet(makeRequest("1.2.3.5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.reason).toBe("Wave payout freeze");
    expect(body.start).toMatch(/2026-09-24/);
    expect(body.end).toMatch(/2026-09-25/);
  });

  // ── Rate-limit headers on 200 ──────────────────────────────────────────────

  it("includes RateLimit-Limit and RateLimit-Remaining headers on 200", async () => {
    const res = await callGet(makeRequest("2.2.2.2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBe("60");
    expect(res.headers.get("RateLimit-Remaining")).not.toBeNull();
  });

  it("preserves Cache-Control on 200 responses", async () => {
    const res = await callGet(makeRequest("3.3.3.3"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("Cache-Control");
    expect(cc).toContain("max-age=15");
    expect(cc).toContain("stale-while-revalidate=30");
  });

  // ── 429 path ──────────────────────────────────────────────────────────────

  it("returns 429 with RATE_LIMIT_EXCEEDED when limit is exhausted", async () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 60; i++) {
      await callGet(makeRequest(ip));
    }
    const res = await callGet(makeRequest(ip));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "Too many requests",
      code: "RATE_LIMIT_EXCEEDED",
    });
  });

  it("includes RateLimit-Limit, RateLimit-Remaining, and Retry-After headers on 429", async () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 60; i++) {
      await callGet(makeRequest(ip));
    }
    const res = await callGet(makeRequest(ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("RateLimit-Limit")).toBe("60");
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("does NOT include Cache-Control on 429 responses", async () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 60; i++) {
      await callGet(makeRequest(ip));
    }
    const res = await callGet(makeRequest(ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("preserves the allowlisted CORS origin on 429 responses", async () => {
    const ip = "10.0.0.4";
    for (let i = 0; i < 60; i++) {
      await callGet(makeRequest(ip, "https://github.com"));
    }

    const res = await callGet(makeRequest(ip, "https://github.com"));

    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://github.com"
    );
    expect(res.headers.get("vary")).toContain("Origin");
  });

  // ── Per-IP isolation ──────────────────────────────────────────────────────

  it("limits are per-IP — different IPs have independent counters", async () => {
    const ipA = "20.0.0.1";
    const ipB = "20.0.0.2";

    for (let i = 0; i < 60; i++) {
      await callGet(makeRequest(ipA));
    }
    const resA = await callGet(makeRequest(ipA));
    expect(resA.status).toBe(429);

    const resB = await callGet(makeRequest(ipB));
    expect(resB.status).toBe(200);
  });

  // ── Unknown IP fallback ────────────────────────────────────────────────────

  it("does not crash when no IP header is present (uses unknown fallback)", async () => {
    const res = await callGet(makeRequest());
    expect([200, 429]).toContain(res.status);
  });
});
