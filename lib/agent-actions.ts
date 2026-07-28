/**
 * Confirmation à deux étapes pour les actions de l'agent Telegram.
 *
 * Le principe tient en une phrase : **un outil d'action n'exécute jamais rien**.
 * Il écrit une INTENTION dans agent_pending_actions et rend la main au modèle
 * avec un « en attente de confirmation ». L'exécution ne part que d'un clic sur
 * [Confirmer], traité par le webhook. Il n'existe donc aucun chemin qui aille du
 * texte produit par le modèle à une écriture en base.
 *
 * Conséquence à ne pas casser : `executeAction()` n'est appelée QUE depuis le
 * handler de callback. Si un jour un outil l'appelle directement, toute la
 * garantie tombe.
 *
 * Chaque action déclare :
 *   - level    : 'simple' | 'sensitive' (le niveau ne change pas le flux — tout
 *                passe par la confirmation — mais il est journalisé et affiché)
 *   - preview  : le récap EXACT montré à l'opérateur avant qu'il tranche. Il doit
 *                contenir tout ce qui identifie l'action (qui, quoi, combien).
 *                Il valide aussi les paramètres : s'il jette, rien n'est mis en attente.
 *   - execute  : délègue à la fonction du back-office. Renvoie before/after pour
 *                le journal — c'est ce qui rend l'action réversible à la main.
 */
import { getDb } from "./db";

export type ActionLevel = "simple" | "sensitive";

export interface ActionOutcome {
  before: unknown;
  after: unknown;
  summary: string;
}

interface ActionDef {
  level: ActionLevel;
  /**
   * Fige les paramètres au moment de la mise en attente : résout les références
   * floues ("Ali", "la semaine dernière") en identifiants stables, et c'est le
   * résultat qui est stocké puis exécuté.
   *
   * Sans ça, `execute()` re-résoudrait les paramètres bruts au clic — et si
   * l'état a changé entre-temps, la résolution peut désigner un AUTRE objet que
   * celui prévisualisé. Sur un paiement, c'est payer le mauvais règlement avec
   * l'accord de l'opérateur pour un autre. Ce que l'opérateur voit doit être
   * exactement ce qui s'exécute.
   */
  pin?(params: any): Promise<any> | any;
  preview(params: any): Promise<string> | string;
  execute(params: any, actor: number, chatId: string): Promise<ActionOutcome>;
}

/** Échappe le HTML : le récap part en parse_mode HTML vers Telegram. */
function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Durée de vie d'une intention non confirmée. Court volontairement. */
const TTL_MINUTES = 10;

// ── Résolveurs partagés ───────────────────────────────────

