/**
 * Reprise de la route d'extraction sur saturation de l'API (529).
 * Run: npx tsx scripts/nexa-extract-retry.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Qu'un 529 overloaded_error est retenté (3 reprises, délais croissants), │
 * │ qu'une 2e tentative qui réussit rend bien le résultat, qu'un 400 ou un  │
 * │ 401 n'est JAMAIS retenté, et que l'écran reçoit un message lisible au   │
 * │ lieu du JSON brut de l'API.                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ Que le modèle transcrit correctement — le SDK est simulé, aucun appel   │
 * │ réseau, aucune clé. La transcription est couverte par                   │
 * │ scripts/affiliate-screenshot.test.ts (post-traitement pur).             │
 * │ Les délais réels ne sont pas attendus : setTimeout est neutralisé.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-extract-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

// ── Faux SDK Anthropic ────────────────────────────────────────────────────
// On reproduit la hiérarchie d'erreurs que la route teste par `instanceof`.
// Le vrai SDK n'est jamais chargé : pas de réseau, pas de clé.
class APIError extends Error {
  status?: number;
  type?: string;
  constructor(status: number, type: string, message: string) {
    super(message); this.status = status; this.type = type;
  }
}
class APIStatusError extends APIError {}
class RateLimitError extends APIStatusError {}
class AuthenticationError extends APIStatusError {}
class PermissionDeniedError extends APIStatusError {}
class APIConnectionError extends APIError {}
class InternalServerError extends APIStatusError {}

/** Réponse vision valide minimale : une ligne, un total. */
const OK_SHEET = {
  month_label: "July 2026",
  week_label: "13.07.-19.07.",
  rows: [{
    nickname: "ImLePAD", member_id: "2518550", affiliate: "", deal_text: "40% NLH and MTT, 45% PLO, 55% Spins",
    nlh: "$1,000.00", mtt: "", plo: "", spins: "", affiliate_payment: "$400.00",
  }],
  total_payment: "$400.00",
};

/** Scénario : liste d'erreurs à jeter avant de (peut-être) réussir. */
let scenario: { throwErrors: Error[]; calls: number } = { throwErrors: [], calls: 0 };

class FakeAnthropic {
  static APIError = APIError;
  static APIStatusError = APIStatusError;
  static RateLimitError = RateLimitError;
  static AuthenticationError = AuthenticationError;
  static PermissionDeniedError = PermissionDeniedError;
  static APIConnectionError = APIConnectionError;
  static InternalServerError = InternalServerError;
  messages = {
    create: async () => {
      const i = scenario.calls++;
      if (i < scenario.throwErrors.length) throw scenario.throwErrors[i];
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(OK_SHEET) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };
  constructor(_opts?: unknown) { /* maxRetries ignoré : c'est la route qui pilote */ }
}

// ── Injection dans le require cache (patron de group-provisioning.test.ts) ──
const Module = require("module");
const originalResolve = Module._resolveFilename;
const SDK_ID = path.join(REPO, "__fake_anthropic_sdk__");
Module._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "@anthropic-ai/sdk") return SDK_ID;
  if (request.startsWith("@/")) return originalResolve.call(this, path.join(REPO, request.slice(2)), ...rest);
  return originalResolve.call(this, request, ...rest);
};
require.cache[SDK_ID] = {
  id: SDK_ID, filename: SDK_ID, loaded: true,
  exports: { __esModule: true, default: FakeAnthropic, ...FakeAnthropic },
} as any;

// Les délais réels rendraient la suite lente pour rien : on neutralise l'attente
// tout en ENREGISTRANT les durées demandées — c'est justement ce qu'on veut vérifier.
const waits: number[] = [];
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = ((fn: () => void, ms?: number) => {
  if (typeof ms === "number" && ms >= 1000) { waits.push(ms); return realSetTimeout(fn, 0); }
  return realSetTimeout(fn, ms);
}) as any;

process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-tests";

const { POST } = require(path.join(REPO, "app/api/nexa/affiliate/extract/route.ts"));

/** NextRequest porteuse d'un faux PNG. */
function makeRequest(): any {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
  return { formData: async () => fd };
}

const overloaded = () => new InternalServerError(529, "overloaded_error",
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');

async function run(errors: Error[]) {
  scenario = { throwErrors: errors, calls: 0 };
  waits.length = 0;
  const res = await POST(makeRequest());
  return { res, body: await res.json(), calls: scenario.calls, waits: [...waits] };
}

(async () => {
  console.log("\n══ 529 : la reprise finit par passer ══");
  {
    const { res, body, calls, waits: w } = await run([overloaded(), overloaded()]);
    eq("2 échecs puis succès → 3 appels", calls, 3);
    eq("délais croissants", w, [2000, 5000]);
    eq("HTTP 200", res.status ?? 200, 200);
    check("la transcription est rendue", body.ok === true, JSON.stringify(body).slice(0, 200));
    eq("la semaine est extraite", body.week_start, "2026-07-13");
  }

  console.log("\n══ 529 persistant : abandon avec un message lisible ══");
  {
    const errs = [overloaded(), overloaded(), overloaded(), overloaded()];
    const { res, body, calls, waits: w } = await run(errs);
    // 1 tentative + 3 reprises = 4 appels, puis abandon.
    eq("4 appels au total", calls, 4);
    eq("3 délais croissants", w, [2000, 5000, 10000]);
    eq("HTTP 503", res.status, 503);
    check("message lisible", /API saturée/.test(body.error), body.error);
    check("dit que rien n'est perdu", /rien n'a été perdu/i.test(body.error), body.error);
    // Le point du cas : plus AUCUN JSON brut de l'API à l'écran.
    check("aucun JSON brut de l'API", !/overloaded_error|\{"type"/.test(body.error), body.error);
  }

  console.log("\n══ Ce qui ne doit JAMAIS être retenté ══");
  {
    // Une image invalide ne deviendra pas valide en réessayant : retenter
    // brûlerait du temps et de l'argent pour la même erreur.
    const { body, calls } = await run([new APIStatusError(400, "invalid_request_error", '{"type":"error"}')]);
    eq("400 → un seul appel", calls, 1);
    check("message sans JSON brut", !/\{"type"/.test(body.error), body.error);

    const auth = await run([new AuthenticationError(401, "authentication_error", '{"type":"error"}')]);
    eq("401 → un seul appel", auth.calls, 1);
    check("message parle de la clé serveur", /clé API du serveur/.test(auth.body.error), auth.body.error);

    const rate = await run([new RateLimitError(429, "rate_limit_error", '{"type":"error"}')]);
    eq("429 → un seul appel (hors périmètre du retry)", rate.calls, 1);
    eq("HTTP 429", rate.res.status, 429);
    check("message parle du quota", /[Qq]uota/.test(rate.body.error), rate.body.error);

    const net = await run([new APIConnectionError(0, "connection_error", "socket hang up")]);
    eq("erreur réseau → un seul appel", net.calls, 1);
    check("message réseau lisible", /joindre l'API/.test(net.body.error), net.body.error);
  }

  console.log("\n══ Un 500 générique n'est pas une saturation ══");
  {
    // Seul le 529 / overloaded_error est retenté — un 500 est remonté tel quel.
    const { body, calls, res } = await run([new InternalServerError(500, "api_error", '{"type":"error"}')]);
    eq("500 → un seul appel", calls, 1);
    eq("HTTP 500", res.status, 500);
    check("message sans JSON brut", !/\{"type"/.test(body.error), body.error);
  }

  console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
})();
