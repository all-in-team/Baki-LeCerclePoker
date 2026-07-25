import { redirect } from "next/navigation";

// La page "CRM Joueurs" et la page "Joueurs" affichaient les mêmes joueurs avec des colonnes
// différentes : elles ont été fusionnées sur /players. Les sous-routes /crm/affiliates,
// /crm/games et /crm/[id] (fiche joueur) ne sont pas concernées.
export default function CRMPage() {
  redirect("/players");
}
