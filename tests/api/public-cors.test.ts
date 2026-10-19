import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/registrations", () => ({
  getDashboardStats: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  isAuthorizedScheduler: vi.fn(),
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/contract-sync", () => ({
  getContractSyncHealth: vi.fn(),
  syncContractToPostgres: vi.fn(),
}));

vi.mock("@/lib/health", () => ({
  runHealthChecks: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import { OPTIONS as checkOptions } from "@/app/api/check/route";
import { OPTIONS as lookupOptions } from "@/app/api/actions/lookup/route";
import { OPTIONS as contractSyncOptions } from "@/app/api/contract-sync/route";
import { OPTIONS as healthOptions } from "@/app/api/health/route";
import { OPTIONS as openapiOptions } from "@/app/api/openapi.json/route";
import { OPTIONS as statsOptions } from "@/app/api/stats/route";
import { OPTIONS as freezeStatusOptions } from "@/app/api/freeze-status/route";
import nextConfig from "@/../next.config.mjs";

describe("public API CORS preflight", () => {
  it.each([
    ["/api/check", checkOptions, "POST, OPTIONS"],
    ["/api/actions/lookup", lookupOptions, "GET, OPTIONS"],
    ["/api/contract-sync", contractSyncOptions, "GET, OPTIONS"],
    ["/api/health", healthOptions, "GET, OPTIONS"],
    ["/api/openapi.json", openapiOptions, "GET, OPTIONS"],
  ])("handles OPTIONS for %s", async (_path, options, methods) => {
    const response = await options();

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe(methods);
    expect(response.headers.get("allow")).toBe(methods);
  });

  it("allows JSON and the public check cache-bypass header", async () => {
    const response = await checkOptions();

    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, X-Cache-Bypass"
    );
  });

  it.each([
    ["/api/stats", statsOptions],
    ["/api/freeze-status", freezeStatusOptions],
  ])("allows only the trusted origin in the %s preflight", async (_path, options) => {
    const allowed = await options(
      new Request("http://localhost", {
        headers: { origin: "https://github.com" },
      })
    );
    const denied = await options(
      new Request("http://localhost", {
        headers: { origin: "https://untrusted.example" },
      })
    );

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://github.com"
    );
    expect(allowed.headers.get("access-control-allow-methods")).toBe(
      "GET, OPTIONS"
    );
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, X-Cache-Bypass"
    );
    expect(allowed.headers.get("access-control-max-age")).toBe("86400");
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-headers")).toBeNull();
    expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
    expect(denied.headers.get("vary")).toContain("Origin");
  });

  it.each([
    "http://github.com",
    "https://github.com.evil.example",
    "https://evil.example",
    "null",
  ])("rejects the non-allowlisted origin %s in stats and freeze preflights", async (origin) => {
    for (const options of [statsOptions, freezeStatusOptions]) {
      const response = await options(
        new Request("http://localhost", { headers: { origin } })
      );

      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toContain("Origin");
    }
  });

  it.each([
    ["/api/stats", statsOptions],
    ["/api/freeze-status", freezeStatusOptions],
  ])("matches the configured public API origin for %s", async (_path, options) => {
    const headers = await nextConfig.headers();
    const checkRule = headers.find((rule) => rule.source === "/api/check");
    const configuredOrigin = checkRule?.headers.find(
      (header) => header.key === "Access-Control-Allow-Origin"
    )?.value;
    const response = await options(
      new Request("http://localhost", {
        headers: { origin: configuredOrigin ?? "" },
      })
    );

    expect(configuredOrigin).toBe("https://github.com");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      configuredOrigin
    );
  });
});