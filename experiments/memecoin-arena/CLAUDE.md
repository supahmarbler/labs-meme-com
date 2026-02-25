# Memecoin Arena - Project Memory

## Overview
Prediction market for memecoins using LMSR (Logarithmic Market Scoring Rule) pricing. Users predict whether a coin's price will go UP or DOWN within 24 hours.

**Production:** https://labs.meme.com
**Staging:** https://labs-meme-com.vercel.app/experiments/memecoin-arena/

## Tech Stack
- **Frontend:** React + Babel (single-file, no build step)
- **Backend:** Supabase (PostgreSQL)
- **Price Feed:** CoinGecko API (60s intervals, with fallback data)
- **Deployment:** Vercel (`vercel --prod` from repo root)

## Database (Supabase)
**Project:** csvegolcvwuwssoefxdh

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

## app.jsx Structure
| Lines | Section |
|-------|---------|
| 1-50 | Hooks, Supabase init, user ID |
| 51-100 | LocalStorage helpers, market sync |
| 100-220 | DB sync functions |
| 220-290 | LMSR math (cost, probability, buy/sell) |
| 300-700 | Card component (market UI) |
| 700-800 | DepositModal |
| 800-950 | App init, state loading |
| 950-1000 | Price feed, resolution timers |
| 1000-1120 | Buy/Sell/Claim handlers |
| 1120-1400 | Main layout, sidebar, leaderboard |

## LMSR Formula
```javascript
// Cost function with base liquidity
cost(qY, qN, b) = b * ln(exp(qY/b) + exp(qN/b))

// Probability
prob(qY, qN, b) = exp(qY/b) / (exp(qY/b) + exp(qN/b))

// Market state stores q_yes/q_no WITHOUT base liquidity
// Frontend adds b back: qY = db.q_yes + b, qN = db.q_no + b
```

## Coins
JOE, STNK, PENGU, PEPE, MOG, DOG (CoinGecko IDs mapped in app.jsx)

## meme.com Integration (2025-02-25)

### Auth Flow
1. Check `localStorage` for `auth_token` (JWT from meme.com)
2. Validate token expiration via `auth_timestamp`
3. Fetch user profile: `GET /user/private_user_detail`
4. Fetch labs balance: `GET /labs/balance` (returns both memescore and labs_balance)

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

## Known Issues / Future Work
- [ ] UI alignment: "PRICE TO BEAT" column sometimes misaligned
- [ ] Run meme-api-v2 migration for labs_balance table
- [ ] Add more coins dynamically
- [ ] Conviction bonus multiplier (code exists, disabled)
- [ ] Server-side auto-resolution (plan exists in ~/.claude/plans/)

## Deployment
```bash
cd /Users/johanunger/Desktop/labs-meme-com
vercel --prod
```

## Session Notes (2025-02-25)
- Fixed database sync: markets now persist correctly after buy/sell
- Added atomic PostgreSQL functions for concurrent user safety
- Added gold styling to countdown clock
- Fixed player count increment/decrement
- Added fallback coin data for CoinGecko rate limits
