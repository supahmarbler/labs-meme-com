-- Migration: Add authentication guard to labs_buy and labs_sell
-- Rejects any user_id that doesn't start with 'meme-' (i.e. not logged in via meme.com)
-- Run this in Supabase SQL Editor
--
-- PREREQUISITE: labs_users.id must be text type (not uuid) to support 'meme-{id}' format.
-- If not already done, run:
--   ALTER TABLE labs_users ALTER COLUMN id TYPE text;
-- (and update foreign keys on labs_positions, labs_trades accordingly)

-- ============================================================
-- 0. DROP OLD uuid-parameter OVERLOADS (if they exist)
-- ============================================================
DROP FUNCTION IF EXISTS labs_buy(uuid, text, text, int);
DROP FUNCTION IF EXISTS labs_sell(uuid, text);

-- ============================================================
-- 1. UPDATE labs_buy TO REQUIRE meme- PREFIX
-- ============================================================

CREATE OR REPLACE FUNCTION labs_buy(
  p_user_id text,
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
  -- Authentication check: reject non-meme.com users
  IF NOT p_user_id LIKE 'meme-%' THEN
    RETURN json_build_object('success', false, 'error', 'Authentication required');
  END IF;

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
-- 2. UPDATE labs_sell TO REQUIRE meme- PREFIX
-- ============================================================

CREATE OR REPLACE FUNCTION labs_sell(
  p_user_id text,
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
  -- Authentication check: reject non-meme.com users
  IF NOT p_user_id LIKE 'meme-%' THEN
    RETURN json_build_object('success', false, 'error', 'Authentication required');
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
-- 3. RE-GRANT PERMISSIONS
-- ============================================================

GRANT EXECUTE ON FUNCTION labs_buy(text, text, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_sell(text, text) TO anon, authenticated;
