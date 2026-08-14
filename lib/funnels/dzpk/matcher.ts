// Appariement nom-de-club ↔ lead dzpk.
//
// ┌─ CE QUI REND L'APPARIEMENT POSSIBLE ───────────────────────────────────────┐
// │ Le club reprend AUTOMATIQUEMENT le nom du compte Telegram du joueur quand   │
// │ il rejoint : le joueur ne saisit aucun pseudo. Le nom d'une notification    │
// │ « 已绑定为代理 [nom] » est donc le display_name capturé au /start. L'exact   │
// │ normalisé doit couvrir la grande majorité des cas — le reste (renommage,    │
// │ homonymes) part en réconciliation manuelle.                                 │
// │                                                                             │
// │ AUCUN appariement approximatif. Pas de distance d'édition, pas de           │
// │ sous-chaîne, pas de prénom seul. Un rattachement faux déplace du revenu     │
// │ d'une source vers une autre, et rien ne le signale ensuite.                 │
// └─────────────────────────────────────────────────────────────────────────────┘

import { getDb } from "@/lib/db";
import { nameKey } from "./name-key";
import { dzpkAutoMatchEnabled } from "./config";
import { fireConversionPostback, fireJoinPostback } from "./postback";
import type { DbLike } from "./leads";

export type MatchStatus = "auto" | "manual" | "ambiguous" | "unmatched";
// `display_name_dated` n'est plus jamais PRODUIT : le départage d'homonymes par
// écart de date a été retiré (arbitrage Baki du 2026-08-12). La valeur reste dans
// le type pour que d'éventuelles lignes historiques restent lisibles.
export type MatchMethod = "link" | "display_name" | "display_name_dated";

/**
 * Fenêtre de cohérence temporelle d'un match CERTAIN, en jours.
 *
 * Un lead qui a fait `/start` il y a six mois et un nom identique aujourd'hui,
 * ce n'est plus une identité : c'est une coïncidence plausible. Au-delà de cette
 * fenêtre, le rattachement part en réconciliation même quand le nom est unique.
 *
 * Le prix est assumé et connu : un joueur qui découvre le bot puis ne joue que
 * des semaines plus tard demandera un clic. Sur du revenu, un pointage manuel
 * coûte moins cher qu'un crédit attribué à la mauvaise source de pub.
 */
export const CERTAIN_WINDOW_DAYS = 30;

export interface LeadCandidate {
  id: number;
  telegram_id: number;
  display_name: string | null;
  username: string | null;
  source: string;
  started_at: string;
  /** Heures écoulées entre le /start et la notification. Négatif = /start postérieur. */
  hours_before: number | null;
}

export interface MatchResolution {
  status: MatchStatus;
  method: MatchMethod | null;
  leadId: number | null;
  candidates: LeadCandidate[];
  /** Explication courte, affichée dans l'écran de réconciliation. */
  note: string;
}

