import { createHash } from "crypto";

// ─── GARDE D'ADRESSE WALLET ───────────────────────────────────────────────────
//
// HISTORIQUE — pourquoi ce fichier existe (deux incidents identiques) :
//   29/07/2026 et 16/08/2026, joueur 148 (Fabien Gün), game A5POKER. L'adresse
//   du contrat USDT TRC20 a été saisie comme wallet de DÉPÔT du joueur. Le
//   scanner (app/api/wallets/sync) lit « tout entrant » sur une wallet game :
//   il a donc attribué au joueur les ~2 000 derniers transferts reçus par le
//   contrat USDT lui-même. Solde affiché : −3,47e+71 USDT, 1 988 lignes « à
//   régler ». Les deux fois, la correction a été purement data — d'où la
//   récidive 18 jours plus tard.
//
// CE QUE CETTE GARDE FAIT, ET CE QU'ELLE NE FAIT PAS :
//   ✅ refuse les adresses de CONTRATS DE TOKENS connus (dont USDT)
//   ✅ refuse les adresses au checksum base58check invalide
//   ❌ ne refuse PAS « tout compte de type contrat » sur TRON
//
//   Ce dernier point est délibéré et mesuré. Audit du 16/08/2026 sur les 275
//   adresses de la base : 74 sont des comptes de type `Contract`, dont trois
//   wallets de trésorerie déclarées dans lib/treasury.ts (« Hugo short gasfee »,
//   « Général gas fee », « Baki gas fee ») et 48 wallets de dépôt joueurs avec
//   des dépôts réels déjà importés (TELE 22, A5POKER 20, NUTSPK 4, WN 2).
//   Sur TRON, les adresses de dépôt fournies par les apps de poker et les
//   exchanges sont très souvent des contrats collecteurs : un refus générique
//   casserait ~27 % des wallets légitimes et bloquerait l'onboarding.
//   Le formulaire admin affiche un AVERTISSEMENT non bloquant à la place
//   (app/api/wallets/inspect-address).
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contrats de tokens TRC20 connus — jamais une wallet de joueur.
 *
 * Un joueur ne « possède » pas un contrat de token : y envoyer des USDT revient
 * à les brûler. Une adresse d'ici en base signifie forcément une erreur de
 * copier-coller, jamais une intention.
 */
export const KNOWN_TOKEN_CONTRACTS: Record<string, string> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: "USDT (Tether TRC20)",
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: "USDC",
  TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn: "USDD",
  TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4: "TUSD",
  TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT: "USDJ",
  TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: "WTRX (Wrapped TRX)",
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: "JST (JustStable)",
  TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: "SUN",
  TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7: "WIN",
  TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4: "BTT (BitTorrent)",
  TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq: "NFT",
  TDyvndWuvX5xTBwHPYJi7J3Yq8pq8yh62h: "HT (Huobi Token)",
};

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Index de recherche insensible à la casse — un copier-coller peut altérer la casse. */
const TOKEN_CONTRACTS_LOWER = new Map(
  Object.entries(KNOWN_TOKEN_CONTRACTS).map(([addr, label]) => [addr.toLowerCase(), label]),
);

/**
 * Décode une adresse TRON base58check → 21 octets (0x41 + 20 octets d'adresse).
 * Retourne null si l'alphabet, la longueur, le préfixe ou le checksum est invalide.
 *
 * C'est la vraie validation, celle que `^T[A-Za-z0-9]{33}$` ne fait pas : ce
 * regex accepte `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6s` — le contrat USDT avec un
 * caractère modifié, adresse qui n'existe pas on-chain. Elle était en base
 * (player_wallet_games id=310), comme deux adresses tronquées à 28 et 33
 * caractères que les routes admin, sans aucune validation, avaient laissé passer.
 */
