// Sanitisation et flagging des clics RichAds (fonctions pures, zéro DB).
// Run: npx tsx scripts/richads-tracking.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Ces valeurs arrivent d'une query string PUBLIQUE, alimentée par les macros │
// │ RichAds, et finissent en base puis dans le back-office. Deux pièges déjà   │
// │ rencontrés, tous deux silencieux :                                         │
// │                                                                            │
// │  1. geo tronqué à 8 caractères + majuscules (calibré pour des codes ISO).  │
// │     [COUNTRY] renvoie un NOM : « United Kingdom » devenait « UNITED K ».   │
// │     Toute la ventilation géo du test était fausse, sans aucune alerte.     │
// │  2. Macro non substituée : campagne mal configurée → RichAds envoie        │
// │     littéralement « [CREATIVE_ID] ». Doit tomber en "unknown" pour rester  │
// │     VISIBLE dans les stats, au lieu de passer pour une créa réelle.        │
// │                                                                            │
// │ Règle qui prime sur tout : ON NE PERD JAMAIS UN CLIC. Une anomalie se      │
// │ marque, ne se supprime pas — RichAds la facture de toute façon.            │
// └────────────────────────────────────────────────────────────────────────────┘

import {
  normalizeCre, cleanToken, cleanGeoName, looksAutomated,
  clientIpFromXff, hashIp, creLabel, CRE_LABELS,
} from "../lib/richads";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

console.log("\ncre — id RichAds accepté tel quel, aucune liste blanche");
eq("id numérique", normalizeCre("48211"), "48211");
eq("id jamais vu", normalizeCre("99999"), "99999");
eq("espaces rognés", normalizeCre("  48211 "), "48211");
eq("alphanumérique", normalizeCre("cre_a-1"), "cre_a-1");
eq("limite 32 car.", normalizeCre("x".repeat(32)), "x".repeat(32));

console.log("\ncre — \"unknown\" seulement si vide ou mal formée");
eq("null", normalizeCre(null), "unknown");
eq("vide", normalizeCre(""), "unknown");
eq("espaces seuls", normalizeCre("   "), "unknown");
eq("macro non substituée", normalizeCre("[CREATIVE_ID]"), "unknown");
eq("macro minuscules", normalizeCre("[creative_id]"), "unknown");
eq("traversée de chemin", normalizeCre("../../etc/passwd"), "unknown");
eq("injection SQL", normalizeCre("1' OR 1=1--"), "unknown");
eq("balise script", normalizeCre("<script>alert(1)</script>"), "unknown");
eq("33 car. = trop long", normalizeCre("x".repeat(33)), "unknown");

console.log("\ngeo — NOM de pays intact (ni majuscules, ni troncature)");
eq("Malaysia", cleanGeoName("Malaysia"), "Malaysia");
eq("United Kingdom", cleanGeoName("United Kingdom"), "United Kingdom");
eq("Bosnia and Herzegovina", cleanGeoName("Bosnia and Herzegovina"), "Bosnia and Herzegovina");
eq("United Arab Emirates", cleanGeoName("United Arab Emirates"), "United Arab Emirates");
eq("accent + apostrophe", cleanGeoName("Côte d'Ivoire"), "Côte d'Ivoire");
eq("trait d'union", cleanGeoName("Guinea-Bissau"), "Guinea-Bissau");
eq("parenthèses", cleanGeoName("Korea (South)"), "Korea (South)");
eq("espaces normalisés", cleanGeoName("United   Kingdom"), "United Kingdom");
eq("macro non substituée", cleanGeoName("[COUNTRY]"), null);
eq("balise script", cleanGeoName("<script>alert(1)</script>"), null);
eq("vide", cleanGeoName(""), null);
eq("trop long", cleanGeoName("A".repeat(65)), null);

console.log("\ncleanToken — dimensions opaques (cid, sid, app, pu)");
eq("publisher", cleanToken("PUB_991"), "PUB_991");
eq("numérique", cleanToken("48211"), "48211");
eq("ponctuation autorisée", cleanToken("app.77:v2"), "app.77:v2");
eq("macro TG_PUB_ID", cleanToken("[TG_PUB_ID]"), null);
eq("macro TG_APP_ID", cleanToken("[TG_APP_ID]"), null);
eq("macro TG_USER_TYPE", cleanToken("[TG_USER_TYPE]"), null);
eq("injection SQL", cleanToken("1' OR 1=1--"), null);
eq("trop long → null, jamais tronqué", cleanToken("x".repeat(65)), null);

console.log("\nlooksAutomated — flag no_ua");
eq("UA vide", looksAutomated(""), true);
eq("UA absent", looksAutomated(null), true);
eq("curl", looksAutomated("curl/8.4.0"), true);
eq("python-requests", looksAutomated("python-requests/2.31"), true);
eq("crawler", looksAutomated("Mozilla/5.0 (compatible; AhrefsBot/7.0)"), true);
eq("iPhone réel", looksAutomated("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148"), false);

console.log("\nclientIpFromXff — l'IP usurpable ne doit pas gagner");
eq("proxy Railway devant", clientIpFromXff("1.2.3.4, 198.51.100.77", 1), "198.51.100.77");
eq("un seul hop", clientIpFromXff("198.51.100.77", 1), "198.51.100.77");
eq("local sans proxy", clientIpFromXff("203.0.113.11", 0), "203.0.113.11");
eq("en-tête absent", clientIpFromXff(null, 1), null);
eq("en-tête vide", clientIpFromXff("", 1), null);

console.log("\nhashIp — jamais d'IP en clair");
const h = hashIp("203.0.113.11");
eq("longueur 32", h.length, 32);
eq("différent de l'IP", h === "203.0.113.11", false);
eq("stable (fenêtre de rafale)", hashIp("203.0.113.11"), h);
eq("discriminant", hashIp("203.0.113.12") === h, false);

console.log("\ncreLabel — libellé résolu à l'affichage, jamais figé en base");
eq("table vide → id brut", creLabel("48211"), "48211");
CRE_LABELS["48211"] = "instant";
eq("id mappé → nom", creLabel("48211"), "instant");
eq("id non mappé → brut", creLabel("48299"), "48299");
delete CRE_LABELS["48211"];

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length > 0) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
