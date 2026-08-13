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
export default function PlayersPeriodBar({
  period, filterRecognized,
}: {
  period: PlayersPeriod;
  filterRecognized: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasFilterParam = searchParams.get("filter") !== null;
  // Garde intra-montage : empêche l'effet de se relancer sur lui-même.
  const restored = useRef(false);

  useEffect(() => {
    if (hasFilterParam) {
      // On ne mémorise QUE ce que la page a su résoudre tel quel. Une URL
      // héritée d'une page P&L (`?filter=current`, `?filter=2026-W18`) ou un
      // `custom:` devenu invalide retombe sur 30j : l'écrire écraserait le
      // lifetime choisi la veille par un repli que Baki n'a jamais demandé.
      // On stocke la CLÉ brute (`custom:2026-08-01T00:00~…`), pas la famille :
      // restaurer un custom sans ses bornes ne voudrait rien dire.
      if (filterRecognized) {
        window.localStorage.setItem(PLAYERS_PERIOD_STORAGE_KEY, period.key);
      }
      return;
    }
    // Restauration à chaque arrivée sur l'URL nue — c'est le comportement
    // demandé : « retomber sur ma dernière vue » vaut aussi au 3e clic sur
    // Joueurs dans la sidebar, pas seulement au premier de la session.
    //
    // Limite connue et assumée : si on atteint `/players` nu avec le bouton
    // Retour, la restauration rejoue et renvoie sur la période mémorisée. On
    // revient donc sur la vue qu'on quittait au lieu de l'URL nue. Pas de
    // boucle (`replace` réécrit l'entrée au lieu d'en empiler une), juste une
    // entrée d'historique peu intéressante. Neutraliser ça par onglet coûterait
    // la restauration elle-même — mauvais échange.
    if (restored.current) return;
    restored.current = true;
    const saved = window.localStorage.getItem(PLAYERS_PERIOD_STORAGE_KEY);
    if (saved && saved !== "30d") {
      router.replace(`/players?filter=${encodeURIComponent(saved)}`);
    }
  }, [hasFilterParam, filterRecognized, period.key, router]);

  return (
    <PeriodFilterBar
      activeFilter={period.key}
      rangeLabel={periodRangeLabel(period)}
      weeks={[]}
      basePath="/players"
      only={["7d", "30d", "lifetime", "custom"]}
      dayGranularCustom
    />
  );
}
