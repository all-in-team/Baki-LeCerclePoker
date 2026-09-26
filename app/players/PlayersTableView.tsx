"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Archive, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";
import { agencyColumnLabel, badgeFor, fmtAmt, isActiveStatus, type Deal, type Player, type PlayersPeriod } from "./shared";

type SortKey = "name" | "games" | "agency" | "status";

interface Props {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  period: PlayersPeriod;
  onEdit: (p: Player) => void;
  /** Vue « Archivés » : les joueurs à régler restent en tête, quel que soit le tri choisi. */
  toSettleFirst?: boolean;
}

const TH: React.CSSProperties = { padding: "8px", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };

export default function PlayersTableView({ players, gamesByPlayer, agencyByPlayer, period, onEdit, toSettleFirst = false }: Props) {
  const router = useRouter();
  // Défaut : agency cut décroissant — les plus rentables en haut. Le tri porte sur
  // agencyByPlayer, déjà résolu pour la période active côté serveur : changer de
  // période change les valeurs, pas la clé de tri, donc l'ordre choisi est conservé.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "agency", dir: "desc" });
  const [archiving, setArchiving] = useState<number | null>(null);

  function clickSort(key: SortKey) {
    setSort(s => s.key === key
      ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
      // Texte : croissant d'abord. Chiffres : décroissant d'abord.
      : { key, dir: key === "name" || key === "status" ? "asc" : "desc" });
  }

  const sorted = [...players].sort((a, b) => {
    if (toSettleFirst) {
      const pin = Number(b.open.length > 0) - Number(a.open.length > 0);
      if (pin !== 0) return pin;
    }
    const dir = sort.dir === "asc" ? 1 : -1;
    switch (sort.key) {
      case "name": return a.name.localeCompare(b.name, "fr") * dir;
      case "status": return (a.status.localeCompare(b.status) || a.name.localeCompare(b.name, "fr")) * dir;
      case "games": return (((gamesByPlayer[a.id] ?? []).length - (gamesByPlayer[b.id] ?? []).length) || a.name.localeCompare(b.name, "fr")) * dir;
      case "agency":
      default: {
        const d = (agencyByPlayer[a.id] ?? 0) - (agencyByPlayer[b.id] ?? 0);
        return d !== 0 ? d * dir : a.name.localeCompare(b.name, "fr");
      }
    }
  });

  // Archive (un seul concept) : sort le joueur de la vue principale, jamais de suppression.
  // Toujours permise ; un joueur à régler passe en tête d'« Archivés ».
  async function setArchived(p: Player, archived: boolean) {
    setArchiving(p.id);
    try {
      const res = await fetch(`/api/players/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived, archive_reason: archived ? "retiré à la main" : null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error ?? `Erreur ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setArchiving(null);
    }
  }

  function Arrow({ k }: { k: SortKey }) {
    if (sort.key !== k) return null;
    return sort.dir === "desc"
      ? <ChevronDown size={11} style={{ display: "inline", marginLeft: 3, verticalAlign: "middle" }} />
      : <ChevronUp size={11} style={{ display: "inline", marginLeft: 3, verticalAlign: "middle" }} />;
  }

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <th style={{ ...TH, textAlign: "left" }} onClick={() => clickSort("name")}>Joueur<Arrow k="name" /></th>
            <th style={{ ...TH, textAlign: "center" }} onClick={() => clickSort("games")}>Games<Arrow k="games" /></th>
            <th style={{ ...TH, textAlign: "right" }} onClick={() => clickSort("agency")}>{agencyColumnLabel(period)}<Arrow k="agency" /></th>
            <th style={{ ...TH, textAlign: "center" }} onClick={() => clickSort("status")}>Status<Arrow k="status" /></th>
            <th style={{ padding: "8px", textAlign: "center", whiteSpace: "nowrap" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--text-dim)", padding: 32 }}>Aucun joueur</td></tr>
          )}
          {sorted.map(p => {
            const agency = agencyByPlayer[p.id] ?? 0;
            const playerGames = gamesByPlayer[p.id] ?? [];
            return (
              <tr
                key={p.id}
                onClick={() => router.push(`/players/${p.id}`)}
                style={{ borderBottom: "1px solid var(--border)", cursor: "pointer", opacity: p.archived_at && p.open.length === 0 ? 0.6 : 1 }}
              >
                <td style={{ padding: "10px 8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{p.name}</span>
                    {!!p.is_affiliate && <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "rgba(139,92,246,0.15)", color: "#A78BFA" }}>Aff</span>}
                    {!!p.is_referred && <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "rgba(236,72,153,0.15)", color: "#F472B6" }}>Ref</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                    {p.telegram_handle ? `@${p.telegram_handle.replace(/^@/, "")}` : p.telegram_phone ? p.telegram_phone : "—"}
                  </div>
                  {p.archived_at && p.open.length > 0 && (
                    <div style={{ fontSize: 11, color: "#EF4444", marginTop: 3, maxWidth: 420 }}>À régler : {p.open.join(" ; ")}</div>
                  )}
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  {playerGames.length === 0 && <span style={{ color: "var(--text-dim)" }}>—</span>}
                  {playerGames.map(gn => {
                    const b = badgeFor(gn);
                    return <span key={gn} style={{ background: b.bg, color: b.color, padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, marginRight: 4, display: "inline-block" }}>{b.short}</span>;
                  })}
                </td>
                <td style={{ textAlign: "right", padding: "10px 8px", fontWeight: 600, whiteSpace: "nowrap", color: agency > 0 ? "#D4AF37" : agency < 0 ? "#EF4444" : "var(--text-muted)" }}>
                  {agency !== 0 ? `${fmtAmt(agency)} USDT` : "—"}
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                    {p.archived_at && p.open.length > 0 && (
                      <span title={"À régler : " + p.open.join(" ; ")} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "rgba(239,68,68,0.15)", color: "#EF4444", whiteSpace: "nowrap" }}>à régler</span>
                    )}
                    {p.archived_at && p.open.length === 0 && (
                      <span title={p.archive_reason ?? "archivé"} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "rgba(240,185,11,0.15)", color: "#F0B90B" }}>archivé</span>
                    )}
                    {p.archived_at && p.links.length > 0 && (
                      <span title={"Lien actif (pas de l'argent) : " + p.links.join(", ")} style={{ padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "rgba(96,165,250,0.15)", color: "#60A5FA", whiteSpace: "nowrap" }}>lien actif</span>
                    )}
                    {/* Statut CRM : libellé manuel, sans effet sur l'affichage (seule l'archive masque). */}
                    <span title="Statut CRM" style={{
                      padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                      background: isActiveStatus(p.status) ? "rgba(16,185,129,0.15)" : "rgba(156,163,175,0.15)",
                      color: isActiveStatus(p.status) ? "#10B981" : "var(--text-muted)",
                    }}>{p.status}</span>
                  </div>
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }} onClick={e => e.stopPropagation()}>
                  <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
                    <button onClick={() => onEdit(p)} title="Edit" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                      <Pencil size={13} />
                    </button>
                    {p.archived_at ? (
                      <button
                        onClick={() => setArchived(p, false)}
                        disabled={archiving === p.id}
                        title="Désarchiver (retour dans la vue principale)"
                        style={{ background: "none", border: "1px solid rgba(240,185,11,0.4)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "#F0B90B", display: "flex", alignItems: "center", opacity: archiving === p.id ? 0.4 : 1 }}
                      >
                        <RotateCcw size={13} />
                      </button>
                    ) : (
                      <button
                        onClick={() => setArchived(p, true)}
                        disabled={archiving === p.id}
                        title={p.open.length > 0 ? "Archiver — il restera en tête d'« Archivés » (à régler : " + p.open.join(" ; ") + ")" : "Archiver (sort de la vue principale, réversible)"}
                        style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "var(--text-muted)", display: "flex", alignItems: "center", opacity: archiving === p.id ? 0.4 : 1 }}
                      >
                        <Archive size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
