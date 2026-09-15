"use client";
// AK multi-Account — écran de clôture. AUCUN calcul ici : tout vient de
// /api/ak-multi/period (preview = lock, même fonction serveur). L'écran saisit des
// SOLDES et un instant, affiche ce que le serveur en dit, et n'envoie jamais un
// montant. Les avertissements (écart d'horodatage, OkPay non nulle, main en
// conflit, doublon) exigent une confirmation explicite avant « Régler » ; les
// blockers rendent le bouton inerte — c'est le serveur qui décide des deux.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Btn from "@/components/Btn";
import { parseMontant } from "@/app/nexapoker/BankrollSettlePanel";

const CARD: React.CSSProperties = { background: "#12141C", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 18 };
const INPUT: React.CSSProperties = { background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#E8E8EE", padding: "6px 8px", fontSize: 12 };
const MUTED = "#8888A0", DIM = "#555568", TEXT = "#E8E8EE", GOLD = "#F0B90B", GREEN = "#34D399", RED = "#F87171", CYAN = "#22D3EE", AMBER = "#F59E0B";
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const netColor = (n: number) => (Math.abs(n) < 0.005 ? MUTED : n > 0 ? GREEN : RED);

type PoolPlayer = { player_id: number; player_name: string; main_okpay_tg_id: string | null; action_pct: number | null };
type Candidate = { id: number; name: string; action_pct: number | null };
type Account = { id: number; label: string; ak_ref: string | null; okpay_tg_id: string | null; closed_at: string | null };
type Movement = { id: number; direction: "in" | "out"; amount: number; occurred_at: string; kind: "declared" | "settlement"; occurred_precision: "second" | "day"; settlement_id: number | null; note: string | null };
type Reading = { account_id: number | null; label: string; wallet_kind: "ak" | "okpay" | "main"; balance: number; observed_at: string; source: "manual" | "okpay_ledger" };
type Warning = { code: string; message: string };
type Computed = { result: number; action_amount: number; transfer_amount: number; next_br_open: number };
type Preview = {
  player_name: string; opened_at: string; closed_at: string; is_first: boolean; action_pct: number;
  pool_open: number | null; pool_open_source: "carry" | "manual"; carried_from: string | null;
  readings: Reading[]; pool_close: number | null; ext_in: number; ext_out: number; movements: Movement[];
  warnings: Warning[]; blockers: string[]; computed: Computed | null;
};
type Period = {
  id: number; opened_at: string; closed_at: string; pool_open: number; pool_open_source: string; pool_close: number;
  ext_in: number; ext_out: number; result: number; action_pct: number; action_amount: number;
  settlement_id: number | null; settlement_status: "locked" | "paid" | null; note: string | null;
  balances: { label: string; wallet_kind: string; balance: number; observed_at: string; source: string }[];
};
type LedgerInfo = { lines: { occurred_at: string; balance_after: number }[]; breaks: { before: { occurred_at: string }; after: { occurred_at: string }; missing_delta: number }[]; ambiguities: unknown[] };

/** « YYYY-MM-DDTHH:MM[:SS] » (datetime-local) ↔ « YYYY-MM-DD HH:MM:SS » (pool). */
const toPool = (v: string) => (v.length === 16 ? `${v}:00` : v).replace("T", " ");
const toLocal = (v: string) => v.replace(" ", "T");

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ...j } as any;
}

