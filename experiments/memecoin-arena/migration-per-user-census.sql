-- Migration: On-demand per-user wallet census
-- Safe: adds column + creates function, no existing data modified
-- Run on both dev and prod Supabase projects

-- 1. Add last_census_at column to labs_users
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS last_census_at timestamptz;

-- 2. RPC function to save census results atomically
--    Same SECURITY DEFINER pattern as labs_buy/labs_sell
CREATE OR REPLACE FUNCTION labs_save_census(p_user_id text, p_holdings jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete old holdings for this user
  DELETE FROM labs_user_holdings WHERE user_id = p_user_id;

  -- Insert new holdings (only if there are any)
  IF jsonb_array_length(COALESCE(p_holdings, '[]'::jsonb)) > 0 THEN
    INSERT INTO labs_user_holdings (user_id, coin_symbol, coin_name, coin_image, wallet_address, chain, token_balance, usd_value, tier, census_at)
    SELECT
      p_user_id,
      h->>'coin_symbol',
      h->>'coin_name',
      h->>'coin_image',
      h->>'wallet_address',
      h->>'chain',
      (h->>'token_balance')::numeric,
      (h->>'usd_value')::numeric,
      h->>'tier',
      now()
    FROM jsonb_array_elements(p_holdings) AS h;
  END IF;

  -- Update last_census_at
  UPDATE labs_users SET last_census_at = now() WHERE id = p_user_id;
END;
$$;
