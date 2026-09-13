// Cartes chiffres XPoker Twd — StatCard partagé, AUCUNE math ici (invariant #2) :
// tout vient de getXpokerDashboardOn. Composant SERVEUR.
//
// TROIS ÉTATS, PAS DEUX : une part d'action dont une semaine est incalculable
// (joueur sans deal) s'affiche « incalculable », jamais un total amputé.
// DEUX COMPTEURS : le stock de jetons de l'agence et les dûs joueurs sont deux
// cartes, jamais une somme.
// Tout en chips ; l'équivalent USD (taux courant) est un sous-titre, jamais la valeur.

import StatCard from "@/components/StatCard";
import type { XpokerDashboard } from "@/lib/games/xpoker/dashboard";
import { usdNow } from "@/lib/games/xpoker/dashboard";

const chips = (n: number) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} chips`;
const usd = (n: number | null) => n === null ? "" : `≈ ${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

export default function XpokerKpiCards({ dash, rangeLabel }: { dash: XpokerDashboard; rangeLabel: string }) {
  const t = dash.totals;
  if (t.imports === 0) {
    return (
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "22px 20px", marginBottom: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
        Aucune semaine importée sur cette période ({rangeLabel}) — rien à afficher, ce qui n&apos;est pas la même chose que zéro.
        {t.unlinked_members > 0 && <> {t.unlinked_members} Player ID attendent d&apos;être rattachés (voir Réconciliation plus bas).</>}
      </div>
    );
  }
  const rate = dash.rate_now;
  const actionSub = t.action_chips === null
    ? `incalculable — ${t.incalculable_weeks} semaine(s) joueur sans deal`
    : `${usd(usdNow(t.action_chips, rate))} · + = les joueurs me doivent`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14, marginBottom: 20 }}>
      <StatCard label="Règlement club (sheet)" value={chips(t.club_sheet_total)} accent="gold"
        sub={`${t.imports} semaine(s) · ${usd(usdNow(t.club_sheet_total, rate))}${t.flagged_imports ? ` · ${t.flagged_imports} en écart acté` : ""}`} />
      <StatCard label="Reçu du club (grand livre)" value={chips(t.club_received)} accent={t.club_received_count === t.imports ? "green" : "neutral"}
        sub={`${t.club_received_count}/${t.imports} semaine(s) saisie(s) · ${usd(usdNow(t.club_received, rate))}`} />
      <StatCard label="Parts d'action joueurs" value={t.action_chips === null ? "incalculable" : chips(t.action_chips)}
        accent={t.action_chips === null ? "neutral" : t.action_chips >= 0 ? "green" : "red"} sub={actionSub} />
      <StatCard label="Stock de jetons agence" value={chips(dash.stock.stock_chips)} accent="neutral"
        sub={`entrées ${chips(dash.stock.in_chips)} · sorties ${chips(dash.stock.out_chips)} · ${usd(usdNow(dash.stock.stock_chips, rate))}`} />
      <StatCard label="À réconcilier" value={String(t.unlinked_members)} accent={t.unlinked_members > 0 ? "red" : "green"}
        sub={t.unlinked_members > 0 ? "Player ID inconnus dans les imports" : "tous les Player ID sont rattachés"} />
    </div>
  );
}