function hoursBetween(startedAt: string | null, postedAt: string | null): number | null {
  if (!startedAt || !postedAt) return null;
  const a = Date.parse(startedAt.replace(" ", "T") + "Z");
  const b = Date.parse(postedAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3600_000;
}

/**
 * Ajoute le lead ciblé par un lien à la liste des candidats, s'il n'y est pas.
 *
 * La cible d'un lien n'est PAS forcément porteuse du nom : c'est même tout
 * l'intérêt du lien dans le cas du lead renommé. Sans cet ajout, un refus de la
 * branche lien renvoyait l'opérateur vers une recherche par nom… qui ne trouve
 * rien, puisque plus aucun lead ne s'appelle ainsi.
 */
function withLinkTarget(
  db: DbLike, candidates: LeadCandidate[], leadId: number, postedAt: string | null,
): LeadCandidate[] {
  if (candidates.some(c => c.id === leadId)) return candidates;
  const t = db.prepare(
    `SELECT id, telegram_id, display_name, username, source, started_at
       FROM dzpk_leads WHERE id = ?`
  ).get(leadId) as Omit<LeadCandidate, "hours_before"> | undefined;
  if (!t) return candidates;
  return [...candidates, { ...t, hours_before: hoursBetween(t.started_at, postedAt) }];
}

/**
 * Décide — sans rien écrire.
 *
 * Séparé de l'application pour que la règle soit testable seule, et pour
 * pouvoir afficher le taux d'auto-appariement qu'on OBTIENDRAIT avant de
 * l'activer.
 */
export function resolveMatch(
  clubNameKey: string,
  postedAt: string | null,
  dbOverride?: DbLike,
): MatchResolution {
  const db = dbOverride ?? getDb();
  const key = nameKey(clubNameKey);
  // Nom illisible après normalisation — typiquement un pseudo entièrement
  // composé d'emoji (« 🐉🐉 »), cas cité comme nominal dans name-key.ts. Le
  // message est parfaitement parsé, son nom brut est stocké : il n'a simplement
  // aucune clé d'appariement. Il doit donc REMONTER dans la file pour être
  // rattaché à la main depuis son texte brut — jamais disparaître.
  // (audit du 2026-08-12, R9)
  if (!key) {
    return {
      status: "unmatched", method: null, leadId: null, candidates: [],
      note: "nom illisible après normalisation (emoji seuls ?) — rattacher depuis le message brut",
    };
  }

  // Les candidats sont calculés AVANT toute décision, et joints à CHAQUE retour.
  //
  // Ils vivaient après la branche « lien », qui rendait donc des listes vides :
  // l'écran de réconciliation ne proposait aucun raccourci alors que le candidat
  // était évident, et le funnel comptait l'item comme « orphelin » — une
  // notification ne citant aucun lead — ce qui était faux.
  // (audit money du 2026-08-12, F2 — régression introduite par les gardes de la
  // branche lien, corrigée ici)
  const rows = db.prepare(
    `SELECT id, telegram_id, display_name, username, source, started_at
       FROM dzpk_leads WHERE display_name_key = ? ORDER BY started_at`
  ).all(key) as Array<Omit<LeadCandidate, "hours_before">>;
  const candidates: LeadCandidate[] = rows.map(r => ({ ...r, hours_before: hoursBetween(r.started_at, postedAt) }));

  // 1. Lien appris.
  //
  // Le nombre d'homonymes est relu À CHAQUE LECTURE, pas seulement via le job
  // `flagContestedLinks`. Un lien créé quand le nom était unique devient faux dès
  // qu'un second lead apparaît, et le job périodique ne passe qu'ENTRE deux
  // passes : un lien né pendant une passe servait déjà, dans la même passe, à
  // absorber la notification suivante. (audit money du 2026-08-12, MA2)
  //
  // Un lien d'origine `manual` reste souverain : un humain l'a tranché en
  // connaissance de cause, l'homonymie ne le remet pas en question.
  const link = db.prepare(
    `SELECT l.lead_id, l.contested, l.origin,
            -- Combien de leads portent ce nom SANS être la cible du lien.
            -- Compter les porteurs ne suffisait pas : « un seul porteur » est vrai
            -- aussi quand ce porteur n'est PAS celui vers qui le lien pointe.
            (SELECT COUNT(*) FROM dzpk_leads d
              WHERE d.display_name_key = l.name_key AND d.id != l.lead_id) AS autres_porteurs,
            (SELECT d.started_at FROM dzpk_leads d WHERE d.id = l.lead_id) AS lead_started_at
       FROM dzpk_name_links l WHERE l.name_key = ?`
  ).get(key) as
    { lead_id: number; contested: number; origin: string; autres_porteurs: number; lead_started_at: string | null } | undefined;

  // Le contrôle d'homonymie s'applique aux DEUX origines, manuelle comprise.
  //
  // Laisser un lien `manual` souverain paraissait légitime — un humain a tranché.
  // Mais couplé à la reprise des `ambiguous`, ça transformait une décision prise
  // sur UN MESSAGE en décision implicite sur LE NOM : deux joueurs réellement
  // distincts nommés « mark », Baki tranche la première notification, et la
  // seconde — plausiblement celle de l'autre — était absorbée sans décision, en
  // quittant la file de réconciliation. Silencieux, et donc pire que l'ambiguïté
  // qu'on cherchait à lever. (audit money du 2026-08-12, R2)
  //
  // Le prix assumé : sur un nom réellement porté par deux leads, chaque
  // notification demande un clic. C'est le bon prix — ce sont deux personnes.
  //
  // ⚠️ Le critère est « AUCUN AUTRE lead ne porte ce nom », pas « un seul lead
  // le porte ». La nuance est tout sauf théorique :
  //
  //   Lead 1 « Ancien Pseudo » se renomme « Twin » sur Telegram.
  //   Lead 2 s'appelle vraiment « Twin ».
  //   Une notif « Twin » part en auto sur le lead 2 ; Baki corrige vers le lead 1.
  //   → lien manuel 'twin' → lead 1, avec UN SEUL porteur de la clé (lead 2).
  //   Quand le VRAI Twin (lead 2) est ensuite rattaché par le club, sa
  //   notification est créditée au lead 1, sans passer par la réconciliation.
  //
  // Le crédit change de source de pub, en silence, et rien ne le signale.
  // (audit money du 2026-08-12, F1)
  const linkUsable = link && !link.contested && link.autres_porteurs === 0;
  if (linkUsable) {
    // ⚠️ La branche « lien » subit les MÊMES gardes que le chemin nominal.
    //
    // Elle retournait ici directement, sautant le contrôle de date et celui de
    // causalité. Deux conséquences mesurées (audit du 2026-08-12, R6/R7) :
    //
    //   • Notification sans date ⇒ match `applied = 1` mais AUCUN crédit posé
    //     (les colonnes du lead dérivent de MIN(posted_at), qui ignore les NULL).
    //     L'item quittait la file, `checkMatchCoherence` ne le voyait pas non
    //     plus : un rattachement s'évaporait sans le moindre symptôme.
    //   • Notification antérieure au /start du lead ⇒ `bound_at < started_at`,
    //     un joueur rattaché avant d'avoir parlé au bot. Et comme l'effet prend
    //     le MIN, la date fausse GAGNE sur la vraie.
    //
    // Un lien appris dit « qui », il ne dit rien sur « quand ».
    if (!postedAt) {
      return {
        status: "ambiguous", method: null, leadId: null,
        candidates: withLinkTarget(db, candidates, link!.lead_id, postedAt),
        note: "lien mémorisé, mais notification sans date — rien à porter sur le lead",
      };
    }
    const h = hoursBetween(link!.lead_started_at, postedAt);
    // `h` nul = date du lead illisible ou absente (lead supprimé avec son lien
    // survivant, `foreign_keys` désactivé le temps d'une migration). Sans ce
    // refus, `?? 0` plus bas traitait « inconnu » comme « conforme » : causalité
    // ET fenêtre sautées d'un coup, match appliqué vers un lead fantôme, invisible
    // partout sauf dans checkMatchCoherence. « Inconnu » n'est pas « conforme ».
    if (h === null) {
      return {
        status: "ambiguous", method: null, leadId: null,
        candidates: withLinkTarget(db, candidates, link!.lead_id, postedAt),
        note: "lien mémorisé, mais la date de /start du lead cible est illisible",
      };
    }
    if (h < 0) {
      return {
        status: "ambiguous", method: null, leadId: null,
        candidates: withLinkTarget(db, candidates, link!.lead_id, postedAt),
        note: `lien mémorisé, mais la notification précède le /start du lead de ${Math.abs(Math.round(h))} h`,
      };
    }
    // ⚠️ La fenêtre de certitude s'applique AUSSI au lien.
    //
    // Le lien garantit « aucun AUTRE LEAD ne porte ce nom ». Il ne dit rien des
    // gens qui ne sont pas leads : le lien d'invitation du club est unique et
    // partagé, donc n'importe qui peut rejoindre sans jamais faire /start.
    //
    // Scénario mesuré (audit du 2026-08-12, F2) : « bob » (tgads) rattaché en
    // janvier ⇒ lien appris. En août, un AUTRE bob entre par le lien du club
    // sans passer par le bot. Sa notification créditait tgads, et
    // checkMatchCoherence affichait collisions: 0 — le seul détecteur du repo
    // ne voyait rien.
    //
    // Conséquence assumée : au-delà de la fenêtre, un lead ancien repasse par
    // une confirmation humaine à chaque notification. Le self-learning perd en
    // portée, et c'est le prix d'un crédit qui ne part pas sur la mauvaise source.
    const days = h / 24;
    if (days > CERTAIN_WINDOW_DAYS) {
      return {
        status: "ambiguous", method: null, leadId: null,
        candidates: withLinkTarget(db, candidates, link!.lead_id, postedAt),
        note: `lien mémorisé, mais /start vieux de ${Math.round(days)} jours (> ${CERTAIN_WINDOW_DAYS}) — un homonyme non-lead est possible`,
      };
    }
    return { status: "auto", method: "link", leadId: link!.lead_id, candidates: [], note: "lien mémorisé" };
  }

  if (link && !linkUsable) {
    return {
      status: "ambiguous", method: null, leadId: null,
      candidates: withLinkTarget(db, candidates, link.lead_id, postedAt),
      note: link.contested
        ? "lien mémorisé marqué contesté"
        : `lien ${link.origin} vers le lead ${link.lead_id}, mais ${link.autres_porteurs} autre(s) lead(s) portent ce nom — décision humaine requise`,
    };
  }
  if (candidates.length === 0) {
    return { status: "unmatched", method: null, leadId: null, candidates: [], note: "aucun lead ne porte ce nom" };
  }

  // Message sans date : la causalité est INVÉRIFIABLE, pas violée. Sans ce cas
  // distinct, le motif affiché aurait été « son /start est POSTÉRIEUR », ce qui
  // est faux et enverrait chercher au mauvais endroit.
  if (!postedAt) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: "notification sans date — antériorité du /start invérifiable",
    };
  }

  // 3. CAUSALITÉ — appliquée à TOUS les candidats, y compris quand il n'y en a
  //    qu'un seul.
  //
  // On ne peut pas être rattaché au club avant d'avoir parlé au bot. Le lien
  // d'invitation du club est unique et partagé : un joueur peut donc rejoindre
  // sans jamais faire /start, et un homonyme arrivé plus tard récupérerait son
  // crédit. Ne filtrer que la branche « homonymes » laissait passer le cas le
  // plus courant — un candidat unique postérieur à la notification, crédité
  // d'un rattachement survenu avant son propre /start.
  // (audit money du 2026-08-12, MA3)
  const prior = candidates.filter(c => c.hours_before !== null && c.hours_before >= 0);
  if (prior.length === 0) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: candidates.length === 1
        ? "seul candidat, mais son /start est POSTÉRIEUR à la notification"
        : "homonymes, tous postérieurs à la notification",
    };
  }
  // ── IDENTITÉ FORTE — trois conditions cumulatives, aucune n'est facultative.
  //
  // Un match n'est CERTAIN que si : le nom correspond exactement, un SEUL lead
  // porte ce nom, et son /start est antérieur ET récent. Tout le reste part à
  // l'humain. (arbitrage Baki du 2026-08-12)
  //
  // Ce qui a été RETIRÉ ici : le départage d'homonymes par écart de date, qui
  // rattachait automatiquement dès 24 h d'écart. Il produisait un rattachement
  // indiscernable d'un match exact dans `bound_at`, sur la foi d'une heuristique.
  // Plusieurs candidats ⇒ jamais d'auto, quelle que soit la distance temporelle.
  if (candidates.length > 1) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: `${candidates.length} leads portent ce nom — départage humain obligatoire`,
    };
  }

  const only = prior[0];
  const days = only.hours_before! / 24;
  if (days > CERTAIN_WINDOW_DAYS) {
    return {
      status: "ambiguous", method: null, leadId: null, candidates,
      note: `nom unique, mais /start vieux de ${Math.round(days)} jours (> ${CERTAIN_WINDOW_DAYS}) — coïncidence possible`,
    };
  }

  return {
    status: "auto", method: "display_name", leadId: only.id, candidates,
    note: `nom unique, /start ${Math.round(only.hours_before!)} h avant la notification`,
  };
}

