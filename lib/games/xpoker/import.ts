// XPoker Twd — INGESTION du sheet hebdo : aperçu (zéro écriture) puis commit d'UN
// onglet avec une plage de dates CONFIRMÉE. Serveur uniquement (xlsx).
//
// Le fichier est reparsé au commit : le serveur ne garde rien entre les deux
// appels, et ce qui est écrit vient du fichier et du moteur, jamais d'un aperçu
// renvoyé par l'écran. Le mapping est dérivé des libellés (parse-sheet.ts) : un
// onglet futur, une colonne ajoutée ou un bloc décalé passent sans réécriture
// tant que les libellés sont là — et un libellé absent donne une erreur nommée,
// pas un import faux.
//
// SOURCE CONFIRMÉE (Baki, 2026-09-13) : le classeur du lien est celui qui fait
// foi ; 花順 ↔ 246579 reste une assertion de config, jamais vérifiée ni bloquante.

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { readXpokerWorkbook, parseXpokerTab, XpokerParseError, type XpokerParsedBlock, type XpokerParseOptions } from "./parse-sheet";
import { tabDateCandidates, proposeWeek, type WeekProposal } from "./tab-date";
import { commitImportOn, type CommitImportResult } from "./engine";
import { XPOKER_AGENT_ID, XPOKER_CLUB_NAME } from "./config";

type DB = Database.Database;

export function xpokerParseOptionsOn(db: DB): XpokerParseOptions {
  const agency = (db.prepare(`SELECT member_id FROM xpoker_agency_accounts`).all() as { member_id: string }[]).map(r => r.member_id);
  return { agentId: XPOKER_AGENT_ID, clubName: XPOKER_CLUB_NAME, agencyMemberIds: new Set(agency) };
}

export type TabPreview = {
  label: string;
  is_template: boolean;
  /** null = l'onglet n'a pas pu être lu (erreur nommée dans `error`). */
  block: XpokerParsedBlock | null;
  error: string | null;
  /** Semaine PROPOSÉE d'après le libellé et l'année suggérée — à confirmer, jamais appliquée seule. */
  proposals: WeekProposal[];
  /** Le libellé est ambigu (« 111 ») ou n'est pas une date (« Sheet1 »). */
  ambiguous: boolean;
  /** Player ID du bloc sans joueur rattaché (hors agence) — partiront en réconciliation. */
  unlinked: string[];
  /** Semaine déjà importée sous cette plage proposée (première proposition). */
  already_imported: { import_id: number; week_start: string } | null;
};

export type WorkbookPreview = {
  source: "xlsx" | "csv";
  file_hash: string;
  filename: string | null;
  year_suggested: number;
  tabs: TabPreview[];
};

/** Aperçu de TOUT le classeur — aucune écriture. */
export function previewWorkbookOn(db: DB, buffer: Buffer, filename: string | null, yearSuggested = new Date().getUTCFullYear()): WorkbookPreview {
  const wb = readXpokerWorkbook(buffer);
  const opts = xpokerParseOptionsOn(db);
  const file_hash = createHash("sha256").update(buffer).digest("hex");
  const gid = (db.prepare(`SELECT id FROM games WHERE name = 'XPOKER_TWD'`).get() as { id: number } | undefined)?.id ?? -1;
  const known = db.prepare(`SELECT 1 FROM player_game_ids WHERE game_id = ? AND external_id = ? AND status = 'active'`);
  const imported = db.prepare(`SELECT id, week_start FROM xpoker_imports WHERE week_start = ?`);

  const tabs: TabPreview[] = wb.tabs.map(t => {
    const candidates = tabDateCandidates(t.label);
    const proposals = candidates.map(c => proposeWeek(c, yearSuggested)).filter((p): p is WeekProposal => p !== null);
    const base = { label: t.label, is_template: t.is_template, proposals, ambiguous: proposals.length !== 1 };
    if (t.is_template) return { ...base, block: null, error: "onglet modèle (公版), ignoré", unlinked: [], already_imported: null };
    try {
      const block = parseXpokerTab(t.ws, t.label, opts);
      const unlinked = block.rows.filter(r => !r.is_agency && !known.get(gid, r.member_id)).map(r => r.member_id);
      const first = proposals[0];
      const ai = first ? (imported.get(first.week_start) as { id: number; week_start: string } | undefined) ?? null : null;
      return { ...base, block, error: null, unlinked, already_imported: ai ? { import_id: ai.id, week_start: ai.week_start } : null };
    } catch (e: any) {
      const msg = e instanceof XpokerParseError ? e.message : (e?.message ?? String(e));
      return { ...base, block: null, error: msg, unlinked: [], already_imported: null };
    }
  });
  return { source: wb.source, file_hash, filename, year_suggested: yearSuggested, tabs };
}

export type CommitTabArgs = {
  tab_label: string;
  /** Plage CONFIRMÉE par Baki. */
  week_start: string;
  week_end: string;
  override_reason?: string | null;
  note?: string | null;
  filename?: string | null;
};

/** Commit d'UN onglet : reparse du fichier, puis commitImportOn (atomique, refus checksum, taux figé). */
export function commitTabOn(db: DB, buffer: Buffer, a: CommitTabArgs): CommitImportResult {
  const wb = readXpokerWorkbook(buffer);
  const tab = wb.tabs.find(t => t.label === a.tab_label);
  if (!tab) return { ok: false, error: `Onglet « ${a.tab_label} » introuvable dans le fichier` };
  if (tab.is_template) return { ok: false, error: "L'onglet modèle ne s'importe pas" };
  let block: XpokerParsedBlock;
  try { block = parseXpokerTab(tab.ws, tab.label, xpokerParseOptionsOn(db)); }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  return commitImportOn(db, {
    block, week_start: a.week_start, week_end: a.week_end, source: wb.source,
    filename: a.filename ?? null, file_hash: createHash("sha256").update(buffer).digest("hex"),
    override_reason: a.override_reason ?? null, note: a.note ?? null,
  });
}
