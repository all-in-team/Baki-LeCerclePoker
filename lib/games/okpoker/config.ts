export const OKPOKER_GAME_NAME = "OKPOKER";

// Game link revealed to the player ONLY after deal acceptance (anti-bypass, same as AKS).
// Empty string = the link line is skipped in the flow — fill this in when Baki provides
// the OKPOKER app/club link.
export const OKPOKER_GAME_LINK = "";

// Fallback only — the action % is chosen by the owner at onboarding (free text)
// and stored per-player in player_game_deals (lib/telegram-commands/action-pct-prompt.ts).
export const OKPOKER_DEFAULT_ACTION_PCT = 30;
