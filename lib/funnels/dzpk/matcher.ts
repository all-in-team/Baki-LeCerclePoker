// Appariement nom-de-club ↔ lead dzpk.
//
// ┌─ CE QUI REND L'APPARIEMENT POSSIBLE ───────────────────────────────────────┐
// │ Le club reprend AUTOMATIQUEMENT le nom du compte Telegram du joueur quand   │
// │ il rejoint : le joueur ne saisit aucun pseudo. Le nom d'une notification    │
// │ « 已绑定为代理 [nom] » est donc le display_name capturé au /start. L'exact   │
// │ normalisé doit couvrir la grande majorité des cas — le reste (renommage,    │
// │ homonymes) part en réconciliation manuelle.                                 │
// │                                                                             │
// │ AUCUN appariement approximatif. Pas de distance d'édition, pas de           │
// │ sous-chaîne, pas de prénom seul. Un rattachement faux déplace du revenu     │
// │ d'une source vers une autre, et rien ne le signale ensuite.                 │
// └─────────────────────────────────────────────────────────────────────────────┘

import { getDb } from "@/lib/db";
import { nameKey } from "./name-key";
import type { DbLike } from "./leads";

export type MatchStatus = "auto" | "manual" | "ambiguous" | "unmatched";
export type MatchMethod = "link" | "display_name" | "display_name_dated";

/**
 * Écart minimal, en heures, entre le meilleur candidat et son suivant pour
 * qu'un départage par date soit considéré comme tranché.
 *
 * Deux leads homonymes ayant fait `/start` à quelques minutes d'intervalle ne
 * SONT PAS départageables par la date : les désigner au hasard maquillerait une
 * incertitude en certitude. Au-delà de ce seuil, l'antériorité devient un
 * argument ; en-deçà, la question part à l'humain.
 */
export const DATE_TIEBREAK_MARGIN_HOURS = 24;

export interface LeadCandidate {
  id: number;
  telegram_id: number;
  display_name: string | null;
  username: string | null;
  source: string;
  started_at: string;
  /** Heures écoulées entre le /start et la notification. Négatif = /start postérieur. */
  hours_before: number | null;
}

export interface MatchResolution {
  status: MatchStatus;
  method: MatchMethod | null;
  leadId: number | null;
  candidates: LeadCandidate[];
  /** Explication courte, affichée dans l'écran de réconciliation. */
  note: string;
}

