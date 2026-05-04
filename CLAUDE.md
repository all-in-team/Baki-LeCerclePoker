# LeCerclePoker — Claude Code Instructions

## What this is
Internal ops + accounting tool for a single-operator poker affiliation business (Baki). NOT a SaaS. Audience = Baki only. Optimize for throughput and clarity over generality.

## Stack
- Next.js 15 App Router · React 19 · TS strict · Tailwind v4
- DB: better-sqlite3, raw SQL, no ORM. File: `data/lecercle.db` (local) / `/data/lecercle.db` (Railway volume)
- Charts: Recharts · Telegram: GramJS + Bot API · AI: @anthropic-ai/sdk · XLS: xlsx
- Deploy: Railway, auto-deploy from `main`. No Docker. Node 20.
- No auth (v1). No tests. No staging — `main` is prod.

## File routing — where things live
- Server reads (SQL) → `lib/queries.ts`
- Schema + migrations → `lib/db.ts` (`initSchema()` + `_applied_fixes`)
- Telegram bot → `lib/telegram-commands/*.ts` (one file per command, registered in `index.ts`)
- Pages → `app/*/page.tsx` · API routes → `app/api/**/route.ts`
- Shared UI → `components/`
- **Domain glossary (READ FIRST when touching balance / wallet / report code)** → `docs/DOMAIN.md`

## Domain — minimum mental model

- Each **player** has a **deal per game** (`player_game_deals`): `action_pct`, `rakeback_pct`, `insurance_pct`. Per-player-per-game, not global.
- **Action** = operator's % of player's winnings AND losses (both directions).
- **Rakeback / insurance** = % of those reported amounts the player gets back (operator pays out).
- **Reports** = data extracted from app screenshots (Claude Vision) or Wepoker XLS (deterministic parser). Stored in `rakeback_reports` + `rakeback_entries`.
- **Wallet transactions** = on-chain USDT movements (`wallet_transactions`), type `deposit | withdrawal`.

### Wallet direction rule (CRITICAL — got this wrong before, cost a migration)
- Incoming USDT to a player's **game wallet** = **deposit** (player funds their action).
- Incoming USDT to a player's **cashout wallet from `wallet_mère`** = **withdrawal** (operator pays the player).
- **Anything else is NOT a transaction.** Do not import. See invariant #1 below.

### Net balance formula (`getPlayerBalance` in `lib/queries.ts`)
```
net = winnings * (1 - action_pct/100)
    + (rakeback + insurance) * rakeback_pct / 100
    + wallet_withdrawn
    - wallet_deposited
```
Positive net = operator owes player. Negative = player owes operator.

Full glossary including currencies, exchange rates, club logic, legacy-vs-new accounting, in `docs/DOMAIN.md`. **Read it before any change to balance/wallet/report code.**

## Hard invariants — never violate without explicit Baki approval

1. **Cashout source rule.** Withdrawals come ONLY from `wallet_mère` → cashout wallets. Importing from any other source corrupts the ledger. (History: a "Pass 3" once imported thousands of phantom cashouts; required a full purge.)
2. **Money math lives in `lib/queries.ts` only.** No business math in route handlers, no math in client components. Routes = thin parameter validation + DB call + response.
3. **Currencies are tracked.** All amounts have a `currency` column. Aggregation across currencies MUST go through `toUsdt()`. Never sum raw amounts across currencies.
4. **Reports are player data, not operator framing.** `rakeback`, `insurance_amount`, `winnings_amount` are the player's numbers. Don't synthesize "Mon coût" or operator-side aggregates unless asked.
5. **Wepoker XLS column mapping.** `保险盈利` = insurance, `组局基金` = rake, `盈亏` = winnings. Use the deterministic parser in `app/api/reports/upload/route.ts`. Do NOT use Claude Vision for Wepoker XLS — Vision read the wrong columns repeatedly.
6. **Migrations are append-only.** Use `_applied_fixes` in `lib/db.ts`:
   ```ts
   const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("fix_name_v1");
   if (fix.changes > 0) { db.exec(`...`); }
   ```
   Never edit existing CREATE TABLE in `initSchema()` after it ships — add a new `_applied_fixes` migration.
7. **Don't touch legacy tables (`reports`, `accounting_entries`).** They're still queried by the dashboard for `getNetByApp` / `getNetByPlayer`. Removing them silently breaks `/`. Migration to the new system is a deliberate, scoped task — ask first.
8. **Wallet sync dedup is sacred.** `tron_tx_hash` UNIQUE + `INSERT OR IGNORE`. Never bypass.
9. **No float math at display.** Money stored as `REAL` (known pragmatic compromise). Round to 2 decimals at the *display boundary* only, never inside aggregations. Never compare floats with `==`.

## Workflow rules

- **Deploy without asking.** After any change that compiles, push to `main`. Commit style: `fix:` or `feat:` prefix, lowercase, single line.
- **Verify before saying "try it."** Workflow:
  1. `git push`
  2. Wait for Railway, then `curl -s https://lecerclepoker-production.up.railway.app/api/version`
  3. Confirm the returned SHA matches `git rev-parse HEAD`
  4. *Then* tell Baki to test
  
  If the deploy hasn't propagated, wait and retry. Don't punt verification to Baki.
- **Maximum work yourself.** Run lints, builds, curls, log inspections. Only ask Baki for credentials, 2FA codes, on-device approvals, physical actions.
- **Ask before acting** ONLY for:
  - DB-destructive ops (DROP, TRUNCATE, DELETE without WHERE)
  - Removing legacy tables/columns
  - Changes to cashout source logic in `app/api/wallets/sync/route.ts`
  - Changes to `getPlayerBalance()` math
  - Auth, payments, private-key handling
- **No new tests required.** Don't add a test suite unless asked.

## When in doubt — playbook

1. **Plan first** for anything touching `lib/queries.ts`, `lib/db.ts`, `app/api/wallets/sync/route.ts`, or any balance/P&L code. Use plan mode (Shift+Tab twice). Output: files I'll touch, invariants this affects, math change, migration name if any, rollback.
2. **Spawn `money-auditor` subagent** for any change to balance math. It reviews against the invariant list with fresh context.
3. **Telegram bot work** → handler in `lib/telegram-commands/`, register in `index.ts`. Webhook entry: `app/api/telegram/webhook/route.ts`.
4. **TRON / wallet sync work** → re-read `docs/DOMAIN.md` § "Wallet sync" first. Cashout source rule is the easiest invariant to break.

## Compact policy

When summarizing this conversation:
- **Preserve:** decisions about money math, schema changes, the wallet-direction model, deployed SHAs, error→resolution pairs, list of modified files.
- **Discard:** styling debates, generic Next.js syntax help, exploratory dead ends.

## Deployment specifics

- Host: Railway (project `LeCerclePoker`)
- Production URL: https://lecerclepoker-production.up.railway.app
- Verify deploy: `curl .../api/version` returns deployed commit SHA
- Auto-deploy: GitHub `all-in-team/Baki-LeCerclePoker` `main`. Fallback if broken: `railway up --ci --detach`
- CLI auth: `contact.baki77777@gmail.com`. Re-link: `railway link --project LeCerclePoker --service lecerclepoker`
- Key env vars: `TRONGRID_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `ADMIN_RECONCILE_TOKEN`