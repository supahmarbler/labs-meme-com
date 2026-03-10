-- Migration: Custom Prediction Markets
-- Adds CUSTOM market type for YES/NO prediction markets with custom titles,
-- images, and manual resolution via Discord bot.
--
-- Applied to both dev (vnteehkwrygodkljfwyp) and prod (csvegolcvwuwssoefxdh)
-- Date: 2026-03-05

-- ============================================================
-- 1. SCHEMA: New columns on labs_markets
-- ============================================================

ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS custom_title text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS custom_image_url text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS custom_description text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS label_yes text DEFAULT 'YES';
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS label_no text DEFAULT 'NO';
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS created_by text;

-- ============================================================
-- 2. UPDATE prevent_duplicate_open — allow multiple CUSTOMs
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_duplicate_open()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' THEN
    IF NEW.market_type = 'CUSTOM' THEN
      -- Allow multiple CUSTOM markets, dedup by title only
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'CUSTOM' AND id != NEW.id
        AND custom_title = NEW.custom_title
      ) THEN
        RAISE EXCEPTION 'Duplicate open custom market with same title';
      END IF;
    ELSIF NEW.market_type = 'BATTLE' THEN
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

-- ============================================================
-- 3. UPDATE enforce_market_expiry — skip CUSTOM (arbitrary dates)
-- ============================================================

CREATE OR REPLACE FUNCTION labs_enforce_market_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN'
    AND (NEW.market_type IS NULL OR (NEW.market_type != 'BATTLE' AND NEW.market_type != 'CUSTOM' AND NEW.market_type != 'TRENDS'))
  THEN
    IF (NOW() AT TIME ZONE 'UTC')::time < '13:59:59'::time THEN
      NEW.expires_at := (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '13 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';
    ELSE
      NEW.expires_at := (date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day 13 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. UPDATE labs_auto_resolve — skip CUSTOM (manual resolution)
-- ============================================================

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
    AND market_type != 'CUSTOM'
    AND expires_at <= NOW()
    AND EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13
    AND EXTRACT(MINUTE FROM expires_at AT TIME ZONE 'UTC') >= 59
    FOR UPDATE
  LOOP
    IF m.market_type = 'BATTLE' THEN
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

-- ============================================================
-- 5. DROP valid_market_expiry CHECK if it exists, re-add excluding CUSTOM
-- ============================================================

-- Drop old constraint (may not exist on all envs)
ALTER TABLE labs_markets DROP CONSTRAINT IF EXISTS valid_market_expiry;

-- Re-add: OPEN markets must expire at hour=13 UTC, UNLESS BATTLE/TRENDS/CUSTOM
ALTER TABLE labs_markets ADD CONSTRAINT valid_market_expiry CHECK (
  status != 'OPEN'
  OR market_type IN ('BATTLE', 'TRENDS', 'CUSTOM')
  OR EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13
);

-- ============================================================
-- 6. NEW RPC: labs_resolve_custom — manual resolution for CUSTOM markets
-- ============================================================

CREATE OR REPLACE FUNCTION labs_resolve_custom(
  p_market_id text,
  p_result text
) RETURNS json AS $$
DECLARE
  v_market labs_markets%ROWTYPE;
  v_total_pot numeric;
  v_winner_weight_sum numeric;
  v_winner_invested_sum numeric;
BEGIN
  -- Validate result
  IF p_result NOT IN ('YES', 'NO') THEN
    RETURN json_build_object('success', false, 'error', 'invalid_result');
  END IF;

  SELECT * INTO v_market FROM labs_markets
  WHERE id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'market_not_found');
  END IF;

  IF v_market.market_type != 'CUSTOM' THEN
    RETURN json_build_object('success', false, 'error', 'not_custom_market');
  END IF;

  IF v_market.status != 'OPEN' THEN
    RETURN json_build_object('success', false, 'error', 'market_not_open');
  END IF;

  -- Compute pot/weights (same logic as labs_auto_resolve)
  SELECT COALESCE(SUM(invested), 0) INTO v_total_pot
  FROM labs_positions
  WHERE market_id = p_market_id;

  SELECT COALESCE(SUM(p.shares), 0) INTO v_winner_weight_sum
  FROM labs_positions p
  WHERE p.market_id = p_market_id AND p.side = p_result;

  SELECT COALESCE(SUM(p.invested), 0) INTO v_winner_invested_sum
  FROM labs_positions p
  WHERE p.market_id = p_market_id AND p.side = p_result;

  UPDATE labs_markets
  SET status = 'RES',
      result = p_result,
      total_pot = v_total_pot,
      winner_weight_sum = v_winner_weight_sum,
      winner_invested_sum = v_winner_invested_sum
  WHERE id = p_market_id;

  RETURN json_build_object(
    'success', true,
    'market_id', p_market_id,
    'result', p_result,
    'total_pot', v_total_pot,
    'winner_weight_sum', v_winner_weight_sum,
    'winner_invested_sum', v_winner_invested_sum
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
