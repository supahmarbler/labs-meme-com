-- Production Migration for Memecoin Arena
-- Run this in Supabase SQL Editor
-- This adds constraints, indexes, and atomic functions for handling concurrent users

-- ============================================================
-- 1. ADD CONSTRAINTS (safe to run multiple times with IF NOT EXISTS pattern)
-- ============================================================

-- Ensure positive balances
DO $$ BEGIN
  ALTER TABLE labs_users ADD CONSTRAINT positive_balance CHECK (labs_balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Ensure positive shares in positions
DO $$ BEGIN
  ALTER TABLE labs_positions ADD CONSTRAINT positive_shares CHECK (shares > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Ensure positive investment
DO $$ BEGIN
  ALTER TABLE labs_positions ADD CONSTRAINT positive_invested CHECK (invested > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. ADD PERFORMANCE INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_markets_expires ON labs_markets(expires_at);
CREATE INDEX IF NOT EXISTS idx_markets_status_expires ON labs_markets(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_positions_market ON labs_positions(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_user_created ON labs_trades(user_id, created_at DESC);

-- ============================================================
-- 3. LMSR HELPER FUNCTIONS
-- ============================================================

-- Cost function: C(qY, qN, B) = B * (m + ln(exp(qY/B - m) + exp(qN/B - m)))
-- where m = max(qY, qN) / B
CREATE OR REPLACE FUNCTION lmsr_cost(q_yes numeric, q_no numeric, b numeric)
RETURNS numeric AS $$
DECLARE
  m numeric;
BEGIN
  m := GREATEST(q_yes, q_no) / b;
  RETURN b * (m + LN(EXP(q_yes/b - m) + EXP(q_no/b - m)));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Calculate shares for a given cost using binary search
CREATE OR REPLACE FUNCTION lmsr_buy_shares(
  q_yes numeric,
  q_no numeric,
  b numeric,
  cost numeric,
  side text
) RETURNS numeric AS $$
DECLARE
  old_cost numeric;
  m numeric;
  e_yes numeric;
  e_no numeric;
  p numeric;
  lo numeric := 0;
  hi numeric;
  mid numeric;
  new_q_yes numeric;
  new_q_no numeric;
  new_cost numeric;
  i int;
BEGIN
  IF cost <= 0 THEN RETURN 0; END IF;

  old_cost := lmsr_cost(q_yes, q_no, b);

  -- Compute proper upper bound based on current share price
  m := GREATEST(q_yes, q_no) / b;
  e_yes := EXP(q_yes/b - m);
  e_no := EXP(q_no/b - m);
  IF side = 'YES' THEN
    p := e_yes / (e_yes + e_no);
  ELSE
    p := e_no / (e_yes + e_no);
  END IF;
  hi := GREATEST(cost * 2, cost / GREATEST(p, 0.01) * 2);

  FOR i IN 1..60 LOOP
    mid := (lo + hi) / 2;
    IF side = 'YES' THEN
      new_q_yes := q_yes + mid;
      new_q_no := q_no;
    ELSE
      new_q_yes := q_yes;
      new_q_no := q_no + mid;
    END IF;
    new_cost := lmsr_cost(new_q_yes, new_q_no, b);
    IF new_cost - old_cost < cost THEN
      lo := mid;
    ELSE
      hi := mid;
    END IF;
  END LOOP;

  RETURN ROUND((lo + hi) / 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Calculate refund for selling shares
CREATE OR REPLACE FUNCTION lmsr_sell_refund(
  q_yes numeric,
  q_no numeric,
  b numeric,
  shares numeric,
  side text
) RETURNS numeric AS $$
DECLARE
  old_cost numeric;
  new_q_yes numeric;
  new_q_no numeric;
  new_cost numeric;
BEGIN
  IF shares <= 0 THEN RETURN 0; END IF;

  old_cost := lmsr_cost(q_yes, q_no, b);

  IF side = 'YES' THEN
    new_q_yes := GREATEST(0, q_yes - shares);
    new_q_no := q_no;
  ELSE
    new_q_yes := q_yes;
    new_q_no := GREATEST(0, q_no - shares);
  END IF;

  new_cost := lmsr_cost(new_q_yes, new_q_no, b);
  RETURN GREATEST(0, ROUND(old_cost - new_cost));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- 4. ATOMIC BUY FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION labs_buy(
  p_user_id uuid,
  p_market_id text,
  p_side text,
  p_amount int
) RETURNS json AS $$
DECLARE
  v_market labs_markets%ROWTYPE;
  v_user labs_users%ROWTYPE;
  v_position labs_positions%ROWTYPE;
  v_shares numeric;
  v_new_q_yes numeric;
  v_new_q_no numeric;
  v_is_new_player boolean;
BEGIN
  -- Validate inputs
  IF p_side NOT IN ('YES', 'NO') THEN
    RETURN json_build_object('success', false, 'error', 'invalid_side');
  END IF;

  IF p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  -- Lock and get market
  SELECT * INTO v_market FROM labs_markets
  WHERE id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'market_not_found');
  END IF;

  IF v_market.status != 'OPEN' THEN
    RETURN json_build_object('success', false, 'error', 'market_closed');
  END IF;

  -- Lock and get user
  SELECT * INTO v_user FROM labs_users
  WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;

  IF v_user.labs_balance < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'insufficient_balance');
  END IF;

  -- Calculate shares using LMSR (add base liquidity B for calculation)
  v_shares := lmsr_buy_shares(
    v_market.q_yes + v_market.b,
    v_market.q_no + v_market.b,
    v_market.b,
    p_amount,
    p_side
  );

  IF v_shares <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'zero_shares');
  END IF;

  -- Check if user already has position in this market
  SELECT * INTO v_position FROM labs_positions
  WHERE user_id = p_user_id AND market_id = p_market_id FOR UPDATE;

  v_is_new_player := NOT FOUND;

  -- Calculate new q values
  IF p_side = 'YES' THEN
    v_new_q_yes := v_market.q_yes + v_shares;
    v_new_q_no := v_market.q_no;
  ELSE
    v_new_q_yes := v_market.q_yes;
    v_new_q_no := v_market.q_no + v_shares;
  END IF;

  -- Update market
  UPDATE labs_markets SET
    q_yes = v_new_q_yes,
    q_no = v_new_q_no,
    volume = volume + p_amount,
    players = players + (CASE WHEN v_is_new_player THEN 1 ELSE 0 END)
  WHERE id = p_market_id;

  -- Update or create position
  IF v_is_new_player THEN
    INSERT INTO labs_positions (user_id, market_id, side, shares, invested)
    VALUES (p_user_id, p_market_id, p_side, v_shares, p_amount);
  ELSE
    -- Can only add to same side position
    IF v_position.side != p_side THEN
      RETURN json_build_object('success', false, 'error', 'different_side');
    END IF;
    UPDATE labs_positions SET
      shares = shares + v_shares,
      invested = invested + p_amount
    WHERE user_id = p_user_id AND market_id = p_market_id;
  END IF;

  -- Deduct from user balance
  UPDATE labs_users SET
    labs_balance = labs_balance - p_amount,
    total_volume = total_volume + p_amount,
    updated_at = NOW()
  WHERE id = p_user_id;

  -- Record trade
  INSERT INTO labs_trades (user_id, market_id, coin_symbol, side, shares, amount, trade_type)
  VALUES (p_user_id, p_market_id, v_market.coin_symbol, p_side, v_shares, p_amount, 'BUY');

  RETURN json_build_object(
    'success', true,
    'shares', v_shares,
    'new_q_yes', v_new_q_yes,
    'new_q_no', v_new_q_no,
    'new_balance', v_user.labs_balance - p_amount
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. ATOMIC SELL FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION labs_sell(
  p_user_id uuid,
  p_market_id text
) RETURNS json AS $$
DECLARE
  v_market labs_markets%ROWTYPE;
  v_position labs_positions%ROWTYPE;
  v_refund numeric;
  v_new_q_yes numeric;
  v_new_q_no numeric;
  v_pnl int;
BEGIN
  -- Lock and get market
  SELECT * INTO v_market FROM labs_markets
  WHERE id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'market_not_found');
  END IF;

  IF v_market.status != 'OPEN' THEN
    RETURN json_build_object('success', false, 'error', 'market_closed');
  END IF;

  -- Lock and get position
  SELECT * INTO v_position FROM labs_positions
  WHERE user_id = p_user_id AND market_id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'no_position');
  END IF;

  -- Calculate refund using LMSR (add base liquidity B for calculation)
  v_refund := lmsr_sell_refund(
    v_market.q_yes + v_market.b,
    v_market.q_no + v_market.b,
    v_market.b,
    v_position.shares,
    v_position.side
  );

  v_pnl := v_refund - v_position.invested;

  -- Calculate new q values
  IF v_position.side = 'YES' THEN
    v_new_q_yes := GREATEST(0, v_market.q_yes - v_position.shares);
    v_new_q_no := v_market.q_no;
  ELSE
    v_new_q_yes := v_market.q_yes;
    v_new_q_no := GREATEST(0, v_market.q_no - v_position.shares);
  END IF;

  -- Update market
  UPDATE labs_markets SET
    q_yes = v_new_q_yes,
    q_no = v_new_q_no,
    volume = volume + v_refund,
    players = GREATEST(0, players - 1)
  WHERE id = p_market_id;

  -- Delete position
  DELETE FROM labs_positions
  WHERE user_id = p_user_id AND market_id = p_market_id;

  -- Add refund to user balance
  UPDATE labs_users SET
    labs_balance = labs_balance + v_refund,
    total_volume = total_volume + v_refund,
    updated_at = NOW()
  WHERE id = p_user_id;

  -- Record trade
  INSERT INTO labs_trades (user_id, market_id, coin_symbol, side, shares, amount, trade_type, pnl)
  VALUES (p_user_id, p_market_id, v_market.coin_symbol, v_position.side, v_position.shares, v_refund, 'SELL', v_pnl);

  RETURN json_build_object(
    'success', true,
    'refund', v_refund,
    'pnl', v_pnl,
    'new_q_yes', v_new_q_yes,
    'new_q_no', v_new_q_no
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. GRANT EXECUTE PERMISSIONS
-- ============================================================

GRANT EXECUTE ON FUNCTION lmsr_cost TO anon, authenticated;
GRANT EXECUTE ON FUNCTION lmsr_buy_shares TO anon, authenticated;
GRANT EXECUTE ON FUNCTION lmsr_sell_refund TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_buy TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_sell TO anon, authenticated;

-- ============================================================
-- Done! The frontend can now call:
-- supabase.rpc('labs_buy', { p_user_id, p_market_id, p_side, p_amount })
-- supabase.rpc('labs_sell', { p_user_id, p_market_id })
-- ============================================================
