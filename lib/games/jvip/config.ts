export const JVIP_GAME_NAME = "JVIP";

// Game link revealed to the player ONLY after deal acceptance (anti-bypass, same as
// AKS/OKPOKER). Club join link provided by Baki at launch (j0001bot deep link).
export const JVIP_GAME_LINK = "https://t.me/j0001bot?start=208118";

// Fallback only — the action % is chosen by the owner at onboarding (free text)
// and stored per-player in player_game_deals (lib/telegram-commands/action-pct-prompt.ts).
export const JVIP_DEFAULT_ACTION_PCT = 30;
