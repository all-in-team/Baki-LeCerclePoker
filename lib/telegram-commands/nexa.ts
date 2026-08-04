// Commande /nexa — buy-in / cash-out NEXAPOKER depuis Telegram.
//
// ─────────────────────────────────────────────────────────────────────────────
// C'EST DE L'ARGENT. Trois règles non négociables :
//   1. RÉSERVÉ À L'OWNER, en conversation PRIVÉE. Tout le reste : silence total —
//      pas de « accès refusé », qui confirmerait l'existence de la commande.
//   2. RIEN N'EST ÉCRIT SANS CONFIRMATION. Le bot reformule (montant en clair,
//      jamais « 1k ») et attend le clic.
//   3. MÊME CHEMIN D'ÉCRITURE que les boutons de la page : addMovement, qui passe
//      par insertWalletTransaction (source='manual'). Aucune requête SQL ici.
// ─────────────────────────────────────────────────────────────────────────────
//
// Aucune création de joueur depuis Telegram : un @ qui ne correspond à personne
// est un refus, pas une invitation à créer.
//
// L'attente de confirmation vit en MÉMOIRE, comme pendingBroadcasts (./broadcast).
// C'est le bon sens de défaillance pour de l'argent : un redéploiement perd
// l'attente, donc RIEN ne s'écrit. L'inverse — une demande qui survit et s'exécute
// après coup — serait bien pire.
import { getDb } from "@/lib/db";
import { addMovement, getMovements } from "@/lib/funnels/nexa/players";
import { NEXA_GAME_NAME } from "@/lib/funnels/nexa/affiliate-ingest";
import {
  parseNexaCommand, formatAmount, NEXA_USAGE,
  type MovementKind, type PlayerRef,
} from "@/lib/funnels/nexa/movement-command";
import { sendMsg, sendMsgKeyboard, answerCbQuery, OWNER_IDS } from "./helpers";

/** Au-delà, la demande est périmée : un bouton oublié ne doit pas écrire 3 jours plus tard. */
const TTL_MS = 10 * 60 * 1000;

type Pending = {
  id: string;
  ownerId: number;
  playerId: number;
  playerName: string;
  handle: string | null;
  kind: MovementKind;
  amount: number;
  date: string;
  note: string | null;
  createdAt: number;
};

const pending = new Map<string, Pending>();
let seq = 0;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > TTL_MS) pending.delete(k);
}

const label = (k: MovementKind) => (k === "buy_in" ? "Buy-in" : "Cash-out");

/** Résolution stricte : uniquement des joueurs DÉJÀ rattachés à NEXAPOKER. */
function resolvePlayer(ref: PlayerRef): { ok: true; id: number; name: string; handle: string | null }
  | { ok: false; error: string } {
  const db = getDb();
  const gid = (db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined)?.id;
  if (!gid) return { ok: false, error: "Game NEXAPOKER absent en base." };

  // Un joueur est « NEXA » s'il porte un lien vers ce game, par ID ou par pseudo —
  // exactement le critère de la page /nexapoker.
  const nexaScope = `
    (EXISTS (SELECT 1 FROM player_game_ids g WHERE g.player_id = p.id AND g.game_id = @gid)
     OR EXISTS (SELECT 1 FROM nexa_nickname_links l WHERE l.player_id = p.id))`;

  let rows: { id: number; name: string; telegram_handle: string | null }[];
  if (ref.kind === "handle") {
    const h = ref.value.replace(/^@/, "").toLowerCase();
    rows = db.prepare(
      `SELECT p.id, p.name, p.telegram_handle FROM players p
        WHERE LOWER(REPLACE(COALESCE(p.telegram_handle,''), '@', '')) = @h AND ${nexaScope}`
    ).all({ h, gid }) as typeof rows;
    if (rows.length === 0) {
      // Distinguer « inconnu » de « connu mais pas NEXA » : le message doit dire
      // quoi faire, pas juste constater l'échec.
      const elsewhere = db.prepare(
        `SELECT name FROM players WHERE LOWER(REPLACE(COALESCE(telegram_handle,''), '@', '')) = ?`
      ).get(h) as { name: string } | undefined;
      return elsewhere
        ? { ok: false, error: `<b>${elsewhere.name}</b> existe mais n'est pas rattaché à NEXAPOKER. Rattache-le sur /nexapoker.` }
        : { ok: false, error: `Aucun joueur NEXAPOKER pour <code>@${ref.value}</code>. Ajoute-le sur /nexapoker — je ne crée pas de joueur depuis Telegram.` };
    }
  } else if (ref.kind === "id") {
    rows = db.prepare(
      `SELECT p.id, p.name, p.telegram_handle FROM players p WHERE p.id = @id AND ${nexaScope}`
    ).all({ id: ref.value, gid }) as typeof rows;
    if (rows.length === 0) return { ok: false, error: `Aucun joueur NEXAPOKER avec l'identifiant <code>#${ref.value}</code>.` };
  } else {
    const n = ref.value.trim().toLowerCase();
    rows = db.prepare(
      `SELECT p.id, p.name, p.telegram_handle FROM players p
        WHERE (LOWER(TRIM(p.name)) = @n
               OR EXISTS (SELECT 1 FROM nexa_nickname_links l WHERE l.player_id = p.id AND l.nickname_key = @n))
          AND ${nexaScope}`
    ).all({ n, gid }) as typeof rows;
    if (rows.length === 0) return { ok: false, error: `Aucun joueur NEXAPOKER nommé « ${ref.value} » (correspondance exacte requise).` };
  }

  // Plusieurs correspondances : jamais de choix arbitraire sur de l'argent.
  if (rows.length > 1) {
    const list = rows.map(r => `• <code>#${r.id}</code> ${r.name}`).join("\n");
    return { ok: false, error: `Plusieurs joueurs correspondent — retape avec l'identifiant :\n${list}` };
  }
  return { ok: true, id: rows[0].id, name: rows[0].name, handle: rows[0].telegram_handle };
}

