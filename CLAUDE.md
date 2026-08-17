# LeCerclePoker — Claude Code Instructions

# 🛑 OPERATING RULES — READ BEFORE EVERY TASK

These rules override default behavior. Violation = stop and report.

## HARD LIMITS (numeric, no exceptions)
- **Max 2 retries** on any failing operation. 3rd attempt = STOP, report, ask.
- **Max 3 calls** to any single endpoint per task. Same result twice = STOP, reassess.
- **NO `until` / `while` polling loops.** Single check, report result, move on.
- **NO background-waiting** for deploys, queues, or state changes to settle.
- **Max 10 min wall-clock** per task before mandatory user checkpoint.
- **Max 1 deploy per task**, et UNIQUEMENT sur feu vert explicite de Baki (cf. § RAILWAY DEPLOY RULES). No speculative `railway up`.

## FORBIDDEN PATTERNS (specific failures observed in this repo)
- ❌ `until [ ... /api/version ... ]` polling — endpoint can return stale "local-dev" forever
- ❌ `railway up` when no code changed this session — SQL cleanup, env edits, queue drains, manual DB ops do NOT need deploys
- ❌ Polling Telegram `getWebhookInfo` more than once per task
- ❌ Auto-retry after failure — STOP, report, ask
- ❌ Claiming "live" / "working" / "deployed" without runtime curl + logs verification
- ❌ Chaining phases — execute ONE phase, report, wait for next prompt from user
- ❌ "Should propagate in a minute" / "should be fine" — verify or explicitly say "unknown / not verified"
- ❌ Inferring runtime state from git/commit logic ("commit X is deployed therefore commit Y is too")

## CONFIRMATION REQUIRED before:
- DELETE on production tables
- ALTER TABLE / schema migration
- UPDATE affecting >10 rows
- Touching: `wallet_transactions`, `weekly_settlements`, `player_game_deals`, `wallet_meres`, `player_wallet_games`, `player_wallet_cashouts`, financial columns in `players`
- Force-push, history rewrite, branch deletion
- Modifying env vars or Railway config
- Any operation that cannot be reverted with a simple `git revert`

## BEFORE CLAIMING "WORKING" / "LIVE" / "DEPLOYED"
Mandatory sequence — no shortcuts:
1. Code change committed + `railway up --ci --detach`
2. ONE check that deploy landed (single curl to `/api/version`, max 60s wait, no loop)
3. Runtime verify the CHANGED BEHAVIOR end-to-end (curl real endpoint, hit webhook with test payload, etc.)
4. `railway logs 2>&1 | tail -50` — scan for errors related to the change
5. THEN report "verified working" with the actual command output pasted as evidence

If any step fails → report "NOT verified, blocked by X". Never claim success on inference.

## MONEY-CRITICAL — MUST run `money-auditor` subagent before completing any task touching:
- wallet sync logic (`lib/queries.ts` wallet functions)
- `wallet_transactions` / `wallet_meres` reads or writes
- P&L computation (any `getPnl*` / `computePnl*` function)
- `weekly_settlements` table or settlements UI
- `player_game_deals` math (action_pct, rb_pct, ins_pct usage)

No exceptions. No "this is just a small change". Run money-auditor and paste its verdict in your final report.

## ESCALATION — STOP IMMEDIATELY when:
- Same endpoint returns the same result on 2 consecutive calls
- Deploy hasn't propagated 60s after `railway up --ci --detach`
- Any test fails (DO NOT auto-retry — report and ask)
- FK / CHECK / UNIQUE constraint error during DB op
- Unexpected schema state (column missing, table missing, type mismatch)
- 10+ min spent without measurable progress
- About to delete or modify production data outside the original task scope

When stopping: state current situation, list 2-3 options for proceeding, wait for user choice. Do NOT pick an option yourself.

## RAILWAY DEPLOY RULES

### 🛑 `railway up` = FEU VERT EXPLICITE DE BAKI, À CHAQUE FOIS
**AUCUN `railway up` sans accord explicite de Baki** — quelle que soit la session, quel que soit
le chantier, même si le code compile, même si "c'est juste pour vérifier".

`railway up` **envoie l'arbre de travail LOCAL**, quelle que soit la branche sur laquelle tu te
trouves. Ce n'est pas une commande de confort, c'est un déploiement en production. Le trigger git
de Railway, lui, ne suit que `main` : c'est donc `railway up` — et lui seul — qui met du code de
branche en prod.
*(Constat 2026-08-05 : la prod tournait sur `579e9f4`, un commit de la branche `nexa-rakeback`,
déployé par un `railway up` depuis une session Claude Code. Meta du déploiement : `cliCaller:
"claude_code"`, aucun hash de commit.)*

**`npm run deploy` compte comme un `railway up`** : `scripts/deploy.sh` l'appelle (ligne 20).
La règle couvre les deux, sans exception.

Ce qui NE déploie PAS, et ne demande donc pas de feu vert : `git commit`, et `git push` sur une
branche autre que `main`. Un push sur `main` déclenche le trigger github → demander avant.

