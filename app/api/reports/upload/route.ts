import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import { getDb } from "@/lib/db";

export const maxDuration = 60;

// ── Column aliases for deterministic XLS parsing ──────────────────────────
// Wepoker (Chinese): 玩家ID | 组局基金 (rake) | 保险盈利 (insurance) | 盈亏 (net)
// Wepoker XLS columns (confirmed by user):
//   J=保险总投保 (premium paid — IGNORED)
//   K=保险总赔付 (payout received — IGNORED)
//   L=保险盈利   (insurance net P&L ← insurance)
//   M=组局基金   (club fund / rake  ← rakeback)
//   N=盈亏       (net win/loss      ← winnings)
//   O=备注名     (alias — IGNORED)
const COL_ALIASES = {
  external_id: ["玩家id", "玩家账号", "player id", "userid", "user_id", "账号", "用户id", "id"],
  rakeback:    ["组局基金", "rake", "rb", "rakeback", "佣金", "退佣", "commission", "返水", "返佣", "club fund", "基金"],
  insurance:   ["保险盈利", "保险净盈亏", "保险净值", "insurance net", "ins net"],
  winnings:    ["盈亏", "net", "win/loss", "输赢", "profit", "result", "净盈亏"],
};

type Row = { external_id: string; rakeback: number; insurance: number; winnings: number; currency: string };

function xlsExtractDirect(bytes: ArrayBuffer): Row[] | null {
  const wb = XLSX.read(Buffer.from(bytes), { type: "buffer" });

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const allRows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "" });

    // Find header row: first row matching external_id + at least one other field
    let headerIdx = -1;
    let colMap: Partial<Record<keyof typeof COL_ALIASES, number>> = {};

    for (let i = 0; i < Math.min(allRows.length, 10); i++) {
      const cells = (allRows[i] as any[]).map((c: any) => String(c).trim().toLowerCase());
      const candidate: typeof colMap = {};
      for (const [field, aliases] of Object.entries(COL_ALIASES) as [keyof typeof COL_ALIASES, string[]][]) {
        // Exact match first — prevents 鱿鱼盈亏 from matching alias 盈亏
        let idx = cells.findIndex(cell => aliases.some(a => cell === a));
        // Fall back to substring match
        if (idx < 0) idx = cells.findIndex(cell => aliases.some(a => cell.includes(a)));
        if (idx >= 0) candidate[field] = idx;
      }
      if (candidate.external_id !== undefined && Object.keys(candidate).length >= 2) {
        headerIdx = i; colMap = candidate; break;
      }
    }

    if (headerIdx < 0) continue;

    // Detect currency: Chinese headers → CNY, otherwise USDT
    const headerCells = (allRows[headerIdx] as any[]).map((c: any) => String(c));
    const hasChinese = headerCells.some(c => /[一-鿿]/.test(c));
    const currency = hasChinese ? "CNY" : "USDT";

    const toNum = (row: any[], idx: number | undefined) => {
      if (idx === undefined) return 0;
      const v = parseFloat(String(row[idx] ?? "").replace(/[^\d.\-]/g, ""));
      return isNaN(v) ? 0 : v;
    };

    const results: Row[] = [];
    for (let i = headerIdx + 1; i < allRows.length; i++) {
      const row = allRows[i] as any[];
      const extId = colMap.external_id !== undefined ? String(row[colMap.external_id] ?? "").trim() : "";
      if (!extId || extId === "-") continue;
      // Skip rows that look like totals/summaries (non-numeric player IDs with suspicious values)
      results.push({
        external_id: extId,
        rakeback: toNum(row, colMap.rakeback),
        insurance: toNum(row, colMap.insurance),
        winnings: toNum(row, colMap.winnings),
        currency,
      });
    }

    if (results.length > 0) {
      console.log("[Reports upload] XLS direct: found", results.length, "rows via column map", colMap);
      return results;
    }
  }
  return null;
}