function hoursBetween(startedAt: string | null, postedAt: string | null): number | null {
  if (!startedAt || !postedAt) return null;
  const a = Date.parse(startedAt.replace(" ", "T") + "Z");
  const b = Date.parse(postedAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3600_000;
}

/**
 * Décide — sans rien écrire.
 *
 * Séparé de l'application pour que la règle soit testable seule, et pour
 * pouvoir afficher le taux d'auto-appariement qu'on OBTIENDRAIT avant de
 * l'activer.
 */
export function resolveMatch(
  clubNameKey: string,
  postedAt: string | null,
  dbOverride?: DbLike,
): MatchResolution {
  const db = dbOverride ?? getDb();
  const key = nameKey(clubNameKey);
  if (!key) return { status: "unmatched", method: null, leadId: null, candidates: [], note: "nom vide" };

  // 1. Lien appris.
  //
  // Le nombre d'homonymes est relu À CHAQUE LECTURE, pas seulement via le job
  // `flagContestedLinks`. Un lien créé quand le nom était unique devient faux dès
  // qu'un second lead apparaît, et le job périodique ne passe qu'ENTRE deux
  // passes : un lien né pendant une passe servait déjà, dans la même passe, à
  // absorber la notification suivante. (audit money du 2026-08-12, MA2)
  //
  // Un lien d'origine `manual` reste souverain : un humain l'a tranché en
  // connaissance de cause, l'homonymie ne le remet pas en question.
  const link = db.prepare(
    `SELECT l.lead_id, l.contested, l.origin,
            (SELECT COUNT(*) FROM dzpk_leads d WHERE d.display_name_key = l.name_key) AS homonymes
       FROM dzpk_name_links l WHERE l.name_key = ?`
  ).get(key) as { lead_id: number; contested: number; origin: string; homonymes: number } | undefined;

  // Le contrôle d'homonymie s'applique aux DEUX origines, manuelle comprise.
  //
  // Laisser un lien `manual` souverain paraissait légitime — un humain a tranché.
  // Mais couplé à la reprise des `ambiguous`, ça transformait une décision prise
  // sur UN MESSAGE en décision implicite sur LE NOM : deux joueurs réellement
  // distincts nommés « mark », Baki tranche la première notification, et la
  // seconde — plausiblement celle de l'autre — était absorbée sans décision, en
  // quittant la file de réconciliation. Silencieux, et donc pire que l'ambiguïté
  // qu'on cherchait à lever. (audit money du 2026-08-12, R2)
  //
  // Le prix assumé : sur un nom réellement porté par deux leads, chaque
  // notification demande un clic. C'est le bon prix — ce sont deux personnes.
  const linkUsable = link && !link.contested && link.homonymes <= 1;
  if (linkUsable) {
    return { status: "auto", method: "link", leadId: link!.lead_id, candidates: [], note: "lien mémorisé" };
  }

  // 2. Égalité exacte sur le display_name capturé au /start.
  const rows = db.prepare(
    `SELECT id, telegram_id, display_name, username, source, started_at
       FROM dzpk_leads WHERE display_name_key = ? ORDER BY started_at`
  ).all(key) as Array<Omit<LeadCandidate, "hours_before">>;

  const candidates: LeadCandidate[] = rows.map(r => ({ ...r, hours_before: hoursBetween(r.started_at, postedAt) }));

  if (link && !linkUsable) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: link.contested
        ? "lien mémorisé marqué contesté"
        : link.origin === "manual"
          ? `lien manuel, mais ${link.homonymes} leads portent ce nom — un humain a tranché UN message, pas le nom`
          : "lien mémorisé automatique devenu ambigu (homonyme apparu)",
    };
  }
  if (candidates.length === 0) {
    return { status: "unmatched", method: null, leadId: null, candidates: [], note: "aucun lead ne porte ce nom" };
  }

  // Message sans date : la causalité est INVÉRIFIABLE, pas violée. Sans ce cas
  // distinct, le motif affiché aurait été « son /start est POSTÉRIEUR », ce qui
  // est faux et enverrait chercher au mauvais endroit.
  if (!postedAt) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: "notification sans date — antériorité du /start invérifiable",
    };
  }

  // 3. CAUSALITÉ — appliquée à TOUS les candidats, y compris quand il n'y en a
  //    qu'un seul.
  //
  // On ne peut pas être rattaché au club avant d'avoir parlé au bot. Le lien
  // d'invitation du club est unique et partagé : un joueur peut donc rejoindre
  // sans jamais faire /start, et un homonyme arrivé plus tard récupérerait son
  // crédit. Ne filtrer que la branche « homonymes » laissait passer le cas le
  // plus courant — un candidat unique postérieur à la notification, crédité
  // d'un rattachement survenu avant son propre /start.
  // (audit money du 2026-08-12, MA3)
  const prior = candidates.filter(c => c.hours_before !== null && c.hours_before >= 0);
  if (prior.length === 0) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: candidates.length === 1
        ? "seul candidat, mais son /start est POSTÉRIEUR à la notification"
        : "homonymes, tous postérieurs à la notification",
    };
  }
  if (prior.length === 1) {
    // `display_name` (unicité réelle) n'est retenu que si le nom ne désigne
    // qu'un lead au total. Sinon c'est un départage, et un départage ne doit
    // jamais se transformer en lien permanent.
    const unique = candidates.length === 1;
    return {
      status: "auto",
      method: unique ? "display_name" : "display_name_dated",
      leadId: prior[0].id,
      candidates,
      note: unique ? "nom unique" : "homonymes, un seul antérieur à la notification",
    };
  }

  // Le plus proche dans le temps l'emporte — à condition d'être NETTEMENT plus
  // proche. Sinon, la date ne tranche rien et l'humain décide.
  const sorted = [...prior].sort((a, b) => (a.hours_before! - b.hours_before!));
  const gap = sorted[1].hours_before! - sorted[0].hours_before!;
  if (gap >= DATE_TIEBREAK_MARGIN_HOURS) {
    return {
      status: "auto", method: "display_name_dated", leadId: sorted[0].id, candidates,
      note: `homonymes départagés par la date (${Math.round(gap)} h d'écart)`,
    };
  }
  return {
    status: "ambiguous", method: null, leadId: null, candidates,
    note: `homonymes trop proches dans le temps (${Math.round(gap)} h) — départage humain`,
  };
}

