// Lectures de l'écran back-office dzpk. SERVEUR uniquement (accès base).
//
// Tout le SQL de la page vit ici, pas dans le composant ni dans une route :
// même règle que le reste du repo (invariant #2 — les handlers restent minces).
//
// Aucune ÉCRITURE dans ce module. L'écran est en lecture seule : la
// réconciliation manuelle passe encore par `POST /api/admin/dzpk-ingest`
// (action `resolve`), qui est le chemin testé. Un bouton dans l'UI viendra
// quand Baki l'aura demandé — attribuer du revenu d'un clic mérite sa propre
// passe de revue.

import { getDb } from "@/lib/db";
import { creLabel, RICHADS_SOURCE_PREFIX } from "@/lib/richads";
import { deriveState, type DzpkState, type DbLike } from "./leads";
import { listPendingReconciliation } from "./matcher";
import { getCommissionTotals, type CommissionTotalRow } from "./ingest";
import type { DzpkMatchStatus } from "./stages";

export interface DzpkDashboardLead {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Nom du compte Telegram — c'est LA clé d'appariement avec le club. */
  display_name: string | null;
  /** Source brute, telle que loggée au /start (first-touch). */
  source: string;
  /** Même source, mise en forme pour l'œil : `richads_4001300` → `richads/instant`. */
  source_label: string;
  started_at: string;
  first_reply_at: string | null;
  club_joined_at: string | null;
  bound_at: string | null;
  banned_at: string | null;
  converted_at: string | null;
  blocked: number;
  start_count: number;
  /** Étape DÉRIVÉE des faits (cf. deriveState) — jamais stockée. */
  state: DzpkState;
  match: DzpkMatchStatus;
  /** Notifications du club rattachées à ce lead, par mode de résolution. */
  match_auto: number;
  match_manual: number;
  /** Notifications en attente de décision qui citent ce lead parmi leurs candidats. */
  match_pending: number;
}

/** Une notification du club qui attend une décision humaine. */
export interface DzpkPendingMatch {
  club_message_id: number;
  status: string;
  parsed_kind: string;
  player_name_raw: string | null;
  posted_at: string | null;
  /** Motif court rendu par le résolveur (« homonymes trop proches… »). */
  note: string;
  /** Leads envisagés, figés au moment de la résolution. */
  candidates: { id: number; label: string }[];
}

export interface DzpkDashboardData {
  leads: DzpkDashboardLead[];
  /** Agrégats PAR DEVISE — jamais tous devises confondues (invariant #3). */
  commissions: CommissionTotalRow[];
  pending: DzpkPendingMatch[];
  /** Notifications en attente ne citant AUCUN lead : invisibles dans le tableau. */
  orphans: number;
}

/**
 * Mise en forme de la source.
 *
 * RichAds ne transmet qu'un identifiant numérique de créa ; `creLabel` lui rend
 * son nom quand on le connaît, et laisse l'identifiant brut sinon (une créa
 * inconnue reste une source valide — cf. lib/richads.ts).
 *
 * Le séparateur toléré est `_` ou `-` : un payload de deep link Telegram
 * n'accepte pas `/`, la barre oblique n'existe donc qu'à l'affichage.
 */
export function sourceLabel(source: string): string {
  const m = new RegExp(`^${RICHADS_SOURCE_PREFIX}[_-](.+)$`).exec(source);
  return m ? `${RICHADS_SOURCE_PREFIX}/${creLabel(m[1])}` : source;
}

type LeadSqlRow = Omit<DzpkDashboardLead, "state" | "source_label" | "match" | "match_pending">;

/**
 * Décide le statut affiché quand plusieurs signaux coexistent.
 *
 * `pending` l'emporte sur tout le reste : un lead déjà rattaché peut être cité
 * dans une AUTRE notification qui, elle, attend une décision. Afficher
 * « auto-certain » masquerait le travail restant, ce qui est exactement ce que
 * la colonne doit empêcher.
 */
function matchStatus(row: { match_auto: number; match_manual: number }, pending: number): DzpkMatchStatus {
  if (pending > 0) return "pending";
  if (row.match_manual > 0) return "manual";
  if (row.match_auto > 0) return "auto";
  return "none";
}

