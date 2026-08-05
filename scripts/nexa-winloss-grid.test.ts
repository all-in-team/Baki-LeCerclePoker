// Parse des montants de la grille de saisie win/loss (fonction pure, zéro DB).
// Run: npx tsx scripts/nexa-winloss-grid.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ parseFloat s'arrête au premier caractère invalide et rend un nombre        │
// │ d'apparence valide : « 1 234,56 » collé depuis un tableur devenait 1.      │
// │ Pas d'erreur, pas d'alerte, juste un win/loss faux de 1233,56 — et une     │
// │ part d'action calculée dessus. Ces cas verrouillent le parse strict.       │
// └────────────────────────────────────────────────────────────────────────────┘

import { parseMontant } from "../app/nexapoker/WinlossGrid";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

console.log("\nMontants valides");
eq("entier", parseMontant("250"), 250);
eq("décimal virgule", parseMontant("250,50"), 250.5);
eq("décimal point", parseMontant("250.50"), 250.5);
eq("négatif", parseMontant("-1200"), -1200);
eq("négatif décimal", parseMontant("-1200,25"), -1200.25);
eq("signe +", parseMontant("+300"), 300);
eq("zéro — une saisie, pas une absence", parseMontant("0"), 0);
eq("espaces autour", parseMontant("  42  "), 42);

console.log("\nSéparateurs de milliers — le piège du copier-coller");
eq("espace fin", parseMontant("1 234,56"), 1234.56);
eq("espace insécable", parseMontant("1 1234,56".replace("1 1234", "1 234")), 1234.56);
eq("espace insécable étroit", parseMontant("1 234,56"), 1234.56);
eq("apostrophe (format suisse)", parseMontant("1'234,56"), 1234.56);

console.log("\nIllisibles — doivent être REFUSÉS, jamais tronqués");
eq("lettre en fin", parseMontant("12o"), undefined);
eq("tiret en fin", parseMontant("5-"), undefined);
eq("point virgule mêlés", parseMontant("1,234.56"), undefined);
eq("deux virgules", parseMontant("1,2,3"), undefined);
eq("tiret seul", parseMontant("-"), undefined);
eq("virgule seule", parseMontant(","), undefined);
eq("point seul", parseMontant("."), undefined);
eq("texte", parseMontant("abc"), undefined);
eq("vide", parseMontant(""), undefined);
eq("espaces seuls", parseMontant("   "), undefined);
eq("notation scientifique refusée", parseMontant("1e3"), undefined);

console.log(`\n${failures.length === 0 ? "=== TOUS LES TESTS PASSENT ===" : `=== ${failures.length} ÉCHEC(S) ===`}  (${passed} assertions)`);
if (failures.length) process.exit(1);
