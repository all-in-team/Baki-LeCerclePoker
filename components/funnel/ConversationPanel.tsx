"use client";

// Panneau conversation d'un lead — historique complet + champ de réponse.
//
// La réponse part par POST /api/nexa-funnel/conversation, qui appelle replyToLead() :
// exactement le même chemin que la réponse depuis Telegram, donc le même effet sur
// takeover_until. Rien n'est envoyé depuis ce composant.
//
// Couleurs : conventions du back-office, inchangées.
//   • lead     → bleu   (#60A5FA), aligné à gauche
//   • bot auto → gris   (#8888A0), aligné à droite
//   • opérateur→ vert   (#34D399), aligné à droite
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDateTime } from "@/lib/funnels/shared";

export type ConversationMessage = {
  id: number;
  direction: "in" | "out";
  sender: string;
  kind: string;
  text: string | null;
  created_at: string;
};

type LeadHead = {
  id: number;
  label: string;
  blocked: number;
  takeover_active: boolean;
  takeover_until: string | null;
  takeover_by: string | null;
  /** Sujet Telegram du lead — null tant qu'aucun n'a été créé. */
  topic_url: string | null;
};

/**
 * Les messages sortants sont stockés tels qu'envoyés à Telegram, donc en HTML
 * (<b>, <code>, <a href>). On les affiche en texte : les rendre en HTML ouvrirait
 * une injection depuis un texte de lead, et laisser les balises brutes est illisible.
 */
function plain(text: string | null): string {
  if (!text) return "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 'operator:@hugo' → 'hugo' ; 'operator:dashboard' → 'dashboard'. */
function operatorOf(sender: string): string {
  return sender.slice("operator:".length).replace(/^@/, "");
}

function toneOf(m: ConversationMessage): { align: "flex-start" | "flex-end"; bg: string; label: string; labelColor: string } {
  if (m.direction === "in") {
    return { align: "flex-start", bg: "rgba(96,165,250,0.10)", label: "lead", labelColor: "#60A5FA" };
  }
  if (m.sender.startsWith("operator:")) {
    return { align: "flex-end", bg: "rgba(52,211,153,0.10)", label: `toi · ${operatorOf(m.sender)}`, labelColor: "#34D399" };
  }
  return { align: "flex-end", bg: "rgba(255,255,255,0.04)", label: "bot", labelColor: "#8888A0" };
}

const LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#555568",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8,
};

export default function ConversationPanel({ leadId, onChanged }: {
  leadId: number;
  /** Appelé après un envoi réussi — le tableau rafraîchit sa pastille. */
  onChanged?: () => void;
}) {
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [head, setHead] = useState<LeadHead | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nexa-funnel/conversation?lead_id=${leadId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) { setError(json?.error ?? "Chargement impossible"); return; }
      setMessages(json.messages);
      setHead(json.lead);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [leadId]);

  useEffect(() => { void load(); }, [load]);

  // Le bas de la liste est le message le plus récent : c'est là qu'on veut être.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setError(null);
    try {
      const res = await fetch("/api/nexa-funnel/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, text }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json?.error ?? "Envoi impossible"); return; }
      setMessages(json.messages);
      setDraft("");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    // Colonne flex qui REMPLIT son conteneur : c'est ce qui garde le champ de
    // réponse visible sans scroller, quelle que soit la longueur de l'historique.
    // Seule la liste des messages scrolle (flex:1 + minHeight:0).
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        <span>Conversation{messages ? ` (${messages.length})` : ""}</span>
        {head?.blocked === 1 && (
          <span style={{ fontSize: 10, color: "#F87171", fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
            🚫 le lead a bloqué le bot
          </span>
        )}
      </div>

      <div
        ref={scroller}
        style={{
          flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6,
          padding: 10, background: "#0B0D12", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
        }}
      >
        {messages === null && <div style={{ color: "#555568", fontSize: 11.5 }}>Chargement…</div>}
        {messages?.length === 0 && (
          <div style={{ color: "#555568", fontSize: 11.5 }}>
            Aucun message enregistré. L&apos;historique démarre au déploiement du live takeover.
          </div>
        )}
        {messages?.map(m => {
          const tone = toneOf(m);
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: tone.align }}>
              <div style={{ maxWidth: "78%", background: tone.bg, borderRadius: 10, padding: "7px 10px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: tone.labelColor }}>{tone.label}</span>
                  <span style={{ fontSize: 10, color: "#3A3A48" }}>{fmtDateTime(m.created_at)}</span>
                  {m.kind !== "text" && <span style={{ fontSize: 10, color: "#8888A0" }}>· {m.kind}</span>}
                </div>
                <div style={{ fontSize: 12.5, color: "#E8E8EE", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {plain(m.text)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "flex-end", flex: "none" }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}
          rows={2}
          placeholder="Répondre au lead — il recevra le message du bot…"
          style={{
            flex: 1, background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
            color: "#E8E8EE", padding: "8px 10px", fontSize: 12, resize: "vertical", fontFamily: "inherit",
          }}
        />
        <button
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          style={{
            padding: "9px 14px", borderRadius: 8, fontSize: 11.5, fontWeight: 700,
            cursor: sending || !draft.trim() ? "default" : "pointer",
            border: "1px solid rgba(52,211,153,0.35)", background: "#0B0D12",
            color: "#34D399", opacity: sending || !draft.trim() ? 0.45 : 1, whiteSpace: "nowrap",
          }}
        >
          {sending ? "…" : "➤ Envoyer"}
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: "#3A3A48", marginTop: 4, flex: "none" }}>
        ⌘/Ctrl + Entrée pour envoyer · l&apos;envoi repousse le takeover à +6 h
      </div>
      {error && <div style={{ fontSize: 11.5, color: "#F87171", marginTop: 6, flex: "none" }}>❌ {error}</div>}
    </div>
  );
}
