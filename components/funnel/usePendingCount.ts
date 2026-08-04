"use client";

// Compteur « À répondre » en temps réel : titre d'onglet + notification navigateur.
//
// Sans ça, rien ne signalait qu'un lead attendait tant qu'on n'ouvrait pas la page.
// Le titre d'onglet est le canal le plus utile — il reste lisible depuis n'importe
// quel autre onglet, sans permission ni réglage.
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 30_000;

export type PendingState = {
  count: number;
  /** 'default' = jamais demandée · 'granted' · 'denied' · null = API absente. */
  permission: NotificationPermission | null;
  requestPermission: () => void;
};

/**
 * @param initial  compteur rendu côté serveur — évite d'afficher 0 avant le 1er poll.
 * @param baseTitle titre de la page, préfixé par « (n) » quand des leads attendent.
 */
export function usePendingCount(initial: number, baseTitle: string): PendingState {
  const [count, setCount] = useState(initial);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  // `previous` sert au front montant 0 → >0 : on notifie sur la TRANSITION, pas sur
  // l'état. Sinon chaque poll rappellerait qu'il y a des leads en attente.
  const previous = useRef(initial);

  useEffect(() => {
    if (typeof Notification !== "undefined") setPermission(Notification.permission);
  }, []);

  const requestPermission = useCallback(() => {
    if (typeof Notification === "undefined") return;
    // Déclenchée par un clic : les navigateurs refusent une demande sans geste
    // utilisateur, et une demande refusée n'est plus rejouable.
    void Notification.requestPermission().then(setPermission);
  }, []);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch("/api/nexa-funnel/pending", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (!alive || typeof json?.count !== "number") return;

        const next = json.count;
        if (previous.current === 0 && next > 0 &&
            typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("Nexa Funnel", {
              body: next === 1 ? "1 lead attend une réponse" : `${next} leads attendent une réponse`,
              tag: "nexa-pending", // remplace la précédente au lieu d'empiler
            });
          } catch { /* certains navigateurs exigent un service worker — sans gravité */ }
        }
        previous.current = next;
        setCount(next);
      } catch { /* onglet en arrière-plan, réseau coupé : on réessaiera dans 30 s */ }
    };

    const id = setInterval(tick, POLL_MS);
    void tick();
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Titre d'onglet — visible depuis un autre onglet, contrairement à la page.
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
    return () => { document.title = baseTitle; };
  }, [count, baseTitle]);

  return { count, permission, requestPermission };
}
