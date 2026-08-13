"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PeriodFilterBar from "@/components/PeriodFilterBar";
import { PLAYERS_PERIOD_STORAGE_KEY, type PlayersPeriodKey } from "./shared";

/**
 * Barre de période de la page Joueurs — la barre PARTAGÉE des pages P&L, restreinte
 * à 30 jours / Lifetime (les bornes hebdo et custom n'ont pas de lecture utile sur
 * un roster). Même contrat d'URL : `?filter=30d|lifetime`.
 *
 * Mémorisation : l'URL fait foi. Le localStorage ne sert qu'à retrouver la dernière
 * vue quand on arrive sur `/players` SANS query (lien de la sidebar, favori) — et
 * seulement pour « lifetime », puisque 30j est déjà le rendu par défaut du serveur :
 * rediriger vers `?filter=30d` ne changerait rien à l'écran et coûterait un
 * re-render à chaque ouverture de la page.
 */
export default function PlayersPeriodBar({ periodKey }: { periodKey: PlayersPeriodKey }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasFilterParam = searchParams.get("filter") !== null;
  // Une seule tentative de restauration par montage : sans ce garde, revenir
  // manuellement sur `/players` après avoir choisi Lifetime rejouerait la
  // redirection en boucle avec le bouton Retour du navigateur.
  const restored = useRef(false);

  useEffect(() => {
    if (hasFilterParam) {
      // Choix explicite dans l'URL → c'est lui qu'on mémorise.
      window.localStorage.setItem(PLAYERS_PERIOD_STORAGE_KEY, periodKey);
      return;
    }
    if (restored.current) return;
    restored.current = true;
    if (window.localStorage.getItem(PLAYERS_PERIOD_STORAGE_KEY) === "lifetime") {
      router.replace("/players?filter=lifetime");
    }
  }, [hasFilterParam, periodKey, router]);

  return (
    <PeriodFilterBar
      activeFilter={periodKey}
      rangeLabel={periodKey === "lifetime"
        ? "Toutes les périodes — depuis le premier mouvement"
        : "30 derniers jours"}
      weeks={[]}
      basePath="/players"
      only={["30d", "lifetime"]}
    />
  );
}
