export const TTPOKER_GAME_NAME = "TTPOKER";

// Game link revealed to the player ONLY after deal acceptance (anti-bypass, same as
// AKS/OKPOKER/JVIP). Room token link provided by Baki at launch.
export const TTPOKER_GAME_LINK = "https://www.ttpokers.net/?ttoken=gjpAP9hQ";

// Fallback only — the action % is chosen by the owner at onboarding (free text)
// and stored per-player in player_game_deals (lib/telegram-commands/action-pct-prompt.ts).
export const TTPOKER_DEFAULT_ACTION_PCT = 30;
