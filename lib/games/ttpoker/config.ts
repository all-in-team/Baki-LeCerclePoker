export const TTPOKER_GAME_NAME = "TTPOKER";

// Room access after deal acceptance (decision Baki 2026-07-08): the player no longer gets a
// web link. Instead he starts the room's Telegram bot, connects to the app, then enters our
// invitation code (Me → Code d'invitation) to be placed UNDER the LeCercle line — the critical
// step. The old web link is kept here for reference only, no longer shown to the player.
// Legacy web link (unused): https://www.ttpokers.net/?ttoken=gjpAP9hQ
export const TTPOKER_ROOM_BOT = "https://t.me/ttpokers_bot";
export const TTPOKER_INVITE_CODE = "288656";

// Fallback only — the action % is chosen by the owner at onboarding (free text)
// and stored per-player in player_game_deals (lib/telegram-commands/action-pct-prompt.ts).
export const TTPOKER_DEFAULT_ACTION_PCT = 30;
