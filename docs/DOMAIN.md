# LeCerclePoker — Domain Glossary

Read this before any change to balance, wallet, report, or accounting code.

## The business in one paragraph

Baki recruits poker players, places them on online poker apps (TELE AKPOKER, Wepoker, Xpoker, ClubGG), and takes an "action" % of their results. He also tracks USDT deposits/cashouts on the TRON blockchain, rakeback/insurance owed back to players, and runs a manual cash ledger for Telegram-based transfers. This app is the unified ledger.

## Entities

### Player
Has a name, telegram handle, telegram_id, status, tier, notes. Has many wallets (game + cashout) and many deals (one per game).

### Game
The poker platform. Four supported: `TELE`, `Wepoker`, `Xpoker`, `ClubGG`. Each has a `default_action_pct`.

### Deal (`player_game_deals`)
The contract between Baki and a player on a specific game. Three numbers:
- `action_pct` — Baki's % of the player's winnings/losses on that game.
- `rakeback_pct` — % of rakeback the *player* gets back.
- `insurance_pct` — % of insurance the *player* gets back.

Example: 50% action, 100% rakeback, 50% insurance means Baki takes 50% of W/L, the player keeps 100% of rakeback and 50% of insurance.

### Report (`rakeback_reports` + `rakeback_entries`)
A periodic data dump from a poker app. Comes as either:
- **Screenshot** → extracted by Claude Vision (`@anthropic-ai/sdk`)
- **Wepoker XLS** → extracted by deterministic parser (`xlsx` + exact Chinese column header match)

Each report contains per-player rows. The fields per row are the *player's* numbers:
- `amount` — rakeback earned (player owed)
- `insurance_amount` — insurance profit (player owed a share)
- `winnings_amount` — net W/L for the period (Baki takes a cut via action_pct)

### Wallet transaction (`wallet_transactions`)
On-chain USDT movement. Auto-synced from TRON. Two types:
- `deposit` — money INTO the player's game wallet (player funded their action)
- `withdrawal` — money OUT to the player's cashout wallet, sent FROM `wallet_mère`

### Telegram transaction (`telegram_transactions`)
Manual cash ledger, EUR-default. Direction `in | out`. This is the off-chain reconciliation of Telegram-based handover (cash, alipay, etc).

### Cashout request (`cashout_requests`)
Workflow queue: `pending → approved → paid | cancelled`. Eventually will trigger an on-chain send (currently manual).

## Currencies

- **USDT** — primary, for TELE on-chain
- **CNY** — Wepoker XLS native
- **EUR** — manual Telegram ledger native

Exchange rates live in `settings` table, manually maintained. `toUsdt(amount, currency)` converts. **All cross-currency aggregation MUST go through this function.**

## Wallet sync — the most error-prone path

File: `app/api/wallets/sync/route.ts`. Two passes ONLY:

**Pass 1 — Deposits.** For each player, for each `player_wallet_games` address, fetch incoming TRC20 USDT transfers via TronGrid → INSERT as `deposit` rows.

**Pass 2 — Withdrawals.** Fetch outgoing transfers from `wallet_mère` (one global address). Filter to those whose recipient is a known `player_wallet_cashouts` address → INSERT as `withdrawal` rows.

**Dedup:** `tron_tx_hash` is UNIQUE. All inserts use `INSERT OR IGNORE`. Multiple sync clicks are idempotent.

**Rate limiting:** TronGrid free tier = 1 RPS per IP. Railway shares egress IPs. Mitigation: global throttle `MIN_SPACING_MS = 1500` + 429 retry with 12s cooldown. The `TRONGRID_API_KEY` env var moves to per-key quota.

### History: the Pass 3 disaster
A previous version added a "Pass 3" that scanned cashout wallets for *all* incoming USDT — not just from `wallet_mère`. This imported thousands of unrelated transfers as phantom cashouts. Required a full purge and re-sync. **Rule that came out of this:** withdrawals are ONLY `wallet_mère → cashout wallet`. Anything else is not the operator's business and must not be imported.

### History: wallet direction flip
Early on, deposits and withdrawals were inverted in the schema. Required `flip_wallet_directions_v2` migration. The mental model is unintuitive: incoming-to-game-wallet = player funding = deposit; incoming-to-cashout-wallet = operator paying out = withdrawal. Memorize it.

