import { createHmac } from "crypto";
import { getDb } from "./db";

/**
 * RichAds — tracking des clics d'acquisition payante (test dzpk, $150).
 *
 * Module AUTONOME : aucune dépendance au money engine, aux players ni au funnel
 * Nexa. Le trafic acheté atterrit sur un lien d'invitation de groupe Telegram,
 * donc il n'existe ni /start ni lead à qui rattacher une source. La conversion
 * se mesure hors système, via le report agent du club.
 *
 * Principe directeur : ON NE PERD JAMAIS UN CLIC. Toute anomalie est marquée,
 * jamais bloquée — un clic frauduleux reste facturé par RichAds, il doit
 * apparaître dans les stats.
 */

export type FraudFlag = "duplicate" | "suspect_ip" | "no_ua";

/** Préfixe de source, même famille de nommage que le funnel. */
export const RICHADS_SOURCE_PREFIX = "richads";

/**
 * Correspondance optionnelle id RichAds → nom lisible, pour l'AFFICHAGE seul.
 * RichAds ne transmet qu'un identifiant numérique via [CREATIVE_ID] : la table
 * se remplit une fois les créas créées, et un id absent d'ici reste valide — il
 * s'affiche brut.
 *
 * Volontairement non stockée sur la ligne de clic : renommer une créa plus tard
 * ne doit pas réécrire l'historique déjà loggé.
 */
export const CRE_LABELS: Record<string, string> = {
  // "48211": "instant",
  // "48212": "usdt",
  // "48213": "antitriche",
};

export function creLabel(cre: string): string {
  return CRE_LABELS[cre] ?? cre;
}

/** Au-delà de ce nombre de clics déjà loggés par IP sur la fenêtre, on flague. */
export const IP_BURST_THRESHOLD = 10;
export const IP_BURST_WINDOW_MIN = 60;

// ---------------------------------------------------------------- config

/** Destination du redirect. Jamais en dur : c'est un paramètre de campagne. */
export function getDestUrl(): string | null {
  const url = process.env.RICHADS_DEST_URL?.trim();
  return url && url !== "" ? url : null;
}

/**
 * Sel du hachage d'IP. Doit être stable : s'il change, la fenêtre de détection
 * de rafale repart de zéro. Repli sur AUTH_SECRET pour que le endpoint ne tombe
 * jamais faute de config — perdre un clic serait pire que hacher avec un sel
 * moins dédié.
 */
function ipSalt(): string {
  return process.env.RICHADS_IP_SALT || process.env.AUTH_SECRET || "richads-fallback-salt";
}

// ---------------------------------------------------------------- sanitisation

/**
 * `cre` est l'identifiant attribué par RichAds, pas un slug choisi par nous :
 * aucune liste blanche, toute valeur bien formée est acceptée telle quelle.
 *
 * Le contrôle de FORME reste indispensable — la valeur vient d'une query string
 * publique et finit en base puis dans le back-office. Renvoyé en "unknown" :
 *   - vide ou absent
 *   - macro non substituée : RichAds envoie littéralement "[CREATIVE_ID]" quand
 *     la campagne est mal configurée. Les crochets échouent au format, donc le
 *     symptôme est VISIBLE dans les stats au lieu de passer inaperçu.
 *   - hors charset ou > 32 caractères
 */
export function normalizeCre(cre: string | null | undefined): string {
  if (!cre) return "unknown";
  const c = cre.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(c)) return "unknown";
  return c;
}

/**
 * Dimensions identifiantes opaques (cid, sid, app, pu). On ne devine pas leur
 * sémantique, on valide la forme. Hors format → null plutôt qu'une troncature
 * silencieuse : une colonne vide se repère dans les stats, une valeur amputée
 * passe pour vraie.
 */
export function cleanToken(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  return /^[A-Za-z0-9._:-]{1,64}$/.test(t) ? t : null;
}

/**
 * [COUNTRY] renvoie un NOM de pays ("Malaysia", "United Kingdom",
 * "Côte d'Ivoire"), pas un code ISO. Donc ni majuscules forcées, ni troncature
 * courte : les deux mutilent la donnée. Le contrôle de forme reste, la valeur
 * s'affichant dans le back-office.
 */
