import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/maintainers", () => ({
  isMaintainer: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({
  assertSameOrigin: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { isMaintainer } from "@/lib/maintainers";
import { prisma } from "@/lib/prisma";
import { PATCH } from "./route";

// ── Shared setup helpers ──────────────────────────────────────────────────────

function mockMaintainerSession() {
  vi.mocked(getServerSession).mockResolvedValueOnce({
    user: { id: "maintainer-1", githubUsername: "octocat" },
  } as never);
  vi.mocked(isMaintainer).mockResolvedValueOnce(true);
}

function mockRegistrationFound() {
  vi.mocked(prisma.registration.findUnique).mockResolvedValueOnce({
    id: "reg-1",
    stellarAddress: "GABCDEF...",
  } as never);
}

function mockRegistrationUpdate(notes: string | null, tags: string[]) {
  vi.mocked(prisma.registration.update).mockResolvedValueOnce({
    id: "reg-1",
    notes,
    tags,
    stellarAddress: "GABCDEF...",
  } as never);
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/contributors/reg-1/notes", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}

// ── Auth & authorization ──────────────────────────────────────────────────────

describe("PATCH /api/contributors/[id]/notes — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);
    const res = await PATCH(patchRequest({ notes: "test" }) as never, {
      params: { id: "reg-1" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-maintainers", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "user-1" },
    } as never);
    vi.mocked(isMaintainer).mockResolvedValueOnce(false);
    const res = await PATCH(patchRequest({ notes: "test" }) as never, {
      params: { id: "reg-1" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the registration does not exist", async () => {
    mockMaintainerSession();
    vi.mocked(prisma.registration.findUnique).mockResolvedValueOnce(null);
    const res = await PATCH(patchRequest({ notes: "test" }) as never, {
      params: { id: "missing-id" },
    });
    expect(res.status).toBe(404);
  });
});

// ── Markdown sanitization — notes field ──────────────────────────────────────

describe("PATCH /api/contributors/[id]/notes — markdown sanitization (notes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips <script> tags and their content from notes", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("Clean note", []);

    const res = await PATCH(
      patchRequest({ notes: "<script>alert('xss')</script>Clean note" }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: "Clean note" }),
      })
    );
  });

  it("strips arbitrary HTML tags from notes while keeping text", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("bold text", []);

    const res = await PATCH(
      patchRequest({ notes: "<b>bold text</b>" }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: "bold text" }),
      })
    );
  });

  it("preserves safe markdown bold syntax in notes", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("**important contributor**", []);

    const res = await PATCH(
      patchRequest({ notes: "**important contributor**" }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: "**important contributor**" }),
      })
    );
  });

  it("preserves safe https:// markdown links in notes", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("[GitHub](https://github.com/octocat)", []);

    const res = await PATCH(
      patchRequest({ notes: "[GitHub](https://github.com/octocat)" }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notes: "[GitHub](https://github.com/octocat)",
        }),
      })
    );
  });

  it("replaces javascript: URIs in markdown links with # in notes", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("[click](#)", []);

    const res = await PATCH(
      patchRequest({ notes: "[click](javascript:alert(1))" }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: "[click](#)" }),
      })
    );
  });

  it("strips event-handler attributes via tag removal", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("text", []);

    const res = await PATCH(
      patchRequest({ notes: '<img src="x" onerror="evil()">text' }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    const callData = (prisma.registration.update as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(callData?.data?.notes).not.toContain("onerror");
    expect(callData?.data?.notes).not.toContain("<img");
  });

  it("handles HTML-entity-obfuscated javascript: URI in notes", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("[x](#)", []);

    const res = await PATCH(
      patchRequest({ notes: "[x](&#106;avascript:alert(1))" }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    const callData = (prisma.registration.update as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(callData?.data?.notes).not.toContain("javascript:");
    expect(callData?.data?.notes).toBe("[x](#)");
  });

  it("returns 400 when sanitised notes exceed 1 000 characters", async () => {
    mockMaintainerSession();
    mockRegistrationFound();

    const res = await PATCH(
      patchRequest({ notes: "a".repeat(1001) }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Validation failed");
  });
});

// ── Markdown sanitization — tags field ───────────────────────────────────────

describe("PATCH /api/contributors/[id]/notes — markdown sanitization (tags)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips HTML tags from tag values", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate(null, ["VIP", "Verified"]);

    const res = await PATCH(
      patchRequest({ tags: ["VIP", "<b>Verified</b>"] }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tags: ["VIP", "Verified"] }),
      })
    );
  });

  it("strips markdown syntax from tags (tags are plain-text only)", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate(null, ["bold tag"]);

    const res = await PATCH(
      patchRequest({ tags: ["**bold tag**"] }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tags: ["bold tag"] }),
      })
    );
  });

  it("returns 400 when a tag is empty after sanitisation", async () => {
    mockMaintainerSession();
    mockRegistrationFound();

    // After stripping, "<b></b>" becomes "" which fails min(1) validation
    const res = await PATCH(
      patchRequest({ tags: ["<b></b>"] }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when a tag exceeds 30 characters after sanitisation", async () => {
    mockMaintainerSession();
    mockRegistrationFound();

    const res = await PATCH(
      patchRequest({ tags: ["a".repeat(31)] }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when more than 10 tags are provided", async () => {
    mockMaintainerSession();
    mockRegistrationFound();

    const res = await PATCH(
      patchRequest({ tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(400);
  });
});

// ── Happy path — valid payload ────────────────────────────────────────────────

describe("PATCH /api/contributors/[id]/notes — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves clean notes and tags and returns 200", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("Plain note with **markdown** ok", ["VIP", "Wave5"]);

    const res = await PATCH(
      patchRequest({
        notes: "Plain note with **markdown** ok",
        tags: ["VIP", "Wave5"],
      }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; registration: { id: string } };
    expect(body.success).toBe(true);
    expect(body.registration.id).toBe("reg-1");
  });

  it("accepts null notes", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate(null, []);

    const res = await PATCH(
      patchRequest({ notes: null, tags: [] }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: null, tags: [] }),
      })
    );
  });

  it("accepts an empty tags array", async () => {
    mockMaintainerSession();
    mockRegistrationFound();
    mockRegistrationUpdate("A note", []);

    const res = await PATCH(
      patchRequest({ notes: "A note", tags: [] }) as never,
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid JSON body", async () => {
    mockMaintainerSession();
    mockRegistrationFound();

    const req = new Request(
      "http://localhost/api/contributors/reg-1/notes",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: "not-json",
      }
    );
    const res = await PATCH(req as never, { params: { id: "reg-1" } });
    expect(res.status).toBe(400);
  });
});
