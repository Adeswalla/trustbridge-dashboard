/**
 * CORS tests for public API endpoints.
 *
 * Verifies that next.config.mjs CORS headers are applied correctly
 * to /api/actions/lookup and /api/check.
 *
 * Note: Next.js applies headers from next.config.mjs at the server level,
 * not at the route handler level. These tests verify the header configuration
 * exists and is correct by reading the config directly.
 */

import { describe, expect, it } from "vitest";
import nextConfig from "@/../next.config.mjs";

describe("CORS Policy", () => {
  it("defines headers for /api/actions/lookup", async () => {
    const headers = await nextConfig.headers();
    const rule = headers.find((h) => h.source === "/api/actions/lookup");
    expect(rule).toBeDefined();
    expect(rule!.headers.length).toBeGreaterThan(0);
  });

  it("defines headers for /api/check", async () => {
    const headers = await nextConfig.headers();
    const rule = headers.find((h) => h.source === "/api/check");
    expect(rule).toBeDefined();
    expect(rule!.headers.length).toBeGreaterThan(0);
  });

  it("does NOT use wildcard origin", async () => {
    const headers = await nextConfig.headers();
    for (const rule of headers) {
      for (const h of rule.headers) {
        if (h.key === "Access-Control-Allow-Origin") {
          expect(h.value).not.toBe("*");
        }
      }
    }
  });

  it("allows single specific origin only without comma separation", async () => {
    const headers = await nextConfig.headers();
    const lookupRule = headers.find((h) => h.source === "/api/actions/lookup");
    const originHeader = lookupRule!.headers.find(
      (h) => h.key === "Access-Control-Allow-Origin"
    );

    expect(originHeader!.value).toBe("https://github.com");
    expect(originHeader!.value).not.toContain(",");
  });

  it("does not include credentials header (no cookies needed)", async () => {
    const headers = await nextConfig.headers();
    for (const rule of headers) {
      for (const h of rule.headers) {
        expect(h.key).not.toBe("Access-Control-Allow-Credentials");
      }
    }
  });

  it("allows GET, POST, OPTIONS methods", async () => {
    const headers = await nextConfig.headers();
    const lookupRule = headers.find((h) => h.source === "/api/actions/lookup");
    const methodsHeader = lookupRule!.headers.find(
      (h) => h.key === "Access-Control-Allow-Methods"
    );

    expect(methodsHeader!.value).toContain("GET");
    expect(methodsHeader!.value).toContain("POST");
    expect(methodsHeader!.value).toContain("OPTIONS");
  });

  it("sets Vary: Origin for cache correctness", async () => {
    const headers = await nextConfig.headers();
    const lookupRule = headers.find((h) => h.source === "/api/actions/lookup");
    const varyHeader = lookupRule!.headers.find((h) => h.key === "Vary");

    expect(varyHeader).toBeDefined();
    expect(varyHeader!.value).toContain("Origin");
  });

  it("leaves route-level CORS endpoints out of static Next.js headers", async () => {
    const headers = await nextConfig.headers();
    const routeLevelCorsPaths = [
      "/api/stats",
      "/api/freeze-status",
    ];

    for (const path of routeLevelCorsPaths) {
      const rule = headers.find((h) => h.source === path);
      expect(rule).toBeUndefined();
    }
  });
});
