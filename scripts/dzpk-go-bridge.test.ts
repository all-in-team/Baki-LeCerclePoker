// Pont clic publicitaire → bot dzpk : conversion de la créative en start param.
// Run: npx tsx scripts/dzpk-go-bridge.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Cette conversion est le seul endroit où l'identité d'une CRÉATIVE devient  │
// │ la SOURCE d'un lead. Si elle rend une chaîne que Telegram rejette ou       │
// │ tronque, le lead arrive sans source — le clic est facturé, le joueur       │
// │ compté, et personne ne sait quelle pub l'a amené. L'échec est muet.        │
// │                                                                            │
// │ Trois cas doivent rester DISTINCTS :                                       │
// │   • pas de cre        → "direct"   (le lien ne portait pas de créative)    │
// │   • macro non résolue → "unknown"  (campagne mal configurée, à corriger)   │
// │   • créative valide   → la créative, tirets convertis                      │
// │ Les fondre effacerait le seul signal d'une campagne cassée.                │
// └────────────────────────────────────────────────────────────────────────────┘

import { creToStartParam, DEFAULT_AD_SOURCE } from "../lib/richads";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

/** La contrainte que tout le reste doit respecter. */
const TELEGRAM_START = /^[A-Za-z0-9_]{1,64}$/;

console.log("\nconversion — le cas nominal de PropellerAds");
eq("tgads-123", creToStartParam("tgads-123"), "tgads_123");
eq("bannerid seul", creToStartParam("445566"), "445566");
eq("underscore conservé", creToStartParam("tgads_123"), "tgads_123");
eq("casse pliée", creToStartParam("TgAds-123"), "tgads_123");
eq("espaces rognés", creToStartParam("  tgads-123  "), "tgads_123");
eq("tirets multiples", creToStartParam("prop-cn-99"), "prop_cn_99");

console.log("\ncre absente ou vide ⇒ source par défaut, jamais une redirection cassée");
eq("null", creToStartParam(null), DEFAULT_AD_SOURCE);
eq("undefined", creToStartParam(undefined), DEFAULT_AD_SOURCE);
eq("chaîne vide", creToStartParam(""), DEFAULT_AD_SOURCE);
eq("espaces seuls", creToStartParam("   "), DEFAULT_AD_SOURCE);
eq("valeur du défaut", DEFAULT_AD_SOURCE, "direct");

console.log("\nmacro non substituée ⇒ « unknown », PAS « direct »");
// La distinction est le seul symptôme d'une campagne mal configurée : la fondre
// dans « direct » ferait passer une panne pour du trafic organique.
eq("PropellerAds, accolades", creToStartParam("tgads-{bannerid}"), "unknown");
eq("RichAds, crochets", creToStartParam("[CREATIVE_ID]"), "unknown");
eq("accolade seule", creToStartParam("{bannerid}"), "unknown");
eq("distinct de direct", creToStartParam("{bannerid}") === DEFAULT_AD_SOURCE, false);

console.log("\nhygiène — la sortie respecte TOUJOURS le format Telegram");
{
  const entrees = [
    "tgads-123", "445566", "TgAds-123", "prop-cn-99", "", "   ", null, undefined,
    "tgads-{bannerid}", "[CREATIVE_ID]", "../../etc/passwd", "1' OR 1=1--",
    "<script>alert(1)</script>", "a".repeat(40), "推广渠道", "🍓", "a b c",
    "tg+ads", "tg%20ads", "tg/ads", "tg?ads=1", "tg&ads",
  ];
  for (const e of entrees) {
    const out = creToStartParam(e as any);
    const ok = TELEGRAM_START.test(out);
    eq(`format valide pour ${JSON.stringify(e)}`, ok, true);
  }
}

console.log("\nbornes");
eq("32 caractères (plafond de normalizeCre)", creToStartParam("a".repeat(32)).length, 32);
eq("33 ⇒ rejeté par normalizeCre, donc unknown", creToStartParam("a".repeat(33)), "unknown");
eq("jamais plus de 64", creToStartParam("a".repeat(200)).length <= 64, true);

console.log("\ncontrefactuel — le tiret non converti serait-il détecté ?");
{
  // Si la conversion disparaissait, la sortie porterait un tiret. Le test de
  // format ci-dessus doit alors rougir — vérifions qu'il en est capable.
  const sansConversion = "tgads-123";
  eq("BUG sans conversion : le tiret survit", TELEGRAM_START.test(sansConversion), false);
  eq("avec conversion : format valide", TELEGRAM_START.test(creToStartParam("tgads-123")), true);
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
