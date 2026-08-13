// Postbacks S2S de conversion : « ce lead a rejoint le club » → réseau de pub.
//
// ┌─ CE QUE FAIT CE MODULE, ET POURQUOI IL EST FRAGILE PAR NATURE ─────────────┐
// │ Un postback est un GET vers Propeller ou RichAds portant le click id du    │
// │ lead. C'est ce qui permet au réseau d'apprendre quelles créatives          │
// │ convertissent, donc d'optimiser les enchères sur notre budget.             │
// │                                                                            │
// │ Deux modes d'échec, très inégaux :                                         │
// │  • postback MANQUANT — le réseau optimise à l'aveugle. Coûteux, mais       │
// │    visible : `postback_result` et les logs le disent.                      │
// │  • postback en DOUBLE — le réseau compte deux conversions pour un joueur.  │
// │    Invisible de notre côté, et il fausse le seul chiffre sur lequel on     │
// │    décide d'acheter plus ou moins de trafic.                               │
// │                                                                            │
// │ Tout le module est réglé sur cette asymétrie : on préfère ne pas envoyer   │
// │ plutôt qu'envoyer deux fois. D'où le verrou posé AVANT l'appel réseau, et  │
// │ l'absence de réessai automatique.                                          │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Ce module n'écrit QUE `dzpk_leads.postback_sent_at` et `postback_result`. Il
// ne touche à aucune table d'argent, ne lit aucune table NEXA, et ne modifie
// jamais une date de funnel : un postback est une notification sortante, pas un
// fait du domaine.

import { getDb } from "@/lib/db";
import { DZPK_MIGRATION_POSTBACK_V1 } from "./schema";
import type { DbLike } from "./leads";

/** Les deux réseaux achetés. La source du lead décide lequel. */
export type PostbackNetwork = "propeller" | "richads";

/**
 * Délai maximal d'un appel de postback.
 *
 * 5 secondes parce que ce n'est pas un appel dont dépend quoi que ce soit :
 * personne n'attend sa réponse, et un endpoint réseau qui traîne ne doit pas
 * retenir la passe de matching qui l'a déclenché.
 */
export const POSTBACK_TIMEOUT_MS = 5_000;

/** Marqueur remplacé par le click id dans les URL de postback. */
export const CB_PLACEHOLDER = "{CB}";

/**
 * Réseau à créditer, déduit de la source first-touch du lead.
 *
 * Les deux formes du préfixe sont acceptées — `tgads-26845722` (tel que la
 * créative est nommée côté réseau) et `tgads_26845722` (tel que /go le convertit
 * pour le start param Telegram). Ne reconnaître que la seconde ferait taire les
 * postbacks de tout lead entré par un lien écrit à la main, sans erreur nulle
 * part.
 *
 * Tout le reste — `organic`, `direct`, achat direct, source inconnue — rend
 * `null` : pas de réseau, donc pas de postback. Ce n'est PAS une anomalie, c'est
 * le cas nominal du trafic non acheté.
 */
export function resolveNetwork(source: string | null | undefined): PostbackNetwork | null {
  const s = (source ?? "").trim().toLowerCase();
  if (s.startsWith("tgads-") || s.startsWith("tgads_")) return "propeller";
  if (s.startsWith("richads-") || s.startsWith("richads_")) return "richads";
  return null;
}

/**
 * Gabarit d'URL du réseau. Lu à CHAQUE appel, jamais mis en cache dans le
 * module : Railway peut changer une variable sans redéploiement, et un cache
 * figerait la valeur du boot (même parti pris que config.ts).
 */
export function postbackTemplate(network: PostbackNetwork): string | null {
  const raw = network === "propeller"
    ? process.env.PROPELLER_POSTBACK_URL
    : process.env.RICHADS_POSTBACK_URL;
  const t = raw?.trim();
  return t ? t : null;
}

/**
 * Substitue le click id dans le gabarit.
 *
 * `encodeURIComponent` bien que le charset des click ids soit déjà sûr : la
 * substitution est le seul endroit où une donnée externe entre dans une URL, et
 * cette garantie ne doit pas dépendre d'un contrôle fait ailleurs.
 *
 * Un gabarit sans `{CB}` rend `null` plutôt qu'une URL muette : poster sur une
 * URL sans click id, c'est déclarer une conversion anonyme — le réseau répond
 * 200 et ne crédite rien. Le silence serait pris pour un succès.
 */
export function buildPostbackUrl(template: string, clickId: string): string | null {
  if (!template.includes(CB_PLACEHOLDER)) return null;
  return template.split(CB_PLACEHOLDER).join(encodeURIComponent(clickId));
}

/** URL réduite à son hôte + chemin — les logs ne doivent pas cracher un click id complet. */
function briefUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "url illisible";
  }
}

export type PostbackSkip =
  | "no_click_id"       // lead non attribuable : arrivé sans click id
  | "no_network"        // organic, achat direct, source inconnue
  | "no_url"            // variable d'env absente
  | "bad_template"      // gabarit sans {CB}
  | "already_sent"      // verrou déjà posé : un postback est déjà parti
  | "lead_not_found";

