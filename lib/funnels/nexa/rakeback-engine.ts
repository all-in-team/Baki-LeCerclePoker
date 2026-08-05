// Moteur de calcul du rakeback et des parts d'action NEXAPOKER — MODULE PUR.
//
// Zéro import, zéro accès DB, zéro horloge : tout entre par les paramètres. Le
// rejeu d'une chaîne se teste donc au chiffre près, sans base. Même découpage que
// ./affiliate-deal (grammaire pure) vs ./affiliate-ingest (base).
//
// ─────────────────────────────────────────────────────────────────────────────
// PAS DE SOLDE STOCKÉ. Le makeup n'est jamais persisté : il est REJOUÉ dans
// l'ordre des week_start à chaque lecture. Un solde stocké dérive dès qu'une
// semaine passée est corrigée par un ré-upload — le rejeu se recorrige seul.
// Le figement n'a lieu qu'au règlement, en recopiant le résultat sur la ligne de
// règlement (étape 7). Ne jamais écrire de makeup dans une table.
//
// LE CALCUL NE LIT JAMAIS getPlayerWalletStats. Cette fonction joint
// player_game_deals, dont l'action_pct NEXA n'est qu'un cache de la période
// COURANTE : elle appliquerait le % d'aujourd'hui à une semaine d'il y a deux
// mois. La vérité historisée est nexa_player_action_shares / nexa_player_rakeback,
// et c'est elle seule qui entre ici. (Constat de l'audit money-auditor.)
//
// SEMAINE EN ÉCHEC DE CONTRÔLE (check_ok = 0) : elle SORT DU CALCUL — dû 0,
// signalée — et la chaîne REPART À ZÉRO la semaine suivante. Le makeup en cours
// n'est pas propagé au travers (c'est ça, « ne pas propager un makeup douteux »),
// mais l'aval n'est PAS gelé : les semaines suivantes se calculent normalement.
// Un écart accepté avec motif (arrondi NEXA) ne doit pas rendre un joueur
// incalculable à vie ; et si la semaine est corrigée plus tard, le rejeu se
// recorrige seul.
//
// UN TOTAL INCOMPLET DOIT SE VOIR. Les totaux ne somment QUE les semaines `ok`
// et se réconcilient entre eux ; ce qu'ils excluent est exposé à côté dans
// `blocked_weeks`. Et `net_operator` vaut null — pas 0 — dès qu'une semaine `ok`
// n'a pas son win/loss : un total amputé ne doit jamais ressembler à un chiffre
// valide. Le compteur `weeks_missing_winloss` dit pourquoi.
// ─────────────────────────────────────────────────────────────────────────────

export type Basis = "gross_rake" | "affiliate_commission";
export type MakeupCarry = "carry" | "reset";

/** Une semaine du report, telle qu'elle sort de nexa_affiliate_weeks. */
export type WeekInput = {
  week_start: string;
  /** nlh + mtt + plo + spins. Peut être négatif (semaine perdante). */
  gross_rake: number;
  /** Affiliate Payment du report. Peut être négatif. */
  affiliate_commission: number;
  /** false = le recalcul ne retombe pas sur le report. Sort la semaine du calcul. */
  check_ok: boolean;
  /** Saisie manuelle d'Hugo. null = non saisi — on ne suppose JAMAIS 0. */
  winloss: number | null;
};

export type RakebackPeriod = {
  pct: number;
  basis: Basis;
  start_week: string;
  end_week: string | null;
  /** À l'ouverture de cette période : reporter le makeup, ou repartir de zéro. */
  makeup_carry: MakeupCarry;
};

export type ActionPeriod = { pct: number; start_week: string; end_week: string | null };

export type EngineConfig = {
  /** Appliqués aux semaines qu'aucune période ne couvre (settings). */
  defaultPct: number;
  defaultBasis: Basis;
};

