// Diffusions dzpk — segment figé, file d'envoi, reprise, garde-fous.
// Run: npx tsx scripts/dzpk-broadcast.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Quatre propriétés de ce module sont invisibles à l'œil et se paient cher   │
// │ en prod, sur des gens réels :                                              │
// │                                                                            │
// │  1. LE SEGMENT EST FIGÉ. Un lead qui change d'étape pendant la diffusion   │
// │     ne doit ni entrer ni sortir de la liste annoncée. Sinon le nombre      │
// │     affiché au moment de confirmer est un mensonge.                        │
// │  2. LA REPRISE NE PERD NI NE REDOUBLE PERSONNE. C'est la raison d'être de  │
// │     la table de cibles. On simule une coupure au milieu et on vérifie les  │
// │     deux côtés : rien de perdu, rien d'envoyé deux fois.                   │
// │  3. UN 429 NE CONSOMME PAS UN DESTINATAIRE. S'il le consommait, une        │
// │     limitation Telegram effacerait silencieusement une partie de la liste. │
// │  4. LES DEUX DÉFINITIONS D'ÉTAPE COÏNCIDENT. `deriveState` (TypeScript) et │
// │     `STAGE_SQL` (SQL) décrivent la même chose deux fois. Si elles          │
// │     divergent, la diffusion part au mauvais public sans aucune erreur.     │
// │                                                                            │
// │ La base est TEMPORAIRE et montée avec le SQL des migrations elles-mêmes,   │
// │ pas une recopie. Et les propriétés sont vérifiées PAR CONTREFACTUEL quand  │
// │ c'est possible : on remet le bug, on constate que le test tombe.           │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  createBroadcast, startBroadcast, pauseBroadcast, cancelBroadcast,
  runBroadcastDrain, resolveSegment, countSegment, segmentError,
  getBroadcast, getCounts, getGuard, listBroadcasts, STAGE_SQL, ALL_STAGES,
  MAX_ATTEMPTS, type DzpkSegment,
} from "../lib/funnels/dzpk/broadcast";
import { deriveState, type DbLike } from "../lib/funnels/dzpk/leads";
import {
  DZPK_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
  DZPK_BROADCAST_SCHEMA_SQL,
} from "../lib/funnels/dzpk/schema";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

type TestDb = DbLike & { exec(s: string): void; close(): void };

function freshDb(): TestDb {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL_2);
  db.exec(DZPK_MATCH_SCHEMA_SQL_3);
  // Le SQL de la migration, pas une recopie : un test qui valide sa propre
  // copie du CREATE TABLE ne dit rien de la base réelle.
  db.exec(DZPK_BROADCAST_SCHEMA_SQL);
  return db as any;
}

interface LeadSpec {
  tg: number;
  source?: string;
  replied?: boolean;
  joined?: boolean;
  bound?: boolean;
  converted?: boolean;
  blocked?: boolean;
  banned?: boolean;
}

