// Rapport hebdomadaire du funnel dzpk : clic → start → join → rattaché,
// ventilé par source, en COHORTES de semaine de /start.
//
// ┌─ CE QUE « SEMAINE » VEUT DIRE ICI ─────────────────────────────────────────┐
// │ Les joins et rattachements sont comptés dans la semaine du /START de leur  │
// │ lead, pas dans la semaine où ils se produisent. C'est le seul découpage    │
// │ qui rende un taux lisible : « des 12 leads entrés cette semaine-là, 3 ont  │
// │ rejoint » — même si le join est arrivé la semaine suivante. Le prix connu :│
// │ les chiffres d'une semaine récente BOUGENT tant que sa cohorte vit.        │
// │                                                                            │
// │ Les CLICS, eux, sont comptés dans leur propre semaine (un clic n'a pas de  │
// │ lead). Sur une frontière de dimanche soir, clic et /start peuvent tomber   │
// │ dans deux semaines différentes — écart structurel, assumé, marginal.       │
// │                                                                            │
// │ La DÉPENSE vit chez les réseaux, pas en base : le coût par étape se lit en │
// │ rapprochant ce tableau des stats de campagne. Pas de saisie manuelle ici — │
// │ un chiffre d'argent recopié à la main dans un back-office finit toujours   │
// │ par diverger de sa source.                                                 │
// └────────────────────────────────────────────────────────────────────────────┘

import { getDb } from "@/lib/db";
import { creToStartParam } from "@/lib/richads";
import type { DbLike } from "./leads";
import { sourceLabel } from "./dashboard";

export interface DzpkWeeklyRow {
  /** Lundi de la semaine, `AAAA-MM-JJ` — clé de tri et d'affichage. */
  week: string;
  source: string;
  source_label: string;
  clicks: number;
  starts: number;
  joined: number;
  bound: number;
  blocked: number;
  followups: number;
}

/** Lundi de la semaine d'une date SQLite, en SQL — utilisé pour clics et leads. */
const WEEK_EXPR = (col: string) =>
  `date(${col}, '-6 days', 'weekday 1')`;

/**
 * Rapport des `weeks` dernières semaines (courante comprise).
 *
 * Le rapprochement clics ↔ leads se fait côté JS : la créative d'un clic
 * (`tgads-26845720`, `4001301`) et la source d'un lead (`tgads_26845720`,
 * `richads_4001301`) ne portent pas la même forme, et `creToStartParam` est LA
 * fonction qui définit cette correspondance — le SQL qui la recopierait se
 * tromperait le jour où elle bouge.
 */
export function getDzpkWeeklyReport(dbOverride?: DbLike, weeks = 6): DzpkWeeklyRow[] {
  const db = dbOverride ?? getDb();
  const horizon = `datetime('now', '-${weeks * 7} days')`;

  const leadRows = db.prepare(
    `SELECT ${WEEK_EXPR("started_at")} AS week,
            source,
            COUNT(*)                                                    AS starts,
            SUM(CASE WHEN club_joined_at IS NOT NULL THEN 1 ELSE 0 END) AS joined,
            SUM(CASE WHEN bound_at       IS NOT NULL THEN 1 ELSE 0 END) AS bound,
            SUM(CASE WHEN blocked = 1                THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN last_followup_at IS NOT NULL THEN 1 ELSE 0 END) AS followups
       FROM dzpk_leads
      WHERE started_at >= ${horizon}
      GROUP BY week, source`
  ).all() as Array<Omit<DzpkWeeklyRow, "source_label" | "clicks">>;

  const clickRows = db.prepare(
    `SELECT ${WEEK_EXPR("clicked_at")} AS week, cre, COUNT(*) AS clicks
       FROM richads_clicks
      WHERE clicked_at >= ${horizon}
        AND is_unique = 1
      GROUP BY week, cre`
  ).all() as Array<{ week: string; cre: string; clicks: number }>;

  const byKey = new Map<string, DzpkWeeklyRow>();
  const keyOf = (week: string, source: string) => `${week}|${source}`;
  const ensure = (week: string, source: string): DzpkWeeklyRow => {
    const k = keyOf(week, source);
    let row = byKey.get(k);
    if (!row) {
      row = {
        week, source, source_label: sourceLabel(source),
        clicks: 0, starts: 0, joined: 0, bound: 0, blocked: 0, followups: 0,
      };
      byKey.set(k, row);
    }
    return row;
  };

  for (const l of leadRows) {
    const row = ensure(l.week, l.source);
    row.starts = l.starts; row.joined = l.joined; row.bound = l.bound;
    row.blocked = l.blocked; row.followups = l.followups;
  }
  for (const c of clickRows) {
    // La forme « source » d'une créative de clic. Les clics de test internes
    // (`moderation_test`, `zztest-…`) produisent des sources qui n'existent sur
    // aucun lead : ils apparaissent en lignes à 0 start, ce qui est voulu — un
    // canal qui clique sans jamais démarrer DOIT se voir.
    ensure(c.week, creToStartParam(c.cre)).clicks += c.clicks;
  }

  return [...byKey.values()].sort((a, b) =>
    a.week !== b.week ? (a.week < b.week ? 1 : -1)
    : b.starts - a.starts || (a.source < b.source ? -1 : 1));
}

export interface DzpkAbStatsRow {
  variant: string;
  leads: number;
  blocked: number;
  replied: number;
  joined: number;
  bound: number;
}

/**
 * Stats du test A/B d'accueil (étape 5). Seuls comptent les leads dont la
 * variante a été ÉCRITE (exposés au test) — les leads antérieurs n'entrent pas.
 */
export function getWelcomeAbStats(dbOverride?: DbLike): DzpkAbStatsRow[] {
  const db = dbOverride ?? getDb();
  try {
    return db.prepare(
      `SELECT welcome_variant AS variant,
              COUNT(*)                                                    AS leads,
              SUM(CASE WHEN blocked = 1                THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN first_reply_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
              SUM(CASE WHEN club_joined_at IS NOT NULL THEN 1 ELSE 0 END) AS joined,
              SUM(CASE WHEN bound_at       IS NOT NULL THEN 1 ELSE 0 END) AS bound
         FROM dzpk_leads
        WHERE welcome_variant IS NOT NULL
        GROUP BY welcome_variant
        ORDER BY welcome_variant`
    ).all() as DzpkAbStatsRow[];
  } catch {
    // Migration pas encore jouée : l'écran vit sans le bloc A/B.
    return [];
  }
}
