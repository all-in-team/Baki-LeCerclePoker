export const dynamic = "force-dynamic";
import { getTopContributors, getWalletSummaryByPlayer, getApps, type Period } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { computePeriodFilter } from "@/lib/period-filter";
import { toParisDate } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import PlayersPeriodBar from "./PlayersPeriodBar";
import PlayersViewToggle from "./PlayersViewToggle";
import { periodSubtitle, type App, type Deal, type Game, type Player, type PlayersPeriod } from "./shared";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Résout `?filter=` vers la période de la page. Toute valeur non reconnue —
 * ou un `custom:` que computePeriodFilter refuse de résoudre — retombe sur 30j,
 * le défaut historique.
 *
 * `custom` est ramené à des dates PARIS nues : la fenêtre est celle que Baki
 * lit dans la barre, et elle reste comparable aux sources jour (cf. le
 * commentaire de PlayersPeriod dans shared.ts).
 */
function resolvePlayersPeriod(raw: string | undefined, today: string): PlayersPeriod {
  if (raw === "lifetime") return { key: "lifetime", kind: "lifetime" };
  if (raw === "7d") return { key: "7d", kind: "7d", from: daysAgo(7), to: today };

  if (raw?.startsWith("custom:")) {
    const resolved = computePeriodFilter(raw);
    // computePeriodFilter signale un custom malformé en retombant sur « current »
    // (semaine en cours) : la clé rendue ne correspond alors plus à la demande.
    if (resolved.key === raw && resolved.startDate && resolved.endDate) {
      return {
        key: raw,
        kind: "custom",
        from: toParisDate(resolved.startDate),
        to: toParisDate(resolved.endDate),
      };
    }
  }

  return { key: "30d", kind: "30d", from: daysAgo(30), to: today };
}

