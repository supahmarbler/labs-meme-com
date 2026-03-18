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
├── index.html                  # Entry point
├── app.jsx                     # All React code (~5000 lines)
├── supabase-schema.sql         # Base schema
├── migration-pending.sql       # Stats migration
├── migration-production.sql    # Atomic functions
├── migration-mememarket.sql    # KYMRACE schema + RPCs
├── STATUS.md                   # Status doc (outdated)
└── CLAUDE.md                   # This file

api/
├── kym-trending.js             # KYM meme scraper (4 sources)
├── kym-index.js                # Market creation indexer (cron)
├── kym-rss-check.js            # RSS monitor: winner/poll detection + dedup guard
├── kym-resolve.js              # Market resolution (cron)
├── kym-poll-sync.js            # Poll sync: finalist markets + image fetch + non-finalist resolution
├── kym-winner.js               # MOTM winner detection
└── kym-nominees.js             # MOTM nominee scraper
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

### Farming Quests (sidebar cards)
Both quest cards (Treasure Chest, Like & Retweet) use a single `GET /farming-quests/list_available` call via `fetchFarmingQuests()`. Individual quests extracted with `extractQuest(data, questType)`.

**Treasure Chest** — `quest_type: "TREASURE_CHEST"`. User picks 1 of 3 chests → `POST /farming-quests/finish`. Shows 24h cooldown timer after claim.

**Like & Retweet** — `quest_type: "RETWEET"`. Flow:
1. `GET /farm/get_quest_tweet?meme_user_id=N` → `{ id, tweet_id_external, cooldown_until }`
2. Open X popup: `x.com/intent/retweet?tweet_id=${tweet_id_external}`
3. Poll `popup.closed`, then `POST /farm/claim_retweet_reward_points` with `{ tweet_id_internal: id }`
4. Returns `{ updated_by_amount, current_memescore }`
5. Card shows reward for 3s, then hides. Hidden when quest completed or unavailable.
- Requires linked Twitter/X profile on meme.com (backend verifies retweet via Twitter API)
- Reward amount from `quest.reward_meme_score` field

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

### Current DB State (end of 2026-02-27 session)
- 4 OPEN markets: JOE-30, MOG-29, PEPE-29, STNK-30 (expiring 2026-02-28T13:59:59 UTC)
- All test data cleared (resolved markets, old positions, trades)
- All user stats reset to 0 (clean slate for first real 24h round)
- ~42 active positions from real users across all 4 markets
- Stale browser tab fully neutralized (triggers + constraint + code filters)

## Session Notes (2026-02-28)

### Dev Environment Setup
- **Dev Supabase project created**: `vnteehkwrygodkljfwyp` (memelabs-dev, eu-west-1)
- **Full prod schema cloned to dev** via Management API: all tables (text user IDs), LMSR functions, `labs_buy`/`labs_sell` (SECURITY DEFINER), `labs_auto_resolve`, all 5 triggers (`protect_start_mc`, `prevent_duplicate_open`, `enforce_market_expiry`, `protect_balance_trigger`, `protect_stats_reset`), CHECK constraints (`valid_market_expiry`, `positive_balance`, `positive_shares`, `positive_invested`), RLS policies, indexes, leaderboard view
- **Hostname-based env toggle** in `app.jsx` (line ~15): `labs.meme.com` → prod, everything else → dev
- **Red "DEV" badge** in header when not on prod
- **Verified**: prod still serving ~200 players across 4 markets, dev DB empty and functional (`labs_buy`/`labs_sell` RPCs tested end-to-end)
- **Supabase access token**: `sbp_34192034a202b013e51e00c353c372e623a5b22a` (used for Management API queries against both projects)

