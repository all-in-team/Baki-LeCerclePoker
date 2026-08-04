// Grammaire de la commande Telegram /nexa — MODULE PUR.
//
// Zéro import, zéro accès DB, zéro réseau : la grammaire se teste seule, sans bot
// et sans base. Le handler (lib/telegram-commands/nexa.ts) ne fait que résoudre le
// joueur et appeler addMovement — le seul chemin d'écriture, celui des boutons de
// la page. Le bot est un producteur de plus, pas un second chemin.
//
// ─────────────────────────────────────────────────────────────────────────────
// ON NE DEVINE RIEN. C'est de l'argent : toute ambiguïté est un refus, avec un
// message qui dit quoi taper. Un montant mal compris ne se rattrape pas.
// ─────────────────────────────────────────────────────────────────────────────
//
// Syntaxe :  /nexa <action> <joueur> <montant> [date] [note]
//   action  : buyin | buy-in | depot | dépôt   →  buy_in
//             cashout | cash-out | retrait     →  cash_out
//   joueur  : @handle · #id · "pseudo exact"
//   montant : 1000 · 1000$ · 1 000 · 1000.50 · 1k · 1.5k
//   date    : YYYY-MM-DD, optionnelle, jamais dans le futur
//   note    : tout ce qui suit

export type MovementKind = "buy_in" | "cash_out";

export type PlayerRef =
  | { kind: "handle"; value: string }
  | { kind: "id"; value: number }
  | { kind: "name"; value: string };

export type ParsedCommand = {
  action: MovementKind;
  player: PlayerRef;
  amount: number;
  /** null = aujourd'hui, résolu par l'appelant (côté serveur, pas côté client). */
  date: string | null;
  note: string | null;
};

export type ParseResult =
  | { ok: true; cmd: ParsedCommand }
  | { ok: false; error: string };

const ACTIONS: Readonly<Record<string, MovementKind>> = {
  buyin: "buy_in", "buy-in": "buy_in", depot: "buy_in", "dépôt": "buy_in", depôt: "buy_in", dépot: "buy_in",
  cashout: "cash_out", "cash-out": "cash_out", retrait: "cash_out",
};

const USAGE =
  "Usage : <code>/nexa buyin @joueur 1000</code>\n" +
  "• action : buyin / depot · cashout / retrait\n" +
  "• joueur : @handle, #id, ou \"pseudo exact\"\n" +
  "• montant : 1000, 1000$, 1k, 1000.50 (point décimal)\n" +
  "• date optionnelle : AAAA-MM-JJ, puis une note libre";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Montant. Accepte « 1k » parce que c'est pratique à taper — mais l'appelant
 * DOIT reformuler en clair (1 000,00) avant confirmation : on ne confirme jamais
 * un raccourci.
 *
 * La virgule décimale est REFUSÉE : « 1,000 » vaut mille pour un anglophone et un
 * virgule zéro en français. Sur de l'argent, cette ambiguïté-là ne se tranche pas
 * par défaut — on demande un point.
 */
export function parseAmount(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const s = raw.trim().replace(/\s/g, "").replace(/\$/g, "").replace(/^usdt/i, "");
  if (s === "") return { ok: false, error: "Montant manquant." };
  if (s.includes(",")) {
    return { ok: false, error: `Montant « ${raw.trim()} » ambigu : la virgule peut vouloir dire millier ou décimale. Utilise un point — <code>1000.50</code>.` };
  }
  const m = /^(\d+(?:\.\d+)?)(k)?$/i.exec(s);
  if (!m) return { ok: false, error: `Montant « ${raw.trim()} » illisible. Attendu : 1000, 1000$, 1k, 1000.50.` };
  const value = parseFloat(m[1]) * (m[2] ? 1000 : 1);
  if (!isFinite(value)) return { ok: false, error: `Montant « ${raw.trim()} » illisible.` };
  if (value <= 0) return { ok: false, error: "Le montant doit être strictement positif — le sens est porté par l'action (buyin / cashout)." };
  // Deux décimales : au-delà, c'est une faute de frappe, pas une intention.
  if (Math.round(value * 100) !== value * 100) {
    return { ok: false, error: `Montant « ${raw.trim()} » : deux décimales maximum.` };
  }
  return { ok: true, value };
}

function parsePlayer(token: string): PlayerRef | null {
  const t = token.trim();
  if (t.startsWith("@") && t.length > 1) return { kind: "handle", value: t.slice(1) };
  if (/^#\d+$/.test(t)) return { kind: "id", value: parseInt(t.slice(1), 10) };
  if (t.startsWith('"') && t.endsWith('"') && t.length > 2) return { kind: "name", value: t.slice(1, -1) };
  return null;
}

/**
 * Découpe la commande. `today` est injecté (jamais `new Date()` ici) pour que la
 * règle « pas de date future » soit testable et ne dépende pas de l'horloge.
 */
export function parseNexaCommand(rawArgs: string, today: string): ParseResult {
  const text = String(rawArgs ?? "").trim();
  if (text === "") return { ok: false, error: `Commande vide.\n${USAGE}` };

  // Le pseudo entre guillemets peut contenir des espaces : on l'isole d'abord.
  const quoted = /^(\S+)\s+("[^"]+")\s+(.*)$/.exec(text);
  const parts = quoted
    ? [quoted[1], quoted[2], ...quoted[3].trim().split(/\s+/)]
    : text.split(/\s+/);

  if (parts.length < 3) {
    return { ok: false, error: `Il manque un élément (action, joueur, montant).\n${USAGE}` };
  }

  const action = ACTIONS[parts[0].toLowerCase()];
  if (!action) {
    return { ok: false, error: `Action « ${parts[0]} » inconnue. Attendu : buyin / depot / cashout / retrait.` };
  }

  const player = parsePlayer(parts[1]);
  if (!player) {
    return { ok: false, error: `Joueur « ${parts[1]} » illisible. Attendu : <code>@handle</code>, <code>#12</code>, ou <code>"pseudo exact"</code>.` };
  }

  const amount = parseAmount(parts[2]);
  if (!amount.ok) return { ok: false, error: amount.error };

  // Date optionnelle, immédiatement après le montant. Ce qui suit est la note.
  let date: string | null = null;
  let rest = parts.slice(3);
  if (rest.length > 0 && ISO_DATE.test(rest[0])) {
    date = rest[0];
    rest = rest.slice(1);
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
      return { ok: false, error: `Date « ${date} » inexistante.` };
    }
    // Une date future est presque toujours une faute de frappe sur l'année ou le
    // mois. On refuse plutôt que d'enregistrer un mouvement qui n'a pas eu lieu.
    if (date > today) {
      return { ok: false, error: `Date « ${date} » dans le futur — un mouvement ne s'enregistre pas à l'avance.` };
    }
  } else if (rest.length > 0 && /^\d{2}[-/]\d{2}[-/]\d{4}$/.test(rest[0])) {
    return { ok: false, error: `Date « ${rest[0] }» : format attendu AAAA-MM-JJ (ex. ${today}).` };
  }

  const note = rest.join(" ").trim();
  return { ok: true, cmd: { action, player, amount: amount.value, date, note: note === "" ? null : note } };
}

/** Toujours reformuler en clair : on ne confirme jamais « 1k ». */
export function formatAmount(n: number): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const NEXA_USAGE = USAGE;
