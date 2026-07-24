/**
 * Purge hebdo des shells d'onboarding morts — "xxx x LeCercle" où il ne reste que
 * l'équipe (@HugoRoine, @Baki77777, @LeCercle_Lebot, le compte userbot). Décision
 * Hugo 2026-07-19 : chaque lundi, kick Hugo + kick le bot, puis le userbot (compte
 * Baki, créateur/owner des groupes) sort en dernier → le shell disparaît de tous
 * les Telegram sans action manuelle.
 *
 * GARDE-FOUS (règles dures) :
 *  - jamais un groupe lié à un joueur (players.telegram_group_id) ni le chat agent ;
 *  - jamais si un membre hors équipe est présent (un joueur a rejoint → pas un shell) ;
 *  - membres illisibles → skip (on ne purge pas à l'aveugle) ;
 *  - cap par run (throttle Telegram) — le backlog se résorbe sur plusieurs lundis.
 */

import { getDb } from "./db";
import {
  listUserbotChannels, getChatMembers, getUserbotMe, kickFromChannel, leaveUserbotChannels,
} from "./telegram-userbot";
import { sendMsg, AGENT_CHAT_ID } from "./telegram-commands/helpers";

const TEAM_USERNAMES = new Set(["hugoroine", "baki77777"]);
const BOT_USERNAME = "lecercle_lebot";
const SHELL_TITLE_RE = /x\s*LeCercle/i;
const DEFAULT_CAP = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ShellPurgeResult {
  ok: boolean;
  scanned: number;
  purged: { chat_id: string; title: string }[];
  skipped: { chat_id: string; title: string; reason: string }[];
  remaining_candidates: number;
  // Nombre de channels du compte AVANT la purge de ce run — pour l'alerte de
  // plafond (limite Telegram 500) dans le rapport agent.
  total_channels: number;
  error: string | null;
}

export async function purgeDeadShells(cap: number = DEFAULT_CAP): Promise<ShellPurgeResult> {
  const res: ShellPurgeResult = { ok: false, scanned: 0, purged: [], skipped: [], remaining_candidates: 0, total_channels: 0, error: null };

  const inv = await listUserbotChannels();
  if (!inv.ok) { res.error = inv.error ?? "listUserbotChannels failed"; return res; }
  res.total_channels = inv.total_channels ?? inv.channels.length;
  const me = await getUserbotMe();
  if (!me) { res.error = "getUserbotMe failed"; return res; }

  const keep = new Set<string>([String(AGENT_CHAT_ID)]);
  const rows = getDb().prepare(
    `SELECT telegram_group_id FROM players WHERE telegram_group_id IS NOT NULL AND telegram_group_id != ''`
  ).all() as { telegram_group_id: string }[];
  for (const r of rows) keep.add(r.telegram_group_id);

  const candidates = inv.channels.filter((c) => SHELL_TITLE_RE.test(c.title) && !keep.has(c.chat_id));
  const batch = candidates.slice(0, Math.min(cap, DEFAULT_CAP));
  res.remaining_candidates = candidates.length - batch.length;

  for (const c of batch) {
    res.scanned++;
    const members = await getChatMembers(c.chat_id);
    await sleep(600);
    if (members.length === 0) {
      res.skipped.push({ chat_id: c.chat_id, title: c.title, reason: "membres illisibles" });
      continue;
    }
    const strangers = members.filter((m) => {
      if (m.id === me.id) return false;
      const uname = (m.username ?? "").toLowerCase();
      if (m.bot) return uname !== BOT_USERNAME; // un autre bot que le nôtre = pas un shell à nous
      return !TEAM_USERNAMES.has(uname);
    });
    if (strangers.length > 0) {
      res.skipped.push({ chat_id: c.chat_id, title: c.title, reason: `membre hors équipe: ${strangers[0].username ?? strangers[0].first_name ?? strangers[0].id}` });
      continue;
    }

    // Purge — kick l'équipe d'abord, le userbot (owner) sort en dernier.
    let kickFailed = false;
    for (const m of members) {
      if (m.id === me.id) continue;
      const k = await kickFromChannel(c.chat_id, m.id);
      await sleep(900);
      if (!k.ok) {
        // Pas admin (shell créé à la main) ou autre blocage → on n'abandonne pas le
        // groupe à moitié vidé sans le signaler.
        res.skipped.push({ chat_id: c.chat_id, title: c.title, reason: `kick impossible (${k.error ?? "?"}) — à nettoyer manuellement` });
        kickFailed = true;
        break;
      }
    }
    if (kickFailed) continue;

    const leave = await leaveUserbotChannels([c.chat_id]);
    if (leave.left.includes(c.chat_id)) {
      res.purged.push({ chat_id: c.chat_id, title: c.title });
    } else {
      res.skipped.push({ chat_id: c.chat_id, title: c.title, reason: `leave échoué (${leave.failed[0]?.error ?? "?"})` });
    }
  }

  res.ok = true;
  return res;
}

// Post the weekly report in the agent chat — never throws (a reporting failure must
// not crash the cron).
export async function reportShellPurge(r: ShellPurgeResult): Promise<void> {
  try {
    const lines: string[] = [`🧹 <b>Purge hebdo des shells</b>`];
    if (!r.ok) {
      lines.push(`❌ Échec : ${r.error}`);
    } else {
      lines.push(`✅ ${r.purged.length} groupe(s) purgé(s) · ${r.skipped.length} ignoré(s) · ${r.remaining_candidates} restant(s) pour les prochains runs`);
      if (r.total_channels > 0) {
        const after = r.total_channels - r.purged.length;
        lines.push(`📡 Compte userbot : ~${after} channels — ~${Math.max(0, 500 - after)} slot(s) libre(s) (limite Telegram 500)`);
        if (after >= 480) lines.push(`⚠️ Plafond proche — lancer un tri (listes B/C) ou prévoir un 2ᵉ compte userbot.`);
      }
      if (r.purged.length) lines.push(r.purged.map((p) => `  • ${p.title}`).join("\n"));
      const manual = r.skipped.filter((s) => s.reason.includes("manuellement"));
      if (manual.length) lines.push(`⚠️ À nettoyer à la main :\n` + manual.map((s) => `  • ${s.title} (${s.reason})`).join("\n"));
    }
    await sendMsg(AGENT_CHAT_ID, lines.join("\n"));
  } catch (e: any) {
    console.error("[SHELL-PURGE] report failed:", e?.message ?? e);
  }
}