/**
 * `/nexa <action> <joueur> <montant> [date] [note]`
 *
 * `fromId` et `isPrivate` viennent du webhook. Le webhook filtre déjà sur
 * OWNER_IDS avant de router les commandes ; on revérifie ici pour que ce fichier
 * reste sûr même si quelqu'un le câble ailleurs un jour.
 */
export async function handleNexa(
  rawArgs: string, chatId: number, fromId: number | undefined, isPrivate: boolean,
): Promise<void> {
  if (!fromId || !OWNER_IDS.has(fromId)) return;   // silence total
  if (!isPrivate) return;                          // jamais en groupe

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseNexaCommand(rawArgs, today);
  if (!parsed.ok) { await sendMsg(chatId, `❌ ${parsed.error}`); return; }

  const p = resolvePlayer(parsed.cmd.player);
  if (!p.ok) { await sendMsg(chatId, `❌ ${p.error}`); return; }

  const date = parsed.cmd.date ?? today;

  // Le solde actuel est affiché AVANT confirmation : c'est ce qui permet de
  // repérer une erreur de destinataire sans ouvrir le back-office.
  const mv = getMovements(p.id);
  const dep = mv.filter(m => m.type === "deposit").reduce((s, m) => s + m.amount, 0);
  const wd = mv.filter(m => m.type === "withdrawal").reduce((s, m) => s + m.amount, 0);

  sweep();
  const id = `nx${++seq}_${Date.now().toString(36)}`;
  pending.set(id, {
    id, ownerId: fromId, playerId: p.id, playerName: p.name, handle: p.handle,
    kind: parsed.cmd.action, amount: parsed.cmd.amount, date, note: parsed.cmd.note,
    createdAt: Date.now(),
  });

  await sendMsgKeyboard(chatId,
    `💰 <b>${label(parsed.cmd.action)}</b> — NEXAPOKER\n` +
    `Joueur   : <b>${p.name}</b>${p.handle ? ` (${p.handle})` : ""}\n` +
    `Montant  : <b>${formatAmount(parsed.cmd.amount)} USDT</b>\n` +
    `Date     : ${date}\n` +
    (parsed.cmd.note ? `Note     : ${parsed.cmd.note}\n` : "") +
    `\nSolde actuel : buy-ins ${formatAmount(dep)} · cash-outs ${formatAmount(wd)} · net ${formatAmount(wd - dep)}\n` +
    `<i>Rien n'est encore enregistré.</i>`,
    [[
      { text: "✅ Confirmer", callback_data: `nexa_go:${id}` },
      { text: "✖️ Annuler", callback_data: `nexa_no:${id}` },
    ]],
  );
}

/**
 * Confirmation / annulation.
 *
 * La demande est CONSOMMÉE à la première confirmation : un second clic répond
 * « déjà traitée » au lieu de créer un doublon.
 */
export async function handleNexaCallback(cbId: string, data: string, chatId: number | undefined, from: any): Promise<void> {
  const fromId = from?.id as number | undefined;
  if (!fromId || !OWNER_IDS.has(fromId)) { await answerCbQuery(cbId, "…"); return; }

  sweep();
  const [kind, id] = data.split(":");
  const req = pending.get(id);

  if (!req) { await answerCbQuery(cbId, "Demande expirée ou déjà traitée — retape la commande."); return; }
  if (req.ownerId !== fromId) { await answerCbQuery(cbId, "…"); return; }

  // Consommée quoi qu'il arrive : ni double écriture, ni bouton rejouable.
  pending.delete(id);

  if (kind === "nexa_no") {
    await answerCbQuery(cbId, "Annulé");
    if (chatId) await sendMsg(chatId, `✖️ ${label(req.kind)} annulé — rien n'a été enregistré.`);
    return;
  }

  const r = addMovement({
    player_id: req.playerId, kind: req.kind, amount: req.amount, tx_date: req.date, note: req.note,
  });
  if (!r.ok) {
    await answerCbQuery(cbId, "Échec");
    if (chatId) await sendMsg(chatId, `❌ ${r.error}`);
    return;
  }

  const mv = getMovements(req.playerId);
  const net = mv.reduce((s, m) => s + (m.type === "withdrawal" ? m.amount : -m.amount), 0);
  await answerCbQuery(cbId, "Enregistré");
  if (chatId) {
    await sendMsg(chatId,
      `✅ <b>${label(req.kind)}</b> de <b>${formatAmount(req.amount)} USDT</b> enregistré pour <b>${req.playerName}</b>.\n` +
      `Nouveau net : <b>${formatAmount(net)}</b>`);
  }
}

export { NEXA_USAGE };
