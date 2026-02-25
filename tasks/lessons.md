# Lessons - labs-meme-com

## React State Updates (2025-02-25)
**Problem:** Database sync wasn't persisting because values were computed inside `setState` callback.
**Fix:** Compute derived values BEFORE `setState`, then pass them to both state update and sync functions.
```javascript
// BAD - updatedMarket computed inside callback, not available for sync
setMks(p => p.map(mk => mk.id !== mid ? mk : { ...mk, qY: mk.qY + shares }));
syncMarketToDb(???); // Can't access updated value

// GOOD - compute first, then use everywhere
const updatedMarket = { ...m, qY: m.qY + shares };
setMks(p => p.map(mk => mk.id !== mid ? mk : updatedMarket));
syncMarketToDb(updatedMarket);
```

## Supabase Upsert vs Update (2025-02-25)
**Problem:** `upsert()` can silently fail or cause race conditions.
**Fix:** Use `update().eq('id', ...)` with retry logic for existing records.

## Atomic Database Operations (2025-02-25)
**Problem:** Concurrent users can cause race conditions in prediction markets.
**Fix:** Use PostgreSQL functions with `FOR UPDATE` row locking:
```sql
SELECT * INTO v_market FROM labs_markets WHERE id = p_market_id FOR UPDATE;
-- Now safe to read, compute, and update
```

## CoinGecko Rate Limits (2025-02-25)
**Problem:** Free tier returns 429 errors, breaks app loading.
**Fix:** Add fallback static data so app loads even when API fails.

## LMSR Base Liquidity Storage (2025-02-25)
**Pattern:** Store q_yes/q_no WITHOUT base liquidity in database, add it back in frontend.
- DB: `q_yes = 0, q_no = 0` (neutral market)
- Frontend: `qY = db.q_yes + b, qN = db.q_no + b` (for calculations)
- This prevents negative q values in storage.
