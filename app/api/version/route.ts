import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const sha = process.env.BUILD_GIT_SHA ?? "local-dev";
  return NextResponse.json({
    commit: sha,
    commit_short: sha.slice(0, 7),
    branch: process.env.RAILWAY_GIT_BRANCH ?? "unknown",
    built_at: process.env.BUILD_TIME ?? null,
    served_at: new Date().toISOString(),
  });
}
