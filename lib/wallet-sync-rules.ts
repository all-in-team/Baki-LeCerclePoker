// ─── RÈGLE DE CLASSEMENT D'UN ENTRANT SUR UNE WALLET DE DÉPÔT ────────────────
//
// Extraite de app/api/wallets/sync/route.ts (Pass 1) pour être exécutable sur de
// vraies transactions sans réseau ni base — cf. scripts/room-hot-wallet.test.ts.
// C'est une transcription fidèle, pas une réécriture : même ordre de tests, mêmes
// verdicts. Invariant #2 du CLAUDE.md : la règle d'argent vit dans lib/, pas dans
// un handler.
//
// Trois natures d'expéditeur, trois verdicts :
//
//   1. mère ACTIVE du game scanné      → 'withdrawal'  (cashout payé par cette mère)
//   2. mère 'operator' d'un autre game → 'skip'        (TON argent, pas un buy-in)
//      …sauf si c'est la wallet de cashout DU joueur   → 'deposit' (réinjection)
//   3. tout le reste                   → 'deposit'
//
// Le point 2 ne regarde QUE les mères de nature 'operator'. Une mère 'room_hot'
// (le hot wallet d'une room) verse l'argent de la room : un entrant sur une wallet
// de dépôt est un vrai dépôt, et le Pass 2 reste seul juge de ses cashouts.
//
// (2026-09-23 — la garde lisait TOUTES les mères. La hot wallet OkPay, mère active
// AKS + OKPOKER, écartait donc en silence les dépôts A5POKER qu'elle finançait :
// 5 lignes / 2 525 USDT chez Raph, 1 262,50 USDT sur le point d'être versés en trop.)

export type IncomingReason =
  | "from_game_mere"    // mère active du game scanné → cashout
  | "operator_mere"     // mère opérateur d'un autre game / retirée → écarté
  | "own_cashout"       // wallet de cashout du joueur lui-même → réinjection
  | "player_funds";     // source quelconque → dépôt ordinaire

export type IncomingVerdict = {
  action: "deposit" | "withdrawal" | "skip";
  reason: IncomingReason;
};

export function classifyIncomingOnGameWallet(input: {
  /** Adresse expéditrice on-chain (casse indifférente). */
  from: string;
  /** Mères ACTIVES du game scanné, en minuscules. */
  gameMereAddrs: Set<string>;
  /** Mères de nature 'operator', tous games, tous statuts, en minuscules. */
  operatorMereAddrs: Set<string>;
  /** Wallets de cashout DU joueur destinataire, tous games, en minuscules. */
  ownCashoutAddrs: Set<string>;
}): IncomingVerdict {
  const from = (input.from ?? "").toLowerCase();

  if (input.gameMereAddrs.has(from)) {
    return { action: "withdrawal", reason: "from_game_mere" };
  }
  if (input.operatorMereAddrs.has(from)) {
    return input.ownCashoutAddrs.has(from)
      ? { action: "deposit", reason: "own_cashout" }
      : { action: "skip", reason: "operator_mere" };
  }
  return { action: "deposit", reason: "player_funds" };
}
