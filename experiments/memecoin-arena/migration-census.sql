-- Weekly Census: labs_coins + labs_user_holdings + inventory view
-- Run against both dev (vnteehkwrygodkljfwyp) and prod (csvegolcvwuwssoefxdh)

-- Coin registry: contract addresses + metadata (seeded once, census reads from here)
CREATE TABLE IF NOT EXISTS labs_coins (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  image text,
  coingecko_id text NOT NULL,
  evm_contract text,       -- Ethereum/Base/etc contract address
  evm_decimals int DEFAULT 18,
  evm_platform text,       -- e.g. 'ethereum', 'base'
  solana_mint text,         -- Solana SPL token mint address
  solana_decimals int DEFAULT 9,
  active boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE labs_coins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read coins" ON labs_coins FOR SELECT USING (true);
CREATE POLICY "Service can manage coins" ON labs_coins FOR ALL USING (true);

-- Holdings table: one row per user+coin+wallet per census run
CREATE TABLE IF NOT EXISTS labs_user_holdings (
  id serial PRIMARY KEY,
  user_id text NOT NULL REFERENCES labs_users(id) ON DELETE CASCADE,
  coin_symbol text NOT NULL,
  coin_name text,
  coin_image text,
  wallet_address text NOT NULL,
  chain text NOT NULL CHECK (chain IN ('EVM', 'SOLANA')),
  token_balance numeric NOT NULL,
  usd_value numeric NOT NULL,
  tier text NOT NULL CHECK (tier IN ('GOLD', 'SILVER', 'BRONZE')),
  census_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, coin_symbol, wallet_address, census_at)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_holdings_user ON labs_user_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_census ON labs_user_holdings(census_at DESC);

-- Inventory view: latest census per user+coin (dedupes across wallets)
CREATE OR REPLACE VIEW labs_user_inventory AS
SELECT DISTINCT ON (user_id, coin_symbol)
  id,
  user_id,
  coin_symbol,
  coin_name,
  coin_image,
  wallet_address,
  chain,
  token_balance,
  usd_value,
  tier,
  census_at
FROM labs_user_holdings
ORDER BY user_id, coin_symbol, census_at DESC, usd_value DESC;

-- RLS: users can read their own holdings
ALTER TABLE labs_user_holdings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own holdings"
  ON labs_user_holdings FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    OR true);  -- Allow all reads for now (anon key), tighten later

CREATE POLICY "Service can insert holdings"
  ON labs_user_holdings FOR INSERT
  WITH CHECK (true);  -- Census script uses service key

CREATE POLICY "Service can update holdings"
  ON labs_user_holdings FOR UPDATE
  USING (true);
