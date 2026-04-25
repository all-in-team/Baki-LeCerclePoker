import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const gameId = Number(formData.get("game_id"));

  if (!file || !gameId) {
    return NextResponse.json({ error: "file + game_id requis" }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const base64 = Buffer.from(bytes).toString("base64");
  const mediaType = (file.type || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";

  // Call Claude Vision
  let extracted: { external_id: string; rakeback: number; insurance: number; winnings: number; currency: string }[] = [];
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: `This is a poker app report screenshot. Extract ALL player entries with their amounts per category.
Return ONLY a valid JSON array, no markdown, no explanation:
[{"external_id":"player ID or username","rakeback":123.45,"insurance":45.67,"winnings":200.00,"currency":"USDT"}]

Rules:
- external_id: the player's ID or username as shown
- rakeback: rakeback/rake amount (0 if not shown)
- insurance: insurance amount (0 if not shown)
- winnings: winnings/profit amount (0 if not shown)
- currency: USDT/USD/CNY/EUR as shown, default USDT if unclear
- Use 0 for any category not present in the screenshot
- Include every row visible`,
          },
        ],
      }],
    });

    const raw = (msg.content[0] as any).text?.trim() ?? "";
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) extracted = JSON.parse(match[0]);
  } catch (e: any) {
    console.error("[Vision]", e);
    const msg = e?.message ?? String(e);
    return NextResponse.json({ error: `Extraction échouée : ${msg}` }, { status: 500 });
  }

  if (!extracted.length) {
    return NextResponse.json({ error: "Aucun joueur détecté dans le screenshot" }, { status: 422 });
  }

  // Auto-match against known player_game_ids
  const db = getDb();
  const knownIds = db.prepare(`
    SELECT pgi.external_id, pgi.player_id, p.name
    FROM player_game_ids pgi JOIN players p ON p.id = pgi.player_id
    WHERE pgi.game_id = ?
  `).all(gameId) as { external_id: string; player_id: number; name: string }[];

  const knownMap = new Map(knownIds.map(r => [r.external_id.toLowerCase(), r]));

  const rows = extracted.map(e => {
    const known = knownMap.get(e.external_id.toLowerCase());
    return {
      external_id: e.external_id,
      rakeback_amount: e.rakeback ?? 0,
      insurance_amount: e.insurance ?? 0,
      winnings_amount: e.winnings ?? 0,
      currency: e.currency || "USDT",
      player_id: known?.player_id ?? null,
      player_name: known?.name ?? null,
    };
  });

  return NextResponse.json({ rows });
}