function resolvePlayer(ref: unknown): { id: number; name: string } {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new Error("joueur manquant");
  const db = getDb();
  if (/^\d+$/.test(raw)) {
    const byId = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(Number(raw)) as { id: number; name: string } | undefined;
    if (byId) return byId;
  }
  const rows = db.prepare(
    `SELECT id, name FROM players WHERE name = ? COLLATE NOCASE
     UNION SELECT id, name FROM players WHERE name LIKE ? COLLATE NOCASE LIMIT 5`
  ).all(raw, `%${raw}%`) as Array<{ id: number; name: string }>;
  if (rows.length === 0) throw new Error(`joueur "${raw}" introuvable`);
  const exact = rows.find(r => r.name.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  if (rows.length > 1) {
    throw new Error(`"${raw}" est ambigu (${rows.map(r => r.name).join(", ")}) — précise le nom exact ou l'id`);
  }
  return rows[0];
}

function resolveNexaLead(ref: unknown): { id: number; label: string; stage: string; relances_count: number; last_reminder_at: string | null } {
  const raw = String(ref ?? "").trim().replace(/^@/, "");
  if (!raw) throw new Error("lead manquant");
  const db = getDb();
  const row = db.prepare(
    `SELECT id, tg_username, first_name, member_id, stage, relances_count, last_reminder_at
     FROM nexa_leads
     WHERE (CAST(id AS TEXT) = ?) OR member_id = ? OR tg_username = ? COLLATE NOCASE OR CAST(tg_user_id AS TEXT) = ?
     LIMIT 1`
  ).get(raw, raw, raw, raw) as any;
  if (!row) throw new Error(`lead Nexa "${raw}" introuvable (essaie l'id, le member_id, le @username ou le tg_user_id)`);
  const label = row.first_name || (row.tg_username ? `@${row.tg_username}` : `lead #${row.id}`);
  return { id: row.id, label, stage: row.stage, relances_count: row.relances_count, last_reminder_at: row.last_reminder_at };
}

/**
 * Retrouve UN règlement locked, sans jamais deviner.
 *
 * La lecture passe par getPendingSettlements() — la même que la page Paiements —
 * donc aucun SQL parallèle : ce que l'agent voit est ce que la page affiche.
 * Ambiguïté = refus explicite avec la liste des candidats (règle validée par Baki) :
 * marquer payé le mauvais règlement est irréversible dans l'app.
 */
async function resolveLockedSettlement(p: any) {
  const { getPendingSettlements, getPaidSettlements } = await import("./manual-settlement-engine");
  const pending = getPendingSettlements();

  const rawId = p?.settlement_id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== "") {
    // Strict : `Number(true)` vaut 1 et `Number("0x0c")` vaut 12 — on n'accepte
    // qu'un entier ou une chaîne de chiffres, jamais une coercition exotique.
    const ok = typeof rawId === "number" ? Number.isInteger(rawId) : /^\d+$/.test(String(rawId).trim());
    const id = Number(rawId);
    if (!ok) throw new Error(`settlement_id invalide : ${JSON.stringify(rawId)}`);
    const hit = pending.find(s => s.id === id);
    if (hit) return hit;
    // Message précis plutôt qu'un "introuvable" qui enverrait l'opérateur chercher.
    const paid = getPaidSettlements({}).find(s => s.id === id);
    if (paid) throw new Error(`règlement #${id} déjà payé le ${paid.paid_on ?? "?"} (${paid.player_name} · ${paid.room_label}) — double-paiement refusé`);
    throw new Error(`règlement #${id} introuvable parmi les règlements en attente de paiement`);
  }

  const playerRef = String(p?.player ?? "").trim();
  if (!playerRef) throw new Error("précise settlement_id, ou au minimum le joueur");
  const roomRef = String(p?.room ?? "").trim().toLowerCase();

  const needle = playerRef.toLowerCase();
  // L'égalité exacte l'emporte : sans ça "Ali" tombe silencieusement sur
  // "Alibaba" dès qu'Ali n'a aucun règlement en attente. Même règle que resolvePlayer().
  const exact = pending.filter(s => s.player_name.toLowerCase() === needle);
  let cands = exact.length > 0 ? exact : pending.filter(s => s.player_name.toLowerCase().includes(needle));
  if (roomRef) cands = cands.filter(s => s.room_label.toLowerCase() === roomRef);

  if (cands.length === 0) {
    throw new Error(`aucun règlement en attente pour "${playerRef}"${roomRef ? ` sur ${p.room}` : ""}`);
  }
  if (cands.length > 1) {
    const list = cands.map(s => `#${s.id} ${s.player_name} · ${s.room_label} · ${s.week_label ?? "?"} · ${s.amount_due_usdt.toFixed(2)} USDT`).join(" | ");
    throw new Error(`ambigu — ${cands.length} règlements correspondent, donne le settlement_id : ${list}`);
  }
  return cands[0];
}

function sensLabel(due: number): string {
  if (Math.abs(due) < 0.005) return "solde nul";
  return due > 0 ? "il nous doit — ça rentre" : "on lui doit — ça sort";
}

function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Registre des actions ──────────────────────────────────