export function cleanGeoName(v: string | null | undefined): string | null {
  if (v == null) return null;
  const g = v.trim().replace(/\s+/g, " ");
  if (g === "") return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} .'()-]{0,63}$/u.test(g) ? g : null;
}

const BOT_UA = /bot|crawl|spider|slurp|curl\/|wget|python-requests|okhttp|headless|phantomjs|scrapy|libwww|java\/|go-http-client/i;

export function looksAutomated(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.trim() === "") return true;
  return BOT_UA.test(userAgent);
}

function parseCost(cost: string | null | undefined): number | null {
  if (cost == null || cost === "") return null;
  const n = Number(cost);
  return Number.isFinite(n) ? n : null;
}

export function hashIp(ip: string): string {
  return createHmac("sha256", ipSalt()).update(ip).digest("hex").slice(0, 32);
}

/**
 * Extrait l'IP client derrière le proxy Railway. `trustedHops` = nombre de
 * proxys que l'on contrôle ; on lit l'entrée à cette distance de la fin, sinon
 * n'importe qui usurpe son IP via son propre X-Forwarded-For et se rend
 * invisible au flag suspect_ip. Bornée aux deux extrémités pour que le mode
 * local (aucun proxy) rende bien le seul hop présent.
 */
export function clientIpFromXff(xff: string | null | undefined, trustedHops = 1): string | null {
  if (!xff) return null;
  const hops = xff.split(",").map(s => s.trim()).filter(Boolean);
  if (hops.length === 0) return null;
  const idx = Math.min(hops.length - 1, Math.max(0, hops.length - trustedHops));
  return hops[idx] ?? null;
}

// ---------------------------------------------------------------- log

export interface RawClick {
  cre?: string | null;
  cid?: string | null;
  sid?: string | null;
  app?: string | null;
  geo?: string | null;
  cost?: string | null;
  pu?: string | null;
  cb?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  // utm_content double cb pour le comptage RichAds : volontairement absent.
}

/**
 * Scoring + insertion. Appelé APRÈS l'envoi du 302, jamais sur le trajet de la
 * réponse. Ne lève jamais : un échec de log ne doit pas remonter dans le
 * endpoint, le clic est déjà parti chez Telegram.
 */
