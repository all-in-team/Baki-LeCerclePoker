/**
 * Harnais de la grammaire /nexa.
 * Run: npx tsx scripts/nexa-command.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ La GRAMMAIRE de la commande : actions et alias, formes de joueur,       │
 * │ montants acceptés et refusés, date optionnelle, note.                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ NI la résolution du joueur en base, NI le flux de confirmation, NI la   │
 * │ garde OWNER_IDS, NI l'écriture. Le handler parle à Telegram : il ne     │
 * │ pourra être exercé qu'en prod, après merge (le bot tourne sur main).    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { parseNexaCommand, parseAmount, formatAmount } from "../lib/funnels/nexa/movement-command";

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

const TODAY = "2026-08-05";
const p = (s: string) => parseNexaCommand(s, TODAY);
const amt = (s: string) => { const r = parseAmount(s); return r.ok ? r.value : `REJET`; };

console.log("\n══ Montants ══");
eq("entier", amt("1000"), 1000);
eq("avec dollar", amt("1000$"), 1000);
eq("avec espace de millier", amt("1 000"), 1000);
eq("décimal au point", amt("1000.50"), 1000.5);
eq("raccourci k", amt("1k"), 1000);
eq("raccourci k décimal", amt("1.5k"), 1500);
eq("k majuscule", amt("2K"), 2000);
check("virgule décimale REFUSÉE (ambiguë)", !parseAmount("1000,50").ok);
check("le message propose le point", /point/.test((parseAmount("1000,50") as { error: string }).error));
check("négatif refusé", !parseAmount("-100").ok);
check("zéro refusé", !parseAmount("0").ok);
check("kk refusé", !parseAmount("1kk").ok);
check("trois décimales refusées", !parseAmount("10.005").ok);
check("texte refusé", !parseAmount("beaucoup").ok);
check("vide refusé", !parseAmount("").ok);
// fr-FR sépare les milliers par U+202F (insécable étroite), pas par une espace
// normale — on teste l'INTENTION (montant en clair, jamais « 1k »), pas l'octet.
check("formatAmount reformule en clair, jamais en k",
      /^1\s?000,00$/u.test(formatAmount(1000)) && !/k/i.test(formatAmount(1000)),
      JSON.stringify(formatAmount(1000)));
eq("deux décimales toujours affichées", formatAmount(1500).endsWith(",00"), true);

console.log("\n══ Actions et alias ══");
for (const [a, want] of [["buyin", "buy_in"], ["buy-in", "buy_in"], ["depot", "buy_in"], ["dépôt", "buy_in"],
                         ["cashout", "cash_out"], ["cash-out", "cash_out"], ["retrait", "cash_out"]] as const) {
  const r = p(`${a} @x 100`);
  eq(`« ${a} » → ${want}`, r.ok && r.cmd.action, want);
}
eq("casse libre", p("BUYIN @x 100").ok && (p("BUYIN @x 100") as any).cmd.action, "buy_in");
check("action inconnue refusée", !p("verse @x 100").ok);

console.log("\n══ Formes de joueur ══");
{
  const r = p("buyin @le_green 1000");
  eq("@handle", r.ok && r.cmd.player, { kind: "handle", value: "le_green" });
}
{
  const r = p("buyin #12 1000");
  eq("#id", r.ok && r.cmd.player, { kind: "id", value: 12 });
}
{
  const r = p('buyin "Le Cercle" 1000');
  eq("pseudo entre guillemets, espaces compris", r.ok && r.cmd.player, { kind: "name", value: "Le Cercle" });
}
check("pseudo nu (sans @ ni guillemets) refusé", !p("buyin lecercle 1000").ok);
check("@ seul refusé", !p("buyin @ 1000").ok);

console.log("\n══ Date ══");
{
  const r = p("buyin @x 1000 2026-08-03");
  eq("date reprise", r.ok && r.cmd.date, "2026-08-03");
  eq("pas de note", r.ok && r.cmd.note, null);
}
eq("sans date → null (résolue côté serveur)", p("buyin @x 1000").ok && (p("buyin @x 1000") as any).cmd.date, null);
eq("date du jour acceptée", p(`buyin @x 1000 ${TODAY}`).ok && (p(`buyin @x 1000 ${TODAY}`) as any).cmd.date, TODAY);
check("date FUTURE refusée", !p("buyin @x 1000 2026-08-06").ok);
check("le message dit pourquoi", /futur/.test((p("buyin @x 1000 2026-08-06") as any).error));
check("date inexistante refusée", !p("buyin @x 1000 2026-02-31").ok);
check("format JJ-MM-AAAA refusé avec le bon format proposé",
      !p("buyin @x 1000 03-08-2026").ok && /AAAA-MM-JJ/.test((p("buyin @x 1000 03-08-2026") as any).error));

console.log("\n══ Note ══");
{
  const r = p("buyin @x 1000 virement recu ce matin");
  eq("note sans date", r.ok && r.cmd.note, "virement recu ce matin");
  eq("date reste nulle", r.ok && r.cmd.date, null);
}
{
  const r = p("cashout @x 500 2026-08-03 paye en especes");
  eq("date ET note", r.ok && [r.cmd.date, r.cmd.note], ["2026-08-03", "paye en especes"]);
}

console.log("\n══ Commande complète ══");
{
  const r = p('buyin "Le Cercle" 1.5k 2026-08-03 note ici');
  check("parsée", r.ok);
  if (r.ok) eq("tout est correct",
    [r.cmd.action, r.cmd.player, r.cmd.amount, r.cmd.date, r.cmd.note],
    ["buy_in", { kind: "name", value: "Le Cercle" }, 1500, "2026-08-03", "note ici"]);
}
check("commande vide refusée", !p("").ok);
check("éléments manquants refusés", !p("buyin @x").ok);
check("l'usage est rappelé", /Usage/.test((p("") as any).error));

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
