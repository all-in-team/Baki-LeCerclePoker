import { redirect } from "next/navigation";

/**
 * L'ancienne page de saisie a été fusionnée dans la page de room : la grille et
 * l'extraction de screenshot vivent maintenant en bas de /nexapoker, sous la
 * liste des joueurs. Le lundi, tout se fait au même endroit.
 *
 * Cette redirection est conservée volontairement : l'URL /nexa/saisie a été mise
 * en favori. On ne casse pas un signet pour un déplacement interne.
 */
export default function NexaSaisieRedirect() {
  redirect("/nexapoker#saisie");
}