export function logRichAdsClick(raw: RawClick): void {
  try {
    const db = getDb();

    const cre = normalizeCre(raw.cre);
    const clickId = cleanToken(raw.cb);
    const ipHash = raw.ip ? hashIp(raw.ip) : null;
    const userAgent = raw.userAgent ? raw.userAgent.slice(0, 512) : null;

    const flags: FraudFlag[] = [];

    // duplicate — click_id rejoué. Sans click_id on ne peut rien conclure :
    // absence de preuve, donc pas de flag.
    if (clickId) {
      const seen = db.prepare(`SELECT 1 FROM richads_clicks WHERE click_id = ? LIMIT 1`).get(clickId);
      if (seen) flags.push("duplicate");
    }

    // suspect_ip — le seuil porte sur les clics DÉJÀ loggés : le (N+1)-ième est
    // le premier flagué.
    if (ipHash) {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM richads_clicks
         WHERE ip_hash = ? AND clicked_at >= datetime('now', ?)`
      ).get(ipHash, `-${IP_BURST_WINDOW_MIN} minutes`) as { n: number };
      if (row.n >= IP_BURST_THRESHOLD) flags.push("suspect_ip");
    }

    if (looksAutomated(userAgent)) flags.push("no_ua");

    db.prepare(
      `INSERT INTO richads_clicks
         (source, cre, cid, sid, app, geo, cost, user_type, click_id, ip_hash, user_agent, flags, is_unique)
       VALUES (@source, @cre, @cid, @sid, @app, @geo, @cost, @user_type, @click_id, @ip_hash, @user_agent, @flags, @is_unique)`
    ).run({
      source: `${RICHADS_SOURCE_PREFIX}/${cre}`,
      cre,
      cid: cleanToken(raw.cid),
      sid: cleanToken(raw.sid),
      app: cleanToken(raw.app),
      geo: cleanGeoName(raw.geo),
      cost: parseCost(raw.cost),
      user_type: cleanToken(raw.pu),
      click_id: clickId,
      ip_hash: ipHash,
      user_agent: userAgent,
      flags: flags.join(","),
      is_unique: flags.length === 0 ? 1 : 0,
    });
  } catch (err: any) {
    console.error("[RICHADS] log failed:", err?.message);
  }
}

// ---------------------------------------------------------------- stats

export interface RichAdsBreakdownRow {
  key: string;
  label: string;
  clicks: number;
  unique: number;
  flagged: number;
  flaggedPct: number;
  cost: number;
}

export interface RichAdsDayRow {
  day: string;
  clicks: number;
  unique: number;
  cost: number;
}

export interface RichAdsTotals {
  clicks: number;
  unique: number;
  flagged: number;
  flaggedPct: number;
  cost: number;
  duplicate: number;
  suspectIp: number;
  noUa: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface RichAdsStats {
  totals: RichAdsTotals;
  byCre: RichAdsBreakdownRow[];
  bySid: RichAdsBreakdownRow[];
  byApp: RichAdsBreakdownRow[];
  byGeo: RichAdsBreakdownRow[];
  byDay: RichAdsDayRow[];
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Ventilation par dimension. `col` est un nom de colonne interne au module,
 * jamais une entrée utilisateur — pas de risque d'injection.
 */
function breakdown(col: "cre" | "sid" | "app" | "geo"): RichAdsBreakdownRow[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT COALESCE(${col}, '—')                       AS key,
            COUNT(*)                                     AS clicks,
            SUM(is_unique)                               AS uniq,
            COALESCE(SUM(cost), 0)                       AS cost
     FROM   richads_clicks
     GROUP  BY COALESCE(${col}, '—')
     ORDER  BY clicks DESC`
  ).all() as { key: string; clicks: number; uniq: number; cost: number }[];

  return rows.map(r => {
    const flagged = r.clicks - r.uniq;
    return {
      key: r.key,
      label: col === "cre" ? creLabel(r.key) : r.key,
      clicks: r.clicks,
      unique: r.uniq,
      flagged,
      flaggedPct: pct(flagged, r.clicks),
      cost: r.cost,
    };
  });
}

export function getRichAdsStats(): RichAdsStats {
  const db = getDb();

  const t = db.prepare(
    `SELECT COUNT(*)                                              AS clicks,
            COALESCE(SUM(is_unique), 0)                           AS uniq,
            COALESCE(SUM(cost), 0)                                AS cost,
            SUM(CASE WHEN flags LIKE '%duplicate%'  THEN 1 ELSE 0 END) AS duplicate,
            SUM(CASE WHEN flags LIKE '%suspect_ip%' THEN 1 ELSE 0 END) AS suspect_ip,
            SUM(CASE WHEN flags LIKE '%no_ua%'      THEN 1 ELSE 0 END) AS no_ua,
            MIN(clicked_at)                                       AS first_at,
            MAX(clicked_at)                                       AS last_at
     FROM   richads_clicks`
  ).get() as {
    clicks: number; uniq: number; cost: number;
    duplicate: number | null; suspect_ip: number | null; no_ua: number | null;
    first_at: string | null; last_at: string | null;
  };

  const flagged = t.clicks - t.uniq;

  const byDay = db.prepare(
    `SELECT substr(clicked_at, 1, 10)   AS day,
            COUNT(*)                    AS clicks,
            COALESCE(SUM(is_unique), 0) AS uniq,
            COALESCE(SUM(cost), 0)      AS cost
     FROM   richads_clicks
     GROUP  BY day
     ORDER  BY day`
  ).all() as { day: string; clicks: number; uniq: number; cost: number }[];

  return {
    totals: {
      clicks: t.clicks,
      unique: t.uniq,
      flagged,
      flaggedPct: pct(flagged, t.clicks),
      cost: t.cost,
      duplicate: t.duplicate ?? 0,
      suspectIp: t.suspect_ip ?? 0,
      noUa: t.no_ua ?? 0,
      firstAt: t.first_at,
      lastAt: t.last_at,
    },
    byCre: breakdown("cre"),
    bySid: breakdown("sid"),
    byApp: breakdown("app"),
    byGeo: breakdown("geo"),
    byDay: byDay.map(d => ({ day: d.day, clicks: d.clicks, unique: d.uniq, cost: d.cost })),
  };
}
