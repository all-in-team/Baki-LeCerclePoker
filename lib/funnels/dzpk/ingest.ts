// Ingestion des notifications du club @dzpk.
//
// ┌─ PULL, PAS LISTENER — et pourquoi ça compte ───────────────────────────────┐
// │ Le userbot interroge l'historique d'UN SEUL peer depuis un curseur, au      │
// │ lieu d'écouter les événements entrants. Deux conséquences voulues :         │
// │                                                                             │
// │  • Confidentialité : aucune autre conversation privée n'est jamais          │
// │    demandée. Ça tient à la PORTÉE de la requête, pas à un filtre appliqué   │
// │    après réception — c'est vérifiable en lisant dix lignes de code.         │
// │  • Non-perte : une coupure réseau ou un redéploiement Railway ne perd rien. │
// │    Le curseur n'avance qu'après écriture réussie, donc la passe suivante    │
// │    reprend exactement où l'on s'était arrêté. Un listener, lui, perd tout   │
// │    ce qui arrive pendant la coupure.                                        │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// Le fichier est coupé en deux volontairement :
//   • `persistClubMessages()` — pure logique + DB, testable sur base temporaire ;
//   • `runDzpkIngest()` — la glue Telegram, non testable hors session réelle.
// Tout ce qui peut être prouvé vit dans la première.

import { getDb } from "@/lib/db";
import { parseClubNotification, PARSER_VERSION, type ParserConfig } from "./club-parser";
import { dzpkAgentName, dzpkClubLabel, dzpkClubBot, ingestBatch, INGEST_STALE_HOURS } from "./config";
import type { DbLike } from "./leads";

/** Message brut tel que rendu par Telegram, réduit à ce dont on a besoin. */
export interface RawClubMessage {
  id: number;
  /** `YYYY-MM-DD HH:MM:SS`, ou null si Telegram n'en fournit pas. Jamais `""`. */
  date: string | null;
  text: string;
}

export interface IngestOutcome {
  inserted: number;
  duplicates: number;
  byKind: Record<string, number>;
  commissions: number;
  /** Commissions écartées parce qu'elles appartiennent à un autre agent. */
  commissionsForeign: number;
  /** Non-parsés qui contenaient le marqueur de commission — de l'argent qu'on ne lit plus. */
  unparsedWithMoney: number;
  maxMsgId: number;
}

/**
 * Écrit un lot de messages bruts, les parse, et matérialise les commissions.
 *
 * Idempotent : `UNIQUE(peer, src_msg_id)` + `INSERT OR IGNORE`. Rejouer le même
 * lot ne duplique rien. La dédup porte sur l'identifiant du message, JAMAIS sur
 * son contenu — deux commissions du même montant le même jour sont deux
 * paiements distincts, et l'inverse (un rejeu) doit être écarté même si les
 * montants diffèrent.
 *
 * ⚠️ N'écrit RIEN sur `dzpk_leads`. L'appariement nom ↔ lead est manuel et
 * n'existe pas encore : à ce stade, aucune attribution n'est possible, donc
 * aucune mauvaise attribution non plus.
 */
