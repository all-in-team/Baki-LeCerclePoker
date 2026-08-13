"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PeriodFilterBar from "@/components/PeriodFilterBar";
import { PLAYERS_PERIOD_STORAGE_KEY, periodRangeLabel, type PlayersPeriod } from "./shared";

/**
 * Barre de période de la page Joueurs — la barre PARTAGÉE des pages P&L, restreinte
 * à 7 jours / 30 jours / Lifetime / Custom (les bornes hebdomadaires n'ont pas de
 * lecture utile sur un roster). Même contrat d'URL : `?filter=7d|30d|lifetime|custom:…`.
 *
 * Mémorisation : l'URL fait foi. Le localStorage ne sert qu'à retrouver la dernière
 * vue quand on arrive sur `/players` SANS query (lien de la sidebar, favori) — et
 * jamais pour « 30d », déjà le rendu par défaut du serveur : rediriger vers
 * `?filter=30d` ne changerait rien à l'écran et coûterait un re-render à chaque
 * ouverture de la page.
 */
export default function PlayersPeriodBar({ period }: { period: PlayersPeriod }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasFilterParam = searchParams.get("filter") !== null;
  // Une seule tentative de restauration par montage : sans ce garde, revenir
  // manuellement sur `/players` après avoir choisi une autre période rejouerait
  // la redirection en boucle avec le bouton Retour du navigateur.
  const restored = useRef(false);

  useEffect(() => {
    if (hasFilterParam) {
      // Choix explicite dans l'URL → c'est lui qu'on mémorise. On stocke la CLÉ
      // brute (`custom:2026-08-01T00:00~…`), pas la famille : restaurer un custom
      // sans ses bornes ne voudrait rien dire.
      window.localStorage.setItem(PLAYERS_PERIOD_STORAGE_KEY, period.key);
      return;
    }
    if (restored.current) return;
    restored.current = true;
    const saved = window.localStorage.getItem(PLAYERS_PERIOD_STORAGE_KEY);
    if (saved && saved !== "30d") {
      router.replace(`/players?filter=${encodeURIComponent(saved)}`);
    }
  }, [hasFilterParam, period.key, router]);

  return (
    <PeriodFilterBar
      activeFilter={period.key}
      rangeLabel={periodRangeLabel(period)}
      weeks={[]}
      basePath="/players"
      only={["7d", "30d", "lifetime", "custom"]}
    />
  );
}
