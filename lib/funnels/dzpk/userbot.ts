// Client GramJS dédié à la lecture des notifications du club dzpk.
//
// ┌─ POURQUOI UN SECOND CLIENT, ALORS QU'UN EXISTE DÉJÀ ───────────────────────┐
// │ `lib/telegram-userbot.ts` porte la session de @Baki77777, qui crée et gère  │
// │ les groupes joueurs. Les DM du club, eux, arrivent sur @strawberry5421 —    │
// │ un AUTRE compte (🍓, d'où le nom).                                          │
// │                                                                             │
// │ Ce n'est donc pas une duplication de confort : deux comptes Telegram        │
// │ distincts exigent deux sessions distinctes. Repointer TELEGRAM_SESSION      │
// │ casserait la gestion des groupes créés par le premier compte.               │
// │                                                                             │
// │ Constat qui a coûté un déploiement et une heure de diagnostic (2026-08-12) :│
// │ l'ingestion tournait sans la moindre erreur, curseur qui avance, alarme au  │
// │ silence — et lisait la conversation du mauvais compte. Un `fetched: 0`      │
// │ parfaitement calme.                                                         │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ⚠️ AUCUN REPLI sur TELEGRAM_SESSION. Un repli silencieux nous ramènerait
// exactement au bug ci-dessus : on lirait le mauvais compte en croyant lire le
// bon. Session absente ⇒ refus explicite, tracé.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

let _client: TelegramClient | null = null;
let _warned = false;

function credentials(): { apiId: number; apiHash: string; session: string } | null {
  // apiId / apiHash sont ceux de l'APPLICATION Telegram, pas du compte : ils se
  // partagent légitimement entre deux sessions de comptes différents.
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0", 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.DZPK_USERBOT_SESSION ?? "";
  if (!apiId || !apiHash || !session) return null;
  return { apiId, apiHash, session };
}

export function isDzpkUserbotConfigured(): boolean {
  return credentials() !== null;
}

export async function getDzpkUserbotClient(): Promise<TelegramClient | null> {
  const creds = credentials();
  if (!creds) {
    if (!_warned) {
      _warned = true;
      console.error(
        "[DZPK USERBOT] DZPK_USERBOT_SESSION absent — ingestion impossible. " +
        "Aucun repli sur TELEGRAM_SESSION : ce compte ne reçoit pas les DM du club."
      );
    }
    return null;
  }

  if (_client?.connected) return _client;

  _client = new TelegramClient(
    new StringSession(creds.session),
    creds.apiId,
    creds.apiHash,
    { connectionRetries: 3 },
  );

  try {
    await _client.connect();
    return _client;
  } catch (e: any) {
    console.error("[DZPK USERBOT] connexion échouée:", e?.message ?? e);
    _client = null;
    return null;
  }
}

export interface DzpkUserbotIdentity {
  configured: boolean;
  connected: boolean;
  user_id: number | null;
  username: string | null;
  error: string | null;
}

/**
 * Identité du compte réellement lu.
 *
 * Exposée dans `/api/admin/dzpk-ingest` parce que c'est LE contrôle qui aurait
 * fait gagner une heure : « ça lit quoi, au juste ? ». Une session valide sur le
 * mauvais compte est indistinguable d'une conversation vide, sauf ici.
 */
export async function dzpkUserbotIdentity(): Promise<DzpkUserbotIdentity> {
  if (!credentials()) {
    return {
      configured: false, connected: false, user_id: null, username: null,
      error: "DZPK_USERBOT_SESSION absent",
    };
  }
  try {
    const client = await getDzpkUserbotClient();
    if (!client) {
      return { configured: true, connected: false, user_id: null, username: null, error: "connexion échouée" };
    }
    const me = await client.getMe() as any;
    return {
      configured: true,
      connected: true,
      // GramJS rend un objet BigInt ({value}), pas un bigint natif : `typeof`
      // rend "object" et une conversion naïve échoue en silence.
      user_id: Number(BigInt(me.id)),
      username: me.username ?? null,
      error: null,
    };
  } catch (e: any) {
    return { configured: true, connected: false, user_id: null, username: null, error: e?.message ?? String(e) };
  }
}