export type WeekResult = {
  week_start: string;
  /** blocked = hors calcul et hors totaux ; la chaîne repart de zéro après elle. */
  status: "ok" | "blocked";
  blocked_reason: string | null;

  // ── Flux 1 : rakeback ──
  basis: Basis;
  rakeback_pct: number;
  /** Assiette brute de la semaine, selon la base. */
  base: number;
  /** Makeup entrant, toujours <= 0. */
  makeup_in: number;
  /** base + makeup_in — c'est SUR L'ASSIETTE que le makeup s'applique. */
  base_net: number;
  /** Dû au joueur. 0 si l'assiette nette est négative ou nulle. */
  due: number;
  /** Makeup sortant, toujours <= 0. */
  makeup_out: number;

  // ── Flux 2 : part d'action (affiché séparément — deux flux distincts) ──
  action_pct: number;
  /** null = win/loss non saisi. On n'invente pas un 0. */
  winloss: number | null;
  /** null tant que le win/loss n'est pas saisi. */
  action_amount: number | null;

  /** Rappels, pour l'affichage et pour agréger au même périmètre que le reste. */
  gross_rake: number;
  commission: number;
  /** commission − dû + action. null si le win/loss manque : le net serait faux. */
  net_operator: number | null;
};

export type EngineWarning = { week_start: string; message: string };

export type EngineResult = {
  weeks: WeekResult[];
  /**
   * MÊME PÉRIMÈTRE POUR TOUS : uniquement les semaines `ok`. Les cinq totaux se
   * réconcilient donc entre eux (net = commission − due + action). Ce qui en est
   * exclu est exposé dans `blocked_weeks`, jamais escamoté.
   */
  totals: {
    gross_rake: number;
    commission: number;
    due: number;
    /** null si un win/loss manque : sommer les autres ferait passer une semaine
     *  non renseignée pour une semaine à zéro. */
    action_amount: number | null;
    /**
     * null dès qu'une semaine `ok` n'a pas son win/loss : le net serait amputé
     * du `commission − dû` de cette semaine et passerait pour un chiffre juste.
     * Voir `weeks_missing_winloss`.
     */
    net_operator: number | null;
    /** Nombre de semaines `ok` dont le net est incalculable faute de win/loss. */
    weeks_missing_winloss: number;
  };
  /** Ce que les totaux N'INCLUENT PAS. Existe pour que rien ne disparaisse en silence. */
  blocked_weeks: {
    count: number;
    week_starts: string[];
    gross_rake: number;
    commission: number;
    /** null si l'une de ces semaines n'a pas son win/loss (même règle que le net). */
    action_amount: number | null;
  };
  /** Makeup restant à la fin de la chaîne. <= 0. */
  makeup_final: number;
  warnings: EngineWarning[];
};

const EPS = 0.0000001;

function periodAt<T extends { start_week: string; end_week: string | null }>(
  periods: T[], week: string,
): T | null {
  // La plus récente qui couvre la semaine : si deux périodes se chevauchent
  // (anomalie de saisie), on ne somme pas, on prend la dernière ouverte.
  let best: T | null = null;
  for (const p of periods) {
    if (p.start_week <= week && (p.end_week === null || week <= p.end_week)) {
      if (!best || p.start_week > best.start_week) best = p;
    }
  }
  return best;
}

/**
 * Rejoue la chaîne d'un joueur, semaine par semaine.
 *
 * MAKEUP SUR L'ASSIETTE, jamais sur le montant dû :
 *   base_net = base + makeup_in                (makeup_in <= 0)
 *   base_net <= 0  →  dû = 0        · makeup_out = base_net
 *   base_net >  0  →  dû = base_net × pct/100 · makeup_out = 0
 *
 * C'est la différence qui compte : avec S1 à −200 puis S2 à +300 et 50 %, le dû
 * de S2 vaut 50 — (300−200)×50 % — et non 150−200.
 *
 * SEMAINE EN ÉCHEC DE CONTRÔLE : elle sort du calcul (dû 0, `blocked`), le
 * makeup en cours n'est PAS propagé au travers, et la chaîne repart de zéro la
 * semaine suivante. L'aval n'est pas gelé. Le makeup abandonné au passage est
 * signalé dans `warnings` : il profite au joueur, ça ne doit pas être muet.
 */
