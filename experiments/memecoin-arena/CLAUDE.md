# Memecoin Arena - Project Memory

## Overview
Prediction market for memecoins using LMSR (Logarithmic Market Scoring Rule) pricing. Users predict whether a coin's price will go UP or DOWN within 24 hours.

**Production:** https://labs.meme.com
**Staging:** https://labs-meme-com.vercel.app/experiments/memecoin-arena/

## Tech Stack
- **Frontend:** React + Babel (single-file, no build step)
- **Backend:** Supabase (PostgreSQL)
- **Price Feed:** CoinGecko free API (60s intervals, DB as source of truth)
- **Deployment:** Vercel (`vercel --prod` from repo root)

## Environment Toggle
Hostname-based switching in `app.jsx` (line ~15):
- `labs.meme.com` → **prod** Supabase (`csvegolcvwuwssoefxdh`)
- Everything else (Vercel previews, localhost) → **dev** Supabase (`vnteehkwrygodkljfwyp`)
- Red "DEV" badge shown in header when not on prod

## Database (Supabase)

### Production
**Project:** csvegolcvwuwssoefxdh

### Dev
**Project:** vnteehkwrygodkljfwyp (memelabs-dev, eu-west-1)
**Anon key:** `sb_publishable_q_M1tOOvwhHnt4x2mgZH8Q_L3FQwgXn`
**DB password:** `DevPass2026Secure`
Schema is an exact mirror of prod (same tables, functions, triggers, constraints, RLS policies).

### Tables
- `labs_users` - User accounts with balance, stats (wins/losses/streaks)
- `labs_markets` - Shared market state (q_yes, q_no, volume, players)
- `labs_positions` - User positions per market
- `labs_trades` - Full trade history with PnL

### Atomic Functions (production-ready)
```sql
-- Buy shares atomically with row locking
labs_buy(p_user_id uuid, p_market_id text, p_side text, p_amount int) -> json

-- Sell entire position atomically
labs_sell(p_user_id uuid, p_market_id text) -> json

-- LMSR math helpers
lmsr_cost(q_yes, q_no, b) -> numeric
lmsr_buy_shares(q_yes, q_no, b, cost, side) -> numeric
lmsr_sell_refund(q_yes, q_no, b, shares, side) -> numeric
```

### Migrations Applied
1. `supabase-schema.sql` - Base tables
2. `migration-pending.sql` - Stats columns, trades table
3. `migration-production.sql` - Atomic functions, constraints, indexes

## Key Files
```
experiments/memecoin-arena/
├── index.html              # Entry point
├── app.jsx                 # All React code (~1400 lines)
├── supabase-schema.sql     # Base schema
├── migration-pending.sql   # Stats migration
├── migration-production.sql # Atomic functions
├── STATUS.md               # Detailed status doc
└── CLAUDE.md               # This file
```

## app.jsx Structure (~1950 lines)
| Lines (approx) | Section |
|-------|---------|
| 1-100 | Hooks, Supabase init, auth (getMemeAuth, fetchMemeUser, fetchLabsBalance) |
| 100-170 | LocalStorage helpers, user ID |
| 170-350 | DB sync functions (ensureUserInDb, syncUserToDb, syncMarketToDb, loadMarketHistoryFromDb) |
| 350-540 | Coin config, CoinGecko, LMSR math, market creation (nextNoonUTC, getB, mk) |
| 540-770 | Card component (market UI, betting, position display) |
| 770-870 | DepositModal (login prompt + deposit/withdraw) |
| 870-1080 | App component state, init flow (auth, migration, DB load) |
| 1080-1260 | Price feed, resolution timers, market refresh (15s polling) |
| 1260-1550 | Buy/Sell/Claim handlers (RPC with fallback, direct DB balance updates) |
| 1550-1900 | Main layout, sidebar (conviction board with form guide, leaderboard, history) |

## LMSR Formula
```javascript
// Cost function with base liquidity
cost(qY, qN, b) = b * ln(exp(qY/b) + exp(qN/b))

// Probability
prob(qY, qN, b) = exp(qY/b) / (exp(qY/b) + exp(qN/b))

// Market state stores q_yes/q_no WITHOUT base liquidity
// Frontend adds b back: qY = db.q_yes + b, qN = db.q_no + b
```

## Coins (4 active)
JOE, STNK, PEPE, MOG (CoinGecko IDs mapped in app.jsx)
- PENGU and DOG removed (2025-02-26), their DB markets closed with status "RES"

## meme.com Integration (2025-02-25)

### Auth Flow
1. Check cookie `meme_auth_account` first, cache to `localStorage` (`labs_auth_token`)
2. Fall back to `localStorage` if cookie expired (longer session persistence)
3. Fetch user profile: `GET /user/private_user_detail`
4. Fetch memescore only from `GET /labs/balance` (for deposit modal display)
5. Arena balance comes **only from Supabase** — API balance is NOT used for gameplay

