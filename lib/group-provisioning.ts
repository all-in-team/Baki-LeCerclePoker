/**
 * LA porte unique de création de groupe joueur (incident Alexis, 2026-08-04).
 *
 * Avant : quatre chemins créaient des groupes, chacun avec sa propre idée de « ce joueur
 * a-t-il déjà un groupe ? » —
 *   A funnel joueur (/start)         → cherchait par tg_user_id ✔
 *   B funnel Nexa (dépôt / bouton)   → cherchait par tg_user_id, mais retombait dans la
 *                                      création si le lien d'invitation était introuvable
 *   C parrainage affilié (/affi)     → cherchait par HANDLE, créait avec tg_user_id = 0
 *   D API admin setup-player-group   → regardait la seule colonne du joueur ciblé
 * Résultat : Alexis (groupe de mai) rattaché à NEXA le 04/08 → second groupe.
 *
 * Maintenant : tout le monde passe par `provisionGroup`. Elle applique dans l'ordre,
 * SANS exception ni raccourci :
 *   1. clé d'unicité = l'utilisateur Telegram. Un @ = un groupe, quelles que soient les
 *      rooms sur lesquelles il a des comptes ;
 *   2. groupe existant trouvé (identité Telegram prouvée) ⇒ RÉUTILISATION. La réutilisation
 *      n'est conditionnée à RIEN — surtout pas à l'obtention d'un lien d'invitation, qui
 *      est exactement ce qui a produit le doublon d'Alexis ;
 *   3. correspondance seulement par handle ou par nom ⇒ AMBIGU : aucune création, aucune
 *      fusion, le cas part en arbitrage manuel dans le back-office ;
 *   4. pas de tg_user_id fiable (chemin C) ⇒ jamais de création automatique. Un groupe
 *      créé 10 min en retard coûte moins cher qu'un doublon à démêler ;
 *   5. création réelle ⇒ ligne `group_creations` TOUJOURS écrite. Plus aucun groupe
 *      n'existe hors registre.
 */