/**
 * `dbOverride` : même parti pris que leads.ts / matcher.ts / ingest.ts. La base
 * locale ne s'initialise pas hors Railway, donc sans ce paramètre le SQL de cet
 * écran ne serait exécuté pour la première fois qu'en production.
 */
export function getDzpkDashboard(dbOverride?: DbLike): DzpkDashboardData {
  const db = dbOverride ?? getDb();

  const rows = db.prepare(
    `SELECT l.id, l.telegram_id, l.username, l.first_name, l.last_name, l.display_name,
            l.source, l.started_at, l.first_reply_at, l.club_joined_at, l.bound_at,
            l.banned_at, l.converted_at, l.blocked, l.start_count,
            -- applied = 1 exigé : une résolution qui n'a rien posé sur le lead ne
            -- prouve aucun rattachement, elle ne doit pas se lire comme tel.
            -- (Pas de backtick dans ce bloc : il est porté par un template literal JS.)
            (SELECT COUNT(*) FROM dzpk_club_matches x
              WHERE x.lead_id = l.id AND x.status = 'auto'   AND x.applied = 1) AS match_auto,
            (SELECT COUNT(*) FROM dzpk_club_matches x
              WHERE x.lead_id = l.id AND x.status = 'manual' AND x.applied = 1) AS match_manual
       FROM dzpk_leads l
      ORDER BY l.started_at DESC, l.id DESC`
  ).all() as LeadSqlRow[];

  const { pending, byLead, orphans } = readPending(dbOverride);

  return {
    leads: rows.map(r => ({
      ...r,
      source_label: sourceLabel(r.source),
      state: deriveState(r),
      match_pending: byLead.get(r.id) ?? 0,
      match: matchStatus(r, byLead.get(r.id) ?? 0),
    })),
    commissions: getCommissionTotals(dbOverride),
    pending,
    orphans,
  };
}

/**
 * File de réconciliation, relue côté JS.
 *
 * Les candidats sont stockés en JSON dans `dzpk_club_matches.candidates` : les
 * interroger en SQL demanderait un `LIKE` sur du JSON, qui rattacherait le lead
 * 7 à toute ligne citant le lead 71. On lit la file (bornée) et on la parse.
 */
function readPending(dbOverride?: DbLike): { pending: DzpkPendingMatch[]; byLead: Map<number, number>; orphans: number } {
  const raw = listPendingReconciliation(200, dbOverride) as Array<{
    status: string; candidates: string | null; club_message_id: number;
    parsed_kind: string; player_name_raw: string | null; posted_at: string | null;
  }>;

  const byLead = new Map<number, number>();
  let orphans = 0;

  const pending = raw.map(r => {
    let note = "";
    let candidates: { id: number; label: string }[] = [];
    try {
      const parsed = r.candidates ? JSON.parse(r.candidates) : null;
      note = typeof parsed?.note === "string" ? parsed.note : "";
      // Le libellé est reconstruit ici et non relu en base : `candidates` est un
      // instantané figé au moment de la résolution. Un lead renommé depuis ne
      // doit pas faire croire que la décision portait sur son nouveau nom.
      candidates = Array.isArray(parsed?.candidates)
        ? parsed.candidates
            .filter((c: any) => Number.isInteger(c?.id))
            .map((c: any) => ({
              id: c.id as number,
              label: String(c.display_name || (c.username ? `@${c.username}` : `lead ${c.id}`)),
            }))
        : [];
    } catch {
      // JSON illisible : la notification reste dans la file, sans candidat. La
      // taire serait pire — c'est une décision à prendre, pas un détail d'affichage.
      note = "candidats illisibles";
    }

    if (candidates.length === 0) orphans++;
    for (const c of candidates) byLead.set(c.id, (byLead.get(c.id) ?? 0) + 1);

    return {
      club_message_id: r.club_message_id,
      status: r.status,
      parsed_kind: r.parsed_kind,
      player_name_raw: r.player_name_raw,
      posted_at: r.posted_at,
      note,
      candidates,
    };
  });

  return { pending, byLead, orphans };
}