export default function AkMultiClient({ initialPlayers, serverNow }: { initialPlayers: PoolPlayer[]; serverNow: string }) {
  const [players, setPlayers] = useState<PoolPlayer[]>(initialPlayers);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<number | null>(initialPlayers[0]?.player_id ?? null);
  const player = players.find(p => p.player_id === selected) ?? null;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [ledger, setLedger] = useState<LedgerInfo | null>(null);

  // Le formulaire de clôture.
  const [closedAt, setClosedAt] = useState(toLocal(serverNow));
  const [bal, setBal] = useState<Record<number, { ak: string; okpay: string; observed: string }>>({});
  const [mainManual, setMainManual] = useState("");
  const [mainObserved, setMainObserved] = useState(toLocal(serverNow));
  const [poolOpenManual, setPoolOpenManual] = useState("");
  const [note, setNote] = useState("");
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Incrémenté à chaque mutation côté serveur (mouvement, compte, page OkPay, lock,
  // unlock) : l'aperçu — qui porte la liste des mouvements — doit être recalculé
  // même si aucune saisie n'a changé. Sans ça, un mouvement retiré restait affiché.
  const [revision, setRevision] = useState(0);
  const [previewPending, setPreviewPending] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const say = (kind: "ok" | "err", text: string) => { setFlash({ kind, text }); setTimeout(() => setFlash(null), 8000); };

  const refreshPlayers = useCallback(async () => {
    const j = await api("/api/ak-multi/players");
    if (j.ok) { setPlayers(j.enrolled); setCandidates(j.candidates); }
  }, []);

  const refreshPlayer = useCallback(async (pid: number, opts: { resetClock?: boolean } = {}) => {
    const [a, m, p] = await Promise.all([
      api(`/api/ak-multi/accounts?player_id=${pid}`), api(`/api/ak-multi/movements?player_id=${pid}`), api(`/api/ak-multi/period?player_id=${pid}`),
    ]);
    if (a.ok) setAccounts(a.accounts);
    if (m.ok) setMovements(m.movements);
    // L'instant de clôture saisi par Baki est PRÉSERVÉ après « déclarer », « retirer »,
    // « préciser l'heure », « corriger » : il ne se remet à « maintenant » qu'au
    // changement de joueur et après un lock/unlock (constat money-auditor 2026-09-15).
    if (p.ok) { setPeriods(p.periods); if (opts.resetClock && p.now) setClosedAt(toLocal(p.now)); }
    setRevision(r => r + 1);
    const pl = players.find(x => x.player_id === pid);
    if (pl?.main_okpay_tg_id) {
      const l = await api(`/api/ak-multi/okpay?wallet=${pl.main_okpay_tg_id}`);
      setLedger(l.ok ? l : null);
    } else setLedger(null);
  }, [players]);

  useEffect(() => { refreshPlayers(); }, [refreshPlayers]);
  useEffect(() => {
    if (selected !== null) { refreshPlayer(selected, { resetClock: true }); setPreview(null); setAcked(new Set()); setBal({}); setMainManual(""); setPoolOpenManual(""); }
  }, [selected, refreshPlayer]);

  const openAccounts = useMemo(() => accounts.filter(a => a.closed_at === null), [accounts]);

  // Soldes envoyés au serveur : chaque compte ouvert, AK + OkPay (OkPay pré-remplie à 0),
  // la main si saisie (sinon le serveur la lit sur le grand livre).
  const balancesPayload = useMemo(() => {
    const out: { account_id: number | null; wallet_kind: string; balance: number; observed_at: string }[] = [];
    for (const a of openAccounts) {
      const b = bal[a.id] ?? { ak: "", okpay: "0", observed: closedAt };
      const ak = parseMontant(b.ak), ok = parseMontant(b.okpay === "" ? "0" : b.okpay);
      const obs = toPool(b.observed || closedAt);
      if (ak !== undefined) out.push({ account_id: a.id, wallet_kind: "ak", balance: ak, observed_at: obs });
      if (ok !== undefined) out.push({ account_id: a.id, wallet_kind: "okpay", balance: ok, observed_at: obs });
    }
    const mm = parseMontant(mainManual);
    if (mm !== undefined) out.push({ account_id: null, wallet_kind: "main", balance: mm, observed_at: toPool(mainObserved || closedAt) });
    return out;
  }, [openAccounts, bal, closedAt, mainManual, mainObserved]);

  const previewArgs = useMemo(() => selected === null ? null : ({
    player_id: selected, closed_at: toPool(closedAt), balances: balancesPayload,
    pool_open_manual: parseMontant(poolOpenManual) ?? null, note: note || null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [selected, closedAt, balancesPayload, poolOpenManual, note, revision]);

  // Aperçu à la volée, débouncé : la même fonction serveur que le lock.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!previewArgs) return;
    if (timer.current) clearTimeout(timer.current);
    // Tant qu'un aperçu est en attente, le bouton « Régler » est inerte : le chiffre
    // lu par Baki doit être celui que le serveur figera (le serveur recalcule de toute
    // façon, mais l'écran ne doit pas montrer autre chose).
    setPreviewPending(true);
    timer.current = setTimeout(async () => {
      const j = await api("/api/ak-multi/period", { method: "POST", body: JSON.stringify({ mode: "preview", ...previewArgs }) });
      if (j.ok) { setPreview(j.preview); setPreviewErr(null); } else { setPreview(null); setPreviewErr(j.error ?? "aperçu impossible"); }
      setPreviewPending(false);
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [previewArgs]);

  const canLock = !previewPending && !!preview && preview.blockers.length === 0 && !!preview.computed && preview.pool_open !== null
    && preview.warnings.every(w => acked.has(w.code + w.message));

  async function lock() {
    if (!previewArgs || !canLock) return;
    setBusy(true);
    const j = await api("/api/ak-multi/period", { method: "POST", body: JSON.stringify({ mode: "lock", ...previewArgs }) });
    setBusy(false);
    if (!j.ok) { say("err", j.error ?? "verrouillage refusé"); return; }
    say("ok", `Période figée. Résultat ${fmt(j.computed.result)} · ma part ${fmt(j.computed.action_amount)}`
      + (j.settlement_id ? ` · règlement #${j.settlement_id} à régler dans /payments` : " · part nulle, aucun règlement"));
    setBal({}); setMainManual(""); setPoolOpenManual(""); setNote(""); setAcked(new Set());
    if (selected !== null) refreshPlayer(selected, { resetClock: true });
  }

  async function unlock(periodId: number) {
    if (selected === null || !confirm("Déverrouiller la dernière période ? Son règlement (s'il n'est pas payé) est retiré, ses soldes effacés.")) return;
    const j = await api(`/api/ak-multi/period?player_id=${selected}&period_id=${periodId}`, { method: "DELETE" });
    if (!j.ok) { say("err", j.error); return; }
    say("ok", `Période close le ${j.closed_at} déverrouillée.`);
    refreshPlayer(selected, { resetClock: true });
  }

  // ── Comptes, mouvements, inscription, OkPay ──
  const [newAcc, setNewAcc] = useState({ label: "", ak_ref: "", okpay_tg_id: "" });
  async function addAccount() {
    if (selected === null) return;
    const j = await api("/api/ak-multi/accounts", { method: "POST", body: JSON.stringify({ player_id: selected, ...newAcc }) });
    if (!j.ok) { say("err", j.error); return; }
    setNewAcc({ label: "", ak_ref: "", okpay_tg_id: "" }); refreshPlayer(selected);
  }
  async function closeAccount(a: Account) {
    if (selected === null || !confirm(`Supprimer ${a.label} ? Refusé s'il portait encore un solde à la dernière clôture.`)) return;
    const j = await api(`/api/ak-multi/accounts?id=${a.id}`, { method: "DELETE" });
    if (!j.ok) { say("err", j.error); return; }
    refreshPlayer(selected);
  }
  const [newMv, setNewMv] = useState<{ direction: "in" | "out"; amount: string; at: string; note: string }>({ direction: "in", amount: "", at: "", note: "" });
  const [instant, setInstant] = useState<Record<number, string>>({});
  async function declareInstant(m: Movement) {
    const at = instant[m.id];
    if (!at || busy) return;
    if (!confirm(`Dater le règlement #${m.settlement_id} à ${toPool(at)} ?\n\nC'est une déclaration : si l'argent était encore sur la main au moment de la photo de clôture, l'heure doit être APRÈS la photo, sinon la période suivante sera fausse et ne se corrigera plus une fois payée.`)) return;
    setBusy(true);
    const j = await api("/api/ak-multi/movements", { method: "PATCH", body: JSON.stringify({ id: m.id, occurred_at: toPool(at) }) });
    setBusy(false);
    if (!j.ok) { say("err", j.error); return; }
    say("ok", `Règlement #${m.settlement_id} daté ${j.occurred_at} (heure déclarée).`);
    if (selected !== null) refreshPlayer(selected);
  }
  const [corr, setCorr] = useState<{ open: boolean; value: string; note: string }>({ open: false, value: "", note: "" });
  async function correctPoolOpen() {
    if (selected === null || busy) return;
    const v = parseMontant(corr.value);
    if (v === undefined) { say("err", "Pool de départ illisible."); return; }
    setBusy(true);
    const j = await api("/api/ak-multi/movements", { method: "POST", body: JSON.stringify({ player_id: selected, correct_pool_open: v, note: corr.note }) });
    setBusy(false);
    if (!j.ok) { say("err", j.error); return; }
    say("ok", `Correction enregistrée comme mouvement ${j.delta > 0 ? "entrée" : "sortie"} de ${fmt(Math.abs(j.delta))}, daté juste après la dernière clôture.`);
    setCorr({ open: false, value: "", note: "" });
    refreshPlayer(selected);
  }
  async function addMovement() {
    if (selected === null) return;
    const amount = parseMontant(newMv.amount);
    if (amount === undefined) { say("err", "Montant illisible."); return; }
    const j = await api("/api/ak-multi/movements", { method: "POST", body: JSON.stringify({
      player_id: selected, direction: newMv.direction, amount, occurred_at: toPool(newMv.at || closedAt), note: newMv.note || null }) });
    if (!j.ok) { say("err", j.error); return; }
    setNewMv({ direction: "in", amount: "", at: "", note: "" }); refreshPlayer(selected);
  }
  async function deleteMovement(id: number) {
    if (selected === null) return;
    const j = await api(`/api/ak-multi/movements?id=${id}`, { method: "DELETE" });
    if (!j.ok) { say("err", j.error); return; }
    refreshPlayer(selected);
  }
  const [enroll, setEnroll] = useState({ player_id: "", main: "" });
  async function doEnroll() {
    const pid = Number(enroll.player_id);
    if (!pid) return;
    const j = await api("/api/ak-multi/players", { method: "POST", body: JSON.stringify({ player_id: pid, main_okpay_tg_id: enroll.main || null }) });
    if (!j.ok) { say("err", j.error); return; }
    setEnroll({ player_id: "", main: "" }); await refreshPlayers(); setSelected(pid);
  }
  const [mainEdit, setMainEdit] = useState("");
  async function saveMain() {
    if (selected === null) return;
    const j = await api("/api/ak-multi/players", { method: "POST", body: JSON.stringify({ player_id: selected, main_okpay_tg_id: mainEdit }) });
    if (!j.ok) { say("err", j.error); return; }
    setMainEdit(""); await refreshPlayers(); refreshPlayer(selected);
  }
  const [paste, setPaste] = useState("");
  const [pasteRes, setPasteRes] = useState<string | null>(null);
  async function ingestPaste() {
    const j = await api("/api/ak-multi/okpay", { method: "POST", body: JSON.stringify({ text: paste }) });
    if (!j.ok) { setPasteRes(`❌ ${j.error}`); return; }
    const owner = j.owner.kind === "main" ? `main de ${j.owner.player_name}` : j.owner.kind === "account" ? `${j.owner.label} de ${j.owner.player_name}` : j.owner.kind === "agency" ? "agence" : "wallet inconnue — à rattacher";
    setPasteRes(`✅ ${j.wallet_label ?? j.wallet_tg_id} (${j.wallet_tg_id}) — ${owner} · ${j.inserted} nouvelle(s), ${j.ignored} déjà connue(s)` + (j.resolved_settlements ? ` · ${j.resolved_settlements} règlement(s) daté(s) à la seconde` : ""));
    setPaste(""); if (selected !== null) refreshPlayer(selected);
  }

  const lastPeriod = periods[periods.length - 1];
  const mainReading = preview?.readings.find(r => r.wallet_kind === "main");

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {flash && <div style={{ ...CARD, padding: "10px 14px", borderColor: flash.kind === "ok" ? GREEN : RED, color: flash.kind === "ok" ? GREEN : RED, fontSize: 13 }}>{flash.text}</div>}

      {/* ── Joueur ── */}
      <div style={{ ...CARD, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: MUTED }}>Joueur</label>
        <select value={selected ?? ""} onChange={e => setSelected(e.target.value ? Number(e.target.value) : null)} style={{ ...INPUT, minWidth: 220 }}>
          <option value="">—</option>
          {players.map(p => <option key={p.player_id} value={p.player_id}>{p.player_name} · {p.action_pct ?? "?"} %</option>)}
        </select>
        {player && (
          <span style={{ fontSize: 12, color: MUTED }}>
            main OkPay : <b style={{ color: player.main_okpay_tg_id ? TEXT : RED }}>{player.main_okpay_tg_id ?? "non rattachée"}</b>
            {" "}<input placeholder="ID Telegram de la main" value={mainEdit} onChange={e => setMainEdit(e.target.value)} style={{ ...INPUT, width: 150, marginLeft: 8 }} />
            <Btn size="sm" onClick={saveMain} disabled={!mainEdit}>{player.main_okpay_tg_id ? "changer" : "rattacher"}</Btn>
            {player.action_pct === null || player.action_pct <= 0 ? <span style={{ color: RED, marginLeft: 10 }}>aucune part d'action sur AK multi-Account — à régler dans <a href="/crm/games" style={{ color: CYAN }}>Games &amp; Deals</a></span> : null}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <select value={enroll.player_id} onChange={e => setEnroll(s => ({ ...s, player_id: e.target.value }))} style={INPUT}>
            <option value="">+ inscrire un joueur…</option>
            {candidates.map(c => <option key={c.id} value={c.id}>{c.name}{c.action_pct ? ` · ${c.action_pct} %` : " · pas de deal"}</option>)}
          </select>
          <input placeholder="ID main OkPay (optionnel)" value={enroll.main} onChange={e => setEnroll(s => ({ ...s, main: e.target.value }))} style={{ ...INPUT, width: 170 }} />
          <Btn size="sm" variant="primary" onClick={doEnroll} disabled={!enroll.player_id}>Inscrire</Btn>
        </span>
      </div>

      {player && (
        <div style={{ display: "grid", gap: 18 }}>
          {/* ── Clôture ── */}
          <div style={{ ...CARD, display: "grid", gap: 14, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: 15, color: TEXT }}>Clôture</h3>
              <label style={{ fontSize: 12, color: MUTED }}>à l'instant</label>
              <input type="datetime-local" step={1} value={closedAt} onChange={e => setClosedAt(e.target.value)} style={INPUT} />
              <span style={{ fontSize: 11, color: DIM }}>heure murale, comme OkPay · serveur : {serverNow}</span>
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "baseline", fontSize: 13 }}>
              <span style={{ color: MUTED }}>Pool de départ</span>
              {preview?.is_first || (!preview && periods.length === 0) ? (
                <>
                  <input placeholder="à SAISIR (première période)" value={poolOpenManual} onChange={e => setPoolOpenManual(e.target.value)} style={{ ...INPUT, width: 180, borderColor: GOLD }} />
                  <span style={{ fontSize: 11, color: GOLD }}>jamais 0 par défaut, jamais repris d'AKS</span>
                </>
              ) : (
                <b style={{ color: TEXT }}>{preview?.pool_open !== null && preview?.pool_open !== undefined ? fmt(preview.pool_open) : lastPeriod ? fmt(lastPeriod.pool_close) : "—"}</b>
              )}
              {preview?.carried_from && <span style={{ fontSize: 11, color: DIM }}>repris de la clôture du {preview.carried_from}</span>}
              {preview && !preview.is_first && (
                <Btn size="sm" variant="ghost" onClick={() => setCorr(c => ({ ...c, open: !c.open }))} title="Le pool de départ est repris de la clôture figée. Le corriger crée un mouvement externe tracé, avec motif.">corriger…</Btn>
              )}
            </div>
            {preview && !preview.is_first && (preview.ext_in > 0 || preview.ext_out > 0) && preview.pool_open !== null && (
              <div style={{ fontSize: 11, color: DIM, marginTop: -8 }}>
                Avec les mouvements de la période (+{fmt(preview.ext_in)} / −{fmt(preview.ext_out)}), le pool de fin qui donne un résultat nul est <b style={{ color: MUTED }}>{fmt(preview.pool_open + preview.ext_in - preview.ext_out)}</b>
                {" "}— un règlement reçu ou versé compte ici, pas dans le pool de départ.
              </div>
            )}
            {corr.open && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${GOLD}`, borderRadius: 8, fontSize: 12 }}>
                <span style={{ color: GOLD }}>Corriger le pool de départ →</span>
                <input placeholder="nouveau pool de départ" value={corr.value} onChange={e => setCorr(c => ({ ...c, value: e.target.value }))} style={{ ...INPUT, width: 160 }} />
                <input placeholder="motif (obligatoire)" value={corr.note} onChange={e => setCorr(c => ({ ...c, note: e.target.value }))} style={{ ...INPUT, flex: 1, minWidth: 200 }} />
                <Btn size="sm" variant="primary" onClick={correctPoolOpen} disabled={busy || !corr.value || corr.note.trim().length < 3}>enregistrer la correction</Btn>
                <span style={{ color: DIM, width: "100%" }}>La clôture précédente reste figée : l'écart devient un mouvement externe daté juste après elle, visible ci-dessous, avec ton motif.</span>
              </div>
            )}

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ color: MUTED, fontSize: 11, textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>Compte</th><th style={{ padding: "4px 6px" }}>AK</th><th style={{ padding: "4px 6px" }}>OkPay</th><th style={{ padding: "4px 6px" }}>relevé à</th><th />
              </tr></thead>
              <tbody>
                {openAccounts.map(a => {
                  const b = bal[a.id] ?? { ak: "", okpay: "0", observed: closedAt };
                  const set = (patch: Partial<typeof b>) => setBal(s => ({ ...s, [a.id]: { ...b, ...patch } }));
                  const okNonZero = (parseMontant(b.okpay) ?? 0) > 0.004;
                  return (
                    <tr key={a.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding: "6px", whiteSpace: "nowrap" }}><b style={{ color: TEXT }}>{a.label}</b><div style={{ fontSize: 11, color: DIM }}>{a.ak_ref ?? ""}{a.okpay_tg_id ? ` · OkPay ${a.okpay_tg_id}` : ""}</div></td>
                      <td style={{ padding: "6px" }}><input value={b.ak} onChange={e => set({ ak: e.target.value })} placeholder="0.00" style={{ ...INPUT, width: 110 }} /></td>
                      <td style={{ padding: "6px" }}><input value={b.okpay} onChange={e => set({ okpay: e.target.value })} style={{ ...INPUT, width: 110, borderColor: okNonZero ? AMBER : undefined }} />
                        {okNonZero && <div style={{ fontSize: 11, color: AMBER }}>virement en route ?</div>}</td>
                      <td style={{ padding: "6px" }}><input type="datetime-local" step={1} value={b.observed} onChange={e => set({ observed: e.target.value })} style={{ ...INPUT, fontSize: 11 }} /></td>
                      <td style={{ padding: "6px", textAlign: "right" }}><Btn size="sm" variant="ghost" onClick={() => closeAccount(a)} title="Refusé si le compte portait un solde à la dernière clôture">supprimer</Btn></td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={{ padding: "6px" }} colSpan={5}>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <input placeholder={`Compte ${accounts.length + 1}`} value={newAcc.label} onChange={e => setNewAcc(s => ({ ...s, label: e.target.value }))} style={{ ...INPUT, width: 110 }} />
                      <input placeholder="réf. AK" value={newAcc.ak_ref} onChange={e => setNewAcc(s => ({ ...s, ak_ref: e.target.value }))} style={{ ...INPUT, width: 110 }} />
                      <input placeholder="ID OkPay du compte" value={newAcc.okpay_tg_id} onChange={e => setNewAcc(s => ({ ...s, okpay_tg_id: e.target.value }))} style={{ ...INPUT, width: 150 }} />
                      <Btn size="sm" onClick={addAccount}>+ ajouter un compte</Btn>
                    </span>
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                  <td style={{ padding: "6px", whiteSpace: "nowrap" }}><b style={{ color: TEXT }}>Wallet main</b><div style={{ fontSize: 11, color: DIM }}>{player.main_okpay_tg_id ? `OkPay ${player.main_okpay_tg_id}` : "non rattachée"}</div></td>
                  <td style={{ padding: "6px" }} colSpan={2}>
                    {mainReading && mainReading.source === "okpay_ledger" && !mainManual ? (
                      <span style={{ color: CYAN }}><b>{fmt(mainReading.balance)}</b> <span style={{ fontSize: 11 }}>lu sur le grand livre (dernière ligne {mainReading.observed_at})</span></span>
                    ) : (
                      <span style={{ fontSize: 11, color: MUTED }}>{player.main_okpay_tg_id ? "pas de ligne OkPay avant la clôture" : "transfère la page OkPay ou saisis :"}</span>
                    )}
                    <div><input value={mainManual} onChange={e => setMainManual(e.target.value)} placeholder="saisie manuelle (l'emporte sur le grand livre)" style={{ ...INPUT, width: 260, marginTop: 4 }} /></div>
                  </td>
                  <td style={{ padding: "6px" }}>{mainManual && <input type="datetime-local" step={1} value={mainObserved} onChange={e => setMainObserved(e.target.value)} style={{ ...INPUT, fontSize: 11 }} />}</td>
                  <td />
                </tr>
              </tbody>
            </table>

            {/* Mouvements externes de l'intervalle */}
            <div style={{ fontSize: 13 }}>
              <div style={{ color: MUTED, marginBottom: 6 }}>Mouvements externes {preview ? <span style={{ color: DIM, fontSize: 11 }}>dans ]{preview.opened_at}, {preview.closed_at}]</span> : null}</div>
              {movements.filter(m => m.kind === "settlement" && m.occurred_precision === "day" && !(preview?.movements ?? []).some(x => x.id === m.id)).map(m => (
                <div key={`d${m.id}`} style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 0", borderTop: "1px solid rgba(255,255,255,0.04)", opacity: 0.85 }}>
                  <span style={{ color: m.direction === "in" ? GREEN : RED, width: 60 }}>{m.direction === "in" ? "entrée" : "sortie"}</span>
                  <b style={{ color: TEXT, width: 90 }}>{fmt(m.amount)}</b>
                  <span style={{ color: MUTED, fontSize: 12 }}>{m.occurred_at} (jour, heure inconnue) — hors intervalle</span>
                  <span style={{ color: DIM, fontSize: 11 }}>règlement #{m.settlement_id}</span>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
                    <input type="datetime-local" step={1} value={instant[m.id] ?? toLocal(m.occurred_at)} onChange={e => setInstant(s => ({ ...s, [m.id]: e.target.value }))} style={{ ...INPUT, fontSize: 11 }} />
                    <Btn size="sm" onClick={() => declareInstant(m)} disabled={busy || !instant[m.id]}>préciser l'heure</Btn>
                  </span>
                </div>
              ))}
              {(preview?.movements ?? []).map(m => (
                <div key={m.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 0", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <span style={{ color: m.direction === "in" ? GREEN : RED, width: 60 }}>{m.direction === "in" ? "entrée" : "sortie"}</span>
                  <b style={{ color: TEXT, width: 90 }}>{fmt(m.amount)}</b>
                  <span style={{ color: MUTED, fontSize: 12 }}>{m.occurred_at}{m.occurred_precision === "day" ? " (jour, heure inconnue)" : ""}</span>
                  <span style={{ color: DIM, fontSize: 11 }}>{m.kind === "settlement" ? `règlement #${m.settlement_id}` : m.note ?? "déclaré"}</span>
                  {m.kind === "declared" && <Btn size="sm" variant="ghost" onClick={() => deleteMovement(m.id)}>retirer</Btn>}
                  {m.kind === "settlement" && m.occurred_precision === "day" && (
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
                      <input type="datetime-local" step={1} value={instant[m.id] ?? toLocal(m.occurred_at)} onChange={e => setInstant(s => ({ ...s, [m.id]: e.target.value }))} style={{ ...INPUT, fontSize: 11 }} title="Heure réelle du virement OkPay (agence ↔ main)" />
                      <Btn size="sm" onClick={() => declareInstant({ ...m })} disabled={busy || !instant[m.id]}>préciser l'heure</Btn>
                    </span>
                  )}
                </div>
              ))}
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                <select value={newMv.direction} onChange={e => setNewMv(s => ({ ...s, direction: e.target.value as "in" | "out" }))} style={INPUT}><option value="in">entrée</option><option value="out">sortie</option></select>
                <input placeholder="montant" value={newMv.amount} onChange={e => setNewMv(s => ({ ...s, amount: e.target.value }))} style={{ ...INPUT, width: 100 }} />
                <input type="datetime-local" step={1} value={newMv.at || closedAt} onChange={e => setNewMv(s => ({ ...s, at: e.target.value }))} style={{ ...INPUT, fontSize: 11 }} />
                <input placeholder="note" value={newMv.note} onChange={e => setNewMv(s => ({ ...s, note: e.target.value }))} style={{ ...INPUT, width: 140 }} />
                <Btn size="sm" onClick={addMovement} disabled={!newMv.amount}>+ déclarer</Btn>
              </div>
              <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>Mes versements et ses règlements s'inscrivent tout seuls au « marquer payé » de /payments — ne les redéclare pas ici.</div>
            </div>

            {/* Résultat */}
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 12, display: "grid", gap: 8 }}>
              {previewErr && <div style={{ color: RED, fontSize: 12 }}>{previewErr}</div>}
              {preview && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, fontSize: 12 }}>
                    <div><div style={{ color: MUTED }}>pool de fin</div><b style={{ color: TEXT, fontSize: 15 }}>{preview.pool_close !== null ? fmt(preview.pool_close) : "—"}</b></div>
                    <div><div style={{ color: MUTED }}>entrées / sorties</div><b style={{ color: TEXT }}>{fmt(preview.ext_in)} / {fmt(preview.ext_out)}</b></div>
                    <div><div style={{ color: MUTED }}>résultat</div><b style={{ color: preview.computed ? netColor(preview.computed.result) : DIM, fontSize: 15 }}>{preview.computed ? fmt(preview.computed.result) : "—"}</b></div>
                    <div><div style={{ color: MUTED }}>% action</div><b style={{ color: TEXT }}>{preview.action_pct} %</b></div>
                    <div><div style={{ color: MUTED }}>ma part</div><b style={{ color: preview.computed ? netColor(preview.computed.action_amount) : DIM, fontSize: 15 }}>{preview.computed ? fmt(preview.computed.action_amount) : "—"}</b>
                      {preview.computed && Math.abs(preview.computed.action_amount) > 0.004 && <div style={{ fontSize: 11, color: DIM }}>{preview.computed.action_amount < 0 ? "je lui verse sur sa main" : "il me règle depuis sa main"}</div>}</div>
                  </div>
                  {preview.blockers.map((b, i) => <div key={i} style={{ color: RED, fontSize: 12, padding: "6px 10px", background: "rgba(248,113,113,0.08)", borderRadius: 8 }}>⛔ {b}</div>)}
                  {preview.warnings.map(w => {
                    const k = w.code + w.message;
                    return (
                      <label key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start", color: AMBER, fontSize: 12, padding: "6px 10px", background: "rgba(245,158,11,0.08)", borderRadius: 8, cursor: "pointer" }}>
                        <input type="checkbox" checked={acked.has(k)} style={{ width: 16, height: 16, flex: "none", marginTop: 1 }}
                          onChange={e => setAcked(s => { const n = new Set(s); e.target.checked ? n.add(k) : n.delete(k); return n; })} />
                        <span style={{ flex: 1 }}>⚠️ {w.message} <i style={{ color: DIM }}>— je confirme</i></span>
                      </label>
                    );
                  })}
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <input placeholder="note (optionnelle)" value={note} onChange={e => setNote(e.target.value)} style={{ ...INPUT, flex: 1 }} />
                    <Btn variant="primary" onClick={lock} disabled={!canLock || busy}>Régler la période</Btn>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── Grand livre, historique ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 18, alignItems: "start" }}>
            <div style={CARD}>
              <h3 style={{ margin: "0 0 8px", fontSize: 15, color: TEXT }}>Grand livre OkPay de la main</h3>
              {ledger ? (
                <div style={{ fontSize: 12, color: MUTED }}>
                  {ledger.lines.length} ligne(s) · dernier solde <b style={{ color: TEXT }}>{ledger.lines.length ? ledger.lines[ledger.lines.length - 1].balance_after.toFixed(6) : "—"}</b>
                  {ledger.lines.length ? <span> au {ledger.lines[ledger.lines.length - 1].occurred_at}</span> : null}
                  <div style={{ marginTop: 6, color: ledger.breaks.length ? RED : GREEN }}>
                    {ledger.breaks.length === 0 ? "chaîne des soldes intacte" : `${ledger.breaks.length} rupture(s) — il manque une page : ` + ledger.breaks.map(b => `entre ${b.before.occurred_at} et ${b.after.occurred_at}`).join(" ; ")}
                  </div>
                </div>
              ) : <div style={{ fontSize: 12, color: DIM }}>aucune main rattachée, ou aucune page reçue</div>}
              <textarea value={paste} onChange={e => setPaste(e.target.value)} placeholder="Filet de secours : coller ici un message OkPay (« <Pseudo> Transaction:<id> » puis les blocs Type/Details/Amount/…). Le chemin normal est le transfert au bot Telegram." rows={5} style={{ ...INPUT, width: "100%", marginTop: 10, fontFamily: "monospace", fontSize: 11 }} />
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                <Btn size="sm" onClick={ingestPaste} disabled={!paste.trim()}>Ingérer</Btn>
                {pasteRes && <span style={{ fontSize: 12, color: pasteRes.startsWith("❌") ? RED : GREEN }}>{pasteRes}</span>}
              </div>
            </div>

            <div style={CARD}>
              <h3 style={{ margin: "0 0 8px", fontSize: 15, color: TEXT }}>Périodes figées</h3>
              {periods.length === 0 ? <div style={{ fontSize: 12, color: DIM }}>aucune — la première clôture fixe le pool de départ</div> : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ color: MUTED, fontSize: 11, textAlign: "left" }}>
                    <th style={{ padding: "4px 6px" }}>clôture</th><th style={{ padding: "4px 6px" }}>pool</th><th style={{ padding: "4px 6px" }}>ext</th><th style={{ padding: "4px 6px" }}>résultat</th><th style={{ padding: "4px 6px" }}>ma part</th><th style={{ padding: "4px 6px" }}>règlement</th><th />
                  </tr></thead>
                  <tbody>
                    {[...periods].reverse().map(p => (
                      <tr key={p.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} title={p.balances.map(b => `${b.label} ${b.wallet_kind.toUpperCase()} ${fmt(b.balance)} @ ${b.observed_at}`).join("\n")}>
                        <td style={{ padding: "5px 6px", color: TEXT }}>{p.closed_at}</td>
                        <td style={{ padding: "5px 6px", color: MUTED }}>{fmt(p.pool_open)} → <span style={{ color: TEXT }}>{fmt(p.pool_close)}</span></td>
                        <td style={{ padding: "5px 6px", color: MUTED }}>+{fmt(p.ext_in)} −{fmt(p.ext_out)}</td>
                        <td style={{ padding: "5px 6px", color: netColor(p.result) }}>{fmt(p.result)}</td>
                        <td style={{ padding: "5px 6px", color: netColor(p.action_amount), fontWeight: 600 }}>{fmt(p.action_amount)} <span style={{ color: DIM, fontWeight: 400 }}>({p.action_pct} %)</span></td>
                        <td style={{ padding: "5px 6px", color: p.settlement_status === "paid" ? GREEN : p.settlement_status === "locked" ? GOLD : DIM }}>
                          {p.settlement_id ? `#${p.settlement_id} ${p.settlement_status === "paid" ? "payé" : "à payer"}` : "part nulle"}
                        </td>
                        <td style={{ padding: "5px 6px", textAlign: "right" }}>
                          {lastPeriod?.id === p.id && p.settlement_status !== "paid" && <Btn size="sm" variant="ghost" onClick={() => unlock(p.id)}>déverrouiller</Btn>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
