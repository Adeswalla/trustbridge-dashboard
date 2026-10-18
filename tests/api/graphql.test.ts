import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-auth", () => ({ requireMaintainerSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  buildRateLimitHeaders: vi.fn().mockReturnValue({}),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  extractClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));
vi.mock("@/lib/registrations", () => ({
  getDashboardStats: vi.fn(),
  getContributorsPaginated: vi.fn(),
}));

import { POST } from "@/app/api/graphql/route";
import { requireMaintainerSession } from "@/lib/api-auth";
import {
  getContributorsPaginated,
  getDashboardStats,
} from "@/lib/registrations";

function post(body: unknown) {
  return new NextRequest("http://localhost:3000/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/graphql query limits and access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);
    vi.mocked(getDashboardStats).mockResolvedValue({
      totalContributors: 4,
      readyCount: 2,
      readyPercent: 50,
    });
  });

  it("keeps the public stats query available", async () => {
    const response = await POST(post({ query: "{ stats { totalContributors } }" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { stats: { totalContributors: 4 } },
    });
    expect(getDashboardStats).toHaveBeenCalledOnce();
  });

  it("rejects contributors queries for unauthenticated callers", async () => {
    const response = await POST(
      post({ query: "{ contributors { nodes { githubUsername } } }" })
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.errors[0].extensions.code).toBe("FORBIDDEN");
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });

  it("rejects a contributor selection whose weighted cost exceeds the limit", async () => {
    const fields = Array.from(
      { length: 26 },
      (_, index) => `field${index}: githubUsername`
    ).join(" ");
    const response = await POST(
      post({
        query: `query Contributors($first: Int!) { contributors(first: $first) { nodes { ${fields} } } }`,
        variables: { first: 100 },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errors: [
        { message: expect.stringContaining("Query cost exceeds the limit") },
      ],
    });
    expect(requireMaintainerSession).not.toHaveBeenCalled();
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });

  it("rejects a non-Int page-size variable before resolver execution", async () => {
    const response = await POST(
      post({
        query: "query Contributors($first: Int) { contributors(first: $first) { nodes { githubUsername } } }",
        variables: { first: "25" },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errors: [
        { message: expect.stringContaining("contributors.first must be an Int") },
      ],
    });
    expect(requireMaintainerSession).not.toHaveBeenCalled();
  });
});