export function decodeTronAddress(address: string): Buffer | null {
  if (typeof address !== "string" || address.length !== 34 || !address.startsWith("T")) return null;

  // Décodage base58 par propagation de retenue sur un tampon d'octets. Pas de
  // BigInt : la cible TS de ce projet est antérieure à ES2020.
  const bytes = new Uint8Array(25);
  for (const ch of address) {
    let carry = B58_ALPHABET.indexOf(ch);
    if (carry < 0) return null;
    for (let i = bytes.length - 1; i >= 0; i--) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    if (carry > 0) return null; // dépasse 25 octets → adresse impossible
  }

  const raw = Buffer.from(bytes);
  const payload = raw.subarray(0, 21);
  const checksum = raw.subarray(21);
  if (payload[0] !== 0x41) return null; // toute adresse mainnet commence par 0x41

  const digest = createHash("sha256")
    .update(createHash("sha256").update(payload).digest())
    .digest()
    .subarray(0, 4);

  return digest.equals(checksum) ? payload : null;
}

/** Adresse TRON syntaxiquement valide ET au checksum correct. */
export function isValidTronAddress(address: string): boolean {
  return decodeTronAddress(address) !== null;
}

/** L'adresse est-elle un contrat de token connu ? Retourne son libellé, ou null. */
export function tokenContractLabel(address: string): string | null {
  if (typeof address !== "string") return null;
  return TOKEN_CONTRACTS_LOWER.get(address.trim().toLowerCase()) ?? null;
}

export function isKnownTokenContract(address: string): boolean {
  return tokenContractLabel(address) !== null;
}

export type WalletAddressCheck =
  | { ok: true; address: string }
  | { ok: false; code: "empty" | "invalid" | "token_contract"; message: string };

/**
 * Point de contrôle unique pour TOUTE adresse de wallet joueur (dépôt ou cashout).
 *
 * Vit ici, et est appelé depuis les 4 setters de lib/queries.ts, parce que c'est
 * le seul goulot commun aux 11 points d'entrée : les 2 routes admin
 * (/api/players/[id]/game-wallets et /cashouts) et les 9 funnels d'onboarding bot
 * (aks, qqpk, a5poker, jvip, nutspk, kkpoker, ttpoker, okpoker, wn). Poser la
 * garde dans les routes en aurait laissé neuf ouvertes — c'est l'invariant #2 du
 * CLAUDE.md : la règle d'argent vit dans queries.ts, pas dans un handler.
 */
export function checkWalletAddress(address: string): WalletAddressCheck {
  const addr = (address ?? "").trim();
  if (!addr) return { ok: false, code: "empty", message: "Adresse vide." };

  const contract = tokenContractLabel(addr);
  if (contract) {
    return {
      ok: false,
      code: "token_contract",
      message:
        `${addr} est l'adresse du contrat ${contract}, pas une wallet. ` +
        `Pour une adresse de dépôt, utilise celle que l'app te donne dans son écran « Deposit ».`,
    };
  }

  if (!isValidTronAddress(addr)) {
    return {
      ok: false,
      code: "invalid",
      message: `${addr} n'est pas une adresse TRON valide (checksum ou format incorrect). Vérifie le copier-coller.`,
    };
  }

  return { ok: true, address: addr };
}

export class WalletAddressError extends Error {
  code: "empty" | "invalid" | "token_contract";
  address: string;
  constructor(address: string, code: "empty" | "invalid" | "token_contract", message: string) {
    super(message);
    this.name = "WalletAddressError";
    this.code = code;
    this.address = address;
  }
}

/** Variante levante, pour les setters. */
export function assertWalletAddress(address: string): string {
  const res = checkWalletAddress(address);
  if (!res.ok) throw new WalletAddressError(address, res.code, res.message);
  return res.address;
}

// ─── Seuil de vraisemblance ───────────────────────────────────────────────────
//
// Au-dessus, une transaction n'est PAS comptabilisée : elle entre en quarantaine
// (status='quarantined') et attend une validation manuelle dans le back-office.
// Filet de dernier recours : même si une adresse douteuse repasse les gardes
// ci-dessus, un montant aberrant ne peut plus corrompre un solde en silence.
export const PLAUSIBILITY_THRESHOLD_USDT = 100_000;
