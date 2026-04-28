# LeCerclePoker

## Project overview

Next.js 15 dashboard for managing a poker affiliation business. Tracks players across multiple poker apps (TELE AKPOKER, Wepoker, Xpoker, ClubGG), handles reports, accounting, and Telegram-based cash flow tracking.

**Stack:** Next.js 15 App Router, Tailwind CSS v4, better-sqlite3 (SQLite on Railway volume at `/data/lecercle.db`), Recharts, Lucide icons. No auth in v1.

**Architecture:** Server components read DB directly via `lib/queries.ts` (synchronous better-sqlite3). Client components use fetch to `/api/*` routes for mutations.

**How to run:** `npm run dev` → http://localhost:3000

## Deployment

- **Host:** Railway (project `LeCerclePoker`, workspace `contactbaki77777-rgb` — migration to `all-in-team` pending)
- **Production URL:** https://lecerclepoker-production.up.railway.app
- **Deploy verification:** `curl .../api/version` returns deployed commit SHA
- **Auto-deploy:** GitHub source connected to `all-in-team/Baki-LeCerclePoker`, branch `main`. If auto-deploy breaks, fallback: `railway up --ci --detach`
- **Railway CLI auth:** logged in as `contact.baki77777@gmail.com`. Run `railway link --project LeCerclePoker --service lecerclepoker` to re-link if needed.

## Key env vars (Railway)

- `TRONGRID_API_KEY` — TronGrid API key for TELE wallet sync (per-key rate limit, avoids shared-IP 429s)
- `TELEGRAM_BOT_TOKEN` — Telegram bot integration
- `ANTHROPIC_API_KEY` — Agent/doer features

## TELE wallet sync (`/api/wallets/sync`)

Scans the TRON blockchain for USDT (TRC20) transfers to track player deposits and cashouts.

**Architecture:**
- Pass 1: For each player with a `wallet_game` (tron_address), fetch incoming TRC20 transfers → insert as deposits
- Pass 2: Fetch outgoing transfers from `wallet_mere` (global), filter by known cashout addresses → insert as withdrawals
- Dedup: `tron_tx_hash` UNIQUE index + `INSERT OR IGNORE`. Multiple sync clicks are safe.

**Rate limiting:** TronGrid free tier = 1 RPS per IP. Railway shares egress IPs across tenants. Fix: global throttle (`MIN_SPACING_MS = 1500`) + 429 retry with 12s cooldown. The `TRONGRID_API_KEY` is the real solution — gives per-key quota instead of per-IP.

**Data model:**
- `wallet_transactions.counterparty_address` — who sent (deposits) or received (withdrawals). Stored on sync, backfilled for existing rows on next sync.
- `wallet_transactions.tron_tx_hash` — blockchain transaction ID. Links to `https://tronscan.org/#/transaction/{hash}`

## DB migrations

Auto-run on app boot via `lib/db.ts`. One-time fixes use `_applied_fixes` table (insert name, check changes > 0, run migration). Pattern:
```js
const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("fix_name_v1");
if (fix.changes > 0) { db.exec(`...`); }
```

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. The
skill has multi-step workflows, checklists, and quality gates that produce better
results than an ad-hoc answer. When in doubt, invoke the skill. A false positive is
cheaper than a false negative.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke /office-hours
- Strategy, scope, "think bigger", "what should we build" → invoke /plan-ceo-review
- Architecture, "does this design make sense" → invoke /plan-eng-review
- Design system, brand, "how should this look" → invoke /design-consultation
- Design review of a plan → invoke /plan-design-review
- Developer experience of a plan → invoke /plan-devex-review
- "Review everything", full review pipeline → invoke /autoplan
- Bugs, errors, "why is this broken", "wtf", "this doesn't work" → invoke /investigate
- Test the site, find bugs, "does this work" → invoke /qa (or /qa-only for report only)
- Code review, check the diff, "look at my changes" → invoke /review
- Visual polish, design audit, "this looks off" → invoke /design-review
- Developer experience audit, try onboarding → invoke /devex-review
- Ship, deploy, create a PR, "send it" → invoke /ship
- Merge + deploy + verify → invoke /land-and-deploy
- Configure deployment → invoke /setup-deploy
- Post-deploy monitoring → invoke /canary
- Update docs after shipping → invoke /document-release
- Weekly retro, "how'd we do" → invoke /retro
- Second opinion, codex review → invoke /codex
- Safety mode, careful mode, lock it down → invoke /careful or /guard
- Restrict edits to a directory → invoke /freeze or /unfreeze
- Upgrade gstack → invoke /gstack-upgrade
- Save progress, "save my work" → invoke /context-save
- Resume, restore, "where was I" → invoke /context-restore
- Security audit, OWASP, "is this secure" → invoke /cso
- Make a PDF, document, publication → invoke /make-pdf
- Launch real browser for QA → invoke /open-gstack-browser
- Import cookies for authenticated testing → invoke /setup-browser-cookies
- Performance regression, page speed, benchmarks → invoke /benchmark
- Review what gstack has learned → invoke /learn
- Tune question sensitivity → invoke /plan-tune
- Code quality dashboard → invoke /health
