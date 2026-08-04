// Promotion des leads NEXA à partir des données de la room.
//
// ─────────────────────────────────────────────────────────────────────────────
// ZÉRO MESSAGE TELEGRAM. Ce module ne fait QUE de la base de données.
//
// L'ancien applyNexaImportPromotions envoyait un message bot au lead à la
// promotion. Cette partie reste DÉBRANCHÉE tant qu'elle n'a pas été cadrée
// séparément (décision Hugo). N'ajoute ici ni sendMsg, ni import de
// telegram-api : ce code tourne dans la transaction d'écriture d'une semaine, un
// appel réseau n'y a rien à faire, et un message parti par erreur ne se rattrape pas.
// ─────────────────────────────────────────────────────────────────────────────
//
// POURQUOI ICI, ET PAS DANS resolveRows. `resolveRows` ne crée jamais rien : elle
// résout ou elle renonce. La création de joueur a lieu au moment où un Member ID
// est CONFIRMÉ PAR LA ROOM — c'est-à-dire quand il apparaît dans un report écrit.
// Un ID tapé dans le bot est déclaratif ; un ID vu dans un report est un fait.
//
// La création déroge à la règle « aucune création implicite », et c'est assumé :
// l'événement est explicite des deux côtés (le lead a donné son ID, la room l'a
// confirmé) et la création est tracée dans nexa_lead_events (actor='import').
// Le garde-fou : la création n'a lieu QUE via nexa_leads.member_id. Un Member ID
// qu'aucun lead ne revendique ne crée personne — il part en réconciliation.
//
// Fichier séparé de ./players pour éviter un import circulaire : players importe
// ./affiliate-ingest, qui appelle ce module.
import type BetterSqlite3 from "better-sqlite3";

type DB = BetterSqlite3.Database;

/** Ordre des paliers — le stage n'avance JAMAIS à reculons. */
const STAGE_ORDER: Readonly<Record<string, number>> = {
  started: 1, app_installed: 2, account_created: 3,
  deposit_done: 4, room_verified: 5, played: 6,
};

export type PromotionInput = { member_id: string | null | undefined; nickname: string; rake: number };

export type PromotionAnomaly = {
  member_id: string;
  /** Le lead qui revendique ce Member ID. */
  lead_id: number;
  /** Le joueur déjà porteur de ce Member ID. */
  player_id: number;
  /** Le lead auquel ce joueur est DÉJÀ lié — d'où le conflit. */
  other_lead_id: number;
};

export type PromotionResult = {
  /** Joueurs créés (lead identifié, aucun joueur existant pour cet ID). */
  created: number;
  /** Leads dont le stage a avancé. */
  promoted: number;
  /** Leads rattachés à un joueur préexistant, sans création. */
  linked: number;
  /** Conflits : deux leads pour un même joueur. Rien n'est touché, à trancher à la main. */
  anomalies: PromotionAnomaly[];
};

/**
 * Applique les promotions pour les lignes d'une semaine qui viennent d'être écrites.
 *
 * À appeler DANS la transaction de commitWeek : une semaine écrite sans ses
 * promotions, ou l'inverse, laisserait un état incohérent.
 *
 * Cinq cas, dans cet ordre :
 *   1. Lead sans player_id, aucun joueur ne porte cet ID → création + lien + stage.
 *   2. Lead déjà lié à un joueur                          → stage seulement.
 *   3. Joueur préexistant porte cet ID, lead non lié      → lien seulement, pas de création.
 *   4. Ce joueur est déjà lié à un AUTRE lead             → on ne touche à RIEN, anomalie.
 *   5. Ligne sans Member ID                               → rien, jamais. Réconciliation manuelle.
 */