// ── Application ───────────────────────────────────────────

/**
 * Colonne du lead à horodater selon le gabarit.
 *
 * `Map` et non objet littéral : `EFFECT["constructor"]` sur un objet rend une
 * valeur héritée du prototype, truthy, qui franchirait un garde `if (!col)` et
 * finirait interpolée dans un `UPDATE dzpk_leads SET <col>`. Le filtre SQL en
 * amont rend le cas inatteignable aujourd'hui, mais la clôture doit être
 * structurelle, pas dépendante d'un autre garde.
 * (audit money du 2026-08-12, MA6)
 */
const EFFECT = new Map<string, string>([
  ["join", "club_joined_at"],
  ["bound", "bound_at"],
  ["banned", "banned_at"],
]);

/**
 * Recalcule l'horodatage d'un lead pour un gabarit, depuis les faits.
 *
 * Remplace un `COALESCE(col, ?)`, qui avait deux défauts :
 *   • « première date écrite » ≠ « date la plus ancienne » — vrai tant que les
 *     messages arrivent par id croissant, faux au premier rejeu d'historique ;
 *   • surtout, il rendait un crédit FAUX indélébile. Corriger à la main posait
 *     la date sur le bon lead sans jamais l'ôter du mauvais : une notification
 *     créditait alors DEUX leads, et un rapport par source comptait plus de
 *     rattachements qu'il n'y avait eu de notifications.
 *     (audit money du 2026-08-12, MA4)
 *
 * Ici la colonne est toujours dérivée de l'ensemble des matches appliqués : elle
 * se pose, se déplace et s'efface toute seule, et reste la PLUS ANCIENNE observée.
 */
