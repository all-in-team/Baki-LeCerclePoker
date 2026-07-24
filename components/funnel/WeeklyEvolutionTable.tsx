// Détail semaine par semaine d'un lead (ligne dépliable du tableau des leads).
// Les colonnes sont décrites par la room : QQPK expose Insurance/Rewards, une
// autre room peut n'avoir que rake/dépôts/retraits/win-loss.
import { fmtAmount } from "@/lib/funnels/shared";
import { SignedAmount } from "./Amounts";

export type WeeklyColumn<R> = {
  label: string;
  value: (row: R) => number;
  /** bright = valeur mise en avant · muted = secondaire · signed = coloré par le signe. */
  tone?: "bright" | "muted" | "signed";
};

export default function WeeklyEvolutionTable<R extends { week_start: string }>({
  rows, columns,
}: {
  rows: R[];
  columns: WeeklyColumn<R>[];
}) {
  const th: React.CSSProperties = {
    padding: "6px 10px", fontSize: 10, fontWeight: 700, color: "#555568",
    textTransform: "uppercase", letterSpacing: "0.05em",
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: "left" }}>Semaine du</th>
          {columns.map(c => (
            <th key={c.label} style={{ ...th, textAlign: "right" }}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {/* Plus récent en haut. */}
        {[...rows].reverse().map(w => (
          <tr key={w.week_start} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <td style={{ padding: "6px 10px", color: "#8888A0" }}>{w.week_start}</td>
            {columns.map(c => {
              const v = c.value(w);
              return (
                <td key={c.label} style={{
                  padding: "6px 10px", textAlign: "right",
                  color: c.tone === "bright" ? "#E8E8EE" : c.tone === "signed" ? undefined : "#8888A0",
                }}>
                  {c.tone === "signed" ? <SignedAmount value={v} /> : fmtAmount(v)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
