-- Migration: Cross-season MOTM guardrail
-- Applied: 2026-03-17
--
-- 1. Both labs_create_kymrace and labs_create_kymrace_system RPCs now reject
--    slugs that had markets in any previous season (error: 'previous_season_duplicate')
-- 2. Jan + Feb 2026 MOTM nominees seeded as resolved placeholder markets
--    so the cross-season check has historical data to work with
-- 3. Going forward, resolved March markets will automatically prevent April repeats

-- See /tmp/update-rpc-system.sql and /tmp/update-rpc-user.sql for full RPC definitions
-- See /tmp/seed-past-motm.sql for seeded history data

-- Google Trends caching table (also added this session)
CREATE TABLE IF NOT EXISTS labs_google_trends (
  market_id TEXT PRIMARY KEY REFERENCES labs_markets(id),
  term TEXT NOT NULL,
  score INT NOT NULL,
  start_score INT NOT NULL,
  pct_change INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE labs_google_trends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON labs_google_trends FOR SELECT USING (true);
