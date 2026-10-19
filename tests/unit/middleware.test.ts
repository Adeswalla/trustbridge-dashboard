import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { NextAuthMiddlewareOptions } from "next-auth/middleware";

const middlewareMocks = vi.hoisted(() => ({
  authOptions: undefined as unknown,
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next-auth/middleware", () => ({
  withAuth: (handler: unknown, options: unknown) => {
    middlewareMocks.authOptions = options;
    return handler;
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: middlewareMocks.recordAuditLog,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { upsert: vi.fn(), findUnique: vi.fn() } },
}));

vi.mock("@/lib/token-crypto", () => ({
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
}));

vi.mock("@/lib/token-audit", () => ({
  recordTokenAudit: vi.fn(),
}));

import middleware from "@/middleware";
import { AUTH_SIGN_IN_PATH } from "@/lib/auth-pages";
import { authOptions } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import { isValidRequestId } from "@/lib/request-id";

type Role = "viewer" | "operator" | "admin";
type TestToken = {
  isMaintainer?: boolean;
  role?: Role;
};
type CapturedMiddlewareAuthOptions = {
  pages?: { signIn?: string };
  callbacks?: {
    authorized?: (params: {
      token: TestToken | null;
      req: NextRequest;
    }) => boolean;
  };
};

const originalMaintenance = process.env.MAINTENANCE;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;
const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;

function getMiddlewareAuthOptions(): CapturedMiddlewareAuthOptions {
  if (middlewareMocks.authOptions === undefined) {
    throw new Error("withAuth options were not captured");
  }
  return middlewareMocks.authOptions as CapturedMiddlewareAuthOptions;
}

function makeRequest(
  path: string,
  token: TestToken | null,
  headers?: Headers
) {
  const request = new NextRequest(new URL(path, "http://localhost:3000"), {
    headers,
  });
  return Object.assign(request, { nextauth: { token } });
}

function runMiddleware(request: ReturnType<typeof makeRequest>) {
  // withAuth is mocked to return the inner handler, which does not use its event argument.
  return middleware(
    request,
    undefined as unknown as Parameters<typeof middleware>[1]
  );
}

function isAuthorized(path: string, token: TestToken | null): boolean {
  const callback = getMiddlewareAuthOptions().callbacks?.authorized;
  if (!callback) {
    throw new Error("Middleware authorized callback is not configured");
  }
  return callback({ token, req: makeRequest(path, token) });
}

beforeEach(() => {
  delete process.env.MAINTENANCE;
  middlewareMocks.recordAuditLog.mockClear();
});

afterEach(() => {
  if (originalMaintenance === undefined) {
    delete process.env.MAINTENANCE;
  } else {
    process.env.MAINTENANCE = originalMaintenance;
  }
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
  }
  if (originalNextAuthSecret === undefined) {
    delete process.env.NEXTAUTH_SECRET;
  } else {
    process.env.NEXTAUTH_SECRET = originalNextAuthSecret;
  }
});

describe("dashboard middleware authentication", () => {
  it("shares the configured sign-in page with NextAuth", () => {
    expect(authOptions.pages?.signIn).toBe(AUTH_SIGN_IN_PATH);
    expect(getMiddlewareAuthOptions().pages?.signIn).toBe(AUTH_SIGN_IN_PATH);
  });

  it.each(["/dashboard", "/dashboard/settings", "/register"])(
    "denies an unauthenticated request to %s so withAuth redirects to sign-in",
    (path) => {
      expect(isAuthorized(path, null)).toBe(false);
    }
  );

  it.each(["/dashboard", "/dashboard/settings", "/register"])(
    "redirects unauthenticated requests from %s to the configured sign-in page",
    async (path) => {
      process.env.NEXTAUTH_URL = "http://localhost:3000/api/auth";
      process.env.NEXTAUTH_SECRET = "middleware-test-secret";
      const { withAuth: nextAuthWithAuth } = await vi.importActual<
        typeof import("next-auth/middleware")
      >("next-auth/middleware");

      const response = await nextAuthWithAuth(
        makeRequest(`${path}?tab=members`, null),
        {
          ...getMiddlewareAuthOptions(),
          secret: process.env.NEXTAUTH_SECRET,
        } as NextAuthMiddlewareOptions
      );

      expect(response).toBeInstanceOf(NextResponse);
      expect(response?.status).toBe(307);
      const signInUrl = new URL(response?.headers.get("location") ?? "");
      expect(signInUrl.pathname).toBe(AUTH_SIGN_IN_PATH);
      expect(signInUrl.searchParams.get("callbackUrl")).toBe(
        `${path}?tab=members`
      );
    }
  );

  it("admits authenticated requests to dashboard and registration routes", () => {
    expect(isAuthorized("/dashboard", { isMaintainer: true })).toBe(true);
    expect(isAuthorized("/register", { isMaintainer: false })).toBe(true);
  });

  it("leaves public paths and API routes outside the middleware auth gate", () => {
    expect(isAuthorized("/", null)).toBe(true);
    expect(isAuthorized("/api/contributors", null)).toBe(true);
  });
});

describe("dashboard middleware redirects and role gates", () => {
  it("redirects an authenticated non-maintainer to registration", async () => {
    const response = await runMiddleware(
      makeRequest("/dashboard", { isMaintainer: false })
    );

    expect(response).toBeInstanceOf(NextResponse);
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe(
      "http://localhost:3000/register?error=maintainer"
    );
    expect(
      isValidRequestId(response?.headers.get("x-request-id") ?? "")
    ).toBe(true);
  });

  it("fails closed when the maintainer claim is missing", async () => {
    const response = await runMiddleware(makeRequest("/dashboard", {}));

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toContain(
      "/register?error=maintainer"
    );
  });

  it("allows a maintainer onto the dashboard and retains the request ID", async () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const response = await runMiddleware(
      makeRequest(
        "/dashboard",
        { isMaintainer: true, role: "viewer" },
        new Headers({ "x-request-id": requestId })
      )
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("location")).toBeNull();
    expect(response?.headers.get("x-request-id")).toBe(requestId);
  });

  it("redirects a viewer away from settings and records the RBAC denial", async () => {
    const response = await runMiddleware(
      makeRequest("/dashboard/settings", {
        isMaintainer: true,
        role: "viewer",
      })
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe(
      "http://localhost:3000/dashboard?error=insufficient_role"
    );
    expect(recordAuditLog).toHaveBeenCalledWith({
      action: "rbac_middleware_denied",
      metadata: {
        path: "/dashboard/settings",
        requiredRole: "operator",
        actualRole: "viewer",
      },
    });
  });

  it.each(["operator", "admin"] as const)(
    "allows a maintainer with the %s role into settings",
    async (role) => {
      const response = await runMiddleware(
        makeRequest("/dashboard/settings", { isMaintainer: true, role })
      );

      expect(response?.status).toBe(200);
      expect(response?.headers.get("location")).toBeNull();
      expect(recordAuditLog).not.toHaveBeenCalled();
    }
  );
});