// ── Application ───────────────────────────────────────────

/**
 * Colonne du lead à horodater selon le gabarit.
 *
 * `Map` et non objet littéral : `EFFECT["constructor"]` sur un objet rend une
 * valeur héritée du prototype, truthy, qui franchirait un garde `if (!col)` et
 * finirait interpolée dans un `UPDATE dzpk_leads SET <col>`. Le filtre SQL en
 * amont rend le cas inatteignable aujourd'hui, mais la clôture doit être
 * structurelle, pas dépendante d'un autre garde.
 * (audit money du 2026-08-12, MA6)
 */
const EFFECT = new Map<string, string>([
  ["join", "club_joined_at"],
  ["bound", "bound_at"],
  ["banned", "banned_at"],
]);

/**
 * Recalcule l'horodatage d'un lead pour un gabarit, depuis les faits.
 *
 * Remplace un `COALESCE(col, ?)`, qui avait deux défauts :
 *   • « première date écrite » ≠ « date la plus ancienne » — vrai tant que les
 *     messages arrivent par id croissant, faux au premier rejeu d'historique ;
 *   • surtout, il rendait un crédit FAUX indélébile. Corriger à la main posait
 *     la date sur le bon lead sans jamais l'ôter du mauvais : une notification
 *     créditait alors DEUX leads, et un rapport par source comptait plus de
 *     rattachements qu'il n'y avait eu de notifications.
 *     (audit money du 2026-08-12, MA4)
 *
 * Ici la colonne est toujours dérivée de l'ensemble des matches appliqués : elle
 * se pose, se déplace et s'efface toute seule, et reste la PLUS ANCIENNE observée.
 */
