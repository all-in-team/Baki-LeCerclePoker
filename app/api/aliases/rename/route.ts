import { NextRequest, NextResponse } from "next/server";
import { updateAliasLabel } from "@/lib/aliases";

// Owner rename of an alias label. Display-only.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const aliasId = Number(body.alias_id);
  const label = String(body.label ?? "");
  if (!aliasId || !label.trim()) return NextResponse.json({ error: "alias_id + label required" }, { status: 400 });
  const ok = updateAliasLabel(aliasId, label);
  if (!ok) return NextResponse.json({ ok: false, error: "alias not found or empty label" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