// ── Claude vision extraction (images only) ───────────────────────────────
// Wepoker column order (confirmed):
//  排名 | 玩家昵称 | 玩家ID | 是否被平台处罚 | 局数 | 手数 | 带入 | 鱿鱼罚金场外带入 | 鱿鱼盈亏 | 保险总投保 | 保险总赔付 | 保险盈利 | 组局基金 | 盈亏 | 备注名
//  IGNORED                                                              IGNORED      IGNORED     ← insurance NET  ← rake     ← winnings  IGNORED
const WEPOKER_COLUMN_GUIDE = `Wepoker column order (left to right):
排名 | 玩家昵称 | 玩家ID | 是否被平台处罚 | 局数 | 手数 | 带入 | 鱿鱼罚金场外带入 | 鱿鱼盈亏 | 保险总投保 | 保险总赔付 | 保险盈利 | 组局基金 | 盈亏 | 备注名

Column mapping:
- external_id  → 玩家ID (player numeric ID)
- rakeback     → 组局基金 (club fund / rake — 2nd-to-last before 备注名)
- insurance    → 保险盈利 (insurance NET P&L — 4th from right). NEVER use 保险总投保 or 保险总赔付.
- winnings     → 盈亏 (net win/loss — last column before 备注名). NEVER use 鱿鱼盈亏.
- currency     → CNY when headers are Chinese, otherwise USDT

CRITICAL column rules:
- 保险总投保 = insurance buy-in premium — IGNORE IT
- 保险总赔付 = insurance payout — IGNORE IT
- 鱿鱼盈亏 = squid side-game P&L — IGNORE IT

CRITICAL row rules:
- Only include rows where 玩家ID is a standalone 7-9 digit number (e.g. 71828947, 58219629)
- SKIP the header row (contains column names, not numbers)
- SKIP summary rows at the top (contain 总局数, 人数, 总组局, etc.)
- SKIP any total/annotation rows at the bottom — these appear after the last player and often contain sums like "36+106+377=519", partial numbers, or formulas. They do NOT have a valid numeric 玩家ID.
- When in doubt whether a row is a player or a total: check if 玩家ID is a 7-9 digit number. If not, skip it.`;

const EXTRACTION_RULES = `Return ONLY a valid JSON array, one object per player:
[{"external_id":"玩家ID value","rakeback":组局基金 value,"insurance":保险盈利 value,"winnings":盈亏 value,"currency":"CNY or USDT"}]
Use 0 for any field not visible. Winnings can be negative.`;

const JSON_FORMAT = `[{"external_id":"12345678","rakeback":152.00,"insurance":72.00,"winnings":1527.00,"currency":"CNY"}]`;

function parseClaudeJson(raw: string): Row[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      const partial = match[0].replace(/,?\s*\{[^}]*$/, "") + "]";
      return JSON.parse(partial) ?? [];
    } catch { return []; }
  }
}

function isXlsFile(file: File): boolean {
  return (
    file.type.includes("spreadsheet") ||
    file.type.includes("excel") ||
    file.type === "application/vnd.ms-excel" ||
    file.name.toLowerCase().endsWith(".xls") ||
    file.name.toLowerCase().endsWith(".xlsx")
  );
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const gameId = Number(formData.get("game_id"));

  if (!file || !gameId) {
    return NextResponse.json({ error: "file + game_id requis" }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  let extracted: Row[] = [];

  try {
    if (isXlsFile(file)) {
      // ── XLS: deterministic column parser, no AI ──
      const direct = xlsExtractDirect(bytes);
      if (direct === null) {
        return NextResponse.json({ error: "Colonnes non reconnues dans le fichier Excel. Colonnes attendues : 玩家ID, 组局基金, 保险盈利, 盈亏" }, { status: 422 });
      }
      extracted = direct;

    } else {
      // ── Image: Claude vision ──
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const base64 = Buffer.from(bytes).toString("base64");
      const mediaType = (file.type || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";

      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: `This is a Wepoker poker club report screenshot.\n\n${WEPOKER_COLUMN_GUIDE}\n\nExample output format:\n${JSON_FORMAT}\n\n${EXTRACTION_RULES}` },
          ],
        }],
      });

      const raw = (msg.content[0] as any).text?.trim() ?? "";
      console.log("[Reports upload] Image Claude raw (300 chars):", raw.substring(0, 300));
      extracted = parseClaudeJson(raw);
    }
  } catch (e: any) {
    console.error("[Reports upload]", e);
    return NextResponse.json({ error: `Extraction échouée : ${e?.message ?? String(e)}` }, { status: 500 });
  }

  if (!extracted.length) {
    return NextResponse.json({ error: "Aucun joueur détecté dans le fichier" }, { status: 422 });
  }

  // Auto-match against known player_game_ids; filter out IDs confirmed as "not our players"
  const db = getDb();
  const knownIds = db.prepare(`
    SELECT pgi.external_id, pgi.player_id, p.name
    FROM player_game_ids pgi JOIN players p ON p.id = pgi.player_id
    WHERE pgi.game_id = ?
  `).all(gameId) as { external_id: string; player_id: number; name: string }[];

  const ignoredIds = db.prepare(`
    SELECT external_id FROM game_ignored_ids WHERE game_id = ?
  `).all(gameId) as { external_id: string }[];

  const knownMap = new Map(knownIds.map(r => [r.external_id.toLowerCase(), r]));
  const ignoredSet = new Set(ignoredIds.map(r => r.external_id.toLowerCase()));

  const rows = extracted
    .filter(e => !ignoredSet.has(String(e.external_id).toLowerCase()))
    .map(e => {
      const known = knownMap.get(String(e.external_id).toLowerCase());
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