### Labs API Endpoints (meme-api-v2)
```
GET  /labs/balance   - Get memescore + labs balance
POST /labs/deposit   - Transfer memescore → labs balance
POST /labs/withdraw  - Transfer labs balance → memescore
```

### Backend Files Created
- `/Users/johanunger/meme-api-v2/src/app/routers/labs.py`
- `/Users/johanunger/meme-api-v2/src/app/services/labs/labs_balance_service.py`
- `/Users/johanunger/meme-api-v2/src/app/models/labs.py`
- `/Users/johanunger/meme-api-v2/src/storage/models/labs.py`
- `/Users/johanunger/meme-api-v2/src/storage/repository/labs/labs_balance_repository.py`
- Migration: `add_labs_balance_table.py`

## Critical Architecture: Balance Management
**Supabase `labs_users.labs_balance` is the ONLY source of truth for arena balance.**

The `syncUserToDb` effect syncs stats (volume, wins, losses, streak) but **never touches `labs_balance`**.
Balance is only modified by:
- `labs_buy` RPC — atomic deduction on bet
- `labs_sell` RPC — atomic credit on sell
- Direct DB update on claim reward (`onClaim`)
- Direct DB update on deposit/withdraw (`onDeposit` callback)

**Why:** Previously `syncUserToDb` wrote `bal` to DB on every state change. Since React state starts at 0, the sync effect could fire before DB values loaded, overwriting the real balance with 0. This caused users to lose their entire balance on page refresh.

A `dbLoaded` ref also guards the sync effect from running until init is complete.

## Market Schedule
Markets reset daily at **14:00 UTC** (rounds end at 13:59:59 UTC). The `nextRoundExpiry()` function calculates next expiry. Server-side resolution via `pg_cron` running `labs_auto_resolve` every 5 minutes.

## Known Issues / Future Work
- [ ] Add more coins dynamically
- [ ] Conviction bonus multiplier (code exists, disabled)
- [ ] Server-side price fetching (http extension failed on Supabase, Edge Function or pg_net needed)
- [ ] CoinGecko Pro not needed currently — free tier sufficient for 4 coins at 60s polling
- [ ] Drop `protect_stats_reset` trigger once all stale browser sessions are gone
- [ ] Drop `valid_market_expiry` CHECK constraint and code-level hour filters once stale tabs are gone
- [ ] Consider cleaning up `labs_auto_resolve` expiry filter once stale tab issue is fully resolved

## Deployment
```bash
cd /Users/johanunger/Desktop/labs-meme-com
vercel --prod
```

## LMSR Bug Fix (2025-02-26)
`buyShares` binary search had `hi = cost * 2` as upper bound. When buying the cheap/minority side of a skewed market, shares cost < 0.5 each so you need > 2x shares per memescore. The capped search gave fewer shares than paid for — showing as instant 5-90% loss on small bets.
**Fix:** Upper bound now computed from current share price: `hi = max(cost * 2, cost / price * 2)`, iterations increased 40→60. Applied to both frontend JS and Supabase `lmsr_buy_shares` function.

## Session Notes (2025-02-25)
- Fixed database sync: markets now persist correctly after buy/sell
- Added atomic PostgreSQL functions for concurrent user safety
- Added gold styling to countdown clock
- Fixed player count increment/decrement
- Added fallback coin data for CoinGecko rate limits

## Session Notes (2025-02-26)
- Re-added deposit/withdraw UI (DepositModal replaces LoginModal)
- Auth persistence via localStorage fallback from cookie
- Fixed profile image field names (snake_case from API)
- One-time user ID migration from anonymous UUIDs to meme-XXXXX
- Market sync changed from UPDATE to UPSERT (fixes disappearing markets)
- Added 15-second periodic market refresh for multi-user consistency
- Removed fake 10000 starting balance — balance only from deposits
- Fixed double deduction bug (optimistic setBal before RPC)
- Markets reset at noon UTC daily
- Reduced to 4 coins (JOE, STNK, PEPE, MOG)
- Fixed LMSR binary search upper bound (minority side small bet loss)
- Removed balance from syncUserToDb (prevents balance reset on refresh)
- Conviction board: added per-coin form guide (last 5 results as colored circles)
- Removed "Recent Results" sidebar section

## Session Notes (2026-02-27)