export function persistClubMessages(
  peerRaw: string,
  messages: RawClubMessage[],
  cfg: ParserConfig,
  dbOverride?: DbLike,
): IngestOutcome {
  const db = dbOverride ?? getDb();
  const peer = normalizePeer(peerRaw);
  const out: IngestOutcome = {
    inserted: 0, duplicates: 0, byKind: {}, commissions: 0, commissionsForeign: 0,
    unparsedWithMoney: 0, maxMsgId: 0,
  };

  const insMsg = db.prepare(
    `INSERT OR IGNORE INTO dzpk_club_messages
       (peer, src_msg_id, posted_at, raw_text, parsed_kind, parser_version,
        agent_name_raw, agent_is_mine, player_name_raw, name_key, name_key_tight, unparsed_reason)
     VALUES (@peer, @src_msg_id, @posted_at, @raw_text, @parsed_kind, @parser_version,
             @agent_name_raw, @agent_is_mine, @player_name_raw, @name_key, @name_key_tight, @unparsed_reason)`
  );
  const insComm = db.prepare(
    `INSERT OR IGNORE INTO dzpk_commissions
       (club_message_id, posted_at, requested_amount, requested_raw,
        paid_amount, paid_raw, currency, agent_name_raw, parser_version)
     VALUES (@club_message_id, @posted_at, @requested_amount, @requested_raw,
             @paid_amount, @paid_raw, @currency, @agent_name_raw, @parser_version)`
  );

  const selMsgId = db.prepare(`SELECT id FROM dzpk_club_messages WHERE peer = ? AND src_msg_id = ?`);

  const applyOne = (m: RawClubMessage) => {
    if (m.id > out.maxMsgId) out.maxMsgId = m.id;
    const p = parseClubNotification(m.text ?? "", cfg);

    const info = insMsg.run({
      peer,
      src_msg_id: m.id,
      posted_at: m.date ?? null,
      raw_text: m.text ?? "",
      parsed_kind: p.kind,
      parser_version: PARSER_VERSION,
      agent_name_raw: p.agentNameRaw,
      agent_is_mine: p.agentIsMine === null ? null : (p.agentIsMine ? 1 : 0),
      player_name_raw: p.playerNameRaw,
      name_key: p.nameKey,
      name_key_tight: p.nameKeyTight,
      unparsed_reason: p.reason,
    });

    if (info.changes === 0) out.duplicates++;
    else {
      out.inserted++;
      out.byKind[p.kind] = (out.byKind[p.kind] ?? 0) + 1;
      // Un non-parsé qui contient le marqueur de commission n'est pas du bruit :
      // c'est un paiement qu'on ne sait plus lire. Compté à part pour que
      // l'alarme le distingue d'une annonce du club.
      if (p.kind === "unparsed" && (m.text ?? "").includes("申请的分佣")) out.unparsedWithMoney++;
    }

    // ── Commissions ─────────────────────────────────────────────────────────
    // UNIQUEMENT celles dont l'agent est le nôtre. Une commission d'un autre
    // agent reste lisible dans dzpk_club_messages (traçabilité), mais n'entre
    // jamais dans un agrégat de revenu : la compter serait s'attribuer l'argent
    // de quelqu'un d'autre.
    //
    // ⚠️ Cette matérialisation ne dépend PAS du fait que le message soit neuf.
    // Si le processus meurt entre l'insert du message et celui de la commission
    // (SIGTERM d'un redéploiement Railway), la ligne message est committée seule ;
    // au rejeu, un `continue` sur doublon aurait figé le trou définitivement.
    // `club_message_id` étant UNIQUE, réessayer est sans risque et RÉPARE.
    // (audit money du 2026-08-12, F2)
    if (p.kind === "commission" && p.commission) {
      if (p.agentIsMine !== true) { out.commissionsForeign++; return; }
      const row = selMsgId.get(peer, m.id) as { id: number } | undefined;
      if (!row) return;
      const ins = insComm.run({
        club_message_id: row.id,
        posted_at: m.date ?? null,
        requested_amount: p.commission.requestedAmount,
        requested_raw: p.commission.requestedRaw,
        paid_amount: p.commission.paidAmount,
        paid_raw: p.commission.paidRaw,
        currency: p.commission.currency,
        agent_name_raw: p.agentNameRaw,
        parser_version: PARSER_VERSION,
      });
      // Compte les lignes réellement créées, pas les tentatives : un rejeu ne
      // doit pas gonfler le compteur rapporté.
      if (ins.changes > 0) out.commissions++;
    }
  };

  // Lot enveloppé dans une transaction : soit le lot entier est écrit, soit
  // rien. Sans elle, une coupure au milieu laisse un état mi-écrit dont seul
  // le filet de réparation ci-dessus permet de sortir.
  const runAll = () => { for (const m of messages) applyOne(m); };
  if (typeof (db as any).transaction === "function") (db as any).transaction(runAll)();
  else runAll();

  return out;
}

/**
 * Forme canonique du peer, utilisée comme clé de dédup et de curseur.
 *
 * `@dp_bot`, `dp_bot` et `@DP_bot` désignent le MÊME chat côté Telegram, mais
 * seraient trois clés distinctes en base : trois curseurs à zéro, donc une
 * réingestion complète et des commissions comptées deux fois sous un nouveau
 * `club_message_id`. Un simple oubli d'arobase dans une variable d'env suffisait.
 * (audit money du 2026-08-12, F3)
 */
export function normalizePeer(peer: string): string {
  return String(peer ?? "").trim().toLowerCase().replace(/^@+/, "");
}

// ── Curseur ───────────────────────────────────────────────

