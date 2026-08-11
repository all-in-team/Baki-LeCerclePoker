import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { peekIngestState, isIngestStale, runDzpkIngest, getCommissionTotals } from "@/lib/funnels/dzpk/ingest";
import { runMatching, resolveManually, flagContestedLinks, listPendingReconciliation, checkMatchCoherence } from "@/lib/funnels/dzpk/matcher";
import { dzpkClubBot, dzpkAgentName, dzpkClubLabel, INGEST_STALE_HOURS } from "@/lib/funnels/dzpk/config";

/**
 * Pilotage et observation de l'ingestion des notifs du club dzpk.
 *
 *   GET  → état : curseur, fraîcheur, compteurs par gabarit, unparsed récents
 *   POST → déclenche une passe immédiate (pour ne pas attendre le cron)
 *
 * Même garde que les autres routes api/admin : `x-admin-token`, fail-closed.
 */
function guard(req: NextRequest): NextResponse | null {
  const adminToken = process.env.ADMIN_RECONCILE_TOKEN;
  if (!adminToken) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== adminToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const db = getDb();
  const peer = dzpkClubBot();
  const state = peekIngestState(peer);

  const byKind = db.prepare(
    `SELECT parsed_kind, COUNT(*) AS n FROM dzpk_club_messages GROUP BY parsed_kind ORDER BY n DESC`
  ).all();

  // Les non-parsés ne sont pas une curiosité : c'est le signal qu'un gabarit a
  // changé. Ils sont remontés ici en clair pour être vus, pas comptés en silence.
  const unparsed = db.prepare(
    `SELECT src_msg_id, posted_at, unparsed_reason, substr(raw_text, 1, 220) AS extrait
       FROM dzpk_club_messages WHERE parsed_kind = 'unparsed'
      ORDER BY id DESC LIMIT 20`
  ).all();

  const foreign = db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_club_messages WHERE agent_is_mine = 0`
  ).get() as { n: number };

  // Agrégat monétaire délégué au module de domaine (invariant #2) : il y est
  // couvert par des tests, ce qu'un SQL inline dans un handler n'est jamais.
  const commissions = getCommissionTotals();

  // Taux d'auto-appariement qu'on OBTIENDRAIT, calculé sans rien écrire.
  // C'est le chiffre sur lequel se décide l'activation de l'auto — pas une
  // intuition. `runMatching({dryRun:true})` ne touche à aucune table.
  const wouldMatch = runMatching({ dryRun: true });

  return NextResponse.json({
    config: {
      peer,
      agent_name_set: Boolean(dzpkAgentName()),
      club_label_set: Boolean(dzpkClubLabel()),
      stale_after_hours: INGEST_STALE_HOURS,
    },
    cursor: state,
    stale: isIngestStale(state),
    messages_by_kind: byKind,
    foreign_agent_messages: foreign.n,
    // Agrégats par devise, jamais tous devises confondues (invariant #3).
    commissions_by_currency: commissions,
    matching_dry_run: wouldMatch,
    // collisions > 0 = deux notifications tombées sur le même lead : un
    // rattachement invisible. Seul symptôme observable d'une homonymie mal départagée.
    match_coherence: checkMatchCoherence(),
    reconciliation_pending: listPendingReconciliation(50),
    unparsed_recent: unparsed,
  });
}

/**
 * POST — trois actions, explicites.
 *
 *   {"action":"ingest"}                        passe d'ingestion immédiate
 *   {"action":"match"}                         résout et applique les appariements
 *   {"action":"resolve","club_message_id":N,
 *    "lead_id":M,"operator":"baki"}            rattachement manuel + mémorisation
 *
 * `match` n'est PAS enchaîné automatiquement après `ingest` : tant que le taux
 * d'auto-appariement n'est pas mesuré sur des données réelles, l'application des
 * effets reste un geste délibéré. Le GET expose ce taux via `matching_dry_run`.
 */
export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({} as any));
  const action = body.action ?? "ingest";

  if (action === "ingest") {
    const result = await runDzpkIngest();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }

  if (action === "match") {
    // Les liens devenus ambigus sont recalculés AVANT d'appliquer quoi que ce
    // soit : sans ça, un lien appris quand le nom était unique continuerait à
    // rattacher au premier venu malgré l'arrivée d'un homonyme.
    const contested = flagContestedLinks();
    const outcome = runMatching({ dryRun: Boolean(body.dry_run) });
    return NextResponse.json({ ok: true, contested, outcome, dry_run: Boolean(body.dry_run) });
  }

  if (action === "resolve") {
    const { club_message_id, lead_id, operator } = body;
    if (!Number.isInteger(club_message_id) || !Number.isInteger(lead_id)) {
      return NextResponse.json({ error: "club_message_id et lead_id requis (entiers)" }, { status: 400 });
    }
    const res = resolveManually(club_message_id, lead_id, String(operator ?? "admin"));
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }

  return NextResponse.json({ error: `action inconnue: ${action}` }, { status: 400 });
}