export interface PostbackOutcome {
  sent: boolean;
  skipped: PostbackSkip | null;
  network: PostbackNetwork | null;
  /** Statut HTTP obtenu, ou null si l'appel n'a pas abouti. */
  status: number | null;
  /** Message d'erreur réseau, le cas échéant. */
  error: string | null;
}

/** Ce qui compte pour décider d'un postback. Découplé de DzpkLead pour rester testable. */
interface PostbackSubject {
  id: number;
  source: string;
  click_id: string | null;
  postback_sent_at: string | null;
}

/**
 * Injection du client HTTP, pour que les tests couvrent la décision ET l'appel
 * sans toucher au réseau. `fetch` par défaut en production.
 */
export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Envoie le postback de conversion d'un lead. Idempotent, ne lève jamais.
 *
 * ORDRE DES OPÉRATIONS, qui est tout l'intérêt de la fonction :
 *   1. relecture du lead (l'appelant peut avoir une copie périmée) ;
 *   2. décisions locales — click id, réseau, URL — aucune écriture ;
 *   3. VERROU : `UPDATE … WHERE postback_sent_at IS NULL`. Si `changes = 0`,
 *      un autre chemin est déjà passé, on s'arrête là ;
 *   4. appel réseau, borné à 5 s ;
 *   5. résultat écrit dans `postback_result`, pour diagnostic seul.
 *
 * Le verrou avant l'appel est ce qui rend le double-envoi impossible, y compris
 * si deux passes du cron tombaient sur le même join à la même seconde. Il rend
 * aussi un échec définitif : voir `retryPostback` pour le rejeu explicite.
 */
export async function sendConversionPostback(
  leadId: number,
  opts: { dbOverride?: DbLike; fetcher?: Fetcher } = {},
): Promise<PostbackOutcome> {
  const db = opts.dbOverride ?? getDb();
  const nothing = (skipped: PostbackSkip, network: PostbackNetwork | null = null): PostbackOutcome =>
    ({ sent: false, skipped, network, status: null, error: null });

  // Lecture sous garde : si la migration n'a pas encore été jouée (échec au
  // boot, rejeu prévu au suivant), les colonnes n'existent pas. Un join ne doit
  // pas se mettre à lever pour autant — il est déjà crédité, c'est l'essentiel.
  let lead: PostbackSubject | undefined;
  try {
    lead = db.prepare(
      `SELECT id, source, click_id, postback_sent_at FROM dzpk_leads WHERE id = ?`
    ).get(leadId) as PostbackSubject | undefined;
  } catch (e: any) {
    console.error(
      `[DZPK POSTBACK] lead=${leadId} — lecture impossible (migration ${DZPK_MIGRATION_POSTBACK_V1} jouée ?):`,
      e?.message ?? e
    );
    return nothing("lead_not_found");
  }
  if (!lead) return nothing("lead_not_found");

  // Les trois refus silencieux et normaux, dans l'ordre du moins au plus
  // spécifique. Aucun n'est loggué : ils concernent la majorité des leads
  // (organiques, ou entrés avant la mise en service) et noieraient les vrais.
  if (lead.postback_sent_at) return nothing("already_sent");
  if (!lead.click_id) return nothing("no_click_id");
  const network = resolveNetwork(lead.source);
  if (!network) return nothing("no_network");

  // Celui-ci, en revanche, est une ANOMALIE DE CONFIGURATION : le lead vient
  // d'un réseau payant et on ne sait pas où poster. Il doit crier.
  const template = postbackTemplate(network);
  if (!template) {
    console.error(
      `[DZPK POSTBACK] lead=${lead.id} réseau=${network} — ` +
      `${network === "propeller" ? "PROPELLER_POSTBACK_URL" : "RICHADS_POSTBACK_URL"} absente, conversion NON remontée`
    );
    return nothing("no_url", network);
  }
  const url = buildPostbackUrl(template, lead.click_id);
  if (!url) {
    console.error(
      `[DZPK POSTBACK] lead=${lead.id} réseau=${network} — gabarit sans ${CB_PLACEHOLDER}, ` +
      `postback annulé (une URL sans click id ne crédite rien)`
    );
    return nothing("bad_template", network);
  }

  // ── Verrou ────────────────────────────────────────────────────────────────
  // Conditionnel : c'est la base qui arbitre, pas la lecture faite plus haut.
  // Entre le SELECT et ici, une autre passe a pu poster.
  const claimed = db.prepare(
    `UPDATE dzpk_leads
        SET postback_sent_at = datetime('now'), postback_result = 'en cours',
            updated_at = datetime('now')
      WHERE id = ? AND postback_sent_at IS NULL`
  ).run(lead.id);
  if (claimed.changes === 0) return nothing("already_sent", network);

  const doFetch: Fetcher = opts.fetcher ?? ((u, init) => fetch(u, { method: "GET", ...init }));
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(POSTBACK_TIMEOUT_MS) });
    status = res.status;
  } catch (e: any) {
    // Un postback qui échoue ne doit RIEN casser en amont : le join est déjà
    // acquis, le lead est crédité, seule la remontée au réseau manque.
    error = e?.name === "TimeoutError" || e?.name === "AbortError"
      ? `timeout ${POSTBACK_TIMEOUT_MS} ms`
      : (e?.message ?? String(e));
  }

  const result = error ? `${network} échec: ${error}` : `${network} ${status}`;
  try {
    db.prepare(`UPDATE dzpk_leads SET postback_result = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(result.slice(0, 200), lead.id);
  } catch (e: any) {
    console.error(`[DZPK POSTBACK] lead=${lead.id} — écriture du résultat impossible:`, e?.message ?? e);
  }

  // Ligne de log VOULUE bavarde : c'est elle qu'on lit dans Railway pour
  // vérifier la chaîne, et elle doit répondre seule aux trois questions —
  // quel lead, quel réseau, qu'a répondu le serveur.
  const ok = status !== null && status >= 200 && status < 400;
  const line =
    `[DZPK POSTBACK] lead=${lead.id} réseau=${network} cb=${lead.click_id} ` +
    `url=${briefUrl(url)} ${error ? `ERREUR ${error}` : `http=${status}`}`;
  if (ok) console.log(`${line} ✅`);
  else console.error(`${line} ❌ (verrou posé : aucun rejeu automatique)`);

  return { sent: true, skipped: null, network, status, error };
}

/**
 * Déclenchement depuis le chemin d'un join : on n'attend PAS la réponse.
 *
 * Le postback ne doit rien retenir — ni la passe de matching, ni la requête
 * HTTP d'une réconciliation manuelle. La promesse est volontairement orpheline,
 * avec un `catch` qui ne peut donc rien remonter à personne : c'est pour ça que
 * `sendConversionPostback` loggue elle-même tout ce qui compte.
 */
export function fireConversionPostback(leadId: number, dbOverride?: DbLike): void {
  void sendConversionPostback(leadId, { dbOverride }).catch(e => {
    console.error(`[DZPK POSTBACK] lead=${leadId} — exception non rattrapée:`, e?.message ?? e);
  });
}

/**
 * Rejeu EXPLICITE d'un postback, réservé à l'humain (route d'admin).
 *
 * Lève le verrou puis renvoie dans le chemin normal. Volontairement absent de
 * tout automatisme : un rejeu automatique après échec est exactement ce qui
 * produit des conversions en double quand l'échec était en fait un succès mal
 * accusé (timeout côté client, requête traitée côté serveur).
 */
export async function retryPostback(
  leadId: number,
  opts: { dbOverride?: DbLike; fetcher?: Fetcher } = {},
): Promise<PostbackOutcome> {
  const db = opts.dbOverride ?? getDb();
  db.prepare(
    `UPDATE dzpk_leads SET postback_sent_at = NULL, postback_result = NULL WHERE id = ?`
  ).run(leadId);
  console.warn(`[DZPK POSTBACK] lead=${leadId} — verrou levé à la main, rejeu demandé`);
  return sendConversionPostback(leadId, opts);
}

/**
 * Envoi de VALIDATION, avec un click id fourni à la main.
 *
 * Sert à valider la chaîne avec l'outil « Test conversion » de PropellerAds sans
 * attendre un vrai join. Ne lit ni n'écrit aucun lead — c'est ce qui la rend
 * sûre : elle ne peut pas consommer le verrou d'un lead réel, ni marquer comme
 * envoyée une conversion qui ne s'est pas produite.
 */
export async function sendTestPostback(
  network: PostbackNetwork,
  clickId: string,
  fetcher?: Fetcher,
): Promise<{ ok: boolean; url: string | null; status: number | null; error: string | null }> {
  const template = postbackTemplate(network);
  if (!template) {
    return { ok: false, url: null, status: null, error: `URL de postback ${network} absente (variable Railway)` };
  }
  const url = buildPostbackUrl(template, clickId);
  if (!url) {
    return { ok: false, url: null, status: null, error: `gabarit ${network} sans ${CB_PLACEHOLDER}` };
  }

  const doFetch: Fetcher = fetcher ?? ((u, init) => fetch(u, { method: "GET", ...init }));
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(POSTBACK_TIMEOUT_MS) });
    const ok = res.status >= 200 && res.status < 400;
    console.log(`[DZPK POSTBACK TEST] réseau=${network} cb=${clickId} url=${briefUrl(url)} http=${res.status} ${ok ? "✅" : "❌"}`);
    return { ok, url, status: res.status, error: null };
  } catch (e: any) {
    const error = e?.name === "TimeoutError" || e?.name === "AbortError"
      ? `timeout ${POSTBACK_TIMEOUT_MS} ms`
      : (e?.message ?? String(e));
    console.error(`[DZPK POSTBACK TEST] réseau=${network} cb=${clickId} url=${briefUrl(url)} ERREUR ${error}`);
    return { ok: false, url, status: null, error };
  }
}