### Le reste
- Git auto-deploy is UNRELIABLE on this project (silently skips commits). Quand Baki a donné son
  feu vert, utiliser `railway up --ci --detach` pour forcer.
- NEVER ask the user to check the Railway dashboard. Use Railway CLI from terminal.
- After `railway up --ci --detach`: ONE curl check on `/api/version`, accept the result. Do not loop.

## ONE PHASE AT A TIME
User gives ONE phase prompt. You execute. You report. You STOP. You wait for the next prompt.
- Do not anticipate the next phase
- Do not chain phases ("while I'm at it...")
- Do not deploy "to be safe"
- Do not start adjacent fixes
- Even if "obvious" — stop and wait

## END EVERY RESPONSE WITH THIS BLOCK:

```
## STATUS REPORT

**Did:** [exact files modified, commits, queries run, commands executed — concrete]

**Verified with evidence:** [test command + actual output pasted; if nothing verified, write "nothing verified this turn"]

**NOT verified / Unknown:** [explicit gaps — list them, don't hide them]

**Blocking issues:** [or "none"]

**Next user action required:** [exact phrase user should paste, OR "task complete, safe to proceed"]
```

## What this is
Internal ops + accounting tool for a single-operator poker affiliation business (Baki). NOT a SaaS. Audience = Baki only. Optimize for throughput and clarity over generality.

## Stack
- Next.js 15 App Router · React 19 · TS strict · Tailwind v4
- DB: better-sqlite3, raw SQL, no ORM. File: `data/lecercle.db` (local) / `/data/lecercle.db` (Railway volume)
- Charts: Recharts · Telegram: GramJS + Bot API · AI: @anthropic-ai/sdk · XLS: xlsx
- Deploy: Railway via `npm run deploy` (force-deploy + verify). Node 20.
- No auth (v1). No tests. No staging — `main` is prod.

## File routing — where things live
- Server reads (SQL) → `lib/queries.ts`
- Schema + migrations → `lib/db.ts` (`initSchema()` + `_applied_fixes`)
- Telegram bot → `lib/telegram-commands/*.ts` (one file per command, registered in `index.ts`)
- Live takeover (relais lead ↔ chat admin, historique `bot_messages`) → `lib/funnels/live-takeover.ts` · doc `docs/LIVE_TAKEOVER.md`
- Pages → `app/*/page.tsx` · API routes → `app/api/**/route.ts`
- Shared UI → `components/`
- **Domain glossary (READ FIRST when touching balance / wallet / report code)** → `docs/DOMAIN.md`
- Réserves du sélecteur de période /players (lifetime indicatif, custom en UTC) → `docs/PLAYERS_PERIOD_RESERVES.md`

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
- ⚠️ **Exception NEXAPOKER — le sens du grand livre n'est pas celui de la bankroll.** Le
  versement d'une part d'action est un `withdrawal` qui **entre** dans la bankroll du joueur ;
  son règlement d'une semaine gagnante est un `deposit` qui ne la **touche pas**. Le calcul
  BR somme sur `br_effect`, jamais sur `type`. Détail et règle d'exploitation :
  `docs/DOMAIN.md` § « NEXAPOKER — le sens du grand livre n'est PAS le sens de la bankroll ».

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
10. **Every `wallet_transactions` row must have a source.** Column `source` must be `'sync'` (with a non-null `tron_tx_hash`) or `'manual'` (from the manual entry form). `'unknown'` is a transitional legacy state — new rows must never use it. Unknown rows are excluded from all aggregates (KPIs, balances, charts) via `AND (wt.source IS NULL OR wt.source != 'unknown')` in every query, and may be purged via `/api/admin/delete-phantom-wallets`. Enforced by a `BEFORE INSERT` trigger. (History: phantom rows with no hash and no manual marker appeared from unknown origin — corrupted P&L views.)
11. **Locked weekly settlements are immutable.** Settlements are editable until Baki explicitly clicks "Lock week". Before lock, Baki can include/exclude individual transactions per player via `weekly_settlement_tx_overrides`. Lock anchor = last cashout's tx_datetime in the final transaction set. Recompute deletes overrides and rebuilds from scratch (with confirmation dialog). On lock: all `auto_settled` rows flip to `settled`, period.status='locked'. `computeWeek` refuses to overwrite locked periods. Late transactions (tx_datetime within a locked week but arriving after lock) belong to the next open week. Once `weekly_settlement_periods.status='locked'`, its `weekly_settlements` rows and overrides are immutable.

## Workflow rules

- **AUTO-COMMIT RULE.** After completing any feature, fix, or meaningful change, always run `git add` + `git commit` + `git push` automatically before declaring the work done. Never leave uncommitted work waiting for user approval to commit. The user will catch problems by testing on Railway, not by reviewing local commits.
- **Commit sans demander, DÉPLOYER JAMAIS sans demander.** Après un changement qui compile : commit
  (style `fix:`/`feat:`, minuscules, une ligne). Le déploiement, lui, attend le feu vert explicite de
  Baki — voir § RAILWAY DEPLOY RULES. (Cette ligne disait « deploy to prod » sans condition : c'est
  cette formulation qui a mis du code de branche en prod.)
