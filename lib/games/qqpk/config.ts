// QQPK — wallet-based game (TRON USDT deposits/withdrawals, mirror of AKS/A5POKER).
// QQPK uses a STAKING model (70/30 + makeup + 30k-hands condition). The staking
// settlement engine is Phase 3; Phase 1 is plumbing only. The net (withdrawals −
// deposits) is read via a player_game_deals row with action_pct=0 so the existing
// wallet P&L queries surface the raw net without producing any action-based cut.
export const QQPK_GAME_NAME = "QQPK";

// Mini App launch link, revealed only AFTER deal acceptance in onboarding (Phase 2).
// TODO(Phase 2): confirm the real QQPK Mini App startapp link.
export const QQPK_GAME_LINK = "https://t.me/qqpoker/miniapp?startapp=PLACEHOLDER";

// Staking deal carries no action %, so the seeded deal uses 0. Kept here for the
// shared onboarding/deal plumbing that expects a default.
export const QQPK_DEFAULT_ACTION_PCT = 0;
