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
  preview(params: any): Promise<string> | string;
  execute(params: any, actor: number, chatId: string): Promise<ActionOutcome>;
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

// ── Registre des actions ──────────────────────────────────

export const ACTIONS: Record<string, ActionDef> = {
  create_note: {
    level: "simple",
    preview(p) {
      const player = resolvePlayer(p?.player);
      const content = String(p?.content ?? "").trim();
      if (!content) throw new Error("contenu de la note manquant");
      const type = String(p?.type ?? "note");
      return `📝 <b>Créer une note CRM</b>\nJoueur : <b>${player.name}</b> (id ${player.id})\nType : ${type}\nContenu : ${content}`;
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
      return `🗒 <b>Ajouter à l'inbox agent</b>\n${message}`;
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
      return `📨 <b>Relancer un lead NEXAPOKER</b>\nLead : <b>${lead.label}</b> (id ${lead.id})\nÉtape : ${lead.stage}\nRelances déjà envoyées : ${lead.relances_count} · ${last}`;
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

  let preview: string;
  try {
    preview = await def.preview(args.params);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  const db = getDb();
  const r = db.prepare(
    `INSERT INTO agent_pending_actions (chat_id, requested_by, tool, level, params_json, preview, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+${TTL_MINUTES} minutes'))`
  ).run(args.chatId, args.userId, args.tool, def.level, JSON.stringify(args.params ?? {}), preview);

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