### Dev Environment Usage
```bash
# Query dev DB via Management API
curl -s -X POST "https://api.supabase.com/v1/projects/vnteehkwrygodkljfwyp/database/query" \
  -H "Authorization: Bearer sbp_34192034a202b013e51e00c353c372e623a5b22a" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT 1;"}'

# Dev REST API
curl -s "https://vnteehkwrygodkljfwyp.supabase.co/rest/v1/labs_markets?select=*" \
  -H "apikey: sb_publishable_q_M1tOOvwhHnt4x2mgZH8Q_L3FQwgXn" \
  -H "Authorization: Bearer sb_publishable_q_M1tOOvwhHnt4x2mgZH8Q_L3FQwgXn"
```

### Deployment
- `vercel --prod` deploys both prod and preview environments from same code
- Prod (`labs.meme.com`) → prod Supabase automatically
- Any preview URL (`labs-meme-*.vercel.app`) or `localhost` → dev Supabase automatically
- **Auth only works on prod domain** — preview URLs don't have the meme.com auth cookie/localStorage. Test quest features on `labs.meme.com`.

## Session Notes (2026-03-03)

### Like & Retweet Quest Card
- Added `RetweetQuestCard` component to sidebar (below treasure chest)
- Refactored `fetchChestQuest` → `fetchFarmingQuests` + `extractQuest` helper (single API call serves both chest and retweet)
- New API functions: `fetchQuestTweet`, `claimRetweetReward`
- Card uses X logo, `quest-retweet-v2.webp` background with 0.6 opacity overlay
- Title: "Like & Retweet" with `#71baff` blue accent
- Button states: LIKE & RT → spinner → +X MEMESCORE → hidden
- Card hidden when quest completed or unavailable (not grayed out like chest)
- `handleRetweet`: opens X intent popup, polls `popup.closed`, claims reward, refreshes memescore
- Cooldown timer useEffect same pattern as chest
- Reward amount from `quest.reward_meme_score` (not from params)
- Backend verifies actual retweet via Twitter API using user's OAuth token
- `claim_retweet_reward_points` expects `tweet_id_internal` (snake_case, not camelCase)

## KYMRACE — KYM Meme of the Month Predictions

### Overview
Users predict which memes will finish top 3 in Know Your Meme's monthly "Meme of the Month" contest. Markets use LMSR pricing (same as coin markets) with YES = "TOP 3" and NO = "NOT TOP 3". Markets expire on the 15th of the following month, giving time for KYM to announce results.

### How It Works
1. **Scraper** discovers trending memes from KYM daily
2. **Indexer** creates prediction markets for each meme
3. Users trade YES/NO on whether each meme will finish top 3
4. **Resolver** checks KYM results and settles all markets for the season

### API Endpoints (Vercel Serverless Functions)

| Endpoint | Cron | Purpose |
|----------|------|---------|
| `GET /api/kym-trending` | — | Scrapes KYM for trending memes, returns `{ memes, count, sources }` |
| `GET /api/kym-index` | Every 6h | Calls kym-trending, creates KYMRACE markets for top 30 memes |
| `GET /api/kym-rss-check` | Hourly, days 1-10 + 24-31 | Polls KYM RSS for winner/poll articles, triggers resolve or poll-sync. Skips if no open markets (prevents ~240 wasted calls/month) |
| `GET /api/kym-resolve` | 12:00 UTC, days 1-15 | Resolves previous month's markets using kym-winner |
| `GET /api/kym-poll-sync` | rss-check + days 26-28 fallback | Syncs finalist markets with KYM poll. Creates missing markets (with images from og:image), resolves non-finalists as NO |
| `GET /api/kym-winner?month=X&year=Y` | — | Detects MOTM winner + top 3 from KYM voting page |
| `GET /api/kym-nominees?month=X&year=Y` | — | Scrapes MOTM nominee list from KYM voting page |

### KYM Trending Scraper (`api/kym-trending.js`)

Scrapes 4 sources in order, deduplicating by slug:

