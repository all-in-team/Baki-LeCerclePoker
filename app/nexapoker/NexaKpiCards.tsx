// Cartes chiffres de NEXAPOKER — même style que les pages P&L (StatCard partagé).
//
// AUCUNE MATH ICI (invariant #2) : tous les montants viennent de getNexaDashboard,
// qui les tient lui-même du moteur. Ce composant met en forme, et signale ce qui
// manque. Il est SERVEUR : pas d'état, pas de fetch.
//
// UN TOTAL PARTIEL NE DOIT PAS PASSER POUR UN TOTAL. Quand la part d'action est
// incalculable (un win/loss non saisi sur la période), la carte n'affiche pas un
// montant amputé : elle affiche « incalculable » et dit combien de semaines
// manquent. Même règle que la mention déjà présente sous la vue Agence.

import StatCard from "@/components/StatCard";
import type { NexaDashboard } from "@/lib/funnels/nexa/dashboard";

const fmt = (n: number) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => `${fmt(n)} USDT`;

export default function NexaKpiCards({ dash, rangeLabel }: {
  dash: NexaDashboard;
  rangeLabel: string;
}) {
  const t = dash.totals;
  const nWeeks = dash.weeks_in_period.length;

  // DEUX CHIFFRES SOUS LE MÊME MOT, C'EST UN BUG D'ÉCRAN. La vue Agence, plus bas
  // sur la page, affiche aussi « Commission encaissée » — mais au périmètre BRUT,
  // semaines en échec de contrôle comprises (choix documenté dans agency.ts : cet
  // argent a bien été reçu). Cette carte, elle, doit rester au périmètre du moteur,
  // sinon « net = commission − dû » ne se réconcilierait plus. Quand les deux
  // périmètres divergent, on nomme l'écart et on désigne l'autre chiffre, plutôt
  // que de laisser Baki découvrir deux montants contradictoires à 30 cm d'écart.
  const blockedNote = t.blocked_weeks > 0
    ? ` · hors ${t.blocked_weeks} semaine(s) en échec de contrôle (${money(t.blocked_commission)} reçus, comptés dans la vue Agence plus bas)`
    : "";

  const missingNote = t.weeks_missing_winloss > 0
    ? `${t.weeks_missing_winloss} semaine(s) joueur sans win/loss`
    : null;

  return (
    <div style={{
      display: "grid", gap: 16, marginBottom: 20,
      gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
    }}>
      <StatCard
        label={t.blocked_weeks > 0 ? "Commission retenue au calcul" : "Commission encaissée"}
        value={money(t.commission)}
        accent="green"
        sub={`${nWeeks} semaine(s) · ${rangeLabel}${blockedNote}`}
      />
      <StatCard
        label="RB dû aux joueurs"
        value={money(t.due)}
        accent="gold"
        sub={t.due > 0 ? "à reverser au titre du rakeback" : "aucun rakeback dû sur la période"}
      />
      <StatCard
        label="Mon net affiliation"
        value={money(t.net_affiliation)}
        accent={t.net_affiliation >= 0 ? "green" : "red"}
        sub="commission encaissée − rakeback dû"
      />
      <StatCard
        label="Ma part d'action"
        value={t.action_amount === null ? "incalculable" : money(t.action_amount)}
        accent={t.action_amount === null ? "neutral" : t.action_amount >= 0 ? "green" : "red"}
        sub={t.action_amount === null
          ? `${missingNote} — un total amputé passerait pour un total`
          : "sur les win/loss saisis de la période"}
      />
      <StatCard
        label="TOTAL — ce que NEXA me rapporte"
        value={t.total === null ? "incalculable" : money(t.total)}
        accent={t.total === null ? "neutral" : t.total >= 0 ? "green" : "red"}
        sub={t.total === null
          ? `net affiliation ${money(t.net_affiliation)} + action non chiffrable`
          : "net affiliation + part d'action"}
      />
    </div>
  );
}
