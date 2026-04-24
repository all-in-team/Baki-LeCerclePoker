"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  MessageCircle, Phone, DollarSign, AlertTriangle,
  StickyNote, Plus, Trash2, ExternalLink, Wallet, Clock,
} from "lucide-react";
import Badge from "@/components/Badge";
import Btn from "@/components/Btn";

interface PlayerCRM {
  id: number; name: string; telegram_handle: string | null; status: string;
  action_pct: number; last_note: string | null; last_activity: string | null;
  note_count: number; wallet_net: number; my_pnl: number;
  msg_count: number; last_msg_date: string | null;
}

interface CrmNote {
  id: number; player_id: number; player_name: string;
  content: string; type: string; created_at: string;
}

const NOTE_TYPES = [
  { value: "note", label: "Note", icon: StickyNote, color: "#8888a0" },
  { value: "call", label: "Appel", icon: Phone, color: "#60a5fa" },
  { value: "payment", label: "Paiement", icon: DollarSign, color: "#22c55e" },
  { value: "alert", label: "Alerte", icon: AlertTriangle, color: "#f87171" },
  { value: "message", label: "Message", icon: MessageCircle, color: "#d4af37" },
];

const STATUS_COLOR: Record<string, "green" | "gray" | "red"> = {
  active: "green", inactive: "gray", churned: "red",
};

function timeAgo(dateStr: string | null) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor(diff / 60000);
  if (d > 0) return `il y a ${d}j`;
  if (h > 0) return `il y a ${h}h`;
  return `il y a ${m}m`;
}

function NoteTypeIcon({ type, size = 13 }: { type: string; size?: number }) {
  const t = NOTE_TYPES.find(n => n.value === type) ?? NOTE_TYPES[0];
  return <t.icon size={size} color={t.color} />;
}