1. **Homepage** (`knowyourmeme.com`) — editorially featured memes in hero cards and sidebar
2. **Newest** (`/memes?sort=newest`) — recently created meme entries
3. **Confirmed** (`/memes?status=confirmed&sort=newest`) — entries with "confirmed" status (higher quality signal)
4. **Editorials** (`/editorials`) — scrapes "What Is X Meme?" explainer articles, follows redirects to `trending.knowyourmeme.com`, extracts `/memes/SLUG` links from article bodies (up to 8 articles, 3 memes per article)

**Page fetching:** Uses Cloudflare Browser Rendering API (`CF_ACCOUNT_ID` + `CF_API_TOKEN` env vars) for listing pages (avoids JS-rendering issues). Falls back to direct `fetch` when Cloudflare unavailable. Editorial article fetches skip Cloudflare (need redirect following).

**Meme extraction patterns** (3 levels of specificity):
- Pattern 1: `<a class="item" data-title="..." href="/memes/SLUG">` — listing page cards
- Pattern 2: `<a class="overlayed-card" href="/memes/SLUG">` — homepage featured cards
- Pattern 3: Any `href="/memes/SLUG"` link — fallback, derives name from nearby text or slug

**Filtering:** `EXCLUDE_SLUGS` set filters out:
- Navigation slugs (`trending`, `popular`, `search`, `categories`, etc.)
- Evergreen classics (`loss`, `doge`, `trollface`, `big-chungus`, etc.)
- Meta categories (`copypasta`, `reaction-images`, `gif`, `anime-manga`, etc.)
- Platform names (`tiktok`, `youtube`, `reddit`, etc.)

**Image handling:** All KYM CDN image URLs are upgraded from `/icons/newsfeed/` (tiny thumbnails) to `/icons/original/` (full resolution).

### Indexer (`api/kym-index.js`)

- Runs every 6 hours via Vercel cron
- Days 1-25: fetches `/api/kym-trending`, takes top 30 memes, calls `labs_create_kymrace_system` RPC for each
- Days 26-31: skips (market creation window closed for the month)
- Duplicate memes silently skipped by the RPC (dedup on `kym_slug + season_id`)

### Resolver (`api/kym-resolve.js`)

- Runs daily at 12:00 UTC on days 1-15 of each month
- Checks for open KYMRACE markets from **previous** month's season
- Calls `/api/kym-winner` to get top 3 slugs
- Calls `labs_resolve_kymrace(p_season_id, p_top3_slugs)` RPC — slug in top 3 → YES wins, otherwise → NO wins
- Creator payout bonus for user-created markets (not SYSTEM-created)

### RSS Check (`api/kym-rss-check.js`)

- Polls `knowyourmeme.com/editorials.rss` for MOTM articles
- Detects two types: winner announcement (previous month) and voting poll (current month)
- **Dedup guard:** Before triggering downstream endpoints, queries Supabase for open KYMRACE markets in the relevant season via anon key (read-only RLS). If no open markets exist → returns `{ already_resolved: true }` and skips kym-resolve/kym-poll-sync. Prevents ~240 wasted invocations/month from re-detecting old articles.
- Winner detected + open markets → triggers `kym-resolve` (preview then auto-execute)
- Poll detected + open markets → triggers `kym-poll-sync`

### Poll Sync (`api/kym-poll-sync.js`)

- Triggered by kym-rss-check when "Cast Your Vote" article detected
- Fetches nominees from `/api/kym-nominees`, compares with open KYMRACE markets
- Creates markets for missing finalists via `labs_create_kymrace_system` RPC
- **Image fetching:** For each missing finalist, fetches `knowyourmeme.com/memes/{slug}` and extracts `og:image` meta tag. Upgrades `/icons/newsfeed/` → `/icons/original/` for full resolution. Falls back to empty string on failure.
- Non-finalist markets shown in preview mode (Discord notification with execute link)
- Execute mode (`?execute=true&key=RESOLVE_SECRET`): resolves non-finalists as NO (`status='RES', result='NO'`)

### DB Schema