export interface IngestState {
  peer: string;
  last_msg_id: number;
  last_run_at: string | null;
  last_success_at: string | null;
  messages_seen: number;
  last_error: string | null;
}

export function getIngestState(peerRaw: string, dbOverride?: DbLike): IngestState {
  const db = dbOverride ?? getDb();
  const peer = normalizePeer(peerRaw);
  db.prepare(`INSERT OR IGNORE INTO dzpk_ingest_state (peer) VALUES (?)`).run(peer);
  return db.prepare(`SELECT * FROM dzpk_ingest_state WHERE peer = ?`).get(peer) as IngestState;
}

/**
 * Lecture seule de l'état — pour les GET, qui ne doivent rien créer.
 *
 * Rend un état par défaut « jamais tourné » plutôt que d'insérer la ligne, ce
 * qui donne exactement la même information à l'affichage sans écrire.
 */
export function peekIngestState(peerRaw: string, dbOverride?: DbLike): IngestState {
  const db = dbOverride ?? getDb();
  const peer = normalizePeer(peerRaw);
  const row = db.prepare(`SELECT * FROM dzpk_ingest_state WHERE peer = ?`).get(peer) as IngestState | undefined;
  return row ?? {
    peer, last_msg_id: 0, last_run_at: null, last_success_at: null,
    messages_seen: 0, last_error: null,
  };
}

/**
 * Avance le curseur — APRÈS écriture réussie, jamais avant.
 *
 * `MAX(last_msg_id, ?)` : le curseur ne recule jamais. Sans ce garde, une passe
 * qui rendrait un lot partiel ou désordonné pourrait faire réingérer — ou pire,
 * sauter — des messages déjà traités.
 */
export function advanceCursor(peerRaw: string, maxMsgId: number, seen: number, dbOverride?: DbLike): void {
  const db = dbOverride ?? getDb();
  const peer = normalizePeer(peerRaw);
  db.prepare(
    `UPDATE dzpk_ingest_state
        SET last_msg_id = MAX(last_msg_id, ?),
            messages_seen = messages_seen + ?,
            last_run_at = datetime('now'),
            last_success_at = datetime('now'),
            last_error = NULL
      WHERE peer = ?`
  ).run(maxMsgId, seen, peer);
}

export function recordIngestError(peerRaw: string, message: string, dbOverride?: DbLike): void {
  const db = dbOverride ?? getDb();
  const peer = normalizePeer(peerRaw);
  db.prepare(
    `UPDATE dzpk_ingest_state
        SET last_run_at = datetime('now'), last_error = ?
      WHERE peer = ?`
  ).run(message.slice(0, 500), peer);
}

/**
 * L'ingestion est-elle en panne silencieuse ?
 *
 * Une session userbot invalidée n'émet aucun signal : elle ressemble trait pour
 * trait à une journée sans nouveau joueur. Sans cette borne, la panne se
 * découvre en comptant l'argent, plusieurs jours plus tard.
 *
 * Un curseur jamais initialisé (`last_success_at` NULL) compte comme périmé :
 * « ça n'a jamais tourné » est un problème, pas un état neutre.
 */
export function isIngestStale(state: Pick<IngestState, "last_success_at">, nowMs = Date.now()): boolean {
  if (!state.last_success_at) return true;
  const last = Date.parse(state.last_success_at.replace(" ", "T") + "Z");
  if (!Number.isFinite(last)) return true;
  return nowMs - last > INGEST_STALE_HOURS * 3600_000;
}

// ── Glue Telegram ─────────────────────────────────────────

export function parserConfigFromEnv(): ParserConfig {
  return { agentName: dzpkAgentName(), clubLabel: dzpkClubLabel() };
}

/**
 * Totaux de commissions, PAR DEVISE.
 *
 * Vit ici et non dans le handler de route : invariant #2, la math d'argent
 * n'appartient pas à une route. Conséquence pratique, et c'est la vraie raison :
 * un agrégat dans un handler n'est couvert par aucun test.
 *
 * `ROUND(..., 2)` est appliqué À LA SORTIE seulement — la somme interne reste
 * non arrondie (invariant #9). Sans ça, `SUM` de REAL rend des artefacts du type
 * 600.5999999999999 directement dans le JSON.
 *
 * Jamais de total toutes devises confondues : l'agrégation inter-devises doit
 * passer par une conversion explicite (invariant #3).
 */