## P&L computation

`getPlayerBalance(playerId)` in `lib/queries.ts` (line ~854) merges two sources:

```
report_pnl    = winnings * (1 - action_pct/100) + (rakeback + insurance) * rakeback_pct/100
wallet_pnl    = withdrawn - deposited
net           = report_pnl + wallet_pnl    // all in USDT
```

- Positive `net` → operator owes player.
- Negative `net` → player owes operator.

Per-currency amounts converted via `toUsdt()` before summation.

## The legacy vs new accounting split

There are TWO accounting systems alive at once:

| System | Tables | Used by |
|---|---|---|
| **Legacy** | `reports`, `accounting_entries` | Dashboard `/` (`getNetByApp`, `getNetByPlayer`) |
| **New** | `rakeback_reports`, `rakeback_entries` | `/finance`, `/reports` upload flow, `getPlayerBalance` |

Numbers can drift between the dashboard and `/finance` because they read different data. **Do not delete legacy tables.** Migration is a separate, deliberate project — coordinate with Baki before touching.

## Clubs

`clubs` table — directory of clubs within games, with `rb_pct` and `ins_pct` defaults. `club_report_schedules` defines expected report cadence per club for missing-report detection (`getMissingReports` in `lib/queries.ts`).

## Telegram bot architecture

Two surfaces:
- **Webhook bot** (Bot API, fetch-based) — handles all `/commands`. Dispatcher: `app/api/telegram/webhook/route.ts`. Handlers: `lib/telegram-commands/*.ts`.
- **Userbot** (GramJS) — owner-account features: creating supergroups with forum topics, custom emoji, etc. `lib/telegram-userbot.ts`. Setup script: `scripts/setup-userbot.ts`.

Onboarding flow creates a Telegram supergroup per player with forum topics: General, Accounting, Deals, Clubs, Depot, Liveplay, Onboarding. The userbot handles group creation; the webhook bot handles ongoing commands inside the group.

## Settlement model

Weekly settlement cycle for TELE wallet P&L:

**Period:** Monday 00:00:00 → Sunday 23:59:59 Europe/Paris (DST-aware).

**Settlement P&L (wallet-only):**
- `pnl_player = sum(withdrawals) - sum(deposits)` within the week window.
- `pnl_operator = pnl_player * action_pct / 100` (snapshot at compute time).
- Reports/rakeback/insurance feed /finance but NOT the weekly settlement.

**Per-player statuses:**
- `settled` — at least one withdrawal in the window. Auto-locked at compute time (locked_by='auto'). Anchor = last withdrawal's tx_datetime.
- `pending_manual` — no withdrawal. Baki decides: carry over (pnl=0) or manual close (enter amount).
- `carry_over` — carried over with pnl=0. Terminal state.
- `conflict` — reserved for future late-attribution manual overrides.

**Auto-lock behavior:**
- `computeWeek` immediately sets status='settled' + locked_at/locked_by for players with cashouts. No manual confirmation step.
- After all player rows reach terminal state (settled/carry_over), the period auto-locks.
- `validatePlayer` (carry_over/manual_close) also triggers `checkAndLockPeriod` — resolving the last pending player auto-locks the period.

**Period lifecycle:** open → computed → locked (automatic when all rows terminal).

**Lock semantics:**
- Once locked, settlement rows are immutable. `computeWeek` will not overwrite them.
- Late transactions (tx_datetime within a locked week but arriving after lock) belong to the next open week.
- Hard cutoff: Monday 00:00:00 Paris. No tolerance window, no exceptions.

**Lock anchor:** The last withdrawal's tx_datetime in the settlement window. Anything with tx_datetime > lock_anchor but < Monday 00:00 of next week is a "late-attribution orphan" — visible in the next week's computation.

**Tables:** `weekly_settlement_periods` (one row per week), `weekly_settlements` (one row per player per week).

## What's NOT in scope (push back if asked)

- Authentication / user accounts — v1 is single-operator, dashboard is open
- Test suite — none exists, none requested
- Production payment automation (auto-cashout via TRON private key) — listed as P2, requires careful key management design
- SaaS framing — pricing pages, customer onboarding, GTM. Not a SaaS.