"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Modal from "@/components/Modal";
import Badge from "@/components/Badge";
import Btn from "@/components/Btn";
import { Plus, Trash2, Pencil } from "lucide-react";

interface Player {
  id: number;
  name: string;
  telegram_handle: string | null;
  status: "active" | "inactive" | "churned";
  tier: "S" | "A" | "B" | null;
  notes: string | null;
  tron_address: string | null;
  tron_app_id: number | null;
  app_count: number;
  active_apps: number;
  created_at: string;
}

interface App { id: number; name: string; }

const TIER_STYLE: Record<string, { color: string; bg: string }> = {
  S: { color: "#000",      bg: "var(--gold)" },
  A: { color: "var(--green)", bg: "rgba(34,197,94,0.15)" },
  B: { color: "var(--text-muted)", bg: "rgba(136,136,160,0.15)" },
};

const BLANK_ADD = { name: "", telegram_handle: "", telegram_phone: "", tier: "A" as "S" | "A" | "B" };
const BLANK_EDIT = { name: "", telegram_handle: "", telegram_phone: "", tier: "A" as "S" | "A" | "B", status: "active" as "active" | "inactive" | "churned", notes: "", tron_address: "", tron_app_id: "" };

export default function PlayersClient({ initialPlayers, apps }: { initialPlayers: Player[]; apps: App[] }) {
  const router = useRouter();
  const [players, setPlayers] = useState(initialPlayers);
  const [modal, setModal] = useState<"add" | "edit" | null>(null);
  const [editing, setEditing] = useState<Player | null>(null);
  const [addForm, setAddForm] = useState(BLANK_ADD);
  const [editForm, setEditForm] = useState(BLANK_EDIT);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = players.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.telegram_handle ?? "").toLowerCase().includes(search.toLowerCase())
  );

  function openAdd() { setAddForm(BLANK_ADD); setModal("add"); }
  function openEdit(p: Player) {
    setEditing(p);
    setEditForm({
      name: p.name,
      telegram_handle: p.telegram_handle ?? "",
      telegram_phone: (p as any).telegram_phone ?? "",
      tier: p.tier ?? "A",
      status: p.status,
      notes: p.notes ?? "",
      tron_address: p.tron_address ?? "",
      tron_app_id: p.tron_app_id ? String(p.tron_app_id) : "",
    });
    setModal("edit");
  }
  function closeModal() { setModal(null); setEditing(null); }

  async function submitAdd() {
    setBusy(true);
    const res = await fetch("/api/players", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addForm),
    });
    if (res.ok) { window.location.reload(); }
    setBusy(false);
  }

  async function submitEdit() {
    setBusy(true);
    const payload = { ...editForm, tron_app_id: editForm.tron_app_id ? Number(editForm.tron_app_id) : null };
    const res = await fetch(`/api/players/${editing!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) { closeModal(); window.location.reload(); }
    setBusy(false);
  }

  async function del(id: number) {
    if (!confirm("Delete this player? This cannot be undone.")) return;
    await fetch(`/api/players/${id}`, { method: "DELETE" });
    setPlayers(p => p.filter(x => x.id !== id));
  }

  return (
    <>
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
        <Btn variant="primary" onClick={openAdd}><Plus size={15} /> Add Player</Btn>
      </div>

      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Telegram</th>
              <th>Tier</th>
              <th>Apps</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr key="empty"><td colSpan={6} style={{ textAlign: "center", color: "var(--text-dim)", padding: 32 }}>
                {search ? "No players found" : "No players yet"}
              </td></tr>
            )}
            {filtered.map(p => {
              const tier = p.tier ?? "A";
              const ts = TIER_STYLE[tier];
              return (
                <tr key={p.id}>
                  <td>
                    <Link href={`/players/${p.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}
                      onMouseEnter={e => (e.currentTarget.style.color = "var(--green)")}
                      onMouseLeave={e => (e.currentTarget.style.color = "var(--text)")}>
                      {p.name}
                    </Link>
                  </td>
                  <td style={{ color: "var(--text-muted)" }}>
                    {p.telegram_handle
                      ? `@${p.telegram_handle.replace(/^@/, "")}`
                      : (p as any).telegram_phone
                        ? (p as any).telegram_phone
                        : "—"}
                  </td>
                  <td>
                    <span style={{
                      display: "inline-block", padding: "2px 10px", borderRadius: 5,
                      fontSize: 12, fontWeight: 700, background: ts.bg, color: ts.color,
                    }}>
                      {tier}
                    </span>
                  </td>
                  <td>
                    <span style={{ color: p.active_apps > 0 ? "var(--green)" : "var(--text-dim)" }}>
                      {p.active_apps} active
                    </span>
                    <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>/ {p.app_count}</span>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.created_at.slice(0, 10)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <Btn size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil size={13} /></Btn>
                      <Btn size="sm" variant="danger" onClick={() => del(p.id)}><Trash2 size={13} /></Btn>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add modal — minimal */}
      <Modal open={modal === "add"} onClose={closeModal} title="Add Player">
        <FormField label="Name *">
          <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="Player name" autoFocus />
        </FormField>
        <FormField label="Telegram Handle">
          <input value={addForm.telegram_handle} onChange={e => setAddForm(f => ({ ...f, telegram_handle: e.target.value }))} placeholder="@handle" />
        </FormField>
        <FormField label="Numéro Telegram (si pas de handle)">
          <input value={addForm.telegram_phone} onChange={e => setAddForm(f => ({ ...f, telegram_phone: e.target.value }))} placeholder="+33 6 12 34 56 78" />
        </FormField>
        <FormField label="Tier">
          <div style={{ display: "flex", gap: 8 }}>
            {(["S", "A", "B"] as const).map(t => {
              const ts = TIER_STYLE[t];
              const active = addForm.tier === t;
              return (
                <button key={t} onClick={() => setAddForm(f => ({ ...f, tier: t }))} style={{
                  flex: 1, padding: "10px", borderRadius: 7, cursor: "pointer", fontWeight: 700,
                  fontSize: 15, border: active ? `2px solid ${ts.color === "#000" ? "var(--gold)" : ts.color}` : "1px solid var(--border)",
                  background: active ? ts.bg : "var(--bg-elevated)",
                  color: active ? ts.color : "var(--text-dim)",
                }}>
                  {t}
                </button>
              );
            })}
          </div>
        </FormField>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="secondary" onClick={closeModal}>Cancel</Btn>
          <Btn variant="primary" disabled={!addForm.name.trim() || busy} onClick={submitAdd}>
            {busy ? "Saving…" : "Add Player"}
          </Btn>
        </div>
      </Modal>

      {/* Edit modal — full options */}
      <Modal open={modal === "edit"} onClose={closeModal} title="Edit Player">
        <FormField label="Name *">
          <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} placeholder="Player name" />
        </FormField>
        <FormField label="Telegram Handle">
          <input value={editForm.telegram_handle} onChange={e => setEditForm(f => ({ ...f, telegram_handle: e.target.value }))} placeholder="@handle" />
        </FormField>
        <FormField label="Numéro Telegram (si pas de handle)">
          <input value={editForm.telegram_phone} onChange={e => setEditForm(f => ({ ...f, telegram_phone: e.target.value }))} placeholder="+33 6 12 34 56 78" />
        </FormField>
        <FormField label="Tier">
          <div style={{ display: "flex", gap: 8 }}>
            {(["S", "A", "B"] as const).map(t => {
              const ts = TIER_STYLE[t];
              const active = editForm.tier === t;
              return (
                <button key={t} onClick={() => setEditForm(f => ({ ...f, tier: t }))} style={{
                  flex: 1, padding: "10px", borderRadius: 7, cursor: "pointer", fontWeight: 700,
                  fontSize: 15, border: active ? `2px solid ${ts.color === "#000" ? "var(--gold)" : ts.color}` : "1px solid var(--border)",
                  background: active ? ts.bg : "var(--bg-elevated)",
                  color: active ? ts.color : "var(--text-dim)",
                }}>
                  {t}
                </button>
              );
            })}
          </div>
        </FormField>
        <FormField label="Status">
          <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value as any }))}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="churned">Churned</option>
          </select>
        </FormField>
        <FormField label="Notes">
          <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Optional" style={{ resize: "vertical" }} />
        </FormField>
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--gold)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
            TELE WT — Adresse Tron
          </div>
          <FormField label="Tron Address (TRC20)">
            <input value={editForm.tron_address} onChange={e => setEditForm(f => ({ ...f, tron_address: e.target.value.trim() }))} placeholder="TXxx..." />
          </FormField>
          <FormField label="Linked App">
            <select value={editForm.tron_app_id} onChange={e => setEditForm(f => ({ ...f, tron_app_id: e.target.value }))}>
              <option value="">Select app…</option>
              {apps.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
            </select>
          </FormField>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={closeModal}>Cancel</Btn>
          <Btn variant="primary" disabled={!editForm.name.trim() || busy} onClick={submitEdit}>
            {busy ? "Saving…" : "Save Changes"}
          </Btn>
        </div>
      </Modal>
    </>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
