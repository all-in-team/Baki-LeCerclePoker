export const WN_GAME_NAME = "WN";

// Room WN (même app que A5POKER/NUTSPK — vue fusionnée A5NUTS, même wallet mère).
// Accès room après acceptation du deal : lien d'invitation Telegram direct (Hugo 2026-07-20).
export const WN_ROOM_INVITE_LINK = "https://t.me/+crGNNT3CoWlhYmFi";

// Fallback only — le % réel est choisi par l'owner à l'onboarding (texte libre), et
// si le joueur a déjà un deal A5POKER/NUTSPK son % est repris d'office (le moteur de
// settlement fusionné A5NUTS refuse les % divergents dans le scope).
export const WN_DEFAULT_ACTION_PCT = 40;