export const ACTIONS: Record<string, ActionDef> = {
  create_note: {
    level: "simple",
    preview(p) {
      const player = resolvePlayer(p?.player);
      const content = String(p?.content ?? "").trim();
      if (!content) throw new Error("contenu de la note manquant");
      const type = String(p?.type ?? "note");
      return `📝 <b>Créer une note CRM</b>\nJoueur : <b>${esc(player.name)}</b> (id ${player.id})\nType : ${esc(type)}\nContenu : ${esc(content)}`;
    },
    async execute(p) {
      const player = resolvePlayer(p?.player);
      const content = String(p?.content ?? "").trim();
      const type = String(p?.type ?? "note");
      const db = getDb();
      const before = db.prepare(`SELECT COUNT(*) AS n FROM crm_notes WHERE player_id = ?`).get(player.id);
      const r = db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, ?)`).run(player.id, content, type);
      const after = db.prepare(`SELECT id, player_id, content, type, created_at FROM crm_notes WHERE id = ?`).get(r.lastInsertRowid);
      return { before, after, summary: `Note créée sur ${player.name} (crm_notes #${r.lastInsertRowid}).` };
    },
  },

  add_todo: {
    level: "simple",
    preview(p) {
      const message = String(p?.message ?? "").trim();
      if (!message) throw new Error("message manquant");
      return `🗒 <b>Ajouter à l'inbox agent</b>\n${esc(message)}`;
    },
    async execute(p, _actor, chatId) {
      const message = String(p?.message ?? "").trim();
      const db = getDb();
      const r = db.prepare(`INSERT INTO agent_inbox (chat_id, message) VALUES (?, ?)`).run(chatId, message);
      const after = db.prepare(`SELECT id, chat_id, message, created_at FROM agent_inbox WHERE id = ?`).get(r.lastInsertRowid);
      return { before: null, after, summary: `Ajouté à l'inbox (agent_inbox #${r.lastInsertRowid}).` };
    },
  },

  // Nexa uniquement : c'est le seul funnel qui expose une relance PAR LEAD
  // (sendNexaManualReminder). QQPK n'a qu'une relance de masse planifiée
  // (runQqpkFunnelReminders) — l'exposer ici enverrait des messages à tous les
  // leads d'un coup, ce qui n'est pas « relancer un lead ».
  relance_lead: {
    level: "simple",
    preview(p) {
      const funnel = String(p?.funnel ?? "nexa").toLowerCase();
      if (funnel !== "nexa") throw new Error(`funnel "${funnel}" non supporté : seul Nexa a une relance par lead`);
      const lead = resolveNexaLead(p?.lead);
      const last = lead.last_reminder_at ? `dernière relance ${lead.last_reminder_at}` : "jamais relancé";
      return `📨 <b>Relancer un lead NEXAPOKER</b>\nLead : <b>${esc(lead.label)}</b> (id ${lead.id})\nÉtape : ${esc(lead.stage)}\nRelances déjà envoyées : ${lead.relances_count} · ${esc(last)}`;
    },
    async execute(p) {
      const lead = resolveNexaLead(p?.lead);
      const db = getDb();
      const before = db.prepare(`SELECT id, stage, relances_count, last_reminder_at, cold FROM nexa_leads WHERE id = ?`).get(lead.id);
      const { sendNexaManualReminder } = await import("./nexa-funnel");
      const res = await sendNexaManualReminder(lead.id);
      if (!res.ok) throw new Error(res.error ?? "échec de la relance");
      const after = db.prepare(`SELECT id, stage, relances_count, last_reminder_at, cold FROM nexa_leads WHERE id = ?`).get(lead.id);
      return { before, after, summary: `Relance envoyée à ${lead.label}.` };
    },
  },

  // ── SENSIBLE — de l'argent réel ───────────────────────────
  //
  // Passe par markPaid() du moteur, EXACTEMENT la fonction qu'appelle le bouton
  // "Marquer payé" de /payments (app/payments/actions.ts:18) et celui de chaque
  // page P&L de room. Pas d'écriture parallèle, pas de table miroir : le
  // règlement payé depuis le bot EST la ligne que la page affiche.
  //
  // Aucune math ici. Tous les montants du récap sont lus tels quels sur
  // HubSettlement ; le "sens" est le signe de amount_due_usdt, même convention
  // que dueLabel côté UI.
  //
  // Irréversible dans l'app : il n'existe pas de "démarquer payé", et
  // unlockSettlement refuse un règlement payé. before_json capture donc la ligne
  // complète ET les tx rattachées — c'est le seul moyen de reconstruire à la main.
  // unlock_settlement n'est délibérément PAS exposé au bot : c'est un DELETE
  // (arbitrage Baki 2026-07-28, "aucune suppression via le bot").
  mark_settlement_paid: {
    level: "sensitive",
    // Fige le règlement : à partir d'ici l'action ne parle plus que d'un id.
    // C'est ce qui garantit que le clic paie EXACTEMENT le règlement affiché.
    async pin(p) {
      const s = await resolveLockedSettlement(p);
      return { ...p, settlement_id: s.id, player: undefined, room: undefined };
    },
    async preview(p) {
      const s = await resolveLockedSettlement(p);

      const txHash = p?.tx_hash ? String(p.tx_hash).trim() : undefined;
      const paidDate = p?.paid_date ? String(p.paid_date).trim() : undefined;
      if (paidDate) {
        const { isValidISODate } = await import("./manual-settlement-engine");
        if (!isValidISODate(paidDate)) throw new Error(`date de paiement invalide (${paidDate}) — format attendu YYYY-MM-DD`);
        if (paidDate > new Date().toISOString().slice(0, 10)) throw new Error(`date de paiement dans le futur (${paidDate}) — refusé`);
      }

      const periode = s.period_start && s.period_end
        ? `${String(s.period_start).slice(0, 10)} → ${String(s.period_end).slice(0, 10)}`
        : "période inconnue";

      // Tout ce qui vient du modèle ou de la base est échappé : ce récap est le
      // SEUL garde-fou humain avant un mouvement d'argent, il ne doit pas pouvoir
      // être maquillé par du balisage dans un tx_hash ou un nom de joueur.
      return [
        `💸 <b>MARQUER UN RÈGLEMENT PAYÉ</b> · #${s.id}`,
        `Joueur   : <b>${esc(s.player_name)}</b>`,
        `Room     : ${esc(s.room_label)}`,
        `Semaine  : ${esc(s.week_label ?? "?")} (${esc(periode)})`,
        `Montant  : <b>${signed(s.amount_due_usdt)} USDT</b>`,
        `Sens     : ${sensLabel(s.amount_due_usdt)}`,
        `Détail   : net ${signed(s.net_selected_usdt)} × action ${s.action_pct_applied}%  ·  ${s.tx_count} tx`,
        `État     : ${esc(s.status)} depuis ${s.age_days} j`,
        `Hash     : ${txHash ? esc(txHash) : "(non fourni)"}   Date paiement : ${paidDate ? esc(paidDate) : "(aujourd'hui, par défaut)"}`,
        ``,
        `⚠️ Irréversible : il n'existe pas de « démarquer payé » dans l'app.`,
      ].join("\n");
    },
    async execute(p) {
      // `pin()` a figé settlement_id à la mise en attente : cette résolution ne
      // peut donc emprunter que le chemin par id, jamais retomber sur un autre
      // règlement. Elle sert à revalider l'état (toujours locked ?) — et si le
      // règlement a été payé depuis la page entre-temps, elle jette ici ;
      // markPaid() porte de toute façon sa propre garde WHERE status='locked'.
      if (p?.settlement_id === undefined || p?.settlement_id === null) {
        throw new Error("action non figée (settlement_id absent) — refus par sécurité");
      }
      const s = await resolveLockedSettlement(p);
      const db = getDb();

      const before = {
        settlement: db.prepare(`SELECT * FROM manual_settlements WHERE id = ?`).get(s.id),
        tx_ids: (db.prepare(`SELECT id FROM wallet_transactions WHERE settlement_id = ?`).all(s.id) as Array<{ id: number }>).map(r => r.id),
      };

      const { markPaid } = await import("./manual-settlement-engine");
      const res = markPaid(
        s.id,
        p?.tx_hash ? String(p.tx_hash).trim() : undefined,
        p?.paid_date ? String(p.paid_date).trim() : undefined,
      );
      if (!res.ok) throw new Error(res.error ?? "markPaid a échoué");

      const after = { settlement: db.prepare(`SELECT * FROM manual_settlements WHERE id = ?`).get(s.id) };
      return {
        before, after,
        summary: `Règlement #${s.id} (${s.player_name} · ${s.room_label} · ${signed(s.amount_due_usdt)} USDT) marqué payé.`,
      };
    },
  },
};

