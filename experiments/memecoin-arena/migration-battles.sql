-- Migration: Battle Markets (Coin vs Coin)
-- Adds BATTLE market type alongside existing UPDOWN markets

-- 1. New columns on labs_markets
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS market_type text DEFAULT 'UPDOWN';
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS coin_b_symbol text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS coin_b_name text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS coin_b_image text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS coin_b_color text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS start_mc_b numeric;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS current_mc_b numeric;

-- 2. Update prevent_duplicate_open trigger
-- For BATTLE: limit 1 open battle total (check both orderings)
-- For UPDOWN: existing logic (1 open per coin symbol)
CREATE OR REPLACE FUNCTION prevent_duplicate_open()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' THEN
    IF NEW.market_type = 'BATTLE' THEN
      -- Only 1 open battle at a time
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'BATTLE' AND id != NEW.id
      ) THEN
        RAISE EXCEPTION 'Only one open battle market allowed at a time';
      END IF;
      -- Check both orderings (AvB and BvA)
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'BATTLE' AND id != NEW.id
        AND (
          (coin_symbol = NEW.coin_symbol AND coin_b_symbol = NEW.coin_b_symbol)
          OR (coin_symbol = NEW.coin_b_symbol AND coin_b_symbol = NEW.coin_symbol)
        )
      ) THEN
        RAISE EXCEPTION 'Duplicate battle matchup already open';
      END IF;
    ELSE
      -- Existing UPDOWN logic
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE coin_symbol = NEW.coin_symbol AND status = 'OPEN' AND id != NEW.id
        AND (market_type IS NULL OR market_type = 'UPDOWN')
      ) THEN
        RAISE EXCEPTION 'Duplicate open market for coin %', NEW.coin_symbol;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Update protect_start_mc trigger to also freeze start_mc_b
CREATE OR REPLACE FUNCTION protect_start_mc()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.start_mc IS NOT NULL AND NEW.start_mc IS DISTINCT FROM OLD.start_mc THEN
    NEW.start_mc := OLD.start_mc;
  END IF;
  IF OLD.start_mc_b IS NOT NULL AND NEW.start_mc_b IS DISTINCT FROM OLD.start_mc_b THEN
    NEW.start_mc_b := OLD.start_mc_b;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Update enforce_market_expiry to skip BATTLE markets (they have 48h expiry)
CREATE OR REPLACE FUNCTION labs_enforce_market_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' AND (NEW.market_type IS NULL OR NEW.market_type != 'BATTLE') THEN
    IF (NOW() AT TIME ZONE 'UTC')::time < '13:59:59'::time THEN
      NEW.expires_at := (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '13 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';
    ELSE
      NEW.expires_at := (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day 13 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Update labs_auto_resolve to handle BATTLE markets
CREATE OR REPLACE FUNCTION labs_auto_resolve()
RETURNS void AS $$
DECLARE
  m RECORD;
  v_result text;
  v_pct_a numeric;
  v_pct_b numeric;
BEGIN
  FOR m IN
    SELECT * FROM labs_markets
    WHERE status = 'OPEN'
    AND expires_at <= NOW()
    AND EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13
    AND EXTRACT(MINUTE FROM expires_at AT TIME ZONE 'UTC') >= 59
    FOR UPDATE
  LOOP
    IF m.market_type = 'BATTLE' THEN
      -- Battle: compare relative % change
      v_pct_a := CASE WHEN COALESCE(m.start_mc, 0) = 0 THEN 0
                      ELSE (COALESCE(m.current_mc, 0) - m.start_mc) / m.start_mc END;
      v_pct_b := CASE WHEN COALESCE(m.start_mc_b, 0) = 0 THEN 0
                      ELSE (COALESCE(m.current_mc_b, 0) - m.start_mc_b) / m.start_mc_b END;
      -- Tie goes to Coin A (YES side)
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

    UPDATE labs_markets
    SET status = 'RES', result = v_result
    WHERE id = m.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
