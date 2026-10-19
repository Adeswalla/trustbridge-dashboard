import { NextRequest, NextResponse } from "next/server";

import { refreshMaintainerSession, requireMaintainerSession } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceFreezeWindowGuard } from "@/lib/freeze-window";
import { getRegistryMode } from "@/lib/registry-mode";
import { getContributors } from "@/lib/registrations";
import { backgroundQueue } from "@/lib/background-queue";
import { buildStalenessSummary } from "@/lib/stale-export";
import { captureException } from "@/lib/sentry";
import { trackServerBatchRecheckStarted } from "@/lib/analytics";
import {
  recheckLockCache,
  buildRecheckLockKey,
  parseRecheckIdempotencyTtl,
} from "@/lib/cache";
import {
  buildContributorListCacheControl,
  invalidateContributorListCaches,
} from "@/lib/cache-tags";
import type { ReadinessStatus } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_READINESS_FILTERS = new Set<ReadinessStatus>([
  "ready",
  "low_reserve",
  "not_ready",
]);

export async function GET(request: NextRequest) {
  if (!(await refreshMaintainerSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const readinessParam = request.nextUrl.searchParams.get("readiness");

  if (
    readinessParam !== null &&
    !VALID_READINESS_FILTERS.has(readinessParam as ReadinessStatus)
  ) {
    return NextResponse.json(
      {
        error: `Invalid readiness filter "${readinessParam}". Must be one of: ${Array.from(
          VALID_READINESS_FILTERS
        ).join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    const { contributors: allContributors, total } = await getContributors();

    const staleness = buildStalenessSummary(allContributors);

    const contributors =
      readinessParam !== null
        ? allContributors.filter((c) => c.readiness === readinessParam)
        : allContributors;

    return NextResponse.json({
      contributors,
      total,
      filtered: contributors.length,
      registryMode: getRegistryMode(),
      staleness,
      ...(readinessParam !== null ? { readiness: readinessParam } : {}),
    }, {
      headers: {
        // Authenticated maintainer-only route: private cache, 30 s fresh,
        // 60 s stale-while-revalidate so table re-opens feel instant.
        "Cache-Control": buildContributorListCacheControl(),
      },
    });
  } catch (error) {
    captureException(error, {
      route: "/api/contributors",
      method: "GET",
      readinessFilter: readinessParam,
    });
    return NextResponse.json(
      { error: "Failed to load contributors" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Enforce wave freeze window — batch recheck is a mutating operation
  const freezeGuard = await enforceFreezeWindowGuard({
    request,
    isMaintainer: Boolean(session.user.isMaintainer),
    userId: session.user.id,
    userLogin: session.user.githubUsername ?? null,
    actionLabel: "recheck.batch",
  });
  if (freezeGuard.blocked && freezeGuard.response) {
    return freezeGuard.response;
  }

  // Check for explicit Idempotency-Key header or use actor-scoped window key
  const customIdempotencyKey = request.headers.get("idempotency-key");
  const lockKey = customIdempotencyKey
    ? `recheck:custom:${customIdempotencyKey}`
    : buildRecheckLockKey("batch", session.user.id);

  // If a recheck request was already enqueued within the idempotency window, return existing job
  const existing = recheckLockCache.get(lockKey);
  if (existing) {
    return NextResponse.json(
      {
        jobId: existing.jobId,
        status: "pending",
        message: "Batch recheck already enqueued (idempotent response).",
        idempotent: true,
      },
      {
        headers: {
          "Idempotency-Key": customIdempotencyKey ?? lockKey,
          "X-Idempotent-Replay": "true",
        },
      }
    );
  }

  try {
    const jobId = await backgroundQueue.enqueue(
      "recheck.batch",
      {},
      session.user.id
    );

    // Lock the recheck key for the duration of the idempotency window
    recheckLockCache.set(lockKey, { jobId, createdAt: Date.now() }, parseRecheckIdempotencyTtl());

    // Eagerly invalidate the contributor list caches so the next GET returns
    // fresh data.  The background job will invalidate again when it finishes,
    // but this first call ensures a maintainer who refreshes the table
    // immediately after hitting "Recheck all" doesn't see a stale list.
    await invalidateContributorListCaches();

    await recordAuditLog({
      action: "recheck.batch.queued",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      metadata: {
        jobId,
        idempotencyKey: customIdempotencyKey ?? lockKey,
      },
    });

    // Track analytics event (no-op when POSTHOG_API_KEY is absent)
    trackServerBatchRecheckStarted({
      initiatedBy: session.user.id,
    });

    return NextResponse.json(
      {
        jobId,
        status: "pending",
        message: "Batch recheck enqueued. Poll /api/contributors/queue/jobs/" + jobId + " for progress.",
        idempotent: false,
      },
      {
        headers: {
          "Idempotency-Key": customIdempotencyKey ?? lockKey,
        },
      }
    );
  } catch (error) {
    captureException(error, {
      route: "/api/contributors",
      method: "POST",
      operation: "batch-recheck-enqueue",
      actorId: session.user.id,
    });
    return NextResponse.json(
      { error: "Failed to enqueue batch recheck" },
      { status: 500 }
    );
  }
}