function recomputeLeadEffect(db: DbLike, leadId: number, kind: string): void {
  const col = EFFECT.get(kind);
  if (!col) return;
  db.prepare(
    `UPDATE dzpk_leads
        SET ${col} = (
              SELECT MIN(m.posted_at)
                FROM dzpk_club_matches x
                JOIN dzpk_club_messages m ON m.id = x.club_message_id
               WHERE x.lead_id = ? AND x.applied = 1 AND m.parsed_kind = ?
                 AND m.posted_at IS NOT NULL AND m.posted_at != ''
            ),
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(leadId, kind, leadId);
}

export interface MatchRunOutcome {
  examined: number;
  auto: number;
  ambiguous: number;
  unmatched: number;
  applied: number;
}

/**
 * Résout et applique les messages rattachables non encore traités.
 *
 * Idempotent : `dzpk_club_matches.club_message_id` est UNIQUE, et l'effet sur le
 * lead est posé avec COALESCE — un second passage ne réécrit pas une date déjà
 * connue. Un rattachement ne recule donc jamais dans le temps.
 *
 * `dryRun` calcule tout et n'écrit RIEN : c'est ce qui permet d'afficher le taux
 * d'auto-appariement réel avant de décider de l'activer.
 */
export function runMatching(
  opts: { dryRun?: boolean } = {},
  dbOverride?: DbLike,
): MatchRunOutcome {
  const db = dbOverride ?? getDb();
  const out: MatchRunOutcome = { examined: 0, auto: 0, ambiguous: 0, unmatched: 0, applied: 0 };

  // Seuls les gabarits porteurs d'un joueur, et seulement ceux qui ne sont pas
  // d'un autre agent. `agent_is_mine IS NULL` est ACCEPTÉ : c'est le cas du
  // gabarit « join », qui ne porte structurellement aucun agent.
  // Sont repris : les messages jamais résolus, ET ceux restés `ambiguous` /
  // `unmatched`. Sans cette reprise, cinq notifications du même nom inconnu
  // resteraient dans la file pour toujours alors que la résolution manuelle de
  // la première a appris le lien — le self-learning n'aurait servi que l'avenir.
  // Les résolutions `manual` et `auto` déjà posées ne sont jamais rejouées.
  const pending = db.prepare(
    `SELECT m.id, m.parsed_kind, m.name_key, m.posted_at
       FROM dzpk_club_messages m
       LEFT JOIN dzpk_club_matches x ON x.club_message_id = m.id
      WHERE m.parsed_kind IN ('join','bound','banned')
        AND m.name_key IS NOT NULL AND m.name_key != ''
        AND (m.agent_is_mine IS NULL OR m.agent_is_mine = 1)
        AND (x.id IS NULL OR x.status IN ('ambiguous','unmatched'))
      ORDER BY m.id`
  ).all() as Array<{ id: number; parsed_kind: string; name_key: string; posted_at: string | null }>;

  const insMatch = db.prepare(
    `INSERT INTO dzpk_club_matches
       (club_message_id, lead_id, status, method, candidates, applied)
     VALUES (@club_message_id, @lead_id, @status, @method, @candidates, @applied)
     ON CONFLICT(club_message_id) DO UPDATE SET
       lead_id = excluded.lead_id, status = excluded.status, method = excluded.method,
       candidates = excluded.candidates, applied = excluded.applied
     WHERE dzpk_club_matches.status IN ('ambiguous','unmatched')`
  );
  const insLink = db.prepare(
    `INSERT OR IGNORE INTO dzpk_name_links (name_key, lead_id, origin) VALUES (?, ?, 'auto')`
  );

  for (const msg of pending) {
    out.examined++;
    const r = resolveMatch(msg.name_key, msg.posted_at, dbOverride);
    out[r.status === "manual" ? "auto" : r.status]++;

    if (opts.dryRun) continue;

    const willApply = r.status === "auto" && r.leadId !== null;
    insMatch.run({
      club_message_id: msg.id,
      lead_id: r.leadId,
      status: r.status,
      method: r.method,
      candidates: JSON.stringify({ note: r.note, candidates: r.candidates }),
      applied: willApply ? 1 : 0,
    });

    if (!willApply) continue;
    if (!EFFECT.has(msg.parsed_kind)) continue;

    recomputeLeadEffect(db, r.leadId!, msg.parsed_kind);

    // Le lien n'est mémorisé QUE sur une unicité réelle du nom.
    //
    // `display_name_dated` est un départage par date — une heuristique. La
    // graver en lien permanent la promouvait au rang d'identité : la
    // notification suivante du même nom, plausiblement celle de l'AUTRE
    // homonyme, était alors absorbée sans le moindre contrôle.
    // (audit money du 2026-08-12, MA2)
    if (r.method === "display_name") insLink.run(msg.name_key, r.leadId);
    out.applied++;
  }

  return out;
}

// ── Réconciliation manuelle ───────────────────────────────

/**
 * Rattache à la main une notification à un lead, et MÉMORISE le lien.
 *
 * C'est le cœur du self-learning : la prochaine notification portant le même
 * nom se rattachera seule. Un lien déjà présent pour cette clé mais pointant
 * ailleurs est réécrit — l'arbitrage humain le plus récent l'emporte.
 */
export function resolveManually(
  clubMessageId: number,
  leadId: number,
  operator: string,
  dbOverride?: DbLike,
): { ok: boolean; error?: string } {
  const db = dbOverride ?? getDb();
  const msg = db.prepare(
    `SELECT id, parsed_kind, name_key, posted_at FROM dzpk_club_messages WHERE id = ?`
  ).get(clubMessageId) as { id: number; parsed_kind: string; name_key: string | null; posted_at: string | null } | undefined;
  if (!msg) return { ok: false, error: "message introuvable" };

  const lead = db.prepare(`SELECT id FROM dzpk_leads WHERE id = ?`).get(leadId);
  if (!lead) return { ok: false, error: "lead introuvable" };

  // Un message sans date ne peut créditer personne : les colonnes du lead sont
  // dérivées de MIN(posted_at), qui l'ignorerait. Accepter la résolution aurait
  // produit le pire état possible — décision enregistrée, message sorti de la
  // file, et aucun crédit nulle part. On refuse, bruyamment.
  // (audit money du 2026-08-12, R3)
  if (EFFECT.has(msg.parsed_kind) && !msg.posted_at) {
    return { ok: false, error: "notification sans date : rattachement impossible (aucune date à porter sur le lead)" };
  }

  // Le lead précédemment crédité, s'il y en avait un et qu'il diffère : sa date
  // devra être recalculée APRÈS la bascule, sans quoi une correction manuelle
  // laisserait le crédit sur les deux leads à la fois.
  const ancien = db.prepare(
    `SELECT lead_id FROM dzpk_club_matches WHERE club_message_id = ?`
  ).get(clubMessageId) as { lead_id: number | null } | undefined;
  const ancienLeadId = ancien?.lead_id != null && ancien.lead_id !== leadId ? ancien.lead_id : null;

  db.prepare(
    `INSERT INTO dzpk_club_matches (club_message_id, lead_id, status, method, applied, resolved_by, resolved_at)
     VALUES (?, ?, 'manual', 'display_name', 1, ?, datetime('now'))
     ON CONFLICT(club_message_id) DO UPDATE SET
       lead_id = excluded.lead_id, status = 'manual', applied = 1,
       resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at`
  ).run(clubMessageId, leadId, operator);

  // Les deux leads sont recalculés depuis les faits : le nouveau reçoit la date,
  // l'ancien la perd si plus aucun message appliqué ne la justifie.
  if (EFFECT.has(msg.parsed_kind)) {
    recomputeLeadEffect(db, leadId, msg.parsed_kind);
    if (ancienLeadId !== null) recomputeLeadEffect(db, ancienLeadId, msg.parsed_kind);
  }

  if (msg.name_key) {
    db.prepare(
      `INSERT INTO dzpk_name_links (name_key, lead_id, origin, contested, created_by)
       VALUES (?, ?, 'manual', 0, ?)
       ON CONFLICT(name_key) DO UPDATE SET
         lead_id = excluded.lead_id, origin = 'manual', contested = 0,
         created_by = excluded.created_by`
    ).run(msg.name_key, leadId, operator);
  }
  return { ok: true };
}

/**
 * Marque contestés les liens dont la clé est devenue ambiguë.
 *
 * Un lien créé quand un seul lead portait ce nom devient douteux dès qu'un
 * second apparaît : l'unicité d'hier était un accident du volume. Le conserver
 * en silence rattacherait toutes les notifications suivantes au premier venu.
 */
export function flagContestedLinks(dbOverride?: DbLike): { contested: number } {
  const db = dbOverride ?? getDb();
  const info = db.prepare(
    `UPDATE dzpk_name_links
        SET contested = 1
      WHERE contested = 0
        AND origin = 'auto'
        AND (SELECT COUNT(*) FROM dzpk_leads l WHERE l.display_name_key = dzpk_name_links.name_key) > 1`
  ).run();
  return { contested: info.changes };
}

/**
 * Contrôle de cohérence : autant de leads crédités que de notifications appliquées ?
 *
 * `bound_at` est une colonne UNIQUE par lead : quand deux notifications tombent
 * sur le même lead — homonymes départagés par la date, ou absorption par un
 * lien — la seconde devient invisible. Le total du funnel semble juste, et il
 * manque un rattachement.
 *
 * Cet écart est le seul symptôme observable d'une collision. Il est exposé
 * plutôt que calculé à la demande, précisément parce que personne ne pense à le
 * chercher. (audit money du 2026-08-12, point 3.2)
 */
export interface CoherenceRow {
  kind: string;
  applied_matches: number;
  credited_leads: number;
  /** > 0 = des notifications sont tombées sur un lead déjà crédité. */
  collisions: number;
}

export function checkMatchCoherence(dbOverride?: DbLike): CoherenceRow[] {
  const db = dbOverride ?? getDb();
  const out: CoherenceRow[] = [];
  for (const [kind, col] of EFFECT) {
    const applied = db.prepare(
      `SELECT COUNT(*) AS n
         FROM dzpk_club_matches x JOIN dzpk_club_messages m ON m.id = x.club_message_id
        WHERE x.applied = 1 AND m.parsed_kind = ?
          AND m.posted_at IS NOT NULL AND m.posted_at != ''`
    ).get(kind) as { n: number };
    const credited = db.prepare(
      `SELECT COUNT(*) AS n FROM dzpk_leads WHERE ${col} IS NOT NULL`
    ).get() as { n: number };
    out.push({
      kind,
      applied_matches: applied.n,
      credited_leads: credited.n,
      collisions: Math.max(0, applied.n - credited.n),
    });
  }
  return out;
}

/** File de réconciliation : ce qui attend une décision humaine. */
export function listPendingReconciliation(limit = 100, dbOverride?: DbLike) {
  const db = dbOverride ?? getDb();
  return db.prepare(
    `SELECT x.id AS match_id, x.status, x.candidates,
            m.id AS club_message_id, m.parsed_kind, m.player_name_raw, m.posted_at, m.raw_text
       FROM dzpk_club_matches x
       JOIN dzpk_club_messages m ON m.id = x.club_message_id
      WHERE x.status IN ('ambiguous','unmatched')
      ORDER BY m.posted_at DESC, x.id DESC
      LIMIT ?`
  ).all(limit);
}