export function applyLeadPromotionsOn(db: DB, gameId: number, rows: PromotionInput[]): PromotionResult {
  const out: PromotionResult = { created: 0, promoted: 0, linked: 0, anomalies: [] };

  const leadByMember = db.prepare(
    `SELECT id, player_id, stage FROM nexa_leads WHERE member_id = ?`
  );
  const playerByMember = db.prepare(
    `SELECT player_id FROM player_game_ids WHERE game_id = ? AND external_id = ?`
  );
  const leadOfPlayer = db.prepare(`SELECT id FROM nexa_leads WHERE player_id = ?`);
  const insPlayer = db.prepare(`INSERT INTO players (name) VALUES (?)`);
  const insGameId = db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`);
  const linkLead = db.prepare(`UPDATE nexa_leads SET player_id = ? WHERE id = ?`);
  const setStage = db.prepare(`UPDATE nexa_leads SET stage = ?, updated_at = datetime('now') WHERE id = ?`);
  const logEvent = db.prepare(
    `INSERT INTO nexa_lead_events (lead_id, kind, stage, payload, actor)
     VALUES (?, 'stage_change', ?, ?, 'import')`
  );
  // resolveRows a tourné AVANT nous : les lignes de cette semaine ont été écrites
  // avec player_id NULL, puisque le joueur n'existait pas encore. On les rattache
  // ici, dans la même transaction — sinon la semaine qui vient de créer le joueur
  // serait la seule à ne pas lui être rattachée, ce qui est absurde.
  // `WHERE player_id IS NULL` : on ne réécrit jamais un rattachement déjà fait.
  const backfill = db.prepare(
    `UPDATE nexa_affiliate_weeks SET player_id = ? WHERE player_id IS NULL AND member_id = ?`
  );

  // Une même clé peut apparaître plusieurs fois dans un lot ; on ne traite qu'une fois.
  const seen = new Set<string>();

  for (const r of rows) {
    const memberId = String(r.member_id ?? "").trim();
    if (memberId === "") continue;            // cas 5 — aucune création sans Member ID
    if (seen.has(memberId)) continue;
    seen.add(memberId);

    const lead = leadByMember.get(memberId) as { id: number; player_id: number | null; stage: string } | undefined;
    if (!lead) continue;                      // ID qu'aucun lead ne revendique → réconciliation

    // Le rake de la ligne décide du palier : un rake > 0 dans un report EST une
    // preuve qu'il a joué. Ce n'est pas une interprétation.
    const target = r.rake > 0 ? "played" : "room_verified";

    let playerId = lead.player_id;

    if (playerId === null) {
      const existing = playerByMember.get(gameId, memberId) as { player_id: number } | undefined;
      if (existing) {
        // Cas 3 / 4 — un joueur porte déjà cet ID.
        const other = leadOfPlayer.get(existing.player_id) as { id: number } | undefined;
        if (other && other.id !== lead.id) {
          // Cas 4 — deux leads pour un joueur. On ne tranche pas à la place d'Hugo.
          out.anomalies.push({
            member_id: memberId, lead_id: lead.id,
            player_id: existing.player_id, other_lead_id: other.id,
          });
          continue;
        }
        playerId = existing.player_id;
        linkLead.run(playerId, lead.id);
        out.linked++;
      } else {
        // Cas 1 — création. `name` = pseudo du REPORT : c'est le pseudo de jeu qui
        // fait foi, pas le prénom Telegram du lead (décision Hugo).
        playerId = Number(insPlayer.run(r.nickname).lastInsertRowid);
        insGameId.run(playerId, gameId, memberId);
        linkLead.run(playerId, lead.id);
        out.created++;
        // Pas de nexa_nickname_links : le Member ID suffit et il est plus fort.
        // Pas de part d'action : 0 par défaut, comme tout nouveau joueur.
      }
    }

    // La semaine qu'on vient d'écrire rejoint son joueur, comme tout l'historique.
    if (playerId !== null) backfill.run(playerId, memberId);

    // Cas 2 (et suite des cas 1/3) — le stage n'avance jamais à reculons.
    const cur = STAGE_ORDER[lead.stage] ?? 0;
    if ((STAGE_ORDER[target] ?? 0) > cur) {
      setStage.run(target, lead.id);
      logEvent.run(lead.id, target, JSON.stringify({ member_id: memberId, rake: r.rake }));
      out.promoted++;
    }
  }

  return out;
}

/**
 * Conflits « deux leads pour un même joueur », pour l'écran de réconciliation.
 *
 * Recalculé à la lecture plutôt que stocké : l'anomalie disparaît d'elle-même dès
 * qu'Hugo a tranché, sans qu'il ait à fermer quoi que ce soit.
 */
export type LeadAnomalyRow = {
  member_id: string; lead_id: number; lead_handle: string | null;
  player_id: number; player_name: string;
  other_lead_id: number; other_lead_handle: string | null;
};

export function getLeadAnomaliesOn(db: DB, gameId: number): LeadAnomalyRow[] {
  return db.prepare(`
    SELECT l.member_id, l.id AS lead_id, l.tg_username AS lead_handle,
           g.player_id, p.name AS player_name,
           o.id AS other_lead_id, o.tg_username AS other_lead_handle
      FROM nexa_leads l
      JOIN player_game_ids g ON g.game_id = @gid AND g.external_id = l.member_id
      JOIN players p ON p.id = g.player_id
      JOIN nexa_leads o ON o.player_id = g.player_id AND o.id != l.id
     WHERE l.member_id IS NOT NULL AND l.player_id IS NULL
     ORDER BY l.member_id
  `).all({ gid: gameId }) as LeadAnomalyRow[];
}
