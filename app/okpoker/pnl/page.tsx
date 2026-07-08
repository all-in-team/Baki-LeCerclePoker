import { redirect } from "next/navigation";

// OKPOKER P&L merged into AKS/OK POKER (same club, same wallet mère, two onboarding
// skins). The standalone page is dead; everything lives at /aks/pnl.
export default function OKPOKERRedirect() {
  redirect("/aks/pnl");
}
