import { describe, expect, it, vi } from "vitest";

import { getSessionUserId } from "@/lib/auth";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

describe("getSessionUserId", () => {
  it("returns null when the session or user is absent", async () => {
    await expect(getSessionUserId(null)).resolves.toBeNull();
    await expect(getSessionUserId(undefined)).resolves.toBeNull();
    await expect(getSessionUserId({ user: null })).resolves.toBeNull();
    await expect(getSessionUserId({ user: {} })).resolves.toBeNull();
    await expect(getSessionUserId({ user: { id: null } })).resolves.toBeNull();
  });

  it("returns the authenticated user's ID", async () => {
    await expect(getSessionUserId({ user: { id: "user-123" } })).resolves.toBe(
      "user-123"
    );
  });
});