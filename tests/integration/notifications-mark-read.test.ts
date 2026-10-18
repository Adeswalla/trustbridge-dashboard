import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const database = vi.hoisted(() => ({
  notificationCount: vi.fn(),
  notificationUpdateMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      count: database.notificationCount,
      updateMany: database.notificationUpdateMany,
    },
  },
}));

import { PATCH } from "@/app/api/notifications/route";
import { getServerSession } from "next-auth";

const sameOriginHeaders = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function patch(body: unknown, headers = sameOriginHeaders) {
  return new NextRequest("http://localhost:3000/api/notifications", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/notifications route and service integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.notificationCount.mockResolvedValue(2);
    database.notificationUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marks only the requested user's notifications in the active tenant", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "user-1",
        isMaintainer: false,
        maintainerOrgId: "org-one",
      },
    } as never);

    const response = await PATCH(patch({ notificationIds: ["notification-1"] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      unreadCount: 2,
    });
    expect(database.notificationUpdateMany).toHaveBeenCalledWith({
      where: {
        maintainerOrgId: "org-one",
        read: false,
        id: { in: ["notification-1"] },
        userId: "user-1",
      },
      data: { read: true, readAt: expect.any(Date) },
    });
    expect(database.notificationCount).toHaveBeenCalledWith({
      where: {
        maintainerOrgId: "org-one",
        read: false,
        userId: "user-1",
      },
    });
  });

  it("rejects unauthenticated callers without updating notifications", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await PATCH(patch({ all: true }));

    expect(response.status).toBe(401);
    expect(database.notificationUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before reading the session", async () => {
    const response = await PATCH(
      patch({ all: true }, {
        ...sameOriginHeaders,
        origin: "https://attacker.example",
      })
    );

    expect(response.status).toBe(403);
    expect(getServerSession).not.toHaveBeenCalled();
    expect(database.notificationUpdateMany).not.toHaveBeenCalled();
  });
});