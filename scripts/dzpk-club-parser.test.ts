// Parseur des notifications du club @dzpk — fonctions pures, zéro DB.
// Run: npx tsx scripts/dzpk-club-parser.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Ce parseur décide de ce qui est compté comme REVENU. Quatre façons de se    │
// │ tromper, toutes silencieuses :                                             │
// │                                                                            │
// │  1. Confondre « a rejoint » (已进群) et « rattaché » (已绑定为代理). Le      │
// │     gabarit join contient « 绑定推广关系 » : un marqueur trop court         │
// │     transformerait chaque join en revenu.                                  │
// │  2. S'attribuer les joueurs d'un AUTRE agent, faute de filtrer sur 🍓.      │
// │  3. Couper un nom sur le `从` qu'il contient (从容) au lieu du séparateur.  │
// │  4. Lire un montant de travers — la virgule idéographique `，` devient une  │
// │     virgule ASCII sous NFKC et rallonge le nombre.                         │
// │                                                                            │
// │ Les fixtures sont les chaînes RÉELLES fournies par Baki, à l'octet près.   │
// └────────────────────────────────────────────────────────────────────────────┘

import { parseClubNotification, parseAmount, PARSER_VERSION, type ParserConfig } from "../lib/funnels/dzpk/club-parser";
import { nameKey, nameKeyTight, decoratedEquals } from "../lib/funnels/dzpk/name-key";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const CFG: ParserConfig = { agentName: "🍓", clubLabel: "德州扑克 ♠️❤️ @dzpk" };
const NO_LABEL: ParserConfig = { agentName: "🍓", clubLabel: null };

// ── Fixtures réelles ──────────────────────────────────────────────────────────
const F_JOIN = "玩家 FUN SEONG 已进群 德州扑克 ♠️❤️ @dzpk 俱乐部，该玩家进入游戏即可绑定推广关系！";
const F_BOUND = "玩家 FUN SEONG 从 德州扑克 ♠️❤️ @dzpk 俱乐部 首次进入俱乐部游戏，已绑定为代理 🍓 的推广！";
const F_COMMISSION = "代理 🍓 申请的分佣 811.62896 USDT，俱乐部已实际支付 811.62 USDT，请进入游戏核对明细！";
const F_BANNED = "代理 🍓 推广的用户 Arnold Poteque 已被封号/冻结，无法正常游戏！";

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ngabarit 1 — JOIN (已进群)");
{
  const r = parseClubNotification(F_JOIN, CFG);
  eq("kind", r.kind, "join");
  eq("nom entier, non découpé", r.playerNameRaw, "FUN SEONG");
  eq("clé d'appariement", r.nameKey, "fun seong");
  eq("PAS de champ agent dans ce gabarit", r.agentNameRaw, null);
  eq("appartenance INDÉTERMINABLE (null, pas false)", r.agentIsMine, null);
  eq("aucune commission", r.commission, null);
}

console.log("\ngabarit 2 — RATTACHÉ (已绑定为代理) = le revenu");
{
  const r = parseClubNotification(F_BOUND, CFG);
  eq("kind", r.kind, "bound");
  eq("nom entier", r.playerNameRaw, "FUN SEONG");
  eq("agent extrait", r.agentNameRaw, "🍓");
  eq("agent reconnu comme le nôtre", r.agentIsMine, true);
}

console.log("\ngabarit 3 — COMMISSION (申请的分佣) = argent réel");
{
  const r = parseClubNotification(F_COMMISSION, CFG);
  eq("kind", r.kind, "commission");
  eq("aucun joueur rattaché", r.playerNameRaw, null);
  eq("agent", r.agentNameRaw, "🍓");
  eq("agent reconnu", r.agentIsMine, true);
  eq("brut demandé conservé", r.commission?.requestedRaw, "811.62896");
  eq("valeur demandée", r.commission?.requestedAmount, 811.62896);
  eq("brut payé conservé", r.commission?.paidRaw, "811.62");
  eq("valeur payée", r.commission?.paidAmount, 811.62);
  eq("devise", r.commission?.currency, "USDT");
  eq("la virgule idéographique n'a PAS été avalée", r.commission?.requestedRaw.includes(","), false);
}

