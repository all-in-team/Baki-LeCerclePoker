// Journal des actions exécutées par l'agent Telegram (Baki 2026-07-27).
// Garde-fou : toute écriture déclenchée par le bot doit être visible ici, avec
// l'état avant/après, pour qu'elle soit auditable et défaisable à la main.
// Server component : lecture directe, pas d'état client.
import { getActionLog } from "@/lib/agent-actions";

function pretty(json: string | null): string {
  if (!json || json === "null") return "—";
  try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; }
}

export default function AgentActionLog() {
  const rows = getActionLog(50);

  return (
    <div style={{ marginTop: 24, padding: 18, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
        Actions de l&apos;agent Telegram
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
        Chaque écriture déclenchée depuis le bot, après confirmation explicite de l&apos;opérateur.
        50 dernières. L&apos;état avant/après est conservé pour pouvoir défaire à la main.
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Aucune action exécutée pour l&apos;instant.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Quand</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Action</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Par</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Résultat</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Détail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px", color: "var(--text-muted)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {r.executed_at}
                  </td>
                  <td style={{ padding: "8px", color: "var(--text)" }}>
                    <code>{r.tool}</code>
                    {r.level === "sensitive" && (
                      <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(239,68,68,0.15)", color: "#EF4444" }}>
                        SENSIBLE
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "8px", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{r.actor}</td>
                  <td style={{ padding: "8px", color: r.ok ? "var(--green)" : "#EF4444" }}>
                    {r.ok ? (r.summary ?? "OK") : `échec — ${r.error ?? "?"}`}
                  </td>
                  <td style={{ padding: "8px" }}>
                    <details>
                      <summary style={{ cursor: "pointer", color: "var(--text-dim)", fontSize: 11 }}>avant / après</summary>
                      <pre style={{ margin: "6px 0 0", fontSize: 10, color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
{`params : ${pretty(r.params_json)}
avant  : ${pretty(r.before_json)}
après  : ${pretty(r.after_json)}`}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
