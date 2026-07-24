import { fmtAmount } from "@/lib/funnels/shared";

/** Montant signé : vert si gain, rouge si perte, gris si nul. Arrondi à l'affichage. */
export function SignedAmount({ value }: { value: number }) {
  return (
    <span style={{ color: value > 0 ? "#34D399" : value < 0 ? "#F87171" : "#8888A0" }}>
      {fmtAmount(value)}
    </span>
  );
}
