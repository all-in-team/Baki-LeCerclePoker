# TODOS

Deferred work from /plan-ceo-review (2026-04-28).

## P1 — High value, build next

### Smart alerts (loss threshold)
- **What:** Telegram alert when a player's net P&L crosses a configurable threshold (e.g. -$2000)
- **Why:** Catch underwater players before losses compound
- **Effort:** ~30 min (CC). Data + Telegram bot already exist.
- **Depends on:** Unified P&L query (must be built first)

### Player self-service via Telegram
- **What:** /historique (last 10 transactions) and /deal (current deal terms) bot commands
- **Why:** Reduces "what's my deal again?" back-and-forth messages with players
- **Effort:** ~45 min (CC). Extends existing bot + queries.
- **Depends on:** telegram_chat_id on players table (built in current phase)

## P2 — Medium value, needs careful planning

### Refactor Telegram webhook into command modules
- **What:** Extract each bot command (/deal, /depot, /retrait, /pnl, /solde, /start, etc.) into separate handler files under lib/telegram-commands/
- **Why:** Webhook handler is the hottest file (18 touches in 30 days) and growing with each new command
- **Effort:** ~30 min (CC). Pure refactor, no behavior change.
- **Depends on:** Nothing. Do whenever the file feels painful to navigate.

### Cashout automation via Tron
- **What:** When operator approves a cashout in the queue, auto-send USDT from wallet mere to player's cashout wallet
- **Why:** Eliminates manual crypto transfers. Closes the loop from approval to payment.
- **Effort:** ~2 hours (CC). Needs private key management (sensitive).
- **Depends on:** Cashout queue (built in current phase), secure key storage strategy
- **Risk:** Private key on Railway volume. Consider hardware wallet integration or manual approval step before broadcast.
