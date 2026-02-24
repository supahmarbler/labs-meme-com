-- Labs Memecoin Arena Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- Users table
create table labs_users (
  id uuid primary key default gen_random_uuid(),
  meme_user_id int unique,
  username text,
  labs_balance int default 10000,
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
create index idx_positions_user on labs_positions(user_id);
create index idx_positions_market on labs_positions(market_id);
create index idx_markets_status on labs_markets(status);