// Page Joueurs unique — fusion de l'ancien /crm (kanban + agency cut + deals) et de
// l'ancien /players (roster + add/edit). /crm redirige ici.
export default async function PlayersPage({ searchParams }: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Période — même contrat d'URL que les pages P&L (PeriodFilterBar +
  // computePeriodFilter), restreint à 7j / 30j / lifetime / custom : les bornes
  // hebdomadaires n'ont pas de lecture utile sur un roster.
  //
  // Les bornes du 30j sont celles d'AVANT ce filtre (`daysAgo(30)` → `today`, en
  // dates nues) et non celles de computePeriodFilter (horodatages ISO complets) :
  // la vue par défaut doit rendre exactement les mêmes chiffres qu'avant. Lifetime
  // = période vide, la forme que getTopContributors traite déjà comme « sans borne »
  // (cf. lib/agent-tools.ts, qui appelle déjà getTopContributors({})).
  const period = resolvePlayersPeriod((await searchParams).filter, today);
  const queryPeriod: Period = period.kind === "lifetime" ? {} : { from: period.from, to: period.to };

  // Pas de whitelist de status : l'ancienne page /players affichait TOUS les joueurs alors
  // que le CRM filtrait 4 status. Sans ce SELECT ouvert, un joueur avec un status hors liste
  // deviendrait invisible partout.
  // `archived_at` remonte ici : la liste masque les archivés par défaut côté client, avec
  // un toggle « Archivés » pour les récupérer (soft-delete réversible, audit 2026-07-25).
  const allPlayers = db.prepare(`
    SELECT p.id, p.name, p.telegram_handle, p.telegram_phone, p.status, p.tier, p.notes,
      p.tron_address, p.tron_app_id, p.telegram_id, p.created_at, p.joined_via,
      p.archived_at, p.archive_reason,
      (SELECT MAX(created_at) FROM crm_notes WHERE player_id = p.id) AS last_note_at,
      EXISTS(SELECT 1 FROM affiliate_relationships WHERE affiliate_player_id = p.id AND status='active') AS is_affiliate,
      EXISTS(SELECT 1 FROM affiliate_relationships WHERE referred_player_id = p.id AND status='active') AS is_referred
    FROM players p
    ORDER BY p.name
  `).all() as Player[];

  const gameRows = db.prepare(`
    SELECT pgd.player_id, GROUP_CONCAT(g.name, ',') AS game_names
    FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
    WHERE pgd.end_date IS NULL
    GROUP BY pgd.player_id
  `).all() as { player_id: number; game_names: string }[];
  const gamesByPlayer: Record<number, string[]> = {};
  gameRows.forEach(g => { gamesByPlayer[g.player_id] = g.game_names.split(","); });

  const dealRows = db.prepare(`
    SELECT pgd.id AS deal_id, pgd.player_id, pgd.game_id, pgd.action_pct, pgd.rakeback_pct, pgd.start_date, pgd.end_date
    FROM player_game_deals pgd
  `).all() as Deal[];
  const dealsByPlayer: Record<number, Deal[]> = {};
  dealRows.forEach(d => { (dealsByPlayer[d.player_id] ??= []).push(d); });

  const activeGames = db.prepare(`SELECT id, name, default_action_pct, status FROM games WHERE status IN ('active', 'archived') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id`).all() as Game[];

  // Limite haute volontaire : getTopContributors fait un slice(limit) et l'agency cut est
  // la colonne de tri par défaut — un cap à 100 ferait afficher "—" au-delà du 100e joueur.
  const contributors = getTopContributors(queryPeriod, 100000);
  const agencyByPlayer: Record<number, number> = {};
  contributors.forEach(c => { agencyByPlayer[c.player_id] = c.agency_usdt; });

  // Le détail par game (Kanban + drawer) suit la même période que la colonne du
  // tableau : deux vues de la même page qui afficheraient des bornes différentes
  // se liraient comme une incohérence de chiffres. Mêmes bornes, converties dans
  // la forme horodatée que prend getWalletSummaryByPlayer — journées entières,
  // exactement la fenêtre que periodToDateRange applique à getTopContributors.
  const pnlRows = getWalletSummaryByPlayer(
    period.kind === "lifetime"
      ? {}
      : { since_date: period.from + "T00:00:00Z", end_date: period.to + "T23:59:59Z" },
  ) as any[];
  const pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }> = {};
  pnlRows.forEach((r: any) => {
    pnlByPlayerGame[`${r.player_id}_${r.game_id}`] = { player_net: r.net ?? 0, agency_pnl: r.my_pnl ?? 0 };
  });

  const affiliateInfo = db.prepare(`
    SELECT ar.referred_player_id, ap.name AS affiliated_by_name, ap.telegram_handle AS affiliated_by_handle
    FROM affiliate_relationships ar
    JOIN players ap ON ap.id = ar.affiliate_player_id
    WHERE ar.status = 'active'
  `).all() as { referred_player_id: number; affiliated_by_name: string; affiliated_by_handle: string | null }[];
  const affiliatedByPlayer: Record<number, { name: string; handle: string | null }> = {};
  affiliateInfo.forEach(a => { affiliatedByPlayer[a.referred_player_id] = { name: a.affiliated_by_name, handle: a.affiliated_by_handle }; });

  // Apps legacy (poker_apps) : uniquement pour le select tron_app_id de la modale d'édition.
  const apps = (getApps() as any[]).map(a => ({ id: a.id, name: a.name })) as App[];

  return (
    <>
      <PageHeader title="Joueurs" subtitle={periodSubtitle(period)} />
      <PlayersPeriodBar period={period} />
      <PlayersViewToggle
        players={allPlayers}
        gamesByPlayer={gamesByPlayer}
        dealsByPlayer={dealsByPlayer}
        agencyByPlayer={agencyByPlayer}
        pnlByPlayerGame={pnlByPlayerGame}
        activeGames={activeGames}
        apps={apps}
        affiliatedByPlayer={affiliatedByPlayer}
        period={period}
      />
    </>
  );
}
