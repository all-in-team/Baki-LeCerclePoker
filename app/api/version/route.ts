import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local-dev",
    commit_short: (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local-dev").slice(0, 7),
    branch: process.env.RAILWAY_GIT_BRANCH ?? process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
    deployment_id: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    built_at: process.env.RAILWAY_GIT_COMMIT_MESSAGE ? new Date().toISOString() : null,
    served_at: new Date().toISOString(),
  });
}
