/**
 * Lecture / résolution des cas de groupe à trancher à la main.
 *
 * Un cas est ouvert par `provisionGroup` quand elle refuse de décider seule : soit le
 * rapprochement ne tient qu'à un handle ou un nom (deux `@alexis` existent), soit le
 * contact n'a aucun tg_user_id fiable. Dans les deux cas AUCUN groupe n'a été créé et
 * aucune liaison n'a été touchée — la file ci-dessous est la seule chose à traiter.
 */

import { getDb } from "@/lib/db";
import type { AmbiguousCandidate } from "@/lib/group-lifecycle";

export type GroupReviewCase = {
  id: number;
  kind: "ambiguous_match" | "no_tg_user_id";
  context: string;
  tg_user_id: number | null;
  handle: string | null;
  display_name: string | null;
  candidates: AmbiguousCandidate[];
  detail: string | null;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
};

function hydrate(row: any): GroupReviewCase {
  let candidates: AmbiguousCandidate[] = [];
  try { candidates = row.candidates ? JSON.parse(row.candidates) : []; } catch { candidates = []; }
  return { ...row, candidates };
}

export function getGroupReviewCases(status: "open" | "all" = "open"): GroupReviewCase[] {
  try {
    const rows = status === "all"
      ? getDb().prepare(`SELECT * FROM group_review_cases ORDER BY status = 'open' DESC, created_at DESC LIMIT 200`).all()
      : getDb().prepare(`SELECT * FROM group_review_cases WHERE status = 'open' ORDER BY created_at DESC`).all();
    return (rows as any[]).map(hydrate);
  } catch {
    return []; // table absente (dev / avant migration)
  }
}

export function countOpenGroupReviewCases(): number {
  try {
    const r = getDb().prepare(`SELECT COUNT(*) AS n FROM group_review_cases WHERE status = 'open'`).get() as { n: number };
    return r.n;
  } catch { return 0; }
}

/**
 * Clôt un cas. Ne touche NI Telegram NI les liaisons : rattacher pour de bon se fait avec
 * les outils existants (`/linkgroup` dans le groupe, bouton du funnel une fois l'identité
 * corrigée). Ici on ne fait que sortir le cas de la file, avec la trace de la décision.
 */
export function resolveGroupReviewCase(id: number, resolution: string, dismissed = false): boolean {
  const r = getDb().prepare(`
    UPDATE group_review_cases
    SET status = ?, resolved_at = datetime('now'), resolution = ?
    WHERE id = ? AND status = 'open'
  `).run(dismissed ? "dismissed" : "resolved", resolution, id);
  return r.changes > 0;
}