### Architecture Changes
- **Price source of truth moved to DB**: One client writes CoinGecko prices to DB every 60s, all clients read from DB via `refreshMarkets` every 15s. Eliminates per-user CoinGecko calls and ensures consistent percentages across users.
- **Server-side resolution only**: Removed client-side resolution entirely. Only `pg_cron` (`labs_auto_resolve`) resolves markets. Client timer is display-only.
- **Wins/losses loaded from DB**: Changed from computed-from-localStorage-hist to proper state loaded from DB on init, incremented on claim. Prevents stale browser sessions from overwriting reset stats.
- **Switched to CoinGecko free API** (`api.coingecko.com/api/v3`, no API key)
- **Market schedule changed to 14:00 UTC** (rounds end 13:59:59 UTC, 24h cycles)

### DB Triggers (active)
- `protect_start_mc` (INSERT/UPDATE) — locks `start_mc` after market creation, prevents price updates from overwriting baseline
- `prevent_duplicate_open` (INSERT) — only one OPEN market per coin symbol
- `enforce_market_expiry` (INSERT) — forces all new OPEN markets to next 13:59:59 UTC expiry, prevents stale tabs from creating short-expiry markets
- `protect_stats_reset` (UPDATE on labs_users) — forces wins/losses/streak to 0 if no resolved markets exist. **Temporary** — can be dropped once all old sessions are gone.

### DB Constraints
- `valid_market_expiry` CHECK — OPEN markets must have `expires_at` hour = 13 UTC. Safety net for stale tab protection.

### Code-Level Filters (defense in depth)
- `loadMarketHistoryFromDb` — filters out resolved markets not expiring at hour 13 UTC
- `loadMarketsFromDb` — filters out non-OPEN markets not expiring at hour 13 UTC
- `marketHistory` now refreshes every 30s (alongside leaderboard) instead of only on init

### Key Fixes
- **`syncMarketToDb` no longer includes `start_mc`** — was overwriting baseline price with current price on every upsert
- **Price updates use `.update({current_mc, price_updated_at})` only** — not full market upsert
- **`refreshMarkets` syncs `mc`, `startMc`, and `ea` from DB** — ensures all clients have consistent data
- **Deposit cap of 100,000 memescore** in DepositModal (`LABS_CAP = 100000`)
- **Resolved markets overlay new OPEN market** for same coin (instead of side-by-side)
- **"YOU LOST. CLOSE." button** replaces "Claim (0)" for lost positions
- **Player avatars hidden when pool is 0**
- **Price section text sizes increased** (labels .5em→.6em, values .9em→1.05em)
- **Auto-renew re-added** — creates new OPEN market when resolved one is claimed/dismissed, with `prevent_duplicate_open` as safety net
- **Wins/losses are DB-sourced state** — loaded from DB on init, incremented on claim. No longer derived from localStorage `hist`.
- **"TOP TRADERS" renamed to "TOP GAINS"**
- **Vercel upgraded to Pro** ($20/month, 6000 deploys/day)

### `labs_auto_resolve` update
Only resolves markets expiring between 13:59:00 and 14:00:00 UTC — ignores stale 5-min test markets.

### Failed Approaches (documented for future reference)
- **PostgreSQL `http` extension for server-side price fetching**: All syntax variants (`http((...))`, record variable, `http_get(url, headers)`) failed with "URL rejected: Malformed input" on Supabase. Not viable.
- **`prevent_client_resolve` trigger**: Attempted to block client-side resolution while allowing pg_cron. Session variable bypass didn't work via PostgREST. Dropped.
- **`enforce_market_expiry` on UPDATE**: Pushed expiry to tomorrow on every UPDATE after 14:00 UTC, including from `labs_auto_resolve`. Changed to INSERT only.
- **CHECK constraint alone for stale market prevention**: The `enforce_market_expiry` trigger rewrites expiry to 13:59:59 BEFORE the CHECK evaluates, so the constraint always passes for inserts. Defense in depth (trigger + constraint + code filter) is needed.

### Supabase Direct Access
Direct SQL via Management API:
```bash
export SUPABASE_ACCESS_TOKEN="sbp_..."
curl -s -X POST "https://api.supabase.com/v1/projects/csvegolcvwuwssoefxdh/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT 1;"}'
```
- **psql direct connection**: IPv6 only (`db.csvegolcvwuwssoefxdh.supabase.co`), no IPv4. Use Management API instead.
- **Supabase CLI**: installed (`/opt/homebrew/bin/supabase`), project linked. Needs `SUPABASE_ACCESS_TOKEN` env var.
- **Service role key**: stored in conversation history (use for REST API calls bypassing RLS)

### Current DB State (end of session)
- 4 OPEN markets: JOE-30, MOG-29, PEPE-29, STNK-30 (expiring 2026-02-28T13:59:59 UTC)
- All test data cleared (resolved markets, old positions, trades)
- All user stats reset to 0 (clean slate for first real 24h round)
- ~42 active positions from real users across all 4 markets
- Stale browser tab fully neutralized (triggers + constraint + code filters)