// ── Cycle de vie d'une intention ──────────────────────────

export interface PendingRow {
  id: number;
  chat_id: string;
  requested_by: number;
  tool: string;
  level: ActionLevel;
  params_json: string;
  preview: string;
  status: string;
  expires_at: string;
}

export function isActionTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

/**
 * Met une action en attente. N'exécute RIEN. Le preview est construit ici :
 * s'il jette (joueur introuvable, paramètre manquant), aucune ligne n'est écrite
 * et le modèle reçoit l'erreur — il peut corriger avant de déranger l'opérateur.
 */
export async function createPendingAction(args: {
  chatId: string; userId: number; tool: string; params: any;
}): Promise<{ ok: true; id: number; preview: string; level: ActionLevel } | { ok: false; error: string }> {
  const def = ACTIONS[args.tool];
  if (!def) return { ok: false, error: `action inconnue : ${args.tool}` };

  // Ordre important : on FIGE d'abord, on prévisualise ensuite, et ce sont les
  // paramètres figés qui sont stockés — donc exécutés. Prévisualiser des params
  // bruts puis exécuter une re-résolution rouvrirait l'écart entre ce que
  // l'opérateur a vu et ce qui part.
  let pinned: any;
  let preview: string;
  try {
    pinned = def.pin ? await def.pin(args.params ?? {}) : (args.params ?? {});
    preview = await def.preview(pinned);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  const db = getDb();
  const r = db.prepare(
    `INSERT INTO agent_pending_actions (chat_id, requested_by, tool, level, params_json, preview, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+${TTL_MINUTES} minutes'))`
  ).run(args.chatId, args.userId, args.tool, def.level, JSON.stringify(pinned), preview);

  return { ok: true, id: Number(r.lastInsertRowid), preview, level: def.level };
}

/** Intentions en attente pour ce chat dont le clavier n'a pas encore été envoyé. */
export function listUnnotifiedActions(chatId: string): PendingRow[] {
  return getDb().prepare(
    `SELECT * FROM agent_pending_actions
     WHERE chat_id = ? AND status = 'pending' AND notified_at IS NULL
     ORDER BY id ASC`
  ).all(chatId) as PendingRow[];
}

export function markNotified(id: number) {
  getDb().prepare(`UPDATE agent_pending_actions SET notified_at = datetime('now') WHERE id = ?`).run(id);
}

function loadOpen(id: number): PendingRow | null {
  const row = getDb().prepare(`SELECT * FROM agent_pending_actions WHERE id = ?`).get(id) as PendingRow | undefined;
  return row ?? null;
}

function expireIfNeeded(row: PendingRow): boolean {
  if (row.status !== "pending") return false;
  const expired = getDb().prepare(`SELECT datetime('now') > ? AS x`).get(row.expires_at) as { x: number };
  if (expired.x) {
    getDb().prepare(`UPDATE agent_pending_actions SET status = 'expired', resolved_at = datetime('now') WHERE id = ?`).run(row.id);
    return true;
  }
  return false;
}

export function cancelAction(id: number, actor: number): { ok: boolean; text: string } {
  const row = loadOpen(id);
  if (!row) return { ok: false, text: `Action #${id} introuvable.` };
  if (row.status !== "pending") return { ok: false, text: `Action #${id} déjà ${row.status}.` };
  getDb().prepare(
    `UPDATE agent_pending_actions SET status = 'cancelled', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?`
  ).run(actor, id);
  return { ok: true, text: `❌ Action #${id} annulée. Rien n'a été exécuté.` };
}

/**
 * Exécute une intention confirmée. **Appelée uniquement depuis le handler de
 * callback**, jamais depuis un outil.
 *
 * Trois verrous avant d'écrire quoi que ce soit : l'intention est encore
 * `pending`, elle n'a pas expiré, et le confirmeur est bien le demandeur.
 * Le contrôle OWNER_IDS est fait en amont par le webhook — celui-ci s'ajoute,
 * il ne le remplace pas.
 */
export async function executeAction(id: number, actor: number): Promise<{ ok: boolean; text: string }> {
  const row = loadOpen(id);
  if (!row) return { ok: false, text: `Action #${id} introuvable.` };
  if (row.status !== "pending") return { ok: false, text: `Action #${id} déjà ${row.status} — rien de refait.` };
  if (expireIfNeeded(row)) return { ok: false, text: `⏱ Action #${id} expirée (${TTL_MINUTES} min). Redemande-la si tu la veux toujours.` };
  if (row.requested_by !== actor) {
    return { ok: false, text: `⛔ Action #${id} demandée par un autre compte (${row.requested_by}) — seul le demandeur peut confirmer.` };
  }

  const def = ACTIONS[row.tool];
  if (!def) return { ok: false, text: `Action #${id} : outil "${row.tool}" inconnu.` };

  const params = JSON.parse(row.params_json);
  const db = getDb();

  try {
    const outcome = await def.execute(params, actor, row.chat_id);
    db.prepare(
      `INSERT INTO agent_action_log (pending_id, tool, level, params_json, actor, chat_id, ok, before_json, after_json, summary)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(id, row.tool, row.level, row.params_json, actor, row.chat_id,
          JSON.stringify(outcome.before ?? null), JSON.stringify(outcome.after ?? null), outcome.summary);
    db.prepare(
      `UPDATE agent_pending_actions SET status = 'confirmed', resolved_at = datetime('now'), resolved_by = ?, result_text = ? WHERE id = ?`
    ).run(actor, outcome.summary, id);
    return { ok: true, text: `✅ Action #${id} exécutée. ${outcome.summary}` };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    db.prepare(
      `INSERT INTO agent_action_log (pending_id, tool, level, params_json, actor, chat_id, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(id, row.tool, row.level, row.params_json, actor, row.chat_id, msg);
    db.prepare(
      `UPDATE agent_pending_actions SET status = 'failed', resolved_at = datetime('now'), resolved_by = ?, result_text = ? WHERE id = ?`
    ).run(actor, msg, id);
    return { ok: false, text: `❌ Action #${id} en échec : ${msg}` };
  }
}

/** Journal des actions exécutées — lu par le back-office. */
export interface ActionLogRow {
  id: number; pending_id: number | null; tool: string; level: string;
  params_json: string; actor: number; chat_id: string; ok: number;
  error: string | null; before_json: string | null; after_json: string | null;
  summary: string | null; executed_at: string;
}

export function getActionLog(limit = 50): ActionLogRow[] {
  return getDb().prepare(
    `SELECT * FROM agent_action_log ORDER BY executed_at DESC, id DESC LIMIT ?`
  ).all(limit) as ActionLogRow[];
}
