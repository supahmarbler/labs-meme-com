-- PENDING MIGRATION - Run this in Supabase SQL Editor
-- This adds the new columns and tables needed for production

-- 1. Add stats columns to labs_users
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS total_volume int DEFAULT 0;
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS wins int DEFAULT 0;
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS losses int DEFAULT 0;
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS current_streak int DEFAULT 0;
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS best_streak int DEFAULT 0;
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS profile_image text;
ALTER TABLE labs_users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. Index for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_users_volume ON labs_users(total_volume DESC);

-- 3. Trades history table
CREATE TABLE IF NOT EXISTS labs_trades (
  id serial PRIMARY KEY,
  user_id uuid REFERENCES labs_users(id) ON DELETE CASCADE,
  market_id text NOT NULL,
  coin_symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('YES', 'NO')),
  shares numeric NOT NULL,
  amount int NOT NULL,
  trade_type text NOT NULL CHECK (trade_type IN ('BUY', 'SELL', 'CLAIM')),
  result text CHECK (result IN ('YES', 'NO')),
  pnl int,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE labs_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all trades" ON labs_trades FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_trades_user ON labs_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_market ON labs_trades(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_created ON labs_trades(created_at DESC);

-- 4. Done!
-- After running this, the app will automatically start syncing user data.