function addLead(db: TestDb, s: LeadSpec): number {
  const info = db.prepare(
    `INSERT INTO dzpk_leads (telegram_id, source, first_reply_at, club_joined_at,
                             bound_at, converted_at, banned_at, blocked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    s.tg, s.source ?? "tgads",
    s.replied ? "2026-08-01 10:00:00" : null,
    s.joined ? "2026-08-01 11:00:00" : null,
    s.bound ? "2026-08-01 12:00:00" : null,
    s.converted ? "2026-08-01 13:00:00" : null,
    s.banned ? "2026-08-02 09:00:00" : null,
    s.blocked ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

const SEG_ALL: DzpkSegment = { sources: null, stages: [...ALL_STAGES] };

const draft = (segment: DzpkSegment = SEG_ALL) => ({
  title: "promo", body: "🎉 Weekend bonus 周末奖金", segment,
});

/** Envoi factice : réussit toujours, journalise qui a été appelé. */
function okSender(log: number[]) {
  return async (chatId: number) => { log.push(chatId); return { ok: true, result: { message_id: 42 } }; };
}

// Un seul IIFE asynchrone : tsx compile ces scripts en CJS, où le top-level
// await n'existe pas. Même forme que scripts/nexa-extract-retry.test.ts.
(async () => {
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nSTAGE_SQL ≡ deriveState — les deux définitions de l'étape coïncident");
  {
    // Les 16 combinaisons des quatre colonnes de date. Exhaustif et non
    // échantillonné : c'est le seul moyen de prouver l'équivalence plutôt que de
    // la sonder.
    const db = freshDb();
    let tg = 1000;
    const attendus: string[] = [];
    for (const converted of [false, true]) {
      for (const bound of [false, true]) {
        for (const joined of [false, true]) {
          for (const replied of [false, true]) {
            addLead(db, { tg: tg++, converted, bound, joined, replied });
            attendus.push(deriveState({
              converted_at: converted ? "x" : null,
              bound_at: bound ? "x" : null,
              club_joined_at: joined ? "x" : null,
              first_reply_at: replied ? "x" : null,
            }));
          }
        }
      }
    }
    const enSql = db.prepare(`SELECT ${STAGE_SQL} AS s FROM dzpk_leads ORDER BY id`).all()
      .map((r: any) => r.s);
    eq("16 combinaisons couvertes", enSql.length, 16);
    eq("SQL identique à deriveState sur les 16", enSql, attendus);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nsegment — exclusions dures, jamais contournables");
  {
    const db = freshDb();
    addLead(db, { tg: 1, source: "tgads" });
    addLead(db, { tg: 2, source: "tgads", blocked: true });
    addLead(db, { tg: 3, source: "tgads", banned: true, bound: true });
    addLead(db, { tg: 4, source: "richads_1", bound: true });

    eq("bloqué et banni exclus de « toutes étapes »", countSegment(SEG_ALL, db), 2);
    eq("filtre par source", countSegment({ sources: ["richads_1"], stages: [...ALL_STAGES] }, db), 1);
    eq("filtre par étape", countSegment({ sources: null, stages: ["bound"] }, db), 1);
    eq("étape sans personne", countSegment({ sources: null, stages: ["replied"] }, db), 0);

    // Contrefactuel : un lead banni est bien dans la table, il est écarté par le
    // filtre — pas absent des données.
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads`).get() as any).n;
    eq("les exclus existent bien en base", total, 4);

    eq("segment vide de stages refusé", segmentError({ sources: null, stages: [] }), "Aucune étape sélectionnée");
    eq("sources vides refusées", segmentError({ sources: [], stages: ["started"] }), "Aucune source sélectionnée");
    eq("étape inconnue refusée", segmentError({ sources: null, stages: ["zzz" as any] }), "Étape inconnue : zzz");
    eq("segment valide accepté", segmentError(SEG_ALL), null);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\ncréation — validations qui évitent un échec répété 4000 fois");
  {
    const db = freshDb();
    addLead(db, { tg: 1 });

    eq("titre vide refusé", createBroadcast({ ...draft(), title: "" }, db).error, "Titre requis");
    eq("message vide refusé", createBroadcast({ ...draft(), body: "  " }, db).error, "Message vide");
    eq("bouton sans url refusé",
      createBroadcast({ ...draft(), buttonLabel: "Join" }, db).error, "Bouton : libellé sans URL");
    eq("url sans libellé refusée",
      createBroadcast({ ...draft(), buttonUrl: "https://t.me/x" }, db).error, "Bouton : URL sans libellé");
    eq("url de schéma invalide refusée",
      createBroadcast({ ...draft(), buttonLabel: "Join", buttonUrl: "javascript:alert(1)" }, db).error,
      "Bouton : URL doit commencer par http://, https:// ou tg://");
    eq("segment sans destinataire refusé",
      createBroadcast(draft({ sources: null, stages: ["converted"] }), db).error,
      "Aucun destinataire pour ce segment");

    // 4096 points de code, pas 4096 unités UTF-16 : un message chinois de 3000
    // idéogrammes passe, alors qu'un comptage naïf en .length le refuserait.
    const long = { ...draft(), body: "汉".repeat(4097) };
    eq("message trop long refusé", createBroadcast(long, db).error,
      "Message trop long : 4097 caractères, maximum 4096");
    eq("4096 idéogrammes acceptés",
      createBroadcast({ ...draft(), title: "long", body: "汉".repeat(4096) }, db).ok, true);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nsegment FIGÉ — un lead qui change d'étape ne bouge plus la liste");
  {
    const db = freshDb();
    addLead(db, { tg: 1 });
    addLead(db, { tg: 2 });
    const created = createBroadcast(draft({ sources: null, stages: ["started"] }), db);
    eq("2 destinataires figés", created.total, 2);

    // Le lead 1 progresse APRÈS la création : il n'est plus « started ».
    db.prepare(`UPDATE dzpk_leads SET bound_at = '2026-08-03 10:00:00' WHERE telegram_id = 1`).run();
    eq("le segment recalculé n'en verrait plus qu'un",
      countSegment({ sources: null, stages: ["started"] }, db), 1);
    eq("la liste figée en garde bien deux",
      (db.prepare(`SELECT COUNT(*) AS n FROM dzpk_broadcast_targets WHERE broadcast_id = ?`)
        .get(created.id!) as any).n, 2);

    // Un nouveau lead arrivé après la création n'entre pas non plus.
    addLead(db, { tg: 3 });
    eq("un lead arrivé après reste dehors",
      (db.prepare(`SELECT COUNT(*) AS n FROM dzpk_broadcast_targets WHERE broadcast_id = ?`)
        .get(created.id!) as any).n, 2);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nenvoi nominal");
  {
    const db = freshDb();
    for (let i = 1; i <= 5; i++) addLead(db, { tg: i });
    const bc = createBroadcast(draft(), db);

    eq("créée en brouillon", getBroadcast(bc.id!, db)!.status, "draft");
    const sent: number[] = [];
    const avant = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("un brouillon n'envoie RIEN", avant.broadcastId, null);
    eq("aucun appel Telegram sur un brouillon", sent.length, 0);

    eq("démarrage accepté", startBroadcast(bc.id!, db).ok, true);
    const res = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("5 envoyés", res.sent, 5);
    eq("terminée", res.finished, true);
    eq("statut done", getBroadcast(bc.id!, db)!.status, "done");
    eq("chaque destinataire une seule fois", sent.length, new Set(sent).size);
    eq("les 5 comptes visés", [...sent].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    eq("compteurs", getCounts(bc.id!, db), { pending: 0, sent: 5, blocked: 0, failed: 0 });

    // Un second tour ne doit rien renvoyer : la diffusion n'est plus 'running'.
    const rejeu = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("rejeu du drain : aucun envoi", rejeu.broadcastId, null);
    eq("toujours 5 appels au total", sent.length, 5);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nREPRISE — une coupure au milieu ne perd ni ne redouble personne");
  {
    const db = freshDb();
    for (let i = 1; i <= 10; i++) addLead(db, { tg: i });
    const bc = createBroadcast(draft(), db);
    startBroadcast(bc.id!, db);

    const sent: number[] = [];
    // Premier tour plafonné à 4 : c'est la coupure. Les 6 restants demeurent
    // 'pending' en base, sans aucun état en mémoire pour s'en souvenir.
    const t1 = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0, max: 4 }, db);
    eq("4 partis au premier tour", t1.sent, 4);
    eq("6 restants annoncés", t1.deferred, 6);
    eq("pas terminée", t1.finished, false);
    eq("toujours running", getBroadcast(bc.id!, db)!.status, "running");

    // « Redémarrage » : plus rien en mémoire, on repart de la base seule.
    const t2 = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("6 partis au second tour", t2.sent, 6);
    eq("terminée après reprise", t2.finished, true);

    eq("10 envois au total", sent.length, 10);
    eq("aucun doublon", new Set(sent).size, 10);
    eq("aucun oublié", [...sent].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    eq("compteurs finaux", getCounts(bc.id!, db), { pending: 0, sent: 10, blocked: 0, failed: 0 });
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n403 — bloqué définitivement, sorti des envois FUTURS");
  {
    const db = freshDb();
    addLead(db, { tg: 1 });
    addLead(db, { tg: 2 });
    addLead(db, { tg: 3 });
    const bc = createBroadcast(draft(), db);
    startBroadcast(bc.id!, db);

    const res = await runBroadcastDrain({
      spacing: 0,
      sendFn: async (chatId) => chatId === 2
        ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }
        : { ok: true, result: { message_id: 1 } },
    }, db);

    eq("2 envoyés", res.sent, 2);
    eq("1 bloqué", res.blocked, 1);
    eq("diffusion terminée quand même", res.finished, true);
    eq("le lead est marqué bloqué en base",
      (db.prepare(`SELECT blocked FROM dzpk_leads WHERE telegram_id = 2`).get() as any).blocked, 1);

    // LA propriété qui compte : il sort des segments suivants, sans rien à faire.
    eq("segment suivant : 2 destinataires", countSegment(SEG_ALL, db), 2);
    const suivant = createBroadcast({ ...draft(), title: "promo 2" }, db);
    eq("la diffusion suivante ne le vise plus", suivant.total, 2);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n429 — la limitation NE consomme PAS de destinataire");
  {
    const db = freshDb();
    for (let i = 1; i <= 5; i++) addLead(db, { tg: i });
    const bc = createBroadcast(draft(), db);
    startBroadcast(bc.id!, db);

    let appels = 0;
    const t1 = await runBroadcastDrain({
      spacing: 0,
      sendFn: async () => {
        appels++;
        // Le 3e appel se heurte au rate limit, budget de tgRetrying épuisé.
        if (appels === 3) return { ok: false, error_code: 429, description: "Too Many Requests" };
        return { ok: true, result: { message_id: 1 } };
      },
    }, db);

    eq("2 partis avant la limitation", t1.sent, 2);
    eq("le drain rend la main", t1.finished, false);
    eq("3 encore en attente", t1.deferred, 3);
    eq("aucun échec compté", t1.failed, 0);
    eq("le destinataire limité reste pending", getCounts(bc.id!, db).pending, 3);
    eq("sa tentative a été rembobinée",
      (db.prepare(`SELECT attempts FROM dzpk_broadcast_targets WHERE telegram_id = 3`).get() as any).attempts, 0);

    // Le tick suivant reprend, y compris celui qui avait été limité.
    const sent: number[] = [];
    const t2 = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("les 3 restants partent", t2.sent, 3);
    eq("dont le limité", sent.includes(3), true);
    eq("terminée", t2.finished, true);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nerreur de FORME — pause immédiate, la liste n'est pas brûlée");
  {
    const db = freshDb();
    for (let i = 1; i <= 50; i++) addLead(db, { tg: i });
    const bc = createBroadcast(draft(), db);
    startBroadcast(bc.id!, db);

    let appels = 0;
    const res = await runBroadcastDrain({
      spacing: 0,
      sendFn: async () => {
        appels++;
        return { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" };
      },
    }, db);

    // LE point : un seul appel, pas cinquante. Sans cette garde, la même erreur
    // de HTML partirait 50 fois et remplirait le compteur d'erreurs du bot.
    eq("un SEUL appel avant la pause", appels, 1);
    eq("aucun envoi", res.sent, 0);
    eq("aucun échec imputé aux destinataires", res.failed, 0);
    eq("diffusion en pause", getBroadcast(bc.id!, db)!.status, "paused");
    eq("motif conservé", getBroadcast(bc.id!, db)!.last_error?.includes("unclosed tag"), true);
    eq("les 50 restent en attente", getCounts(bc.id!, db).pending, 50);
    eq("la tentative du premier est rembobinée",
      (db.prepare(`SELECT attempts FROM dzpk_broadcast_targets WHERE telegram_id = 1`).get() as any).attempts, 0);

    // Une diffusion en pause n'envoie plus rien tant qu'on ne la relance pas.
    const apres = await runBroadcastDrain({ spacing: 0, sendFn: okSender([]) }, db);
    eq("le drain ignore une diffusion en pause", apres.broadcastId, null);

    // Après correction, la reprise repart sur les 50 intacts.
    eq("reprise acceptée", startBroadcast(bc.id!, db).ok, true);
    const sent: number[] = [];
    const t2 = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("les 50 partent après correction", t2.sent, 50);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\néchec ordinaire — réessayé, puis abandonné, jamais en boucle");
  {
    const db = freshDb();
    addLead(db, { tg: 1 });
    const bc = createBroadcast(draft(), db);
    startBroadcast(bc.id!, db);

    const echec = async () => ({ ok: false, error_code: 500, description: "Internal Server Error" });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = await runBroadcastDrain({ spacing: 0, sendFn: echec }, db);
      eq(`tentative ${i} : pas encore en échec`, r.failed, 0);
      eq(`tentative ${i} : toujours en attente`, getCounts(bc.id!, db).pending, 1);
    }
    const dernier = await runBroadcastDrain({ spacing: 0, sendFn: echec }, db);
    eq(`abandon après ${MAX_ATTEMPTS} tentatives`, dernier.failed, 1);
    eq("plus rien en attente", getCounts(bc.id!, db).pending, 0);
    eq("diffusion terminée", getBroadcast(bc.id!, db)!.status, "done");
    eq("motif conservé",
      (db.prepare(`SELECT error FROM dzpk_broadcast_targets WHERE telegram_id = 1`).get() as any).error,
      "Internal Server Error");
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nune seule diffusion à la fois");
  {
    const db = freshDb();
    addLead(db, { tg: 1 });
    const a = createBroadcast({ ...draft(), title: "A" }, db);
    const b = createBroadcast({ ...draft(), title: "B" }, db);
    eq("A démarre", startBroadcast(a.id!, db).ok, true);
    const refus = startBroadcast(b.id!, db);
    eq("B refusée pendant A", refus.ok, false);
    eq("motif explicite", refus.error?.includes("déjà en cours"), true);

    // Le drain ne sert que A, même si B existe.
    const sent: number[] = [];
    const res = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("le drain sert A", res.broadcastId, a.id);
    eq("B intacte", getCounts(b.id!, db).pending, 1);
    eq("B démarre une fois A finie", startBroadcast(b.id!, db).ok, true);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\npause et annulation manuelles");
  {
    const db = freshDb();
    for (let i = 1; i <= 6; i++) addLead(db, { tg: i });
    const bc = createBroadcast(draft(), db);
    startBroadcast(bc.id!, db);
    const sent: number[] = [];
    await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0, max: 2 }, db);

    eq("pause acceptée", pauseBroadcast(bc.id!, "test", db).ok, true);
    const apres = await runBroadcastDrain({ sendFn: okSender(sent), spacing: 0 }, db);
    eq("le drain ne sert plus rien", apres.broadcastId, null);
    eq("aucun envoi supplémentaire", sent.length, 2);

    eq("annulation acceptée", cancelBroadcast(bc.id!, db).ok, true);
    eq("statut annulée", getBroadcast(bc.id!, db)!.status, "cancelled");
    // Ce qui est parti reste parti : une annulation n'efface pas ce qui est
    // arrivé chez les gens.
    eq("les 2 envoyés restent comptés", getCounts(bc.id!, db).sent, 2);
    eq("relance refusée", startBroadcast(bc.id!, db).ok, false);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\ngarde-fou anti-spam — mesure ce que les leads REÇOIVENT");
  {
    const db = freshDb();
    for (let i = 1; i <= 4; i++) addLead(db, { tg: i });

    const vide = getGuard(db);
    eq("aucune diffusion : rien à signaler", vide.last, null);
    eq("aucun message sur 24 h", vide.sentLast24h, 0);
    eq("aucune heure écoulée", vide.hoursSince, null);

    const bc = createBroadcast({ ...draft(), title: "promo août" }, db);
    startBroadcast(bc.id!, db);
    await runBroadcastDrain({ sendFn: okSender([]), spacing: 0 }, db);

    const g = getGuard(db);
    eq("dernière diffusion nommée", g.last?.title, "promo août");
    eq("volume réellement envoyé", g.last?.sent, 4);
    eq("compté sur 24 h", g.sentLast24h, 4);
    eq("compté sur 7 j", g.sentLast7d, 4);
    eq("une seule diffusion cette semaine", g.broadcastsLast7d, 1);
    eq("écoulé depuis peu", g.hoursSince, 0);

    // Un brouillon jamais envoyé ne doit RIEN peser : le garde-fou mesure les
    // messages reçus, pas les formulaires ouverts.
    createBroadcast({ ...draft(), title: "brouillon jamais parti" }, db);
    const g2 = getGuard(db);
    eq("un brouillon ne compte pas", g2.sentLast24h, 4);
    eq("ni dans le nombre de diffusions", g2.broadcastsLast7d, 1);
    eq("ni comme dernière diffusion", g2.last?.title, "promo août");

    eq("l'historique liste les deux", listBroadcasts(20, db).length, 2);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nresolveSegment — ordre stable, identité correcte");
  {
    const db = freshDb();
    const idA = addLead(db, { tg: 777, source: "tgads" });
    const idB = addLead(db, { tg: 888, source: "richads_2" });
    const rows = resolveSegment(SEG_ALL, db);
    eq("deux destinataires", rows.length, 2);
    eq("lead_id et telegram_id appariés", rows, [
      { lead_id: idA, telegram_id: 777 },
      { lead_id: idB, telegram_id: 888 },
    ]);
    eq("segment invalide ⇒ liste vide, pas d'exception",
      resolveSegment({ sources: null, stages: [] }, db).length, 0);
    db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\ntelegram_id FIGÉ sur la cible — l'audit survit à un changement de compte");
  {
    const db = freshDb();
    const id = addLead(db, { tg: 111 });
    const bc = createBroadcast(draft(), db);
    db.prepare(`UPDATE dzpk_leads SET telegram_id = 999 WHERE id = ?`).run(id);

    const cible = db.prepare(
      `SELECT telegram_id FROM dzpk_broadcast_targets WHERE broadcast_id = ?`
    ).get(bc.id!) as any;
    eq("la cible garde le compte visé à la création", cible.telegram_id, 111);
    db.close();
  }

  console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
  if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }

})();
