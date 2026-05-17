import { NextRequest, NextResponse } from "next/server";
import { handleKkpokerOnboarding } from "@/lib/games/kkpoker/onboarding";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "test-onboard-20260517") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  try {
    await handleKkpokerOnboarding(999999999, {
      id: 999999999,
      first_name: "FakeTest",
      last_name: "Bot",
      username: "faketest",
    });
    return NextResponse.json({ ok: true, result: "handleKkpokerOnboarding completed without error" });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, code: e.code, stack: e.stack?.split("\n").slice(0, 5) }, { status: 500 });
  }
}