console.log("\ngabarit 4 — BANNI (已被封号/冻结)");
{
  const r = parseClubNotification(F_BANNED, CFG);
  eq("kind", r.kind, "banned");
  eq("nom entier, 2 mots", r.playerNameRaw, "Arnold Poteque");
  eq("agent", r.agentNameRaw, "🍓");
  eq("agent reconnu", r.agentIsMine, true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nFILTRE AGENT — ne jamais s'attribuer les joueurs d'un autre");
{
  const autre = F_BOUND.replace("已绑定为代理 🍓 的推广", "已绑定为代理 🍔 的推广");
  const r = parseClubNotification(autre, CFG);
  eq("parsé quand même", r.kind, "bound");
  eq("agent de l'autre conservé tel quel", r.agentNameRaw, "🍔");
  eq("REFUSÉ comme nôtre", r.agentIsMine, false);

  const rc = parseClubNotification(F_COMMISSION.replace("代理 🍓", "代理 🍔"), CFG);
  eq("commission d'un autre agent refusée", rc.agentIsMine, false);
  eq("montants tout de même lus (traçabilité)", rc.commission?.paidAmount, 811.62);
}

console.log("\nFILTRE AGENT — tolérance au sélecteur de variante (U+FE0F)");
{
  const avecVS = F_BOUND.replace("🍓", "🍓️");
  eq("🍓 + VS16 reconnu", parseClubNotification(avecVS, CFG).agentIsMine, true);
  eq("config avec VS16, message sans", parseClubNotification(F_BOUND, { ...CFG, agentName: "🍓️" }).agentIsMine, true);
  eq("decoratedEquals direct", decoratedEquals("🍓️", "🍓"), true);
  eq("emoji différents restent différents", decoratedEquals("🍓", "🍔"), false);
  eq("agent non configuré ⇒ indéterminable", parseClubNotification(F_BOUND, { ...CFG, agentName: null }).agentIsMine, null);
}

console.log("\nFILTRE AGENT — tolérance sur le libellé du club (♠️❤️)");
{
  const sansVS = F_BOUND.replace("♠️❤️", "♠❤");
  const r = parseClubNotification(sansVS, { agentName: "🍓", clubLabel: "德州扑克 ♠️❤️ @dzpk" });
  eq("club sans VS : repli structurel, nom correct", r.playerNameRaw, "FUN SEONG");
  eq("kind conservé", r.kind, "bound");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nNOMS — pris ENTIERS, quelle que soit leur forme");
{
  const cas: Array<[string, string]> = [
    ["FUN SEONG", "deux mots latins"],
    ["Fabien Gün", "tréma"],
    ["mark", "minuscule, un mot"],
    ["Rom", "trois lettres"],
    ["豪豪 黄", "chinois avec espace"],
    ["张伟", "chinois sans espace"],
    ["王小明 🐉", "chinois + emoji"],
  ];
  for (const [nom, libelle] of cas) {
    const r = parseClubNotification(F_BOUND.replace("FUN SEONG", nom), CFG);
    eq(`${libelle} : "${nom}"`, r.playerNameRaw, nom);
  }
}

console.log("\nNOMS — le CJK survit à la normalisation (contrairement à normalizeForMatch)");
eq("张伟 garde une clé", nameKey("张伟"), "张伟");
eq("豪豪 黄 espace réduit", nameKey("豪豪  黄"), "豪豪 黄");
eq("王小明 🐉 → emoji retiré, nom gardé", nameKey("王小明 🐉"), "王小明");
eq("pleine chasse repliée", nameKey("ＦＵＮ ＳＥＯＮＧ"), "fun seong");
eq("casse pliée", nameKey("Fabien Gün"), "fabien gün");
eq("clé compacte pour SUGGESTION seulement", nameKeyTight("FUN SEONG"), "funseong");
eq("deux noms chinois distincts NE collident PAS", nameKey("张伟") === nameKey("李娜"), false);

console.log("\nNOMS — le `从` d'un nom ne coupe pas l'extraction");
{
  const avecCong = "玩家 从容 从 德州扑克 ♠️❤️ @dzpk 俱乐部 首次进入俱乐部游戏，已绑定为代理 🍓 的推广！";
  eq("avec libellé de club", parseClubNotification(avecCong, CFG).playerNameRaw, "从容");
  eq("SANS libellé (repli : dernier 从)", parseClubNotification(avecCong, NO_LABEL).playerNameRaw, "从容");
  eq("repli sur le cas simple", parseClubNotification(F_BOUND, NO_LABEL).playerNameRaw, "FUN SEONG");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nMONTANTS — strict, jamais de devinette");
eq("décimales longues", parseAmount("811.62896"), 811.62896);
eq("deux décimales", parseAmount("811.62"), 811.62);
eq("entier", parseAmount("800"), 800);
eq("chiffres pleine chasse", parseAmount("８１１.６２"), 811.62);

// La virgule est TOUJOURS refusée, même en groupes de 3 apparemment réguliers.
// "811,628" vaut 811628 si c'est un séparateur de milliers, 811.628 si c'est un
// séparateur décimal — un facteur 1000, et rien dans la chaîne ne tranche.
// C'était la seule branche du parseur capable de produire un montant FAUX
// plutôt qu'un refus (audit money du 2026-08-12, F5). Un refus tombe en
// `unparsed`, donc visible à l'écran ; un faux se comptabilise en silence.
eq("virgule en groupe de 3 refusée", parseAmount("1,234.56"), null);
eq("virgule décimale ambiguë refusée", parseAmount("811,628"), null);
eq("virgule mal groupée refusée", parseAmount("1,23,456"), null);
eq("texte refusé", parseAmount("abc"), null);
eq("vide refusé", parseAmount(""), null);
eq("double point refusé", parseAmount("1.2.3"), null);
eq("négatif refusé", parseAmount("-5"), null);

console.log("\nMONTANTS — un montant illisible fait basculer TOUT le message en unparsed");
{
  const casse = "代理 🍓 申请的分佣 8ll.62896 USDT，俱乐部已实际支付 811.62 USDT，请进入游戏核对明细！";
  const r = parseClubNotification(casse, CFG);
  eq("kind", r.kind, "unparsed");
  eq("aucune commission fabriquée", r.commission, null);
}
{
  const devises = F_COMMISSION.replace("俱乐部已实际支付 811.62 USDT", "俱乐部已实际支付 811.62 USDC");
  const r = parseClubNotification(devises, CFG);
  eq("devises incohérentes ⇒ unparsed", r.kind, "unparsed");
  eq("motif explicite", (r.reason ?? "").includes("devises"), true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nUNPARSED — rien n'est jeté en silence");
{
  const cas = ["", "   ", "bonjour", "俱乐部公告：今晚有活动！", "代理 🍓 你好"];
  for (const c of cas) {
    const r = parseClubNotification(c, CFG);
    eq(`"${c.slice(0, 20)}" ⇒ unparsed avec motif`, r.kind === "unparsed" && Boolean(r.reason), true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTREFACTUELS — remettre le bug et exiger que le test tombe.
console.log("\ncontrefactuels — les gardes savent-ils rougir ?");
{
  // Bug 1 : marqueur trop court. « 绑定 » est présent DANS le gabarit join.
  eq("BUG marqueur court : le join contient bien 绑定", F_JOIN.includes("绑定"), true);
  eq("…mais PAS le marqueur long 已绑定为代理", F_JOIN.includes("已绑定为代理"), false);
  eq("le join n'est donc jamais classé bound", parseClubNotification(F_JOIN, CFG).kind === "bound", false);

  // Bug 2 : premier `从` au lieu du dernier.
  const avecCong = "玩家 从容 从 德州扑克 ♠️❤️ @dzpk 俱乐部 首次进入俱乐部游戏，已绑定为代理 🍓 的推广！";
  const naif = avecCong.slice(avecCong.indexOf("玩家") + 2, avecCong.indexOf("从")).trim();
  eq("BUG premier 从 : couperait le nom à vide", naif, "");
  eq("le parseur, lui, rend le nom entier", parseClubNotification(avecCong, CFG).playerNameRaw, "从容");

  // Bug 3 : NFKC global avant extraction du montant.
  const nfkc = F_COMMISSION.normalize("NFKC");
  eq("BUG NFKC global : ， devient une virgule ASCII", nfkc.includes("811.62896 USDT,"), true);
  eq("le parseur ne l'applique pas au message entier",
    parseClubNotification(F_COMMISSION, CFG).commission?.requestedAmount, 811.62896);

  // Bug 4 : absence de filtre agent.
  const autre = F_COMMISSION.replace("代理 🍓", "代理 🍔");
  eq("BUG sans filtre : la notif d'un autre serait comptée", parseClubNotification(autre, CFG).kind, "commission");
  eq("le filtre la marque comme non-nôtre", parseClubNotification(autre, CFG).agentIsMine, false);
}

console.log(`\nPARSER_VERSION = ${PARSER_VERSION}`);
console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