**Columns on `labs_markets`:**
- `market_type = 'KYMRACE'` — distinguishes from coin prediction markets
- `kym_slug` — KYM meme slug (e.g., `hey-girl-you-gonna-eat-your-cornbread`)
- `season_id` — `YYYY-MM` format (e.g., `2026-03`)
- `coin_color = '#71BAFF'` — blue accent (matches other labs)

**RPCs:**
- `labs_create_kymrace(p_user_id, p_meme_name, p_kym_slug, p_image_url, p_liquidity)` — user-created market, deducts balance
- `labs_create_kymrace_system(p_meme_name, p_kym_slug, p_image_url, p_liquidity)` — indexer-created, no balance check, `created_by='SYSTEM'`
- `labs_resolve_kymrace(p_season_id, p_top3_slugs text[])` — resolves all open KYMRACE markets for a season

**Market ID format:** `KYM-{SLUG}-{ROUND}` (e.g., `KYM-hey-girl-you-gonna-eat-your-cornbread-1`)
**Title:** `"Will {name} finish top 3 Meme of the Month?"`
**Expiry:** 15th of next month (gives time for KYM to announce results)

### Triggers & Constraints
- `labs_prevent_duplicate_open` — deduplicates KYMRACE by `kym_slug + season_id`
- `labs_enforce_market_expiry` — skips KYMRACE (expiry set by RPC, not trigger)
- `labs_auto_resolve` — skips KYMRACE (resolved via cron + `labs_resolve_kymrace`)
- `valid_market_expiry` CHECK — exempts KYMRACE

### Frontend (app.jsx)
- KYM tab shows single grid of KYMRACE markets
- `KYMSeasonHeader` — shows "+ ADD MEME" button (opens KYMCreateModal) or "AWAITING RESULTS" when expired
- `MemeMarketCard` — YES label = "TOP 3", NO label = "NOT TOP 3"
- `KYMCreateModal` — search KYM, preview meme, set liquidity, create market
- `KYMProbabilityGraph` — bar chart of top 3 probabilities for open markets

### Key Files
```
api/
├── kym-trending.js    # Scraper: 4-source KYM meme discovery
├── kym-index.js       # Indexer: creates markets from trending (cron every 6h)
├── kym-rss-check.js   # RSS monitor: detects winner/poll articles, gates downstream calls
├── kym-resolve.js     # Resolver: settles markets from KYM results (cron days 1-15)
├── kym-poll-sync.js   # Poll sync: creates finalist markets (with images), resolves non-finalists
├── kym-winner.js      # Winner detection: scrapes MOTM voting page
└── kym-nominees.js    # Nominee scraper: MOTM voting page nominees
```

### Cron Schedule (vercel.json)
```json
{ "path": "/api/kym-index",     "schedule": "0 */6 * * *" }         // Every 6 hours
{ "path": "/api/kym-rss-check", "schedule": "0 * 1-10,24-31 * *" }  // Hourly, days 1-10 + 24-31
{ "path": "/api/kym-poll-sync", "schedule": "0 12 26-28 * *" }      // 12:00 UTC, days 26-28 (fallback)
{ "path": "/api/kym-resolve",   "schedule": "0 12 11-15 * *" }      // 12:00 UTC, days 11-15
```

---

## Meme Inventory (Holdings / Diamond Hands)

### Overview
Users can view their memecoin holdings in a profile modal. Holdings are seeded from the meme.com API and updated via on-chain wallet scans. A "diamond hands" multiplier rewards users for holding the same coins across scans.

### Data Flow
1. **Prepopulate (first load):** If user has no holdings in DB, fetch from `GET /farm/get_user_coins?meme_user_id=N` (meme.com API). Maps `coin_key` → `coin_symbol`, `coin_name` → display name. Stored with `chain: "API"`, `wallet_address: "meme.com"`.
2. **Wallet Census (manual scan):** User clicks "CLAIM" / "SCAN" button. `runWalletCensus()` scans linked wallets (EVM via JSON-RPC batch, Solana via `getTokenAccountsByOwner`) against coins in `labs_coins` table. Prices from CoinGecko. Holdings above $10 USD threshold get a tier (GOLD ≥$10K, SILVER ≥$1K, BRONZE ≥$10).
3. **Display:** `loadInventory()` reads from `labs_user_inventory` view, then fetches CoinGecko `/coins/markets` to resolve actual ticker symbols (`coin_ticker` field on each holding).

