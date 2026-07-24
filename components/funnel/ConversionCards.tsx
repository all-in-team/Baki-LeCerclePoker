// Rangée de cards de conversion d'un funnel — une card par étape.
// Générique multi-rooms : les cards sont calculées par buildConversionCards().
import type { ConversionCard } from "@/lib/funnels/shared";
import { FUNNEL_CARD } from "./styles";

export default function ConversionCards({ cards }: { cards: ConversionCard[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
      {cards.map(c => (
        <div key={c.label} style={FUNNEL_CARD}>
          <div style={{ fontSize: 11, color: "#8888A0", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{c.label}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#E8E8EE", marginTop: 4 }}>{c.count}</div>
          <div style={{ fontSize: 11, color: "#555568", marginTop: 2 }}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
