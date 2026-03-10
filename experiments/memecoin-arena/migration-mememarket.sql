-- Migration: MemeMarket — User-Generated Trend Prediction Markets
-- Prerequisites: migration-trends.sql must be applied first
--
-- Adds MEMEMARKET market type: single-meme UP/DOWN markets created by users,
-- resolved via Google Trends scores (same pipeline as TRENDS).

-- ============================================================
-- 1. NEW COLUMNS
-- ============================================================

ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS creation_fee numeric DEFAULT 0;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS creator_payout_claimed boolean DEFAULT false;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS created_by text;

-- ============================================================
-- 2. UPDATE valid_market_expiry CHECK — exempt MEMEMARKET
-- ============================================================

ALTER TABLE labs_markets DROP CONSTRAINT IF EXISTS valid_market_expiry;
ALTER TABLE labs_markets ADD CONSTRAINT valid_market_expiry
  CHECK (status != 'OPEN' OR market_type = 'BATTLE' OR market_type = 'TRENDS'
         OR market_type = 'MEMEMARKET'
         OR EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13);

-- ============================================================
-- 3. UPDATE labs_prevent_duplicate_open — deduplicate MEMEMARKET by trend term
-- ============================================================

CREATE OR REPLACE FUNCTION labs_prevent_duplicate_open()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' THEN
    IF NEW.market_type = 'MEMEMARKET' THEN
      -- Deduplicate by trend term (case-insensitive)
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'MEMEMARKET'
        AND lower(trend_term_a) = lower(NEW.trend_term_a)
        AND id != NEW.id
      ) THEN
        RETURN NULL;
      END IF;
    ELSIF NEW.market_type = 'TRENDS' THEN
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'TRENDS' AND id != NEW.id
      ) THEN
        RETURN NULL;
      END IF;
    ELSIF NEW.market_type = 'BATTLE' THEN
      IF EXISTS (
        SELECT 1 FROM labs_markets
        WHERE status = 'OPEN' AND market_type = 'BATTLE' AND id != NEW.id
      ) THEN
        RETURN NULL;
      END IF;
    ELSE
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

-- ============================================================
-- 4. UPDATE labs_enforce_market_expiry — skip MEMEMARKET
-- ============================================================

CREATE OR REPLACE FUNCTION labs_enforce_market_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' AND (NEW.market_type IS NULL OR (NEW.market_type != 'BATTLE' AND NEW.market_type != 'TRENDS' AND NEW.market_type != 'MEMEMARKET')) THEN
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
-- 5. UPDATE labs_auto_resolve — add MEMEMARKET support + creator payout
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
  v_creator_bonus numeric;
BEGIN
  FOR m IN
    SELECT * FROM labs_markets
    WHERE status = 'OPEN'
    AND expires_at <= NOW()
    AND (
      (market_type IN ('BATTLE', 'TRENDS', 'MEMEMARKET'))
      OR (EXTRACT(HOUR FROM expires_at AT TIME ZONE 'UTC') = 13
          AND EXTRACT(MINUTE FROM expires_at AT TIME ZONE 'UTC') >= 59)
    )
    FOR UPDATE
  LOOP
    IF m.market_type = 'TRENDS' THEN
      v_pct_a := COALESCE(m.current_mc, 0) - COALESCE(m.start_mc, 0);
      v_pct_b := COALESCE(m.current_mc_b, 0) - COALESCE(m.start_mc_b, 0);
      IF v_pct_a >= v_pct_b THEN
        v_result := 'YES';
      ELSE
        v_result := 'NO';
      END IF;
    ELSIF m.market_type = 'BATTLE' THEN
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
      -- UPDOWN and MEMEMARKET: current >= start → YES
      IF COALESCE(m.current_mc, 0) >= COALESCE(m.start_mc, 0) THEN
        v_result := 'YES';
      ELSE
        v_result := 'NO';
      END IF;
    END IF;

    -- Total pot
    SELECT COALESCE(SUM(invested), 0) INTO v_total_pot
    FROM labs_positions WHERE market_id = m.id;

    -- Winner weight
    SELECT COALESCE(SUM(p.shares), 0) INTO v_winner_weight_sum
    FROM labs_positions p WHERE p.market_id = m.id AND p.side = v_result;

    -- Winner invested sum
    SELECT COALESCE(SUM(p.invested), 0) INTO v_winner_invested_sum
    FROM labs_positions p WHERE p.market_id = m.id AND p.side = v_result;

    UPDATE labs_markets
    SET status = 'RES', result = v_result,
        total_pot = v_total_pot,
        winner_weight_sum = v_winner_weight_sum,
        winner_invested_sum = v_winner_invested_sum
    WHERE id = m.id;

    -- MEMEMARKET creator payout: refund creation_fee + 25% of fee_pool
    IF m.market_type = 'MEMEMARKET' AND m.created_by IS NOT NULL AND COALESCE(m.creation_fee, 0) > 0 THEN
      v_creator_bonus := ROUND(COALESCE(m.fee_pool, 0) * 0.25);
      PERFORM set_config('labs.allow_balance_write', 'true', true);
      UPDATE labs_users
      SET labs_balance = labs_balance + m.creation_fee + v_creator_bonus,
          updated_at = NOW()
      WHERE id = m.created_by;
      UPDATE labs_markets
      SET creator_payout_claimed = true,
          fee_pool = GREATEST(0, fee_pool - v_creator_bonus)
      WHERE id = m.id;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. NEW RPC: labs_create_mememarket