export interface CommissionTotalRow {
  currency: string;
  n: number;
  total_requested: number;
  total_paid: number;
  /** Écart d'arrondi cumulé — CALCULÉ, jamais stocké. */
  total_gap: number;
  first_at: string | null;
  last_at: string | null;
}

export function getCommissionTotals(dbOverride?: DbLike): CommissionTotalRow[] {
  const db = dbOverride ?? getDb();
  return db.prepare(
    `SELECT currency,
            COUNT(*)                                          AS n,
            ROUND(SUM(requested_amount), 2)                   AS total_requested,
            ROUND(SUM(paid_amount), 2)                        AS total_paid,
            ROUND(SUM(requested_amount) - SUM(paid_amount), 8) AS total_gap,
            MIN(posted_at) AS first_at,
            MAX(posted_at) AS last_at
       FROM dzpk_commissions
      GROUP BY currency
      ORDER BY currency`
  ).all() as CommissionTotalRow[];
}

/**
 * Signale ce qui est anormal DANS une passe, au lieu de le laisser dans un log.
 *
 * Deux pannes muettes que l'alarme de fraîcheur ne voit pas, parce que
 * l'ingestion tourne parfaitement dans les deux cas :
 *
 *   • Le gabarit du club change ⇒ tout part en `unparsed`, aucune commission
 *     n'est plus enregistrée, et `last_success_at` reste frais.
 *   • `DZPK_AGENT_NAME` diffère d'un caractère du pseudo réel ⇒ 100 % des
 *     commissions basculent en « autre agent » et sont écartées.
 *
 * On n'alerte pas sur « il existe une commission étrangère » (ce peut être
 * normal), mais sur « des commissions sont passées et AUCUNE n'a été retenue » —
 * signature exacte d'un filtre agent désaccordé.
 */
async function raiseIngestAnomalies(outcome: IngestOutcome): Promise<void> {
  const alerts: string[] = [];

  if (outcome.commissions === 0 && outcome.commissionsForeign > 0) {
    alerts.push(
      `💸 <b>${outcome.commissionsForeign} commission(s) écartée(s), aucune retenue</b>\n` +
      `Le filtre agent ne reconnaît plus aucun paiement comme le nôtre. ` +
      `Vérifier <code>DZPK_AGENT_NAME</code> face au pseudo réel dans le club.`
    );
  }
  // Alerter dès UN message non reconnu serait ingérable : le DM du club contient
  // forcément des messages qui ne sont pas des notifications (annonces, promos),
  // et un rattrapage d'historique en produirait une alerte par lot de 100. Une
  // alarme qu'on apprend à ignorer ne protège plus rien.
  //
  // Deux déclencheurs, resserrés sur ce qui compte vraiment :
  //   • une PROPORTION anormale du lot non reconnue ⇒ gabarit probablement changé ;
  //   • un message contenant le marqueur de commission qui échoue au parsing ⇒
  //     toujours, quel que soit le volume : c'est de l'argent qu'on ne lit plus.
  const unparsed = outcome.byKind.unparsed ?? 0;
  const ratio = outcome.inserted > 0 ? unparsed / outcome.inserted : 0;
  if (outcome.unparsedWithMoney > 0) {
    alerts.push(
      `💰 <b>${outcome.unparsedWithMoney} notification(s) de COMMISSION non lisible(s)</b>\n` +
      `Le marqueur 申请的分佣 est présent mais le message n'a pas pu être parsé. ` +
      `Montants non comptabilisés. Détail dans <code>/api/admin/dzpk-ingest</code>.`
    );
  } else if (unparsed >= 3 && ratio > 0.3) {
    alerts.push(
      `❓ <b>${unparsed} notification(s) non reconnue(s) sur ${outcome.inserted}</b>\n` +
      `Proportion anormale — gabarit possiblement modifié par le club. Détail dans ` +
      `<code>/api/admin/dzpk-ingest</code> (unparsed_recent).`
    );
  }
  if (!alerts.length) return;

  try {
    const { notifyOps } = await import("@/lib/ops-notifications");
    await notifyOps(`⚠️ <b>Ingestion dzpk — anomalie</b>\n\n${alerts.join("\n\n")}`);
  } catch (e: any) {
    console.error("[DZPK INGEST] notification d'anomalie échouée:", e?.message ?? e);
  }
}

export interface IngestRunResult {
  ok: boolean;
  peer: string;
  fetched: number;
  error?: string;
  outcome?: IngestOutcome;
}