- **Quand Baki a dit oui, utiliser `npm run deploy`.** Ne jamais compter sur `git push` seul — le trigger
  github ne suit que `main`. Le script fait : push → `railway up --ci` → vérification `/api/version`
  (plafond 5 min). ⚠️ Il appelle `railway up` : il EST un déploiement, il exige le même feu vert.
- If deploy script reports "❌" → check Railway build logs. Otherwise never needed.
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
- **Deploy command: `npm run deploy`** (push + `railway up --ci` + verify `/api/version`)
- Verify deploy: `curl .../api/version` returns build-time git SHA (baked in at `next build` via `next.config.ts`)
- CLI auth: `contact.baki77777@gmail.com`. Re-link: `railway link --project LeCerclePoker --service lecerclepoker`
- Key env vars: `TRONGRID_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `ADMIN_RECONCILE_TOKEN`

## Hard limits on retries

- NEVER poll the same endpoint more than 3 times in any tool call.
- If a tool returns the same result twice, STOP and reassess.
- Background "wait for deploy" loops are FORBIDDEN. The deploy script handles waiting with a hard 5-min cap.

## Builds & long-running commands

- Le push vers main EST la validation (Railway build = vrai test). Le build local est SKIPPÉ par défaut.
- Workflow standard : (1) écrire le code, (2) commit + push immédiatement, (3) UNE vérification curl /api/version après ~2 min pour confirmer le deploy.
- npm run build local : UNIQUEMENT si explicitement demandé par l'utilisateur. Dans ce cas : timeout 5 min max via `timeout 300 npm run build`, jamais en background détaché.
- INTERDIT : lancer un process en background avec & qui survit à la fin du tour. Tout process lancé doit être terminé (kill) avant de rendre la main.
- Avant chaque nouvelle session de travail : pkill -f "next build" 2>/dev/null; pkill -f "npm run" 2>/dev/null (cleanup des zombies éventuels).

## Money-critical commits

- Any commit touching wallet sync, wallet_transactions, P&L math, wallet_meres, settlements → MUST run money-auditor before push.

## Project gotchas

### Game ID conventions
- Internal `TELE` = user-facing `AKPOKER` (legacy product name)
- `KKPOKER` = same internal/external name
- ALWAYS: `SELECT id FROM games WHERE name='X'` — never hardcode integer game_ids

### Player wallets — 2 storage systems
- **LEGACY (AKPOKER bot):** `players.tron_address`, `players.tele_wallet_cashout` — single pair, game-agnostic
- **NEW (KKPOKER+ future games):** `player_wallet_games` and `player_wallet_cashouts` tables with `game_id INTEGER`, `UNIQUE(player_id, address, game_id)`
- KKPOKER pages do NOT read legacy columns (`useLegacyWalletFallback=false` prop)

### Shared multi-game components
`TELEClient` and `SettlementsClient` are multi-game via props:
- `gameLabel`: `"TELE AKPOKER"` (default) or `"KKPOKER"`
- `basePath`: `"/tele"` (default) or `"/kkpoker/pnl"`
- `useLegacyWalletFallback`: `true` (default) or `false` (KKPOKER)
- Pass `game_id` explicitly in wallet queries

### Wallet mères
- Table: `wallet_meres` (`game_id`, `address`, `status`, `label`)
- Helpers in `lib/queries.ts`:
  - `getActiveWalletMeresForGame(gameId)` → `Set<string>` for sync logic
  - `getWalletMeresForGame(gameId)` → `WalletMere[]` for UI display
- INVARIANT: withdrawals are ONLY tx FROM wallet_mère of that game to cashout wallets

### Archived games
- AKPOKER (TELE) is archived. `status='archived'` in games table.
- Backend mutations on archived games return 403 (`isGameArchived` guard).
- AKPOKER UI must remain byte-for-byte identical. Historical data is sacred.

### Adding a new game (multi-game pattern)
1. `INSERT` row in `games` table with new name + `status='active'`
2. Create `lib/games/<game>/config.ts`: gameLink, defaultDeal
3. Seed wallet_mère via UI or direct INSERT
4. Routes: `app/<game>/pnl/page.tsx` + `app/<game>/settlements/page.tsx` (pass game-specific props to TELEClient/SettlementsClient)
5. Bot: `lib/games/<game>/onboarding.ts` triggered by `?start=<game>`
6. Clone `player_game_deals` if applicable
7. Update sidebar to include new game

### Bot onboarding
- AKPOKER bot writes to legacy columns (unchanged)
- KKPOKER+ bots write to `player_wallet_games`/`player_wallet_cashouts` with `game_id`
- `?start=<game>` deep link routes to game-specific flow
- Re-onboarding edge case: block + alert AGENT_CHAT_ID (no silent overwrite)
- TRC20 only — validate `^T[A-Za-z0-9]{33}$`