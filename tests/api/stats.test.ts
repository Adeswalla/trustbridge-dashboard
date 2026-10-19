import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { resetRateLimit } from "@/lib/rate-limit";

vi.mock("@/lib/registrations", () => ({
  getDashboardStats: vi.fn().mockResolvedValue({
    totalContributors: 0,
    readyCount: 0,
    readyPercent: 0,
  }),
}));

import { GET } from "@/app/api/stats/route";

function makeRequest(ip: string, origin?: string): NextRequest {
  const headers = new Headers({ "x-forwarded-for": ip });
  if (origin) headers.set("origin", origin);
  return new NextRequest("http://localhost/api/stats", { headers });
}

describe("GET /api/stats CORS", () => {
  beforeEach(() => {
    resetRateLimit();
  });

  it("returns aggregate stats to the allowlisted origin", async () => {
    const response = await GET(makeRequest("192.0.2.1", "https://github.com"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      totalContributors: 0,
      readyCount: 0,
      readyPercent: 0,
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://github.com"
    );
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("does not grant CORS access to an untrusted origin", async () => {
    const response = await GET(
      makeRequest("192.0.2.2", "https://untrusted.example")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("keeps the allowlisted origin on rate-limit responses", async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      await GET(makeRequest("192.0.2.3", "https://github.com"));
    }

    const response = await GET(
      makeRequest("192.0.2.3", "https://github.com")
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://github.com"
    );
    expect(response.headers.get("vary")).toContain("Origin");
  });
});
