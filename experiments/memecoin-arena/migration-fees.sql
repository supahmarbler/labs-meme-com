-- Migration: Trading Fee System (Diamond Hands Bonus)
-- 2% entry fee + 2% sell fee → fee pool → distributed to winners at resolution
--
-- Run via Supabase Management API on both dev and prod

-- ============================================================
-- 1. SCHEMA: Add fee_pool to labs_markets
-- ============================================================

ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS fee_pool numeric DEFAULT 0;

-- ============================================================
-- 2. MODIFIED labs_buy — 2% entry fee goes to fee pool
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
  v_fee numeric;
  v_net numeric;
  v_shares numeric;
  v_new_q_yes numeric;
  v_new_q_no numeric;
  v_is_new_player boolean;
BEGIN
  -- Allow balance writes (bypasses protect_labs_balance trigger)
  PERFORM set_config('labs.allow_balance_write', 'true', true);

  -- Validate inputs
  IF p_side NOT IN ('YES', 'NO') THEN
    RETURN json_build_object('success', false, 'error', 'invalid_side');
  END IF;

  IF p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  -- Calculate fee (2% entry fee)
  v_fee := ROUND(p_amount * 0.02);
  v_net := p_amount - v_fee;

  IF v_net <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'amount_too_small');
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

  -- Calculate shares from NET amount (after fee) using LMSR
  v_shares := lmsr_buy_shares(
    v_market.q_yes + v_market.b,
    v_market.q_no + v_market.b,
    v_market.b,
    v_net,
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

  -- Update market (volume tracks full amount, fee goes to pool)
  UPDATE labs_markets SET
    q_yes = v_new_q_yes,
    q_no = v_new_q_no,
    volume = volume + p_amount,
    players = players + (CASE WHEN v_is_new_player THEN 1 ELSE 0 END),
    fee_pool = COALESCE(fee_pool, 0) + v_fee
  WHERE id = p_market_id;

  -- Update or create position (invested = full amount paid)
  IF v_is_new_player THEN
    INSERT INTO labs_positions (user_id, market_id, side, shares, invested)
    VALUES (p_user_id, p_market_id, p_side, v_shares, p_amount);
  ELSE
    IF v_position.side != p_side THEN
      RETURN json_build_object('success', false, 'error', 'different_side');
    END IF;
    UPDATE labs_positions SET
      shares = shares + v_shares,
      invested = invested + p_amount
    WHERE user_id = p_user_id AND market_id = p_market_id;
  END IF;

  -- Deduct full amount from user balance
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
    'fee', v_fee,
    'net_amount', v_net,
    'new_q_yes', v_new_q_yes,
    'new_q_no', v_new_q_no,
    'new_balance', v_user.labs_balance - p_amount,
    'fee_pool', COALESCE(v_market.fee_pool, 0) + v_fee
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 3. MODIFIED labs_sell — 2% exit fee goes to fee pool
-- ============================================================

CREATE OR REPLACE FUNCTION labs_sell(
  p_user_id text,
  p_market_id text
) RETURNS json AS $$
DECLARE
  v_market labs_markets%ROWTYPE;
  v_position labs_positions%ROWTYPE;
  v_gross_refund numeric;
  v_fee numeric;
  v_net_refund numeric;
  v_new_q_yes numeric;
  v_new_q_no numeric;
  v_pnl int;
  v_new_balance numeric;
BEGIN
  -- Allow balance writes (bypasses protect_labs_balance trigger)
  PERFORM set_config('labs.allow_balance_write', 'true', true);

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

  -- Calculate gross refund using LMSR
  v_gross_refund := lmsr_sell_refund(
    v_market.q_yes + v_market.b,
    v_market.q_no + v_market.b,
    v_market.b,
    v_position.shares,
    v_position.side
  );

  -- 2% exit fee
  v_fee := ROUND(v_gross_refund * 0.02);
  v_net_refund := v_gross_refund - v_fee;
  v_pnl := v_net_refund - v_position.invested;

  -- Calculate new q values
  IF v_position.side = 'YES' THEN
    v_new_q_yes := GREATEST(0, v_market.q_yes - v_position.shares);
    v_new_q_no := v_market.q_no;
  ELSE
    v_new_q_yes := v_market.q_yes;
    v_new_q_no := GREATEST(0, v_market.q_no - v_position.shares);
  END IF;

  -- Update market (fee goes to pool)
  UPDATE labs_markets SET
    q_yes = v_new_q_yes,
    q_no = v_new_q_no,
    volume = volume + v_gross_refund,
    players = GREATEST(0, players - 1),
    fee_pool = COALESCE(fee_pool, 0) + v_fee
  WHERE id = p_market_id;

  -- Delete position
  DELETE FROM labs_positions
  WHERE user_id = p_user_id AND market_id = p_market_id;

  -- Credit net refund to user and track profit
  UPDATE labs_users SET
    labs_balance = labs_balance + v_net_refund,
    total_volume = total_volume + v_gross_refund,
    total_profit = COALESCE(total_profit, 0) + v_pnl,
    updated_at = NOW()
  WHERE id = p_user_id;

  -- Get updated balance
  SELECT labs_balance INTO v_new_balance FROM labs_users WHERE id = p_user_id;

  -- Record trade
  INSERT INTO labs_trades (user_id, market_id, coin_symbol, side, shares, amount, trade_type, pnl)
  VALUES (p_user_id, p_market_id, v_market.coin_symbol, v_position.side, v_position.shares, v_net_refund, 'SELL', v_pnl);

  RETURN json_build_object(
    'success', true,
    'gross_refund', v_gross_refund,
    'fee', v_fee,
    'refund', v_net_refund,
    'pnl', v_pnl,
    'new_q_yes', v_new_q_yes,
    'new_q_no', v_new_q_no,
    'new_balance', v_new_balance,
    'fee_pool', COALESCE(v_market.fee_pool, 0) + v_fee
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 4. NEW: labs_claim — atomic claim with fee bonus distribution
-- ============================================================

CREATE OR REPLACE FUNCTION labs_claim(
  p_user_id text,
  p_market_id text
) RETURNS json AS $$
DECLARE
  v_market labs_markets%ROWTYPE;
  v_position labs_positions%ROWTYPE;
  v_user labs_users%ROWTYPE;
  v_won boolean;
  v_reward numeric;
  v_fee_bonus numeric := 0;
  v_total_payout numeric;
  v_pnl numeric;
  v_winning_q numeric;
  v_new_streak int;
  v_new_best_streak int;
  v_new_balance numeric;
BEGIN
  -- Allow balance writes (bypasses protect_labs_balance trigger)
  PERFORM set_config('labs.allow_balance_write', 'true', true);

  -- Lock and get market
  SELECT * INTO v_market FROM labs_markets
  WHERE id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'market_not_found');
  END IF;

  IF v_market.status != 'RES' THEN
    RETURN json_build_object('success', false, 'error', 'market_not_resolved');
  END IF;

  -- Lock and get position
  SELECT * INTO v_position FROM labs_positions
  WHERE user_id = p_user_id AND market_id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'no_position');
  END IF;

  -- Lock and get user
  SELECT * INTO v_user FROM labs_users
  WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;

  -- Determine win/loss
  v_won := (v_market.result = v_position.side);

  IF v_won THEN
    v_reward := ROUND(v_position.shares);

    -- Calculate fee bonus (proportional share of fee pool)
    IF v_market.result = 'YES' THEN
      v_winning_q := v_market.q_yes;
    ELSE
      v_winning_q := v_market.q_no;
    END IF;

    IF v_winning_q > 0 AND COALESCE(v_market.fee_pool, 0) > 0 THEN
      v_fee_bonus := LEAST(
        ROUND(v_position.shares / v_winning_q * v_market.fee_pool),
        v_market.fee_pool
      );
    END IF;

    v_total_payout := v_reward + v_fee_bonus;
    v_new_streak := v_user.current_streak + 1;
    v_new_best_streak := GREATEST(v_user.best_streak, v_new_streak);

    -- Update user balance + stats
    UPDATE labs_users SET
      labs_balance = labs_balance + v_total_payout,
      total_profit = COALESCE(total_profit, 0) + (v_total_payout - v_position.invested),
      wins = wins + 1,
      current_streak = v_new_streak,
      best_streak = v_new_best_streak,
      updated_at = NOW()
    WHERE id = p_user_id;

    -- Decrement fee pool
    IF v_fee_bonus > 0 THEN
      UPDATE labs_markets SET
        fee_pool = GREATEST(0, fee_pool - v_fee_bonus)
      WHERE id = p_market_id;
    END IF;
  ELSE
    v_reward := 0;
    v_fee_bonus := 0;
    v_total_payout := 0;
    v_new_streak := 0;
    v_new_best_streak := v_user.best_streak;

    -- Update user stats (no balance change for losers)
    UPDATE labs_users SET
      total_profit = COALESCE(total_profit, 0) - v_position.invested,
      losses = losses + 1,
      current_streak = 0,
      updated_at = NOW()
    WHERE id = p_user_id;
  END IF;

  v_pnl := v_total_payout - v_position.invested;

  -- Get updated balance
  SELECT labs_balance INTO v_new_balance FROM labs_users WHERE id = p_user_id;

  -- Delete position
  DELETE FROM labs_positions
  WHERE user_id = p_user_id AND market_id = p_market_id;

  -- Record trade
  INSERT INTO labs_trades (user_id, market_id, coin_symbol, side, shares, amount, trade_type, result, pnl)
  VALUES (p_user_id, p_market_id, v_market.coin_symbol, v_position.side, v_position.shares, v_total_payout, 'CLAIM', v_market.result, v_pnl);

  RETURN json_build_object(
    'success', true,
    'won', v_won,
    'reward', v_reward,
    'fee_bonus', v_fee_bonus,
    'total_payout', v_total_payout,
    'pnl', v_pnl,
    'new_balance', v_new_balance,
    'new_wins', CASE WHEN v_won THEN v_user.wins + 1 ELSE v_user.wins END,
    'new_losses', CASE WHEN NOT v_won THEN v_user.losses + 1 ELSE v_user.losses END,
    'new_streak', v_new_streak,
    'new_best_streak', v_new_best_streak
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 5. CLEANUP: Drop dead labs_sell(uuid, text) overload (prod only)
-- ============================================================

DROP FUNCTION IF EXISTS labs_sell(uuid, text);

-- ============================================================
-- 6. ENSURE labs_adjust_balance + labs_adjust_profit exist
--    (used by deposit/withdraw handler and fallback paths)
-- ============================================================

CREATE OR REPLACE FUNCTION labs_adjust_balance(p_user_id text, p_delta int)
RETURNS void AS $$
BEGIN
  PERFORM set_config('labs.allow_balance_write', 'true', true);
  UPDATE labs_users SET
    labs_balance = labs_balance + p_delta,
    updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION labs_adjust_profit(p_user_id text, p_delta bigint)
RETURNS void AS $$
BEGIN
  UPDATE labs_users SET
    total_profit = COALESCE(total_profit, 0) + p_delta,
    updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 7. GRANT PERMISSIONS
-- ============================================================

GRANT EXECUTE ON FUNCTION labs_buy(text, text, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_sell(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_claim(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_adjust_balance(text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION labs_adjust_profit(text, bigint) TO anon, authenticated;