/**
 * Une passe d'ingestion.
 *
 * Ne lit QUE `DZPK_CLUB_BOT`. Ne touche à aucune autre conversation.
 *
 * L'absence de configuration n'est pas une erreur silencieuse : sans
 * `DZPK_AGENT_NAME`, le filtre agent ne peut pas trancher, et toute commission
 * serait écartée comme « non nôtre ». On refuse donc de tourner plutôt que de
 * remplir la base de messages inexploitables.
 */
export async function runDzpkIngest(): Promise<IngestRunResult> {
  const peer = dzpkClubBot();

  if (!dzpkAgentName()) {
    return { ok: false, peer, fetched: 0, error: "DZPK_AGENT_NAME absent — ingestion refusée" };
  }

  const state = getIngestState(peer);

  try {
    const { getUserbotClient } = await import("@/lib/telegram-userbot");
    const client = await getUserbotClient();
    if (!client) {
      const msg = "userbot indisponible (session absente ou connexion échouée)";
      recordIngestError(peer, msg);
      return { ok: false, peer, fetched: 0, error: msg };
    }

    // ⚠️ `reverse: true` est OBLIGATOIRE, ce n'est pas une préférence.
    //
    // Par défaut GramJS rend les messages du plus RÉCENT au plus ancien
    // (`node_modules/telegram/client/messages.d.ts:82-84`). Avec `limit: 100` et
    // un curseur à 0, on recevrait donc les 100 messages les plus RÉCENTS — puis
    // le curseur sauterait au maximum, enterrant définitivement tout l'historique
    // antérieur sous `minId`. À la mise en service, avec des mois de notifs dans
    // le DM, la quasi-totalité des commissions passées disparaissait en silence :
    // le log aurait dit « 100 lus, 100 nouveaux » et le total aurait eu l'air juste.
    //
    // En mode `reverse`, on remonte du plus ancien au plus récent depuis
    // `offsetId` (exclusif) : le lot est un PRÉFIXE CONTINU, donc « curseur = max
    // reçu » est enfin une affirmation vraie. (audit money du 2026-08-12, F1)
    const batch = ingestBatch();
    const msgs = await client.getMessages(peer, {
      limit: batch,
      reverse: true,
      offsetId: state.last_msg_id,
    });
    const rows: RawClubMessage[] = msgs
      .filter((m: any) => typeof m?.id === "number")
      .map((m: any) => ({
        id: m.id,
        // `null` et surtout pas `""` : une chaîne vide n'est pas nullish, elle
        // traversait les `??` et finissait écrite telle quelle dans `bound_at`,
        // où `IS NOT NULL` la comptait comme un lead crédité.
        // (audit money du 2026-08-12, MA5)
        date: m.date ? new Date(m.date * 1000).toISOString().slice(0, 19).replace("T", " ") : null,
        text: typeof m.message === "string" ? m.message : "",
      }))
      .sort((a, b) => a.id - b.id);

    const outcome = persistClubMessages(peer, rows, parserConfigFromEnv());
    // Curseur avancé même sur un lot vide : « rien de neuf » est un succès, et
    // c'est ce qui maintient `last_success_at` frais et l'alarme au silence.
    advanceCursor(peer, Math.max(outcome.maxMsgId, state.last_msg_id), outcome.inserted);

    console.log(
      `[DZPK INGEST] ${peer} — ${rows.length} lus, ${outcome.inserted} nouveaux, ` +
      `${outcome.duplicates} doublons, kinds=${JSON.stringify(outcome.byKind)}, ` +
      `commissions=${outcome.commissions}${outcome.commissionsForeign ? ` (${outcome.commissionsForeign} d'un autre agent, écartées)` : ""}`
    );

    // Lot plein = il reste probablement du retard. Sans cette ligne, un
    // rattrapage de plusieurs milliers de messages est indistinguable d'un
    // régime stable dans les logs.
    if (rows.length >= batch) {
      console.log(`[DZPK INGEST] lot plein (${batch}) — rattrapage en cours, la passe suivante continuera`);
    }

    await raiseIngestAnomalies(outcome);
    return { ok: true, peer, fetched: rows.length, outcome };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(`[DZPK INGEST] échec sur ${peer}:`, msg);
    recordIngestError(peer, msg);
    return { ok: false, peer, fetched: 0, error: msg };
  }
}