import { getDb } from "@/lib/db";
import {
  findExistingGroupForTgUser, findAmbiguousGroupCandidates, ensureInviteLink,
  recordGroupCreation, backfillRegistryForExistingGroup, claimGroupCreation, releaseGroupClaim,
  type GroupOwnerKind, type ExistingGroup, type AmbiguousCandidate,
} from "@/lib/group-lifecycle";
import { sendMsg, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";
import { coerceLang, type Lang } from "@/lib/i18n";

export type ProvisionRequest = {
  /** L'identité Telegram. 0 / null / négatif = pas d'identité fiable ⇒ jamais de création. */
  tgUserId: number | null;
  /** @handle sans le @, sert au rapprochement ambigu et au titre du groupe. */
  handle?: string | null;
  /** Nom affiché — titre du groupe « X x LeCercle ». */
  displayName: string;
  ownerKind: GroupOwnerKind;
  ownerLabel?: string | null;
  /** Suffixe de titre (agent parrain) — « X x LeCercle (Agent : Y) ». */
  titleSuffix?: string | null;
  /** D'où vient la demande : 'nexa_lead:42', 'player_start', 'affiliate:@x', 'admin_api:player#34'. */
  context: string;
  /** Room qui demande le rattachement — sert au message posté dans un groupe réutilisé. */
  room?: RoomNotice | null;
  lang?: Lang | string | null;
  /** true = ne crée jamais, se contente de dire ce qui se passerait (aperçu du bouton). */
  dryRun?: boolean;
};

export type ProvisionResult =
  | { status: "reused"; chatId: string; inviteLink: string | null; topicIds: Record<string, number> | null;
      source: ExistingGroup["source"]; ownerLabel: string | null; createdAt: string | null; noticePosted: boolean }
  // `raw` = le retour brut du userbot (topics manqués, bot non promu…). L'appelant en a
  // besoin pour son rapport d'onboarding ; la porte, elle, n'en dépend pas.
  | { status: "created"; chatId: string; inviteLink: string | null; topicIds: Record<string, number>;
      raw: import("@/lib/telegram-userbot").GroupResult | null }
  | { status: "ambiguous"; caseId: number | null; candidates: AmbiguousCandidate[]; reason: string }
  | { status: "pending" }
  | { status: "failed"; error: string };

// ── Message posté dans un groupe réutilisé ────────────────
// Le joueur voit sa nouvelle room arriver dans le groupe qu'il connaît déjà, au lieu de
// recevoir un lien vers un second groupe vide.

export type RoomNotice = "nexa";

const ROOM_NOTICE: Record<RoomNotice, Record<Lang, string>> = {
  nexa: {
    fr: `🃏 <b>NEXA ajouté à ton suivi</b>\n\nTa room NEXAPOKER est rattachée à ce groupe — dépôts, retraits et suivi se passent ici, comme d'habitude. Pas besoin d'un autre groupe.`,
    en: `🃏 <b>NEXA added to your tracking</b>\n\nYour NEXAPOKER room is now linked to this group — deposits, withdrawals and follow-up all happen here, as usual. No need for a second group.`,
  },
};

/**
 * Poste l'avis d'ajout de room, UNE seule fois par (groupe, room). La table fait foi :
 * un rattachement rejoué (webhook Telegram, double clic, retry admin) ne reposte rien.
 */
async function postRoomNoticeOnce(chatId: string, room: RoomNotice, lang: Lang): Promise<boolean> {
  let first = false;
  try {
    const r = getDb().prepare(
      `INSERT OR IGNORE INTO group_room_notices (chat_id, room) VALUES (?, ?)`
    ).run(String(chatId), room);
    first = r.changes > 0;
  } catch (e: any) {
    console.error(`[GROUPS] room notice dedup failed (${chatId}/${room}):`, e?.message ?? e);
    return false;
  }
  if (!first) return false;

  try {
    await sendMsg(Number(chatId), ROOM_NOTICE[room][lang]);
    return true;
  } catch (e: any) {
    // Le message est un confort, pas le contrat : on ne casse pas un rattachement
    // réussi parce que Telegram a refusé un envoi. On relâche la marque de dédoublonnage
    // pour qu'un prochain passage puisse réessayer.
    console.error(`[GROUPS] room notice send failed (${chatId}/${room}):`, e?.message ?? e);
    try { getDb().prepare(`DELETE FROM group_room_notices WHERE chat_id = ? AND room = ?`).run(String(chatId), room); } catch {}
    return false;
  }
}

// ── Cas ambigus → arbitrage manuel ────────────────────────

export function openReviewCase(o: {
  kind: "ambiguous_match" | "no_tg_user_id";
  context: string;
  tgUserId?: number | null;
  handle?: string | null;
  displayName?: string | null;
  candidates?: AmbiguousCandidate[];
  detail: string;
}): number | null {
  try {
    const db = getDb();
    // L'index unique partiel sur (context) WHERE status='open' garantit qu'un même
    // contexte ne s'empile pas : re-cliquer met le cas à jour au lieu d'en ouvrir un autre.
    db.prepare(`
      INSERT INTO group_review_cases (kind, context, tg_user_id, handle, display_name, candidates, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(context) WHERE status = 'open' DO UPDATE SET
        candidates = excluded.candidates, detail = excluded.detail, kind = excluded.kind
    `).run(
      o.kind, o.context, o.tgUserId ?? null, o.handle ?? null, o.displayName ?? null,
      JSON.stringify(o.candidates ?? []), o.detail,
    );
    const row = db.prepare(`SELECT id FROM group_review_cases WHERE context = ? AND status = 'open'`)
      .get(o.context) as { id: number } | undefined;
    return row?.id ?? null;
  } catch (e: any) {
    console.error(`[GROUPS] openReviewCase(${o.context}) failed:`, e?.message ?? e);
    return null;
  }
}

async function notifyReviewCase(caseId: number | null, o: ProvisionRequest, candidates: AmbiguousCandidate[], reason: string) {
  const who = o.handle ? `@${o.handle}` : o.displayName;
  const lines = [
    `🕵️ <b>Groupe à trancher à la main</b> — <b>${who}</b>`,
    `Contexte : <code>${o.context}</code>`,
    reason,
  ];
  if (candidates.length) {
    lines.push(`\nGroupes candidats (rapprochement par ${candidates[0].matchedOn === "handle" ? "handle" : "nom"}, non prouvé) :`);
    for (const c of candidates) lines.push(`  • <code>${c.chatId}</code> — ${c.label}`);
  }
  lines.push(`\n<b>Aucun groupe n'a été créé.</b> Tranche dans le back-office → <i>Groupes à trancher</i>${caseId ? ` (cas #${caseId})` : ""}.`);
  await sendMsg(AGENT_CHAT_ID, lines.join("\n")).catch(() => {});
}

// ── La porte ──────────────────────────────────────────────

export async function provisionGroup(req: ProvisionRequest): Promise<ProvisionResult> {
  const tgId = Number(req.tgUserId ?? 0);
  const lang = coerceLang(req.lang);
  const handle = (req.handle ?? "").trim().replace(/^@/, "") || null;

  // ── 1. Groupe existant, identité Telegram prouvée → RÉUTILISATION ──
  // Inconditionnelle. Le lien d'invitation est tenté ensuite, en best-effort : ne pas
  // l'obtenir n'autorise PAS à créer un second groupe (le bug d'Alexis).
  if (tgId > 0) {
    const already = findExistingGroupForTgUser(tgId);
    if (already) {
      if (req.dryRun) {
        return {
          status: "reused", chatId: already.chatId, inviteLink: already.inviteLink,
          topicIds: already.topicIds, source: already.source, ownerLabel: already.ownerLabel,
          createdAt: already.createdAt, noticePosted: false,
        };
      }

      const link = await ensureInviteLink(already.chatId, already.inviteLink).catch(() => null);

      // Le groupe entre au registre s'il n'y était pas : les prochains chemins le
      // trouveront du premier coup, sans dépendre de la table où il a été trouvé.
      if (already.source !== "registry") {
        backfillRegistryForExistingGroup({
          chatId: already.chatId, ownerKind: req.ownerKind, ownerKey: tgId,
          ownerLabel: req.ownerLabel ?? already.ownerLabel ?? req.displayName,
          inviteLink: link, topicIds: already.topicIds,
        });
      }

      const noticePosted = req.room ? await postRoomNoticeOnce(already.chatId, req.room, lang) : false;

      console.log(`[GROUPS] ${req.context}: groupe existant ${already.chatId} (${already.source}) réutilisé — aucune création`);
      return {
        status: "reused", chatId: already.chatId, inviteLink: link, topicIds: already.topicIds,
        source: already.source, ownerLabel: already.ownerLabel, createdAt: already.createdAt,
        noticePosted,
      };
    }
  }

  // ── 2. Rapprochement seulement par handle / nom → AMBIGU, on ne crée rien ──
  const candidates = findAmbiguousGroupCandidates({ handle, displayName: req.displayName });
  if (candidates.length > 0) {
    const reason = `Un ou plusieurs groupes ressemblent à ce contact, mais aucun n'est rattaché à son compte Telegram — impossible d'affirmer que c'est la même personne.`;
    if (req.dryRun) return { status: "ambiguous", caseId: null, candidates, reason };
    const caseId = openReviewCase({
      kind: "ambiguous_match", context: req.context, tgUserId: tgId || null, handle,
      displayName: req.displayName, candidates, detail: reason,
    });
    await notifyReviewCase(caseId, req, candidates, reason);
    return { status: "ambiguous", caseId, candidates, reason };
  }

  // ── 3. Pas d'identité Telegram fiable → jamais de création automatique ──
  if (tgId <= 0) {
    const reason = `Aucun tg_user_id fiable pour ce contact : impossible de garantir qu'il n'a pas déjà un groupe. Création manuelle requise.`;
    if (req.dryRun) return { status: "ambiguous", caseId: null, candidates: [], reason };
    const caseId = openReviewCase({
      kind: "no_tg_user_id", context: req.context, tgUserId: null, handle,
      displayName: req.displayName, candidates: [], detail: reason,
    });
    await notifyReviewCase(caseId, req, [], reason);
    return { status: "ambiguous", caseId, candidates: [], reason };
  }

  if (req.dryRun) return { status: "created", chatId: "", inviteLink: null, topicIds: {}, raw: null };

  // ── 4. Création, sous verrou par tg_user_id ──
  if (!claimGroupCreation(tgId, req.context)) {
    console.log(`[GROUPS] ${req.context}: création déjà en vol pour tg ${tgId} — rien créé`);
    return { status: "pending" };
  }

  try {
    const { createPlayerGroup } = await import("@/lib/telegram-userbot");
    const res = await createPlayerGroup(
      tgId, req.displayName, process.env.TELEGRAM_BOT_TOKEN, handle ?? undefined,
      req.titleSuffix ?? undefined,
    );
    if (!res || res.status === "failed") {
      releaseGroupClaim(tgId);
      const err = res?.errors?.join("; ") || "userbot indisponible";
      return { status: "failed", error: err };
    }

    // Registre écrit AVANT tout join possible et AVANT que l'appelant fasse quoi que ce
    // soit : c'est ce qui rend le prochain appel — quel que soit son chemin — idempotent.
    recordGroupCreation({
      chatId: res.chatId,
      ownerKind: req.ownerKind,
      ownerKey: tgId,
      ownerLabel: req.ownerLabel ?? req.displayName,
      title: `${req.displayName} x LeCercle${req.titleSuffix ? ` (Agent : ${req.titleSuffix})` : ""}`,
      inviteLink: res.inviteLink || null,
      topicIds: res.topicIds,
    });

    console.log(`[GROUPS] ${req.context}: groupe ${res.chatId} créé pour tg ${tgId} (${res.status})`);
    return {
      status: "created", chatId: String(res.chatId),
      inviteLink: res.inviteLink || null, topicIds: res.topicIds, raw: res,
    };
  } catch (e: any) {
    releaseGroupClaim(tgId);
    const err = e?.message ?? String(e);
    console.error(`[GROUPS] ${req.context}: création échouée:`, err);
    return { status: "failed", error: err };
  }
}
