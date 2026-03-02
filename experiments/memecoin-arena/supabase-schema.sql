-- Labs Memecoin Arena Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- Users table
create table labs_users (
  id uuid primary key default gen_random_uuid(),
  meme_user_id int unique,
  username text,
  labs_balance int default 0,
  created_at timestamptz default now()
);

-- Markets table
create table labs_markets (
  id text primary key,
  coin_symbol text not null,
  coin_name text,
  coin_image text,
  coin_color text,
  start_mc numeric not null,
  current_mc numeric not null,
  q_yes numeric default 0,
  q_no numeric default 0,
  b numeric default 500,
  status text default 'OPEN',
  result text,
  volume int default 0,
  players int default 0,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

-- Positions table
create table labs_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references labs_users(id) on delete cascade,
  market_id text references labs_markets(id) on delete cascade,
  side text not null,
  shares numeric not null,
  invested int not null,
  conv_bonus numeric default 1,
  claimed boolean default false,
  created_at timestamptz default now(),
  unique(user_id, market_id)
);

-- Enable Row Level Security
alter table labs_users enable row level security;
alter table labs_markets enable row level security;
alter table labs_positions enable row level security;

-- Policies (allow all for now - tighten later)
create policy "Allow all" on labs_users for all using (true) with check (true);
create policy "Allow all" on labs_markets for all using (true) with check (true);
create policy "Allow all" on labs_positions for all using (true) with check (true);

-- Index for faster lookups
create index if not exists idx_positions_user on labs_positions(user_id);
create index if not exists idx_positions_market on labs_positions(market_id);
create index if not exists idx_markets_status on labs_markets(status);

-- ============================================================
-- MIGRATION: Add stats columns to labs_users
-- ============================================================
alter table labs_users add column if not exists total_volume int default 0;
alter table labs_users add column if not exists wins int default 0;
alter table labs_users add column if not exists losses int default 0;
alter table labs_users add column if not exists current_streak int default 0;
alter table labs_users add column if not exists best_streak int default 0;
alter table labs_users add column if not exists profile_image text;
alter table labs_users add column if not exists updated_at timestamptz default now();

-- Index for leaderboard queries
create index if not exists idx_users_volume on labs_users(total_volume desc);

-- ============================================================
-- Trades history table
-- ============================================================
create table if not exists labs_trades (
  id serial primary key,
  user_id uuid references labs_users(id) on delete cascade,
  market_id text not null,
  coin_symbol text not null,
  side text not null check (side in ('YES', 'NO')),
  shares numeric not null,
  amount int not null,
  trade_type text not null check (trade_type in ('BUY', 'SELL', 'CLAIM')),
  result text check (result in ('YES', 'NO')),
  pnl int,
  created_at timestamptz default now()
);

alter table labs_trades enable row level security;
create policy "Allow all" on labs_trades for all using (true) with check (true);

create index if not exists idx_trades_user on labs_trades(user_id);
create index if not exists idx_trades_market on labs_trades(market_id);
create index if not exists idx_trades_created on labs_trades(created_at desc);

-- ============================================================
-- Leaderboard view
-- ============================================================
create or replace view labs_leaderboard as
select
  id,
  username,
  profile_image,
  total_volume,
  wins,
  losses,
  current_streak,
  best_streak,
  case when (wins + losses) > 0
    then round(wins::numeric / (wins + losses) * 100, 1)
    else 0
  end as win_rate
from labs_users
where total_volume > 0
order by total_volume desc
limit 50;

-- Grant access to views
grant select on labs_leaderboard to anon, authenticated;