-- ============================================================

CREATE OR REPLACE FUNCTION labs_create_mememarket(
  p_user_id text,
  p_meme_name text,
  p_trend_term text,
  p_image_url text,
  p_duration_hours int
) RETURNS json AS $$
DECLARE
  v_user labs_users%ROWTYPE;
  v_market_id text;
  v_slug text;
  v_round int;
  v_expires_at timestamptz;
  v_creation_fee numeric := 1000;
  v_new_balance numeric;
  v_open_count int;
BEGIN
  -- Validate inputs
  IF length(trim(p_meme_name)) < 2 OR length(trim(p_meme_name)) > 50 THEN
    RETURN json_build_object('success', false, 'error', 'name_invalid');
  END IF;
  IF length(trim(p_trend_term)) < 2 OR length(trim(p_trend_term)) > 80 THEN
    RETURN json_build_object('success', false, 'error', 'term_invalid');
  END IF;
  IF p_duration_hours NOT IN (24, 72, 168) THEN
    RETURN json_build_object('success', false, 'error', 'duration_invalid');
  END IF;

  -- Cap at 20 concurrent MEMEMARKET markets
  SELECT COUNT(*) INTO v_open_count FROM labs_markets
  WHERE market_type = 'MEMEMARKET' AND status = 'OPEN';
  IF v_open_count >= 20 THEN
    RETURN json_build_object('success', false, 'error', 'max_markets_reached');
  END IF;

  -- Check no duplicate open market for same trend term
  IF EXISTS (
    SELECT 1 FROM labs_markets
    WHERE status = 'OPEN' AND market_type = 'MEMEMARKET'
    AND lower(trend_term_a) = lower(trim(p_trend_term))
  ) THEN
    RETURN json_build_object('success', false, 'error', 'duplicate_term');
  END IF;

  -- Lock user and check balance
  PERFORM set_config('labs.allow_balance_write', 'true', true);
  SELECT * INTO v_user FROM labs_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF v_user.labs_balance < v_creation_fee THEN
    RETURN json_build_object('success', false, 'error', 'insufficient_balance');
  END IF;

  -- Deduct creation fee
  UPDATE labs_users SET
    labs_balance = labs_balance - v_creation_fee,
    updated_at = NOW()
  WHERE id = p_user_id;

  SELECT labs_balance INTO v_new_balance FROM labs_users WHERE id = p_user_id;

  -- Build market ID
  v_slug := upper(regexp_replace(trim(p_meme_name), '[^a-zA-Z0-9]', '', 'g'));
  v_slug := left(v_slug, 12);

  SELECT COALESCE(MAX(
    (regexp_match(id, '-(\d+)$'))[1]::int
  ), 0) + 1 INTO v_round
  FROM labs_markets
  WHERE market_type = 'MEMEMARKET' AND id LIKE 'MEME-' || v_slug || '-%';

  v_market_id := 'MEME-' || v_slug || '-' || v_round;
  v_expires_at := NOW() + (p_duration_hours || ' hours')::interval;

  -- Insert market
  INSERT INTO labs_markets (
    id, market_type, status,
    coin_symbol, coin_name, coin_image, coin_color,
    trend_term_a,
    start_mc, current_mc,
    q_yes, q_no, b,
    expires_at, volume, players,
    fee_pool, total_pot, winner_weight_sum, winner_invested_sum,
    creation_fee, created_by, creator_payout_claimed,
    custom_title, created_at
  ) VALUES (
    v_market_id, 'MEMEMARKET', 'OPEN',
    trim(p_meme_name), trim(p_meme_name), COALESCE(NULLIF(trim(p_image_url), ''), ''), '#71BAFF',
    trim(p_trend_term),
    50, 50,
    0, 0, 50000,
    v_expires_at, 0, 0,
    0, 0, 0, 0,
    v_creation_fee, p_user_id, false,
    'Will ' || trim(p_meme_name) || ' trend UP in ' ||
      CASE p_duration_hours WHEN 24 THEN '1 day' WHEN 72 THEN '3 days' WHEN 168 THEN '7 days' END || '?',
    NOW()
  );

  RETURN json_build_object(
    'success', true,
    'market_id', v_market_id,
    'new_balance', v_new_balance,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 7. INDEX for fast MEMEMARKET queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_markets_mememarket_open
  ON labs_markets (market_type, status)
  WHERE market_type = 'MEMEMARKET' AND status = 'OPEN';

-- ============================================================
-- 8. PERMISSIONS
-- ============================================================

GRANT EXECUTE ON FUNCTION labs_create_mememarket(text, text, text, text, int) TO anon, authenticated;
