-- Migration: Trends Battle Markets
-- Extends existing BATTLE infrastructure for Google Trends meme-vs-meme battles
--
-- Prerequisites: migration-battles.sql + migration-winner-floor.sql must be applied first

-- 1. Trend-specific columns (images reuse existing coin_image / coin_b_image)
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS trend_term_a text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS trend_term_b text;

-- 2. Update valid_market_expiry CHECK constraint to exempt TRENDS (like BATTLE)
ALTER TABLE labs_markets DROP CONSTRAINT IF EXISTS valid_market_expiry;
ALTER TABLE labs_markets ADD CONSTRAINT valid_market_expiry
  CHECK (status != 'OPEN' OR market_type = 'BATTLE' OR market_type = 'TRENDS'
         OR EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13);

-- 3. Update labs_prevent_duplicate_open (the actual trigger function, note labs_ prefix)
--    Uses RETURN NULL to silently drop duplicates (matching production pattern)
CREATE OR REPLACE FUNCTION labs_prevent_duplicate_open()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' THEN
    IF NEW.market_type = 'TRENDS' THEN
      -- Only 1 open trends battle at a time
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'TRENDS' AND id != NEW.id
      ) THEN
        RETURN NULL;
      END IF;
    ELSIF NEW.market_type = 'BATTLE' THEN
      -- Only 1 open coin battle at a time
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'BATTLE' AND id != NEW.id
      ) THEN
        RETURN NULL;
      END IF;
    ELSE
      -- Existing UPDOWN logic: must expire at hour 13, one per coin
      IF EXTRACT(HOUR FROM NEW.expires_at AT TIME ZONE 'UTC') != 13 THEN
        RETURN NULL;
      END IF;
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE coin_symbol = NEW.coin_symbol AND status = 'OPEN' AND id != NEW.id
        AND (market_type IS NULL OR market_type = 'UPDOWN')
      ) THEN
        RETURN NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Update enforce_market_expiry to skip TRENDS markets (7-day expiry set by bot)
CREATE OR REPLACE FUNCTION labs_enforce_market_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' AND (NEW.market_type IS NULL OR (NEW.market_type != 'BATTLE' AND NEW.market_type != 'TRENDS')) THEN
    IF (NOW() AT TIME ZONE 'UTC')::time < '13:59:59'::time THEN
      NEW.expires_at := (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '13 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';
    ELSE
      NEW.expires_at := (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day 13 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Update labs_auto_resolve — CRITICAL: preserves floor payout fields from migration-winner-floor.sql
--    Changes: BATTLE/TRENDS resolve at any expiry time (not just 13:59 UTC)
CREATE OR REPLACE FUNCTION labs_auto_resolve()
RETURNS void AS $$
DECLARE
  m RECORD;
  v_result text;
  v_pct_a numeric;
  v_pct_b numeric;
  v_total_pot numeric;
  v_winner_weight_sum numeric;
  v_winner_invested_sum numeric;
BEGIN
  FOR m IN
    SELECT * FROM labs_markets
    WHERE status = 'OPEN'
    AND expires_at <= NOW()
    -- UPDOWN: only resolve at 13:59 UTC. BATTLE/TRENDS: resolve whenever expired.
    AND (
      (market_type IN ('BATTLE', 'TRENDS'))
      OR (EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13
          AND EXTRACT(MINUTE FROM expires_at AT TIME ZONE 'UTC') >= 59)
    )
    FOR UPDATE
  LOOP
    IF m.market_type = 'TRENDS' THEN
      -- Trends: absolute point change (both on same Pytrends 0-100 scale)
      v_pct_a := COALESCE(m.current_mc, 0) - COALESCE(m.start_mc, 0);
      v_pct_b := COALESCE(m.current_mc_b, 0) - COALESCE(m.start_mc_b, 0);
      IF v_pct_a >= v_pct_b THEN
        v_result := 'YES';
      ELSE
        v_result := 'NO';
      END IF;
    ELSIF m.market_type = 'BATTLE' THEN
      -- Battle: compare relative % change (market cap)
      v_pct_a := CASE WHEN COALESCE(m.start_mc, 0) = 0 THEN 0
                      ELSE (COALESCE(m.current_mc, 0) - m.start_mc) / m.start_mc END;
      v_pct_b := CASE WHEN COALESCE(m.start_mc_b, 0) = 0 THEN 0
                      ELSE (COALESCE(m.current_mc_b, 0) - m.start_mc_b) / m.start_mc_b END;
      IF v_pct_a >= v_pct_b THEN
        v_result := 'YES';
      ELSE
        v_result := 'NO';
      END IF;
    ELSE
      -- Existing UPDOWN logic
      IF COALESCE(m.current_mc, 0) >= COALESCE(m.start_mc, 0) THEN
        v_result := 'YES';
      ELSE
        v_result := 'NO';
      END IF;
    END IF;

    -- Total pot: sum of all invested
    SELECT COALESCE(SUM(invested), 0) INTO v_total_pot
    FROM labs_positions
    WHERE market_id = m.id;

    -- Winner weight: SUM(shares) for winning side
    SELECT COALESCE(SUM(p.shares), 0) INTO v_winner_weight_sum
    FROM labs_positions p
    WHERE p.market_id = m.id AND p.side = v_result;

    -- Winner invested sum: SUM(invested) for winning side
    SELECT COALESCE(SUM(p.invested), 0) INTO v_winner_invested_sum
    FROM labs_positions p
    WHERE p.market_id = m.id AND p.side = v_result;

    UPDATE labs_markets
    SET status = 'RES', result = v_result,
        total_pot = v_total_pot,
        winner_weight_sum = v_winner_weight_sum,
        winner_invested_sum = v_winner_invested_sum
    WHERE id = m.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
