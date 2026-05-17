import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "db-diag-20260518") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  const db = getDb();
  const results: Record<string, any> = {};

  // 1. Schema dumps
  results["1_schemas"] = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE name IN ('player_game_deals','games','players','player_wallet_games','player_wallet_cashouts','telegram_sessions','wallet_transactions','wallet_meres')
    ORDER BY name
  `).all();

  // 2. FK lists per table
  const fkTables = ['player_game_deals','player_wallet_games','player_wallet_cashouts','telegram_sessions','wallet_transactions','wallet_meres'];
  results["2_fk_lists"] = {};
  for (const t of fkTables) {
    results["2_fk_lists"][t] = db.pragma(`foreign_key_list('${t}')`);
  }

  // 3. FK violation check
  results["3_fk_violations"] = db.pragma("foreign_key_check");

  // 4. Referenced data
  results["4_games"] = db.prepare("SELECT id, name, status FROM games").all();
  results["4_player_55"] = db.prepare("SELECT id, name, telegram_id FROM players WHERE id = 55").get() ?? "NOT FOUND";

  // 5. Reproduce failing insert in rolled-back transaction
  try {
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (55, 5, 40, 0)").run();
      throw new Error("ROLLBACK_SENTINEL");
    });
    try { tx(); } catch (e: any) {
      if (e.message === "ROLLBACK_SENTINEL") {
        results["5_insert_test"] = "INSERT succeeded (rolled back)";
      } else {
        results["5_insert_test"] = { error: e.message, code: e.code };
      }
    }
  } catch (e: any) {
    results["5_insert_test"] = { error: e.message, code: e.code };
  }

  return NextResponse.json(results);
}