export default function CRMClient({ players, recentNotes }: {
  players: PlayerCRM[];
  recentNotes: CrmNote[];
}) {
  const [selected, setSelected] = useState<PlayerCRM | null>(null);
  const [notes, setNotes] = useState<CrmNote[]>(recentNotes);
  const [noteContent, setNoteContent] = useState("");
  const [noteType, setNoteType] = useState("note");
  const [saving, setSaving] = useState(false);

  const playerNotes = selected ? notes.filter(n => n.player_id === selected.id) : [];

  async function addNote() {
    if (!selected || !noteContent.trim()) return;
    setSaving(true);
    const res = await fetch("/api/crm/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: selected.id, content: noteContent.trim(), type: noteType }),
    });
    if (res.ok) {
      const { id } = await res.json();
      const newNote: CrmNote = {
        id, player_id: selected.id, player_name: selected.name,
        content: noteContent.trim(), type: noteType,
        created_at: new Date().toISOString(),
      };
      setNotes(prev => [newNote, ...prev]);
      setNoteContent("");
    }
    setSaving(false);
  }

  async function deleteNote(id: number) {
    await fetch(`/api/crm/notes/${id}`, { method: "DELETE" });
    setNotes(prev => prev.filter(n => n.id !== id));
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20, alignItems: "start" }}>

      {/* Player list */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {players.length} joueur{players.length !== 1 ? "s" : ""}
        </div>
        {players.map(p => {
          const isSelected = selected?.id === p.id;
          const pnlColor = p.my_pnl > 0 ? "var(--green)" : p.my_pnl < 0 ? "#f87171" : "var(--text-dim)";
          return (
            <div
              key={p.id}
              onClick={() => setSelected(isSelected ? null : p)}
              style={{
                padding: "14px 16px", cursor: "pointer", borderBottom: "1px solid var(--border)",
                background: isSelected ? "rgba(34,197,94,0.08)" : "transparent",
                borderLeft: isSelected ? "3px solid var(--green)" : "3px solid transparent",
                transition: "all 0.15s",
              }}
            >
              {/* Name row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
                  background: isSelected ? "rgba(34,197,94,0.2)" : "var(--bg-elevated)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 700, color: isSelected ? "var(--green)" : "var(--text-muted)",
                }}>
                  {p.name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{p.name}</div>
                  {p.telegram_handle && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>@{p.telegram_handle.replace(/^@/, "")}</div>
                  )}
                </div>
                <Badge label={p.status} color={STATUS_COLOR[p.status] ?? "gray"} />
              </div>

              {/* Stats row */}
              <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                <span style={{ color: pnlColor, fontWeight: 600 }}>
                  {p.my_pnl >= 0 ? "+" : ""}{p.my_pnl.toFixed(0)} USDT
                </span>
                <span style={{ color: "var(--text-dim)" }}>{p.note_count} note{p.note_count !== 1 ? "s" : ""}</span>
                {p.last_activity && (
                  <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>{timeAgo(p.last_activity)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail panel */}
      {!selected ? (
        <div style={{
          background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10,
          padding: 48, textAlign: "center", color: "var(--text-dim)", fontSize: 13,
        }}>
          Sélectionne un joueur pour voir son profil CRM
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Header card */}
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
              <div style={{
                width: 48, height: 48, borderRadius: "50%", flexShrink: 0,
                background: "rgba(34,197,94,0.15)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, fontWeight: 700, color: "var(--green)",
              }}>
                {selected.name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{selected.name}</span>
                  <Badge label={selected.status} color={STATUS_COLOR[selected.status] ?? "gray"} />
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {selected.telegram_handle && (
                    <a
                      href={`https://t.me/${selected.telegram_handle.replace(/^@/, "")}`}
                      target="_blank" rel="noreferrer"
                      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "#60a5fa", textDecoration: "none" }}
                    >
                      <MessageCircle size={13} /> @{selected.telegram_handle.replace(/^@/, "")}
                      <ExternalLink size={11} />
                    </a>
                  )}
                  <Link href={`/players/${selected.id}`} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}>
                    <ExternalLink size={13} /> Profil complet
                  </Link>
                </div>
              </div>
              {/* Mini P&L */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Mon P&L</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: selected.my_pnl >= 0 ? "var(--green)" : "#f87171" }}>
                  {selected.my_pnl >= 0 ? "+" : ""}{selected.my_pnl.toFixed(0)} USDT
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{selected.action_pct}% action</div>
              </div>
            </div>

            {/* Wallet + messages stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              {[
                { icon: <Wallet size={14} />, label: "Net joueur", value: (selected.wallet_net >= 0 ? "+" : "") + selected.wallet_net.toFixed(0) + " USDT", color: selected.wallet_net >= 0 ? "var(--green)" : "#f87171" },
                { icon: <StickyNote size={14} />, label: "Notes CRM", value: String(selected.note_count), color: "var(--text)" },
                { icon: <MessageCircle size={14} />, label: "Messages Tg", value: selected.msg_count > 0 ? String(selected.msg_count) : "—", color: "var(--text-muted)" },
              ].map(s => (
                <div key={s.label} style={{ background: "var(--bg-elevated)", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11, marginBottom: 4 }}>{s.icon}{s.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Telegram messages preview */}
          {selected.msg_count > 0 && (
            <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                <MessageCircle size={14} color="#60a5fa" />
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Messages Telegram</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>
                  {selected.last_msg_date ? `Dernier : ${timeAgo(selected.last_msg_date)}` : ""}
                </span>
              </div>
              <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>
                {selected.msg_count} message{selected.msg_count > 1 ? "s" : ""} importé{selected.msg_count > 1 ? "s" : ""}
                <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>— Sync Telegram pour voir le contenu</span>
              </div>
            </div>
          )}

          {/* Add note */}
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
              Ajouter une note
            </div>

            {/* Type selector */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {NOTE_TYPES.map(t => (
                <button
                  key={t.value}
                  onClick={() => setNoteType(t.value)}
                  style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
                    borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600, border: "none",
                    background: noteType === t.value ? "var(--bg-elevated)" : "transparent",
                    color: noteType === t.value ? t.color : "var(--text-dim)",
                    outline: noteType === t.value ? `1px solid ${t.color}33` : "none",
                  }}
                >
                  <t.icon size={12} /> {t.label}
                </button>
              ))}
            </div>

            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              placeholder="Ajoute une note, un rappel, un paiement reçu..."
              rows={3}
              style={{ resize: "vertical", width: "100%", marginBottom: 8 }}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addNote(); }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>⌘+Enter pour envoyer</span>
              <Btn variant="primary" onClick={addNote} disabled={!noteContent.trim() || saving}>
                <Plus size={13} /> {saving ? "Saving…" : "Ajouter"}
              </Btn>
            </div>
          </div>

          {/* Notes timeline */}
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                Activité ({playerNotes.length})
              </span>
            </div>

            {playerNotes.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                Aucune note — commence à suivre l'activité de ce joueur
              </div>
            ) : (
              <div style={{ padding: "8px 0" }}>
                {playerNotes.map((note, i) => (
                  <div key={note.id} style={{
                    padding: "12px 16px",
                    borderBottom: i < playerNotes.length - 1 ? "1px solid var(--border)" : "none",
                    display: "flex", gap: 12, alignItems: "flex-start",
                  }}>
                    <div style={{ marginTop: 2, flexShrink: 0 }}>
                      <NoteTypeIcon type={note.type} size={15} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, wordBreak: "break-word" }}>
                        {note.content}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          <Clock size={10} style={{ display: "inline", marginRight: 3 }} />
                          {timeAgo(note.created_at) ?? new Date(note.created_at).toLocaleDateString("fr-FR")}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "capitalize" }}>· {note.type}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => deleteNote(note.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 4, flexShrink: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#f87171")}
                      onMouseLeave={e => (e.currentTarget.style.color = "var(--text-dim)")}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Telegram bot setup */}
          <TelegramBotSetup />

        </div>
      )}
    </div>
  );
}

