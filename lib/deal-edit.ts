import { getDb } from "@/lib/db";
import { updatePlayerActionPct, getScopeActionPcts } from "@/lib/queries";

// Inline action-% edit from the P&L tables. Reuses the existing deal write path
// (player_game_deals) and, on an effective change, announces it in the player's Telegram group
// Onboarding topic. Money-adjacent: action_pct drives the agency cut, so this only ever touches
// action_pct (never rakeback/dates), and on merged scopes it aligns every game so the settlement
// engine's divergent-deal guard stays satisfied.

export interface UpdateActionPctResult {
  ok: boolean;
  changed: boolean;
  announced?: "group" | "agent" | "failed";
  error?: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function parisDateTime(): string {
  // Regular server runtime (not a workflow script) → new Date() is available.
  return new Date().toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

async function announceDealChange(
  playerId: number,
  gameLabel: string,
  oldPct: number,
  newPct: number,
): Promise<"group" | "agent" | "failed"> {
  const db = getDb();
  const player = db.prepare(
    `SELECT id, name, telegram_group_id FROM players WHERE id = ?`
  ).get(playerId) as { id: number; name: string; telegram_group_id: string | null } | undefined;
  const { sendMsg, AGENT_CHAT_ID } = await import("@/lib/telegram-commands/helpers");
  const name = player?.name ?? `#${playerId}`;

  // No linked group → the save still stands; ping the agent to warn the player manually.
  if (!player?.telegram_group_id) {
    await sendMsg(AGENT_CHAT_ID,
      `⚠️ % changé pour <b>${name}</b> (${gameLabel}) ${oldPct}%→${newPct}% mais aucun groupe lié — préviens-le manuellement.`
    );
    return "agent";
  }

  // Telegram failure (API down, broken topic despite auto-repair) must NEVER roll back the deal.
  try {
    const groupId = Number(player.telegram_group_id);
    const { getOnboardingThreadId } = await import("@/lib/telegram-commands/onboarding-topic");
    const tid = await getOnboardingThreadId(groupId, playerId, gameLabel);
    await sendMsg(groupId,
      `📊 <b>Mise à jour du deal ${gameLabel}</b> : action ${oldPct}% → <b>${newPct}%</b>, ` +
      `effectif à partir de maintenant (${parisDateTime()} heure FR).`,
      tid
    );
    return "group";
  } catch (e: any) {
    await sendMsg(AGENT_CHAT_ID,
      `⚠️ Deal <b>${gameLabel}</b> changé pour <b>${name}</b> ${oldPct}%→${newPct}% mais l'envoi Telegram a échoué ` +
      `(${e?.message ?? e}) — préviens-le manuellement.`
    );
    return "failed";
  }
}

// gameNames = full scope (canonical first). gameLabel = user-facing label for the message.
// oldPct = the value the owner saw on the row (drives the "old→new" text + no-op detection).
export async function updateDealActionPct(
  playerId: number,
  gameNames: string[],
  gameLabel: string,
  oldPct: number,
  newPct: number,
): Promise<UpdateActionPctResult> {
  if (!Number.isFinite(newPct) || newPct < 0 || newPct > 100) {
    return { ok: false, changed: false, error: "Le % doit être entre 0 et 100." };
  }
  // NEXAPOKER est hors de ce chemin, volontairement. Sa part d'action vit dans
  // nexa_player_action_shares (historisée, append-only) ; player_game_deals.action_pct
  // n'en est qu'un CACHE de la période courante, écrit dans la même transaction par
  // setActionShareOn (lib/funnels/nexa/players.ts). Écrire le cache ici le ferait
  // diverger de l'historique dès la première édition — le miroir deviendrait un
  // mensonge, et le recalcul d'une semaine passée serait faux.
  // Aucune page de room n'appelle cette fonction pour NEXAPOKER aujourd'hui ; ce
  // refus existe pour qu'un futur copier-coller de page ne l'introduise pas.
  if (gameNames.some(n => n.toUpperCase() === "NEXAPOKER")) {
    return {
      ok: false, changed: false,
      error: "La part d'action et le rakeback NEXAPOKER s'éditent sur la page NEXAPOKER (historisés par période), pas ici.",
    };
  }
  const db = getDb();
  const gameIds = gameNames
    .map((n) => (db.prepare(`SELECT id FROM games WHERE name = ?`).get(n) as { id: number } | undefined)?.id)
    .filter((id): id is number => id !== undefined);
  if (gameIds.length === 0) return { ok: false, changed: false, error: "Game introuvable." };

  // True no-op = the scope is ALREADY aligned to newPct (single distinct value === newPct).
  // NB: we must NOT no-op on `oldPct === newPct` alone — oldPct is the DISPLAYED value (the first
  // game of a merged scope). On a divergent pair (e.g. A5POKER=40 / NUTSPK=30, cell shows 40),
  // typing 40 to force alignment would wrongly no-op and leave NUTSPK at 30, keeping the
  // settlement blocked silently. Checking real alignment fixes that trap.
  const currentPcts = getScopeActionPcts(playerId, gameIds);
  if (currentPcts.length === 0) return { ok: false, changed: false, error: "Aucun deal à mettre à jour pour ce joueur." };
  const alreadyAligned = currentPcts.length === 1 && round2(currentPcts[0]) === round2(newPct);
  if (alreadyAligned) return { ok: true, changed: false };

  updatePlayerActionPct(playerId, gameIds, newPct);

  // "old" for the announcement = the value the owner saw on the row (single-game: exact; merged
  // divergent: the displayed first-game value — the human-facing "before").
  const displayedOld = Number.isFinite(oldPct) ? round2(oldPct) : round2(currentPcts[0]);
  const announced = await announceDealChange(playerId, gameLabel, displayedOld, round2(newPct));
  return { ok: true, changed: true, announced };
}
