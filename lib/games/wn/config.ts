export const WN_GAME_NAME = "WN";

// Room WN (même app que A5POKER/NUTSPK — vue fusionnée A5NUTS, même wallet mère).
// Accès room après acceptation du deal : lien d'invitation Telegram direct (Hugo 2026-07-20).
export const WN_ROOM_INVITE_LINK = "https://t.me/+crGNNT3CoWlhYmFi";
// Hash du lien (vérification d'appartenance au groupe room via le userbot — le bot
// ne peut pas y être invité, droits côté room).
export const WN_ROOM_INVITE_HASH = "crGNNT3CoWlhYmFi";

// Fallback only — le % réel est choisi par l'owner à l'onboarding (texte libre).
// Le % WN est INDÉPENDANT du deal A5/NUTS (règlements séparés — Hugo 2026-07-20).
export const WN_DEFAULT_ACTION_PCT = 40;
