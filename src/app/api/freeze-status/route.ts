import { NextRequest, NextResponse } from "next/server";

import { isFreezeWindowActive } from "@/lib/freeze-window";
import {
  allowlistedPublicOptionsResponse,
  withAllowlistedPublicCors,
} from "@/lib/public-cors";
import {
  checkRateLimit,
  extractClientIp,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/freeze-status
 *
 * Returns the current Wave freeze-window state. Publicly readable so the
 * client-side maintainer dashboard can poll it without a session cookie
 * (the response contains no PII — only operational flags and timestamps).
 *
 * Rate limiting (issue #519):
 *   Up to 60 requests / minute per IP — generous for a polling UI, hard limit
 *   against polling storms during Wave events.  Exceeded IPs receive 429 with
 *   standard RateLimit-* / Retry-After headers.  Cache-Control is preserved on
 *   200 responses so CDN / browser caching still applies.
 *
 *   Unknown client IP (no x-forwarded-for / x-real-ip) uses the safe "unknown"
 *   fallback from extractClientIp() so the route never crashes; in practice a
 *   CDN should resolve true unknowns before they reach the origin.
 *
 * Shape (200):
 * ```json
 * {
 *   "active": true,
 *   "reason": "Wave roster payout freeze window in effect",
 *   "start":  "2026-09-24T18:00:00.000Z",
 *   "end":    "2026-09-25T06:00:00.000Z"
 * }
 * ```
 *
 * Shape (429):
 * ```json
 * { "error": "Too many requests", "code": "RATE_LIMIT_EXCEEDED" }
 * ```
 */

/** Max requests per window for this public endpoint. */
const FREEZE_STATUS_MAX_REQUESTS = 60;
/** Window length in milliseconds (1 minute). */
const FREEZE_STATUS_WINDOW_MS = 60_000;

export async function GET(request: NextRequest) {
  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip = extractClientIp(request);
  // Prefix the key with the route name to avoid collisions with other
  // rate-limited endpoints (e.g. /api/check uses a different limit).
  const identifier = `freeze-status:${ip}`;

  const rateLimitResult = checkRateLimit(identifier, {
    maxRequests: FREEZE_STATUS_MAX_REQUESTS,
    windowMs: FREEZE_STATUS_WINDOW_MS,
  });

  const rateLimitHeaders = buildRateLimitHeaders(
    rateLimitResult,
    FREEZE_STATUS_MAX_REQUESTS,
  );

  if (!rateLimitResult.allowed) {
    return withAllowlistedPublicCors(
      NextResponse.json(
        { error: "Too many requests", code: "RATE_LIMIT_EXCEEDED" },
        {
          status: 429,
          headers: rateLimitHeaders,
          // Intentionally no Cache-Control on 429 — CDNs must not cache error responses.
        }
      ),
      request.headers.get("origin")
    );
  }

  // ── Freeze status ─────────────────────────────────────────────────────────
  const status = isFreezeWindowActive();

  return withAllowlistedPublicCors(
    NextResponse.json(
      {
        active: status.active,
        reason: status.reason ?? null,
        start: status.start?.toISOString() ?? null,
        end: status.end?.toISOString() ?? null,
      },
      {
        status: 200,
        headers: {
          // Short TTL — freeze state can flip at any point; 15 s lets the UI
          // react quickly while avoiding a thundering herd on every keystroke.
          "Cache-Control": "public, max-age=15, stale-while-revalidate=30",
          // Include rate-limit headers on 200 so proactive clients can back off
          // before hitting the 429 boundary.
          ...rateLimitHeaders,
        },
      }
    ),
    request.headers.get("origin")
  );
}

export function OPTIONS(request: Request) {
  return allowlistedPublicOptionsResponse(
    "GET, OPTIONS",
    request.headers.get("origin")
  );
}