### DB Tables
- **`labs_user_holdings`** — Raw holdings data (user_id, coin_symbol, coin_name, coin_image, wallet_address, chain, token_balance, usd_value, tier, census_at)
  - CHECK constraint: `chain` must be `EVM`, `SOLANA`, or `API`
  - CHECK constraint: `tier` must be `GOLD`, `SILVER`, or `BRONZE`
- **`labs_user_inventory`** — View (read-only, used by `loadInventory`)
- **`labs_coins`** — Coin config for wallet scanning (symbol, coingecko_id, evm_contract, solana_mint, etc.)

### RPCs
- **`labs_save_census(p_user_id, p_holdings jsonb)`** — DELETEs all existing holdings, inserts new ones, computes diamond_hands multiplier (1-10x based on overlap ratio with previous holdings), updates `last_census_at`.
- **`labs_claim_holdings_reward(p_user_id, p_reward)`** — Credits holdings-based reward to user balance.

### Diamond Hands Multiplier
Computed in `labs_save_census` by comparing old vs new holdings:
- ≥99% overlap → 10x
- ≥90% → 7x, ≥80% → 5x, ≥70% → 3x, <70% → 1x
- First scan (no previous data) → 10x
- Overlap is weighted: GOLD=10000, SILVER=5000, BRONZE=500

### Holdings Reward
`calcHoldingsReward(holdingsList, dhBoost)` — sums daily rates per tier (GOLD=10000, SILVER=7000, BRONZE=1500), multiplied by 3 days × (dhBoost/10). Credited on scan.

### Cooldown
- `CENSUS_COOLDOWN_MS = 3 days` between scans
- Progress bar shows time remaining
- Button shows "CLAIM {reward}" when ready, countdown timer when on cooldown

### Known Issues / Fixes Applied
- **Empty scan wipes holdings (FIXED):** `runWalletCensus` now throws error if scan finds 0 holdings, preventing `labs_save_census` from deleting everything.
- **Prepopulate failed silently (FIXED):** `chain: ""` violated CHECK constraint. Now uses `chain: "API"`.
- **Prepopulate was fire-and-forget (FIXED):** Now `await`ed, followed by `loadInventory()`.
- **Cashtags show slugs instead of tickers (FIXED):** `loadInventory` now resolves CoinGecko ticker symbols via `/coins/markets` API.

### Code Locations (app.jsx)
- `CENSUS_TIERS`, `HOLDINGS_DAILY_RATES`, `calcHoldingsReward` — ~line 681-698
- `fetchCoinsWithPrices`, `scanEvmWallet`, `scanSolanaWallet`, `runWalletCensus` — ~line 711-839
- `loadInventory` — ~line 3427
- `prepopulateHoldings` — ~line 3441
- Profile modal + inventory grid — ~line 4820-4980
- Scan/Claim card — ~line 4984-5095

### Remaining Issues
- [ ] Holdings not loading for users whose meme.com `coin_key` doesn't match a CoinGecko ID (ticker falls back to `coin_name`)
- [ ] `labs_coins` table needs more coins added for wallet scanning to work broadly
- [ ] No error toast shown when prepopulate fails (only console.warn)
- [ ] Diamond hands multiplier resets to 1x if scan returns fewer coins (e.g., sold some) — may frustrate users
- [ ] Census cooldown timer doesn't auto-refresh (needs `claimTick` state toggle)
- [ ] No way to manually refresh holdings without wallet scan (if wallets changed but cooldown active)
