// XPoker Twd — IDENTITÉ de la game. Module pur : aucun import.
//
// Ce sont des paramètres d'exploitation (qui est le club, qui est l'agent), pas
// des hypothèses sur le FORMAT du report : le parseur (parse-sheet.ts) reçoit ces
// valeurs en argument et ne connaît aucune adresse de cellule. Un nouveau classeur
// se teste en changeant ces valeurs, pas le parseur.
//
// ⚠️ CLUB_ID ↔ CLUB_NAME est une ASSERTION de Baki (brief 2026-09-13), pas un fait
// lu dans le sheet : l'ID 246579 n'apparaît nulle part dans le classeur observé.
// Confirmation demandée au club (étape 2b-a) — tant qu'elle n'est pas revenue,
// aucune ingestion n'est câblée sur ce classeur.

export const XPOKER_GAME_NAME = "XPOKER_TWD";
export const XPOKER_GAME_LABEL = "XPoker Twd";
export const XPOKER_GAME_LINK = "https://x-poker.net/";
export const XPOKER_FORMAT = "72o · 10bb";

export const XPOKER_CLUB_ID = "246579";
/** Nom du club tel qu'il apparaît dans le sheet (paramètres A2 et en-tête de grille Q2). */
export const XPOKER_CLUB_NAME = "花順";
/** ID agent (chips) — apparaît sous « LeCercleAdmin2 » dans le sheet. */
export const XPOKER_AGENT_ID = "3970004";

/** Action proposée par défaut à un nouveau joueur, en %. */
export const XPOKER_DEFAULT_ACTION_PCT = 10;
/** Taux opérationnel initial, chips par USD. Historisé en base (xpoker_chip_rates) — ceci n'est que la graine. */
export const XPOKER_SEED_CHIPS_PER_USD = 33;
/**
 * Date d'effet de la graine = début de l'historique. Le classeur a été créé le
 * lundi 2026-03-23 (Sheets → Détails) ; par défaut l'onglet « 3/23 » couvre la
 * semaine PRÉCÉDENTE, lun 16/03 → dim 22/03 (inférence Baki, à confirmer par le club).
 */
export const XPOKER_SEED_RATE_EFFECTIVE_FROM = "2026-03-16";

/**
 * Player ID qui sont des comptes AGENCE, pas des joueurs (décision Baki, Q5) :
 * leur win/lose compte dans le total du club — donc dans le checksum — mais
 * jamais dans une position joueur. Graine de xpoker_agency_accounts ; la table
 * fait foi ensuite, pas cette liste.
 */
export const XPOKER_SEED_AGENCY_ACCOUNTS: { member_id: string; label: string }[] = [
  { member_id: "3970004", label: "LeCercleAdmin2 (agent)" },
  { member_id: "3999050", label: "Shangyu (ex-agent)" },
];
