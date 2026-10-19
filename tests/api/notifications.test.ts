import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, PATCH } from "@/app/api/notifications/route";

// Mocks
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/notifications", () => ({
  getNotificationsForUser: vi.fn(),
  markNotificationsAsRead: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { getServerSession } from "next-auth";
import {
  getNotificationsForUser,
  markNotificationsAsRead,
} from "@/lib/notifications";

const sameOriginHeaders = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

describe("/api/notifications API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/notifications", () => {
    it("returns 401 when unauthenticated", async () => {
      vi.mocked(getServerSession).mockResolvedValue(null);
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it("returns notifications and unreadCount when authenticated", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "u1", isMaintainer: true, maintainerOrgId: "default" },
      } as any);

      vi.mocked(getNotificationsForUser).mockResolvedValue({
        notifications: [
          {
            id: "n1",
            type: "BATCH_JOB_COMPLETED",
            title: "Batch check completed",
            body: "Batch recheck finished",
            read: false,
            createdAt: new Date().toISOString(),
          },
        ] as any,
        unreadCount: 1,
      });

      const res = await GET();
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.unreadCount).toBe(1);
      expect(body.notifications).toHaveLength(1);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  describe("PATCH /api/notifications", () => {
    it("returns 403 when CSRF check fails (cross-origin request)", async () => {
      const req = new NextRequest("http://localhost:3000/api/notifications", {
        method: "PATCH",
        headers: {
          origin: "https://evil.com",
          host: "localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ all: true }),
      });

      const res = await PATCH(req);
      expect(res.status).toBe(403);
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(getServerSession).mockResolvedValue(null);
      const req = new NextRequest("http://localhost:3000/api/notifications", {
        method: "PATCH",
        headers: sameOriginHeaders,
        body: JSON.stringify({ all: true }),
      });

      const res = await PATCH(req);
      expect(res.status).toBe(401);
    });

    it("marks notifications as read and returns new unreadCount", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "u1", isMaintainer: false, maintainerOrgId: "default" },
      } as any);

      vi.mocked(markNotificationsAsRead).mockResolvedValue({ unreadCount: 0 });

      const req = new NextRequest("http://localhost:3000/api/notifications", {
        method: "PATCH",
        headers: sameOriginHeaders,
        body: JSON.stringify({ notificationIds: ["n1"] }),
      });

      const res = await PATCH(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.unreadCount).toBe(0);

      expect(markNotificationsAsRead).toHaveBeenCalledWith(
        "u1",
        false,
        ["n1"],
        "default"
      );
    });
  });
});
