import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceFreezeWindowGuard } from "@/lib/freeze-window";
import { refreshContributor } from "@/lib/registrations";
import { captureException } from "@/lib/sentry";
import { invalidateContributorListCaches } from "@/lib/cache-tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { id: string };
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Enforce wave freeze window — single contributor recheck is a mutating operation
  const freezeGuard = await enforceFreezeWindowGuard({
    request,
    isMaintainer: Boolean(session.user.isMaintainer),
    userId: session.user.id,
    userLogin: session.user.githubUsername ?? null,
    actionLabel: "recheck.single",
  });
  if (freezeGuard.blocked && freezeGuard.response) {
    return freezeGuard.response;
  }

  const id = params.id?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "Contributor id is required" },
      { status: 400 }
    );
  }

  try {
    const result = await refreshContributor(id);
    if (!result) {
      return NextResponse.json(
        { error: "Contributor not found" },
        { status: 404 }
      );
    }

    const { contributor, diff } = result;

    // Invalidate contributor list and stats caches so the next GET reflects
    // the fresh readiness state without requiring a full page reload.
    await invalidateContributorListCaches();

    await recordAuditLog({
      action: "recheck.single.queued",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: contributor.id,
      targetLabel: contributor.githubUsername,
      metadata: {
        previousReadiness: diff.previousReadiness,
        readiness: contributor.readiness,
        changed: diff.changed,
        verified: contributor.verified,
      },
    });

    return NextResponse.json({ contributor, diff });
  } catch (error) {
    captureException(error, {
      route: "POST /api/contributors/[id]",
      contributorId: id,
      actorId: session.user.id,
    });

    return NextResponse.json(
      { error: "Failed to recheck contributor" },
      { status: 500 }
    );
  }
}