export function computeRakeback(
  weeks: WeekInput[],
  rakebackPeriods: RakebackPeriod[],
  actionPeriods: ActionPeriod[],
  config: EngineConfig,
): EngineResult {
  // L'ordre chronologique EST le calcul : un tri instable donnerait un autre makeup.
  const ordered = [...weeks].sort((a, b) => a.week_start.localeCompare(b.week_start));

  const out: WeekResult[] = [];
  const warnings: EngineWarning[] = [];

  let makeup = 0;
  let prevPeriodKey: string | null = null;
  let prevBasis: Basis | null = null;

  for (const w of ordered) {
    const rp = periodAt(rakebackPeriods, w.week_start);
    const ap = periodAt(actionPeriods, w.week_start);
    const basis: Basis = rp?.basis ?? config.defaultBasis;
    const pct = rp?.pct ?? config.defaultPct;
    const actionPct = ap?.pct ?? 0;
    const base = basis === "gross_rake" ? w.gross_rake : w.affiliate_commission;
    const commission = w.affiliate_commission;
    const periodKey = rp ? `${rp.start_week}|${rp.pct}|${rp.basis}` : "default";

    // Part d'action — flux INDÉPENDANT du rakeback, y compris sur une semaine
    // bloquée : une assiette de rake fausse ne rend pas le win/loss faux.
    const actionAmount = w.winloss === null ? null : (w.winloss * actionPct) / 100;

    if (!w.check_ok) {
      // La semaine sort du calcul, et le makeup en cours s'arrête là : on ne
      // propage pas un report adossé à une assiette qu'on sait fausse. La
      // semaine suivante repart de zéro — l'aval n'est pas gelé.
      if (makeup < -EPS) {
        warnings.push({
          week_start: w.week_start,
          message: `Semaine en échec de contrôle : le makeup de ${makeup.toFixed(2)} en cours n'est pas reporté au-delà `
                 + `et la chaîne repart de zéro. Corriger cette semaine puis relire rétablit le report.`,
        });
      }
      out.push({
        week_start: w.week_start, status: "blocked",
        blocked_reason: "Le recalcul de cette semaine ne retombe pas sur le report — assiette non fiable.",
        basis, rakeback_pct: pct, base, makeup_in: makeup, base_net: 0, due: 0, makeup_out: 0,
        action_pct: actionPct, winloss: w.winloss, action_amount: actionAmount,
        gross_rake: w.gross_rake, commission, net_operator: null,
      });
      makeup = 0;
      prevPeriodKey = periodKey;
      prevBasis = basis;
      continue;
    }

    // Changement de période : le makeup se reporte ou repart de zéro, selon le
    // choix EXPLICITE porté par la nouvelle période.
    if (prevPeriodKey !== null && periodKey !== prevPeriodKey) {
      if (rp?.makeup_carry === "reset") {
        if (makeup < -EPS) {
          warnings.push({ week_start: w.week_start, message: `Makeup de ${makeup.toFixed(2)} purgé à l'ouverture de la période.` });
        }
        makeup = 0;
      } else if (prevBasis !== null && basis !== prevBasis && makeup < -EPS) {
        // Reporter un makeup accumulé en « commission » sur une base « rake brut »
        // revient à additionner des pommes et des poires. On le fait — c'est ce que
        // dit la configuration — mais on le SIGNALE, parce que le défaut 'carry'
        // n'est pas un choix explicite.
        warnings.push({
          week_start: w.week_start,
          message: `La base passe de ${prevBasis} à ${basis} avec un makeup de ${makeup.toFixed(2)} reporté. `
                 + `Ces deux assiettes n'ont pas la même unité — vérifie que c'est bien voulu (makeup_carry='reset' pour purger).`,
        });
      }
    }
    prevPeriodKey = periodKey;
    prevBasis = basis;

    const makeupIn = makeup;
    const baseNet = base + makeupIn;

    let due = 0;
    let makeupOut = 0;
    if (baseNet <= EPS) {
      // Assiette nette négative ou nulle : rien n'est dû, le déficit se reporte.
      // Math.min borne à 0 : dans la fenêtre 0 < base_net <= EPS, base_net est
      // positif et deviendrait un makeup POSITIF, donc un bonus d'assiette la
      // semaine suivante — l'inverse d'un makeup. Le type promet <= 0 : on tient
      // la promesse, y compris sur un montant dérisoire. (Et pas de -0.)
      due = 0;
      makeupOut = Math.min(baseNet, 0) || 0;
    } else {
      due = (baseNet * pct) / 100;
      makeupOut = 0;
    }
    makeup = makeupOut;

    out.push({
      week_start: w.week_start, status: "ok", blocked_reason: null,
      basis, rakeback_pct: pct, base, makeup_in: makeupIn, base_net: baseNet, due, makeup_out: makeupOut,
      action_pct: actionPct, winloss: w.winloss, action_amount: actionAmount,
      gross_rake: w.gross_rake, commission,
      net_operator: actionAmount === null ? null : commission - due + actionAmount,
    });
  }

  // Un seul périmètre pour tous les totaux : les semaines `ok`. Ce qui en sort
  // est repris tel quel dans blocked_weeks — aucune ligne ne s'évapore.
  const okWeeks = out.filter(w => w.status === "ok");
  const blockedWeeks = out.filter(w => w.status === "blocked");

  const okMissingWinloss = okWeeks.filter(w => w.winloss === null).length;
  const sumCommission = okWeeks.reduce((s, w) => s + w.commission, 0);
  const sumDue = okWeeks.reduce((s, w) => s + w.due, 0);
  // Ces deux sommes n'ont de sens QUE si tous les win/loss du périmètre sont
  // saisis : sinon un `?? 0` ferait passer une semaine non renseignée pour une
  // semaine à zéro. Incalculable se dit null, pas 0.
  const sumAction = okMissingWinloss > 0
    ? null
    : okWeeks.reduce((s, w) => s + (w.action_amount ?? 0), 0);

  const blockedMissingWinloss = blockedWeeks.some(w => w.winloss === null);

  return {
    weeks: out,
    totals: {
      gross_rake: okWeeks.reduce((s, w) => s + w.gross_rake, 0),
      commission: sumCommission,
      due: sumDue,
      action_amount: sumAction,
      net_operator: sumAction === null ? null : sumCommission - sumDue + sumAction,
      weeks_missing_winloss: okMissingWinloss,
    },
    blocked_weeks: {
      count: blockedWeeks.length,
      week_starts: blockedWeeks.map(w => w.week_start),
      gross_rake: blockedWeeks.reduce((s, w) => s + w.gross_rake, 0),
      commission: blockedWeeks.reduce((s, w) => s + w.commission, 0),
      action_amount: blockedMissingWinloss
        ? null
        : blockedWeeks.reduce((s, w) => s + (w.action_amount ?? 0), 0),
    },
    makeup_final: makeup,
    warnings,
  };
}

/**
 * Semaines effectivement réglables : dû strictement positif et non bloquées.
 *
 * Une semaine à 0 ne produit AUCUNE ligne de règlement — un règlement à zéro
 * n'est pas un règlement, c'est du bruit dans le hub de paiement.
 * (Le branchement à /payments est l'étape 7 ; cette fonction ne fait que dire
 * quelles semaines seraient concernées.)
 */
export function settleableWeeks(result: EngineResult): WeekResult[] {
  return result.weeks.filter(w => w.status === "ok" && w.due > EPS);
}
