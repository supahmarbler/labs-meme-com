-- Migration: Zero-Sum Pot Distribution
-- Winners split the total pot weighted by LMSR sell value at resolution.
-- No memescore created or destroyed — zero-sum.
--
-- Run via Supabase Management API on both dev and prod

-- ============================================================
-- 1. SCHEMA: Add pot snapshot columns to labs_markets
-- ============================================================

ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS total_pot numeric DEFAULT 0;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS winner_weight_sum numeric DEFAULT 0;

-- ============================================================
-- 2. UPDATED labs_auto_resolve — compute pot + weights at resolution
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

    -- Compute total pot: sum of all positions' invested for this market
    SELECT COALESCE(SUM(invested), 0) INTO v_total_pot
    FROM labs_positions
    WHERE market_id = m.id;

    -- Compute winner weight sum: sum of lmsr_sell_refund for winning-side positions
    SELECT COALESCE(SUM(
      lmsr_sell_refund(
        m.q_yes + m.b, m.q_no + m.b, m.b,
        p.shares, p.side
      )
    ), 0) INTO v_winner_weight_sum
    FROM labs_positions p
    WHERE p.market_id = m.id AND p.side = v_result;

    UPDATE labs_markets
    SET status = 'RES', result = v_result,
        total_pot = v_total_pot,
        winner_weight_sum = v_winner_weight_sum
    WHERE id = m.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. UPDATED labs_claim — pot-proportional reward
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
  v_my_weight numeric;
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
    -- Pot-proportional reward: my_weight / winner_weight_sum * total_pot
    v_my_weight := lmsr_sell_refund(
      v_market.q_yes + v_market.b, v_market.q_no + v_market.b, v_market.b,
      v_position.shares, v_position.side
    );

    IF COALESCE(v_market.winner_weight_sum, 0) > 0 THEN
      v_reward := ROUND(v_my_weight / v_market.winner_weight_sum * v_market.total_pot);
    ELSE
      -- Safety fallback: no winner weights (shouldn't happen)
      v_reward := 0;
    END IF;

    -- Calculate fee bonus (proportional share of fee pool — separate from pot)
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
