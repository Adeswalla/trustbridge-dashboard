/**
 * Tests for the contributor list cache-tags module (#555).
 *
 * Verifies:
 *   - CONTRIBUTOR_CACHE_TAGS constants are stable strings.
 *   - buildContributorListCacheControl() emits the right header value.
 *   - invalidateContributorListCaches() clears in-process caches even when
 *     revalidateTag() throws (non-Next.js test context).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/cache's revalidateTag — it throws outside a Next.js request context
// and we want to verify our swallow-silently behaviour.
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

import { revalidateTag } from "next/cache";
import {
  CONTRIBUTOR_CACHE_TAGS,
  buildContributorListCacheControl,
  invalidateContributorListCaches,
} from "@/lib/cache-tags";
import { contributorCache, statsCache } from "@/lib/cache";

// ── Tag constants ─────────────────────────────────────────────────────────────

describe("CONTRIBUTOR_CACHE_TAGS", () => {
  it("exports a stable list tag", () => {
    expect(CONTRIBUTOR_CACHE_TAGS.list).toBe("contributors:list");
  });

  it("exports a stable paginated tag", () => {
    expect(CONTRIBUTOR_CACHE_TAGS.paginated).toBe("contributors:paginated");
  });

  it("exports a stable stats tag", () => {
    expect(CONTRIBUTOR_CACHE_TAGS.stats).toBe("contributors:stats");
  });
});

// ── buildContributorListCacheControl ─────────────────────────────────────────

describe("buildContributorListCacheControl", () => {
  it("returns a private directive", () => {
    expect(buildContributorListCacheControl()).toContain("private");
  });

  it("sets max-age to the default 30 seconds", () => {
    expect(buildContributorListCacheControl()).toContain("max-age=30");
  });

  it("sets stale-while-revalidate to the default 60 seconds", () => {
    expect(buildContributorListCacheControl()).toContain(
      "stale-while-revalidate=60"
    );
  });

  it("respects custom maxAgeMs", () => {
    // 60 000 ms → max-age=60
    expect(buildContributorListCacheControl(60_000)).toContain("max-age=60");
  });

  it("respects custom swrMs", () => {
    // 120 000 ms → stale-while-revalidate=120
    expect(buildContributorListCacheControl(30_000, 120_000)).toContain(
      "stale-while-revalidate=120"
    );
  });

  it("converts ms to seconds by flooring (no decimal seconds)", () => {
    // 31 500 ms → max-age=31, not 31.5
    expect(buildContributorListCacheControl(31_500)).toContain("max-age=31");
  });

  it("produces a well-formed header value with all three directives", () => {
    const header = buildContributorListCacheControl(30_000, 60_000);
    expect(header).toBe("private, max-age=30, stale-while-revalidate=60");
  });
});

// ── invalidateContributorListCaches ──────────────────────────────────────────

describe("invalidateContributorListCaches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contributorCache.clear();
    statsCache.clear();
  });

  it("evicts all contributor cache entries", async () => {
    contributorCache.set("contributor:alice", { id: "reg-1" });
    contributorCache.set("contributor:bob", { id: "reg-2" });
    expect(contributorCache.getStats().size).toBe(2);

    await invalidateContributorListCaches();

    expect(contributorCache.getStats().size).toBe(0);
  });

  it("evicts stats cache entries", async () => {
    statsCache.set("stats:dashboard", { totalContributors: 5 });
    expect(statsCache.getStats().size).toBe(1);

    await invalidateContributorListCaches();

    expect(statsCache.getStats().size).toBe(0);
  });

  it("calls revalidateTag for all three tag constants", async () => {
    await invalidateContributorListCaches();

    expect(revalidateTag).toHaveBeenCalledWith(CONTRIBUTOR_CACHE_TAGS.list);
    expect(revalidateTag).toHaveBeenCalledWith(CONTRIBUTOR_CACHE_TAGS.paginated);
    expect(revalidateTag).toHaveBeenCalledWith(CONTRIBUTOR_CACHE_TAGS.stats);
  });

  it("does not throw when revalidateTag throws (non-Next.js context)", async () => {
    vi.mocked(revalidateTag).mockImplementation(() => {
      throw new Error("Invariant: revalidateTag called outside request context");
    });

    // Must resolve without throwing
    await expect(invalidateContributorListCaches()).resolves.toBeUndefined();
  });

  it("still clears in-process caches even when revalidateTag throws", async () => {
    vi.mocked(revalidateTag).mockImplementation(() => {
      throw new Error("outside request context");
    });

    contributorCache.set("contributor:test", { id: "reg-99" });
    statsCache.set("stats:dashboard", { totalContributors: 1 });

    await invalidateContributorListCaches();

    // In-process caches cleared despite revalidateTag failure
    expect(contributorCache.getStats().size).toBe(0);
    expect(statsCache.getStats().size).toBe(0);
  });

  it("is idempotent — calling twice does not throw", async () => {
    await expect(
      invalidateContributorListCaches().then(() => invalidateContributorListCaches())
    ).resolves.toBeUndefined();
  });
});