function TelegramBotSetup() {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; description?: string; url?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/telegram/setup").then(r => r.json()).then(d => {
      if (d.result) setStatus({ ok: true, url: d.result.url, description: d.result.url ? "Webhook actif" : "Non configuré" });
    }).catch(() => {});
  }, []);

  async function setup() {
    if (!webhookUrl.trim()) return;
    setBusy(true);
    const res = await fetch("/api/telegram/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookUrl: webhookUrl.trim() }),
    });
    const data = await res.json();
    setStatus({ ok: data.ok, description: data.description ?? data.error });
    setBusy(false);
  }

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <MessageCircle size={16} color="var(--green)" />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Auto-import Telegram</span>
        {status?.url && (
          <span style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px", borderRadius: 5, background: "rgba(34,197,94,0.12)", color: "var(--green)", fontWeight: 600 }}>
            Actif
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
        Le bot Telegram ajoute automatiquement les joueurs au CRM quand ils rejoignent un groupe dont le nom contient <strong style={{ color: "var(--text)" }}>"Le Cercle"</strong>.
        <br />
        Groupes avec d'autres noms → ne rien faire. Ajoute le bot comme admin et c'est tout.
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 16, background: "var(--bg-elevated)", borderRadius: 8, padding: "10px 14px", lineHeight: 1.8 }}>
        <strong style={{ color: "var(--text-muted)" }}>Setup (une seule fois) :</strong><br />
        1. Crée un bot → <strong>@BotFather</strong> sur Telegram → <code>/newbot</code><br />
        2. Copie le token dans <code>.env.local</code> → <code>TELEGRAM_BOT_TOKEN=...</code><br />
        3. Ajoute optionnellement <code>TELEGRAM_WEBHOOK_SECRET=mot_de_passe_random</code><br />
        4. Entre l'URL de l'app ci-dessous et clique Configurer<br />
        5. Ajoute le bot comme <strong>admin</strong> dans tes groupes "Le Cercle"
      </div>

      {status?.url && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
          Webhook actuel : <code style={{ color: "var(--green)" }}>{status.url}</code>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={webhookUrl}
          onChange={e => setWebhookUrl(e.target.value)}
          placeholder="https://ton-domaine.com"
          style={{ flex: 1, fontSize: 13 }}
        />
        <Btn variant="primary" disabled={!webhookUrl.trim() || busy} onClick={setup}>
          {busy ? "Configuring…" : "Configurer"}
        </Btn>
      </div>
      {status && !status.url && (
        <div style={{ marginTop: 8, fontSize: 12, color: status.ok ? "var(--green)" : "#f87171" }}>
          {status.description}
        </div>
      )}
    </div>
  );
}
