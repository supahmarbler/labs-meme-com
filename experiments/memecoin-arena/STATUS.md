# Memecoin Arena - Project Status

**Last Updated:** 2025-02-25
**Production URL:** https://labs.meme.com
**Staging URL:** https://labs-meme-com.vercel.app/experiments/memecoin-arena/

---

## What It Is

A prediction market for memecoins using LMSR (Logarithmic Market Scoring Rule) pricing. Users predict whether a coin's price will go UP or DOWN within 24 hours.

**Coins:** JOE, STNK, PENGU, PEPE, MOG, DOG
**Price Feed:** CoinGecko API (with meme.com API fallback)
**Backend:** Supabase (PostgreSQL)
**Frontend:** React + Babel (single-file, no build step)

---

## Current State

### Working
- Market creation and 24h auto-resolution
- LMSR buy/sell mechanics
- Real-time price updates from CoinGecko
- Mobile responsive layout (stacks vertically below 1000px)
- Markets sync to Supabase (`labs_markets` table)
- LocalStorage persistence as fallback

### Also Working (migration completed 2025-02-25)
- User stats persistence (balance, volume, wins/losses, streaks)
- Position persistence (survives browser clear)
- Trade history logging
- Real leaderboard from database

---

## Database

Migration has been applied. Tables:
- `labs_users` - user accounts with stats columns
- `labs_markets` - shared market state
- `labs_positions` - user positions per market
- `labs_trades` - full trade history with PnL

### 2. Verify It Works

After running the migration:
1. Open https://labs-meme-com.vercel.app/experiments/memecoin-arena/
2. Make a trade
3. Check Supabase Table Editor → `labs_users` (should see your user)
4. Check `labs_trades` (should see your trade)
5. Check `labs_positions` (should see your position)

---

## File Structure

```
experiments/memecoin-arena/
├── index.html          # Entry point, loads fonts + Supabase SDK
├── app.jsx             # All React code (~1300 lines)
├── supabase-schema.sql # Database schema + migrations
└── STATUS.md           # This file
```

---

## Key Code Sections (app.jsx)

| Lines | Section |
|-------|---------|
| 1-12 | useIsMobile hook |
| 14-17 | Supabase client init |
| 19-49 | User ID + meme.com auth detection |
| 51-66 | LocalStorage helpers |
| 68-91 | Market sync to DB |
| 93-212 | DB sync functions (users, positions, trades, leaderboard) |
| 214-275 | LMSR math (cost function, probability, buy/sell) |
| 300-665 | Card component (market UI) |
| 667-780 | DepositModal component |
| 782-930 | App init + state loading |
| 932-970 | Price feed + resolution timers |
| 992-1085 | Buy/Sell/Claim handlers |
| 1087-1350 | Main layout + sidebar |

---

## Supabase Config

```
URL: https://csvegolcvwuwssoefxdh.supabase.co
Key: sb_publishable_Qf1O75YbEeBE2qwg4ThmwA_Uxpw9BG4
```

Tables:
- `labs_markets` - shared market state
- `labs_users` - user accounts + stats
- `labs_positions` - active positions per user
- `labs_trades` - trade history

---

## Future Improvements

### High Priority
- [ ] Run the SQL migration (required for leaderboard to work)
- [ ] Link to real meme.com accounts (currently uses anonymous UUIDs)
- [ ] Add more coins dynamically

### Nice to Have
- [ ] Conviction bonus multiplier (code exists but disabled)
- [ ] Share predictions to Twitter
- [ ] Price alerts
- [ ] Historical charts

---

## Deployment

```bash
cd /Users/johanunger/Desktop/labs-meme-com
vercel --prod
```

Auto-deploys to: https://labs-meme-com.vercel.app

---

## Related Backend Work (meme-api-v2)

There's also a plan for server-side auto-resolution at:
```
/Users/johanunger/.claude/plans/polymorphic-roaming-hellman.md
```

This would add:
- Automatic price-based resolution via CoinGecko Pro API
- Recurring 24h markets that auto-create after resolution
- Integration with the main meme.com prediction market system

**Status:** Schema + services written, needs testing and deployment.
