// Vue AGENCE de NEXAPOKER : ce que la room rapporte, semaine par semaine, et la
// position nette de chaque joueur.
//
// Aucune math nouvelle ici. Deux sources, deux natures :
//   • la rentrée hebdo est une AGRÉGATION BRUTE de nexa_affiliate_weeks — la
//     commission d'affiliation est de l'argent réellement reçu ;
//   • la position par joueur vient du MOTEUR, via getNexaPlayerDetailOn.
//
// POURQUOI LA RENTRÉE HEBDO COMPTE AUSSI LES SEMAINES `check_ok = 0`, alors que les
// totaux du moteur les excluent : ce ne sont pas les mêmes objets. Le moteur refuse
// de CALCULER sur une assiette dont le recalcul ne retombe pas — il ne peut pas en
// déduire un dû fiable. La commission, elle, a été encaissée : l'écarter du chiffre
// d'affaires ferait disparaître de l'argent qui est bien arrivé. On la compte donc,
// et on affiche à côté le nombre de semaines dont le contrôle a échoué, pour que
// l'écart soit visible au lieu d'être silencieux.
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import { getNexaPlayersOn, getNexaPlayerDetailOn } from "./players";

type DB = BetterSqlite3.Database;

export type AgencyWeek = {
  week_start: string;
  /** Rake brut généré par les joueurs, toutes lignes confondues. */
  gross_rake: number;
  /** Commission d'affiliation reçue — la rentrée. */
  commission: number;
  players_count: number;
  /** Lignes dont le recalcul ne retombe pas sur le report. 0 = semaine saine. */
  check_ko: number;
};

export type AgencyPlayer = {
  player_id: number;
  name: string;
  /** Ce que ce joueur a rapporté en commission (périmètre moteur : semaines ok). */
  commission: number;
  /** null si un win/loss manque — on ne complète pas par un zéro. */
  action_amount: number | null;
  net_movements: number;
  /** action + mouvements. Positif = le joueur doit au Cercle. null si incalculable. */
  net_position: number | null;
  /** Nombre de semaines `ok` sans win/loss saisi — la raison des null ci-dessus. */
  weeks_missing_winloss: number;
};

export type NexaAgency = {
  weeks: AgencyWeek[];
  players: AgencyPlayer[];
  totals: {
    /** Somme de TOUTES les semaines, contrôle en échec compris (argent reçu). */
    gross_rake: number;
    commission: number;
    /** Semaines distinctes dont au moins une ligne est en échec de contrôle. */
    weeks_with_check_ko: number;
    /** Σ des positions nettes, null dès qu'un joueur est incalculable. */
    net_position: number | null;
    /** Joueurs dont la position est incalculable faute de win/loss. */
    players_incomplete: number;
  };
};

export function getNexaAgencyOn(db: DB): NexaAgency {
  const weeks = db.prepare(`
    SELECT week_start,
           COALESCE(SUM(nlh + mtt + plo + spins), 0) AS gross_rake,
           COALESCE(SUM(affiliate_payment), 0)       AS commission,
           COUNT(*)                                  AS players_count,
           SUM(CASE WHEN check_ok = 0 THEN 1 ELSE 0 END) AS check_ko
    FROM nexa_affiliate_weeks
    GROUP BY week_start
    ORDER BY week_start
  `).all() as AgencyWeek[];

  const players: AgencyPlayer[] = [];
  for (const p of getNexaPlayersOn(db)) {
    const d = getNexaPlayerDetailOn(db, p.player_id);
    if (!d) continue;
    players.push({
      player_id: p.player_id,
      name: p.name,
      commission: d.totals.commission,
      action_amount: d.totals.action_amount,
      net_movements: d.net_movements,
      net_position: d.net_position,
      weeks_missing_winloss: d.totals.weeks_missing_winloss,
    });
  }

  const incomplete = players.filter(p => p.net_position === null);

  return {
    weeks,
    players,
    totals: {
      gross_rake: weeks.reduce((s, w) => s + w.gross_rake, 0),
      commission: weeks.reduce((s, w) => s + w.commission, 0),
      weeks_with_check_ko: weeks.filter(w => w.check_ko > 0).length,
      // Un seul joueur incalculable rend le total incalculable : le sommer en
      // ignorant les null donnerait un chiffre d'apparence juste, amputé du reste.
      net_position: incomplete.length > 0
        ? null
        : players.reduce((s, p) => s + (p.net_position ?? 0), 0),
      players_incomplete: incomplete.length,
    },
  };
}

export function getNexaAgency(): NexaAgency { return getNexaAgencyOn(getDb()); }