function recomputeLeadEffect(db: DbLike, leadId: number, kind: string): void {
  const col = EFFECT.get(kind);
  if (!col) return;
  db.prepare(
    `UPDATE dzpk_leads
        SET ${col} = (
              SELECT MIN(m.posted_at)
                FROM dzpk_club_matches x
                JOIN dzpk_club_messages m ON m.id = x.club_message_id
               WHERE x.lead_id = ? AND x.applied = 1 AND m.parsed_kind = ?
                 AND m.posted_at IS NOT NULL AND m.posted_at != ''
            ),
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(leadId, kind, leadId);
}

/**
 * Le join vient d'être crédité : c'est LE moment de prévenir le réseau de pub.
 *
 * Pourquoi ici et pas dans le webhook : « rejoindre le groupe » n'est pas un
 * événement que le bot observe. Le bot ne voit que le /start ; l'entrée dans le
 * club arrive plus tard, par une notification `已进群` du club, ingérée puis
 * appariée. Ce point du code est le seul endroit où « ce lead-ci a rejoint »
 * devient vrai — et il l'est pour les DEUX chemins, l'auto et la main.
 *
 * Depuis l'étape 2 de l'optimisation, le goal PRINCIPAL part au /start
 * (webhook dzpk). Ici il reste deux déclenchements :
 *  • le goal JOIN (secondaire), sur ses propres colonnes de verrou — inerte
 *    tant que les variables *_POSTBACK_URL_JOIN ne sont pas posées ;
 *  • le goal principal en FILET : seul un lead entré AVANT la mise en service
 *    du déclenchement au /start peut encore avoir un click id sans postback —
 *    pour tous les autres, le verrou `postback_sent_at` rend l'appel inerte.
 *
 * L'appel ne bloque rien et ne peut rien casser : tout est décidé et loggué
 * dans postback.ts, y compris les refus (pas de click id, source organique).
 */
function notifyNetworkOnJoin(db: DbLike, leadId: number, kind: string): void {
  if (kind !== "join") return;
  fireConversionPostback(leadId, db);
  fireJoinPostback(leadId, db);
}

export interface MatchRunOutcome {
  examined: number;
  auto: number;
  ambiguous: number;
  unmatched: number;
  applied: number;
  /** Matchs jugés certains mais NON appliqués : le drapeau d'observation est baissé. */
  observed: number;
  /** L'auto-rattachement appliquait-il ses effets sur cette passe ? */
  applying: boolean;
}

/**
 * Résout et applique les messages rattachables non encore traités.
 *
 * Idempotent : `dzpk_club_matches.club_message_id` est UNIQUE, et l'effet sur le
 * lead est posé avec COALESCE — un second passage ne réécrit pas une date déjà
 * connue. Un rattachement ne recule donc jamais dans le temps.
 *
 * `dryRun` calcule tout et n'écrit RIEN : c'est ce qui permet d'afficher le taux
 * d'auto-appariement réel avant de décider de l'activer.
 */
export function runMatching(
  opts: { dryRun?: boolean; apply?: boolean } = {},
  dbOverride?: DbLike,
): MatchRunOutcome {
  const db = dbOverride ?? getDb();
  // `apply` par défaut = l'état du drapeau d'observation. Tant qu'il est baissé,
  // les matchs certains sont ENREGISTRÉS et affichés, mais ne créditent personne :
  // Baki valide un lot sur ses vraies données avant de lever le drapeau.
  const applying = opts.apply ?? dzpkAutoMatchEnabled();
  const out: MatchRunOutcome = {
    examined: 0, auto: 0, ambiguous: 0, unmatched: 0, applied: 0, observed: 0, applying,
  };

  // Seuls les gabarits porteurs d'un joueur, et seulement ceux qui ne sont pas
  // d'un autre agent. `agent_is_mine IS NULL` est ACCEPTÉ : c'est le cas du
  // gabarit « join », qui ne porte structurellement aucun agent.
  // Sont repris : les messages jamais résolus, ET ceux restés `ambiguous` /
  // `unmatched`. Sans cette reprise, cinq notifications du même nom inconnu
  // resteraient dans la file pour toujours alors que la résolution manuelle de
  // la première a appris le lien — le self-learning n'aurait servi que l'avenir.
  // Les résolutions `manual` et `auto` déjà posées ne sont jamais rejouées.
  const pending = db.prepare(
    `SELECT m.id, m.parsed_kind, m.name_key, m.posted_at
       FROM dzpk_club_messages m
       LEFT JOIN dzpk_club_matches x ON x.club_message_id = m.id
      WHERE m.parsed_kind IN ('join','bound','banned')
        AND (m.agent_is_mine IS NULL OR m.agent_is_mine = 1)
        -- Sont repris : jamais résolus, restés à la main de l'humain, ET les
        -- matchs certains enregistrés pendant l'observation (applied = 0), qui
        -- doivent s'appliquer dès que le drapeau est levé.
        --
        -- La clause sur name_key non vide a été RETIRÉE : elle faisait disparaître
        -- des trois écrans les notifications au nom illisible (pseudo tout en
        -- emoji). Ni ligne de match, ni file, ni compteur, ni crédit — le seul
        -- mode d'échec sans aucun symptôme. (audit du 2026-08-12, R9)
        AND (x.id IS NULL
             OR x.status IN ('ambiguous','unmatched')
             OR (x.status = 'auto' AND x.applied = 0))
      ORDER BY m.id`
  ).all() as Array<{ id: number; parsed_kind: string; name_key: string | null; posted_at: string | null }>;

  const insMatch = db.prepare(
    `INSERT INTO dzpk_club_matches
       (club_message_id, lead_id, status, method, candidates, applied)
     VALUES (@club_message_id, @lead_id, @status, @method, @candidates, @applied)
     ON CONFLICT(club_message_id) DO UPDATE SET
       lead_id = excluded.lead_id, status = excluded.status, method = excluded.method,
       candidates = excluded.candidates, applied = excluded.applied
     WHERE dzpk_club_matches.status IN ('ambiguous','unmatched')
        OR (dzpk_club_matches.status = 'auto' AND dzpk_club_matches.applied = 0)`
  );
  const insLink = db.prepare(
    `INSERT OR IGNORE INTO dzpk_name_links (name_key, lead_id, origin) VALUES (?, ?, 'auto')`
  );

  for (const msg of pending) {
    out.examined++;
    const r = resolveMatch(msg.name_key ?? "", msg.posted_at, dbOverride);
    out[r.status === "manual" ? "auto" : r.status]++;

    // `observed` est compté AVANT la sortie dry-run : sinon le seul rapport
    // machine sur l'état d'observation rapportait toujours 0 observé.
    // (audit money du 2026-08-12, R2)
    if (r.status === "auto" && r.leadId !== null && !applying) out.observed++;
    if (opts.dryRun) continue;

    // Un match certain n'est APPLIQUÉ que si le drapeau est levé. Sinon il est
    // enregistré tel quel (`status = 'auto'`, `applied = 0`) : l'écran le montre,
    // Baki le vérifie sur ses vraies données, et la passe qui suit la levée du
    // drapeau le reprend et le crédite — c'est pour ça que la requête `pending`
    // réinclut les `auto` non appliqués.
    const certain = r.status === "auto" && r.leadId !== null;
    const willApply = certain && applying;

    insMatch.run({
      club_message_id: msg.id,
      lead_id: r.leadId,
      status: r.status,
      method: r.method,
      candidates: JSON.stringify({ note: r.note, candidates: r.candidates }),
      applied: willApply ? 1 : 0,
    });

    if (!willApply) continue;
    if (!EFFECT.has(msg.parsed_kind)) continue;
    if (!msg.name_key) continue;

    recomputeLeadEffect(db, r.leadId!, msg.parsed_kind);
    notifyNetworkOnJoin(db, r.leadId!, msg.parsed_kind);

    // Le lien n'est mémorisé QUE sur une unicité réelle du nom.
    //
    // `display_name_dated` est un départage par date — une heuristique. La
    // graver en lien permanent la promouvait au rang d'identité : la
    // notification suivante du même nom, plausiblement celle de l'AUTRE
    // homonyme, était alors absorbée sans le moindre contrôle.
    // (audit money du 2026-08-12, MA2)
    if (r.method === "display_name") insLink.run(msg.name_key, r.leadId);
    out.applied++;
  }

  return out;
}

// ── Réconciliation manuelle ───────────────────────────────

/**
 * Rattache à la main une notification à un lead, et MÉMORISE le lien.
 *
 * C'est le cœur du self-learning : la prochaine notification portant le même
 * nom se rattachera seule. Un lien déjà présent pour cette clé mais pointant
 * ailleurs est réécrit — l'arbitrage humain le plus récent l'emporte.
 */
export function resolveManually(
  clubMessageId: number,
  leadId: number,
  operator: string,
  dbOverride?: DbLike,
): { ok: boolean; error?: string } {
  const db = dbOverride ?? getDb();
  const msg = db.prepare(
    `SELECT id, parsed_kind, name_key, posted_at, agent_is_mine FROM dzpk_club_messages WHERE id = ?`
  ).get(clubMessageId) as
    { id: number; parsed_kind: string; name_key: string | null; posted_at: string | null; agent_is_mine: number | null } | undefined;
  if (!msg) return { ok: false, error: "message introuvable" };

  // Seuls les gabarits porteurs d'un joueur sont rattachables. Sans ce garde, un
  // POST direct sur un message `unparsed` ou `commission` rendait `{ok:true}`,
  // écrivait un match `applied=1` sans le moindre effet, et — plus grave —
  // MÉMORISAIT un lien de nom qui servirait ensuite aux vraies notifications.
  if (!EFFECT.has(msg.parsed_kind)) {
    return { ok: false, error: `gabarit « ${msg.parsed_kind} » non rattachable à un lead` };
  }

  // Une notification appartenant à un AUTRE agent ne doit jamais créditer Baki,
  // quel que soit le chemin. `runMatching` filtre déjà ; le chemin manuel doit
  // le faire aussi, sinon la garde dépend de par où l'on passe.
  if (msg.agent_is_mine === 0) {
    return { ok: false, error: "notification d'un autre agent — rattachement refusé" };
  }

  const lead = db.prepare(`SELECT id, started_at FROM dzpk_leads WHERE id = ?`)
    .get(leadId) as { id: number; started_at: string } | undefined;
  if (!lead) return { ok: false, error: "lead introuvable" };

  // CAUSALITÉ, y compris à la main.
  //
  // Un arbitrage humain prime sur une heuristique, pas sur la chronologie : un
  // joueur ne peut pas avoir été rattaché au club avant d'avoir parlé au bot.
  // Accepter poserait `bound_at < started_at`, une incohérence que rien en aval
  // ne détecte — et comme l'effet prend le MIN, la date fausse l'emporterait
  // ensuite sur la vraie. (audit money du 2026-08-12, R1)
  //
  // Le refus est explicite plutôt que silencieux : si Baki vise vraiment ce
  // lead, c'est que l'un des deux horodatages est faux, et ça se règle en
  // regardant la donnée, pas en forçant le rattachement.
  const gap = hoursBetween(lead.started_at, msg.posted_at);
  if (gap !== null && gap < 0) {
    return {
      ok: false,
      error: `la notification (${msg.posted_at}) précède le /start de ce lead (${lead.started_at}) de ${Math.abs(Math.round(gap))} h — rattachement impossible`,
    };
  }

  // Un message sans date ne peut créditer personne : les colonnes du lead sont
  // dérivées de MIN(posted_at), qui l'ignorerait. Accepter la résolution aurait
  // produit le pire état possible — décision enregistrée, message sorti de la
  // file, et aucun crédit nulle part. On refuse, bruyamment.
  // (audit money du 2026-08-12, R3)
  if (EFFECT.has(msg.parsed_kind) && !msg.posted_at) {
    return { ok: false, error: "notification sans date : rattachement impossible (aucune date à porter sur le lead)" };
  }

  // Le lead précédemment crédité, s'il y en avait un et qu'il diffère : sa date
  // devra être recalculée APRÈS la bascule, sans quoi une correction manuelle
  // laisserait le crédit sur les deux leads à la fois.
  const ancien = db.prepare(
    `SELECT lead_id FROM dzpk_club_matches WHERE club_message_id = ?`
  ).get(clubMessageId) as { lead_id: number | null } | undefined;
  const ancienLeadId = ancien?.lead_id != null && ancien.lead_id !== leadId ? ancien.lead_id : null;

  db.prepare(
    `INSERT INTO dzpk_club_matches (club_message_id, lead_id, status, method, applied, resolved_by, resolved_at)
     VALUES (?, ?, 'manual', 'display_name', 1, ?, datetime('now'))
     ON CONFLICT(club_message_id) DO UPDATE SET
       lead_id = excluded.lead_id, status = 'manual', applied = 1,
       resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at`
  ).run(clubMessageId, leadId, operator);

  // Les deux leads sont recalculés depuis les faits : le nouveau reçoit la date,
  // l'ancien la perd si plus aucun message appliqué ne la justifie.
  if (EFFECT.has(msg.parsed_kind)) {
    recomputeLeadEffect(db, leadId, msg.parsed_kind);
    if (ancienLeadId !== null) recomputeLeadEffect(db, ancienLeadId, msg.parsed_kind);
    // Le lead nouvellement crédité peut déclencher un postback ; l'ancien, lui,
    // ne se « dé-poste » pas. Un postback parti est parti — le réseau n'a pas
    // d'annulation, et en fabriquer une (seconde requête « ignore la
    // précédente ») serait plus risqué que la conversion en trop qu'on corrige.
    notifyNetworkOnJoin(db, leadId, msg.parsed_kind);
  }

  if (msg.name_key) {
    db.prepare(
      `INSERT INTO dzpk_name_links (name_key, lead_id, origin, contested, created_by)
       VALUES (?, ?, 'manual', 0, ?)
       ON CONFLICT(name_key) DO UPDATE SET
         lead_id = excluded.lead_id, origin = 'manual', contested = 0,
         created_by = excluded.created_by`
    ).run(msg.name_key, leadId, operator);
  }
  return { ok: true };
}

/**
 * Marque contestés les liens dont la clé est devenue ambiguë.
 *
 * Un lien créé quand un seul lead portait ce nom devient douteux dès qu'un
 * second apparaît : l'unicité d'hier était un accident du volume. Le conserver
 * en silence rattacherait toutes les notifications suivantes au premier venu.
 */
export function flagContestedLinks(dbOverride?: DbLike): { contested: number } {
  const db = dbOverride ?? getDb();
  const info = db.prepare(
    `UPDATE dzpk_name_links
        SET contested = 1
      WHERE contested = 0
        AND origin = 'auto'
        AND (SELECT COUNT(*) FROM dzpk_leads l WHERE l.display_name_key = dzpk_name_links.name_key) > 1`
  ).run();
  return { contested: info.changes };
}

/**
 * Contrôle de cohérence : autant de leads crédités que de notifications appliquées ?
 *
 * `bound_at` est une colonne UNIQUE par lead : quand deux notifications tombent
 * sur le même lead — homonymes départagés par la date, ou absorption par un
 * lien — la seconde devient invisible. Le total du funnel semble juste, et il
 * manque un rattachement.
 *
 * Cet écart est le seul symptôme observable d'une collision. Il est exposé
 * plutôt que calculé à la demande, précisément parce que personne ne pense à le
 * chercher. (audit money du 2026-08-12, point 3.2)
 */
export interface CoherenceRow {
  kind: string;
  applied_matches: number;
  credited_leads: number;
  /** > 0 = des notifications sont tombées sur un lead déjà crédité. */
  collisions: number;
}

export function checkMatchCoherence(dbOverride?: DbLike): CoherenceRow[] {
  const db = dbOverride ?? getDb();
  const out: CoherenceRow[] = [];
  for (const [kind, col] of EFFECT) {
    const applied = db.prepare(
      `SELECT COUNT(*) AS n
         FROM dzpk_club_matches x JOIN dzpk_club_messages m ON m.id = x.club_message_id
        WHERE x.applied = 1 AND m.parsed_kind = ?
          AND m.posted_at IS NOT NULL AND m.posted_at != ''`
    ).get(kind) as { n: number };
    const credited = db.prepare(
      `SELECT COUNT(*) AS n FROM dzpk_leads WHERE ${col} IS NOT NULL`
    ).get() as { n: number };
    out.push({
      kind,
      applied_matches: applied.n,
      credited_leads: credited.n,
      collisions: Math.max(0, applied.n - credited.n),
    });
  }
  return out;
}

/** File de réconciliation : ce qui attend une décision humaine. */
export function listPendingReconciliation(limit = 100, dbOverride?: DbLike) {
  const db = dbOverride ?? getDb();
  return db.prepare(
    `SELECT x.id AS match_id, x.status, x.candidates,
            m.id AS club_message_id, m.parsed_kind, m.player_name_raw, m.posted_at, m.raw_text
       FROM dzpk_club_matches x
       JOIN dzpk_club_messages m ON m.id = x.club_message_id
      WHERE x.status IN ('ambiguous','unmatched')
      ORDER BY m.posted_at DESC, x.id DESC
      LIMIT ?`
  ).all(limit);
}

// ── Écran de réconciliation ───────────────────────────────

export interface PendingItem {
  club_message_id: number;
  status: MatchStatus;
  kind: string;
  player_name_raw: string | null;
  posted_at: string | null;
  raw_text: string;
  /** Pourquoi ce message n'a pas été rattaché tout seul. */
  note: string;
  /** Leads portant exactement ce nom, avec leur écart temporel. */
  candidates: LeadCandidate[];
}

/**
 * La file, prête à afficher.
 *
 * Les candidats sont RECALCULÉS à la lecture plutôt que relus du JSON figé au
 * moment du match : entre-temps de nouveaux leads ont pu faire `/start`, et
 * l'écran doit montrer l'état d'aujourd'hui, pas celui d'hier.
 */
export function getReconciliationQueue(limit = 200, dbOverride?: DbLike): PendingItem[] {
  const db = dbOverride ?? getDb();
  const rows = db.prepare(
    `SELECT x.status, m.id AS club_message_id, m.parsed_kind, m.player_name_raw,
            m.posted_at, m.raw_text, m.name_key
       FROM dzpk_club_matches x
       JOIN dzpk_club_messages m ON m.id = x.club_message_id
      WHERE x.status IN ('ambiguous','unmatched')
      ORDER BY m.posted_at DESC, m.id DESC
      LIMIT ?`
  ).all(limit) as Array<{
    status: MatchStatus; club_message_id: number; parsed_kind: string;
    player_name_raw: string | null; posted_at: string | null; raw_text: string; name_key: string;
  }>;

  return rows.map(r => {
    const fresh = resolveMatch(r.name_key, r.posted_at, dbOverride);
    return {
      club_message_id: r.club_message_id,
      status: r.status,
      kind: r.parsed_kind,
      player_name_raw: r.player_name_raw,
      posted_at: r.posted_at,
      raw_text: r.raw_text,
      note: fresh.note,
      candidates: fresh.candidates,
    };
  });
}

export interface ObservedMatch {
  club_message_id: number;
  kind: string;
  player_name_raw: string | null;
  posted_at: string | null;
  raw_text: string;
  method: string | null;
  lead_id: number;
  lead_display_name: string | null;
  lead_username: string | null;
  lead_source: string;
  lead_started_at: string;
  /** Heures entre le /start du lead et la notification. */
  hours_before: number | null;
}

/**
 * Les matchs jugés CERTAINS mais non encore appliqués.
 *
 * C'est LE troisième état, et il doit être listé item par item — pas résumé par
 * un compteur. Sans cette liste, un match certain n'apparaissait nulle part : ni
 * dans la file de réconciliation (qui ne montre que ambiguous/unmatched), ni
 * dans les compteurs du funnel (qui ne comptent que applied = 1). Le lead
 * s'affichait « aucune notification ne le concerne », ce qui était faux, et le
 * rattachement — donc le revenu — sortait de tous les écrans en silence.
 * (audit money du 2026-08-12, F1)
 *
 * L'objet de cette liste est de permettre de VÉRIFIER chaque certain, avec le
 * lead visé et l'écart temporel, avant de lever le drapeau d'application.
 */
export function getObservedMatches(limit = 200, dbOverride?: DbLike): ObservedMatch[] {
  const db = dbOverride ?? getDb();
  return db.prepare(
    `SELECT x.club_message_id, x.method, x.lead_id,
            m.parsed_kind AS kind, m.player_name_raw, m.posted_at, m.raw_text,
            l.display_name AS lead_display_name, l.username AS lead_username,
            l.source AS lead_source, l.started_at AS lead_started_at,
            (julianday(m.posted_at) - julianday(l.started_at)) * 24 AS hours_before
       FROM dzpk_club_matches x
       JOIN dzpk_club_messages m ON m.id = x.club_message_id
       JOIN dzpk_leads l        ON l.id = x.lead_id
      WHERE x.status = 'auto' AND x.applied = 0
      ORDER BY m.posted_at DESC, x.id DESC
      LIMIT ?`
  ).all(limit) as ObservedMatch[];
}

export interface LeadSearchResult {
  id: number;
  telegram_id: number;
  display_name: string | null;
  username: string | null;
  source: string;
  started_at: string;
  bound_at: string | null;
}

/**
 * Recherche d'un lead pour un rattachement manuel — par nom, @handle ou id.
 *
 * La recherche par nom passe par `display_name_key`, la MÊME clé normalisée que
 * l'appariement automatique. Chercher sur le nom brut donnerait des résultats
 * incohérents avec ce que le matcher considère : on chercherait dans un espace
 * et on rattacherait dans un autre.
 */
export function searchLeads(query: string, limit = 25, dbOverride?: DbLike): LeadSearchResult[] {
  const db = dbOverride ?? getDb();
  const q = String(query ?? "").trim();
  if (!q) return [];

  // `%` et `_` sont des jokers SQL : saisis par l'opérateur, ils feraient
  // remonter des leads sans rapport avec ce qu'il a tapé.
  const esc = (v: string) => v.replace(/[\\%_]/g, m => "\\" + m);

  const key = nameKey(q);
  const handle = q.replace(/^@+/, "").trim().toLowerCase();
  const asId = /^\d+$/.test(q) ? Number(q) : null;

  // ⚠️ Une clé vide ne doit RIEN remonter.
  //
  // nameKey() supprime les pictogrammes : un joueur nommé « 🐉🐉 » se normalise
  // en chaîne vide, et `LIKE '%%'` renvoyait alors les 25 leads les plus récents,
  // présentés comme des résultats de recherche. Baki en cliquait un, le crédit
  // partait sur un lead au hasard, et un lien de nom permanent était mémorisé.
  // (audit money du 2026-08-12, F3)
  const useKey = key !== "";
  const useHandle = handle !== "";
  if (!useKey && !useHandle && asId === null) return [];

  return db.prepare(
    `SELECT id, telegram_id, display_name, username, source, started_at, bound_at
       FROM dzpk_leads
      WHERE (? = 1 AND display_name_key IS NOT NULL AND display_name_key LIKE '%' || ? || '%' ESCAPE '\\')
         OR (? = 1 AND username IS NOT NULL AND LOWER(username) LIKE '%' || ? || '%' ESCAPE '\\')
         OR telegram_id = ?
         OR id = ?
      ORDER BY started_at DESC
      LIMIT ?`
  ).all(
    useKey ? 1 : 0, esc(key),
    useHandle ? 1 : 0, esc(handle),
    asId ?? -1, asId ?? -1, limit,
  ) as LeadSearchResult[];
}

/** Compteurs de tête d'écran. */
export function getReconciliationStats(dbOverride?: DbLike) {
  const db = dbOverride ?? getDb();
  const byStatus = db.prepare(
    `SELECT status, COUNT(*) AS n FROM dzpk_club_matches GROUP BY status`
  ).all() as Array<{ status: string; n: number }>;
  const total = byStatus.reduce((s, r) => s + r.n, 0);
  const pending = byStatus.filter(r => r.status === "ambiguous" || r.status === "unmatched")
    .reduce((s, r) => s + r.n, 0);
  const auto = byStatus.find(r => r.status === "auto")?.n ?? 0;
  const manual = byStatus.find(r => r.status === "manual")?.n ?? 0;
  return {
    total,
    pending,
    auto,
    manual,
    // `null` et non `0` quand rien n'a été examiné : un taux de 0 % et une
    // absence de données ne se lisent pas pareil, et c'est ce chiffre qui doit
    // décider de l'activation de l'auto-match.
    auto_rate_pct: total > 0 ? Math.round((auto / total) * 1000) / 10 : null,
  };
}
