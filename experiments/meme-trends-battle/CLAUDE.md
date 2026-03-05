# Meme Trends Battle — Project Brief for Claude Code

## What We're Building
A Google Trends-powered meme vs meme battle system for labs.meme.com (Memecoin Arena). Instead of coins battling on price, memes battle on Google Trends search interest.

## Architecture

### The Flow
1. **Cron job (daily/weekly)** — Python script uses Pytrends to discover trending memes
2. **Image discovery** — Google Custom Search API grabs the canonical image for each meme
3. **Discord bot posts** — Curated list of ~10-15 trending memes posted to team Discord channel with images, trend scores, and numbered options
4. **Team picks matchup** — Someone replies `!battle 3 7` to select meme #3 vs meme #7
5. **Bot creates market** — Inserts into Supabase `labs_markets` with `market_type = 'TRENDS'`
6. **Battle card goes live** — Renders on labs.meme.com using the existing BattleCard component

### Key Decisions
- **One data source per battle**: Google Trends only (no blending with Twitter/on-chain data)
- **Memes, not coins**: The trending subjects are actual memes (Distracted Boyfriend, etc.), not memecoins
- **Images are dynamic**: Fetched via Google Image Search at discovery time, not from a hardcoded list
- **Manual matchup selection**: Automated discovery, human-curated matchups via Discord
- **Resolution**: Compare % change in Google Trends search interest over the battle period

## Existing Codebase

### Memecoin Arena (labs.meme.com)
- **Repo**: labs-meme-com (deploy via `vercel --prod`)
- **Main file**: `experiments/memecoin-arena/app.jsx` (~3000 lines, single-file React + Babel, no build step)
- **Backend**: Supabase PostgreSQL
- **Prod Supabase**: `csvegolcvwuwssoefxdh`
- **Dev Supabase**: `vnteehkwrygodkljfwyp`
- **Hostname toggle**: `labs.meme.com` → prod, everything else → dev

### Existing Battle System
The BattleCard already exists in `app.jsx` for coin vs coin battles. Key parts:
- `BattleCard` component (line ~1601): Face-off header, % change comparison, LMSR betting, buy/sell/claim
- `BATTLE_COINS` config (line ~578): Maps coin symbols to CoinGecko IDs
- `migration-battles.sql`: Adds `market_type`, `coin_b_*` columns to `labs_markets`
- `labs_auto_resolve` function: Compares relative % change between A and B at expiry
- CoinGecko Pro feeds prices for battle coins every 60s

### Discord Bot
**TODO: Locate the existing meme.com Discord bot** — check Johan's projects for the bot repo. It needs to be found first so we can add the trends commands as a new module/cog.

```bash
# Likely locations on Johan's machine:
find ~/Desktop ~/projects ~/code -name "*.py" -path "*discord*" -o -name "*.js" -path "*discord*" -o -name "*.py" -path "*bot*" 2>/dev/null | head -20

# Or search for discord.py/discord.js in package files:
grep -r "discord" ~/Desktop/*/package.json ~/Desktop/*/requirements.txt ~/projects/*/package.json 2>/dev/null
```

## Implementation Plan

### Step 1: Find & Understand Discord Bot
- Locate the existing meme.com Discord bot
- Understand its structure (framework, command pattern, how it connects)

### Step 2: Trend Discovery Script
Create a Python module that:
```python
# Uses Pytrends to find trending memes
from pytrends.request import TrendReq

def discover_trending_memes(count=15):
    """
    Pull trending searches related to memes/internet culture.
    
    Approach A: trending_searches() for real-time trending
    Approach B: related_queries() for "meme" seed term
    Approach C: interest_over_time() for a curated watchlist
    
    Returns list of:
    {
        "name": "Distracted Boyfriend",
        "trend_term": "distracted boyfriend meme", 
        "score": 85,          # Google Trends 0-100
        "change_pct": 12.5,   # 7-day % change
        "image_url": "https://...",
        "source_url": "https://knowyourmeme.com/..."
    }
    """
```

### Step 3: Image Discovery
```python
# Google Custom Search API for canonical meme images
def fetch_meme_image(meme_name: str) -> str:
    """
    Search Google Images for the meme, return the top result URL.
    Cache results to avoid repeated API calls.
    
    Requires:
    - Google Cloud project with Custom Search API enabled
    - Custom Search Engine (CSE) configured for image search
    - API key + CX ID
    """
```

Alternative: Use a simple Google Image Search scraper, or DuckDuckGo image search (no API key needed via `duckduckgo_search` Python package).

### Step 4: Discord Integration
Add to existing bot:
```python
# New commands for trends battle curation

# Automated: runs on schedule (daily or triggered)
@bot.command()
async def trends(ctx):
    """Discover and post trending memes to channel"""
    memes = discover_trending_memes(count=15)
    # Post embed with numbered list, images, scores
    
# Manual: team picks the matchup
@bot.command()
async def battle(ctx, a: int, b: int):
    """Create a trends battle market: !battle 3 7"""
    # Validates picks from latest trends post
    # Creates market in Supabase
    # Confirms with embed showing the matchup
```

### Step 5: Supabase Market Creation
```python
async def create_trends_market(meme_a: dict, meme_b: dict):
    """
    Insert into labs_markets with:
    - market_type = 'TRENDS'
    - coin_symbol = meme_a['trend_term']  (repurposed field)
    - coin_b_symbol = meme_b['trend_term']
    - coin_b_image = meme_b['image_url']
    - start_mc = meme_a['score']          (starting trend score)
    - start_mc_b = meme_b['score']
    - expires_at = now + 7 days
    """
```

### Step 6: Frontend — Adapt BattleCard for Trends
Minimal changes to `app.jsx`:
- The BattleCard already handles `market_type === 'BATTLE'` 
- For `TRENDS` type: same card layout, but:
  - Sub-labels show `62/100 → 71/100` (trend score) instead of `$2.4B → $2.6B` (market cap)
  - Footer badge says `7D TRENDS BATTLE` instead of `48H BATTLE`
  - Expiry is 7 days instead of 48h
- Price feed: instead of CoinGecko, a cron/edge function fetches Pytrends scores and writes to `current_mc` / `current_mc_b` fields
- Resolution: same logic (compare relative % change), already works in `labs_auto_resolve`

### Step 7: Trend Score Feed (Server-Side)
A scheduled job (Supabase Edge Function or external cron) that:
- Runs every 4-6 hours (Google Trends data has ~4h lag)
- For each OPEN `TRENDS` market, fetches current interest scores via Pytrends
- Updates `current_mc` and `current_mc_b` in `labs_markets`

## Database Migration

```sql
-- Migration: Trends Battle Markets
-- Extends existing BATTLE infrastructure for Google Trends data

-- The existing migration-battles.sql already added:
--   market_type, coin_b_symbol, coin_b_name, coin_b_image, coin_b_color,
--   start_mc_b, current_mc_b

-- Additional columns for trends-specific data:
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS trend_term_a text;
ALTER TABLE labs_markets ADD COLUMN IF NOT EXISTS trend_term_b text;

-- Update prevent_duplicate_open for TRENDS markets
-- (allow 1 open TRENDS market alongside BATTLE and UPDOWN markets)

-- Update labs_auto_resolve to handle TRENDS the same as BATTLE
-- (already compares relative % change — just needs to include TRENDS type)
```

## Environment Variables Needed

```bash
# Trend discovery
GOOGLE_CSE_API_KEY=       # Google Custom Search API key
GOOGLE_CSE_CX=            # Custom Search Engine ID

# Supabase (already exist in the project)
SUPABASE_URL=https://csvegolcvwuwssoefxdh.supabase.co
SUPABASE_SERVICE_KEY=     # Service role key

# Discord (already exist for the meme bot)
DISCORD_BOT_TOKEN=        # Existing bot token
DISCORD_CHANNEL_ID=       # #meme-battles channel
```

## File Structure
```
experiments/meme-trends-battle/
├── CLAUDE.md              # This file
├── trends_discovery.py    # Pytrends + image search module
├── discord_commands.py    # !trends and !battle commands (cog for existing bot)
├── supabase_integration.py # Market creation + score feed
├── migration-trends.sql   # DB migration
├── requirements.txt       # Python deps
└── README.md              # Setup instructions
```

## First Task for Claude Code
1. Find the existing Discord bot: `find ~ -maxdepth 4 -name "*.py" -exec grep -l "discord" {} \; 2>/dev/null | head -20`
2. Read its structure
3. Build the trends discovery module
4. Add the Discord commands as a cog/module
5. Test with dev Supabase (`vnteehkwrygodkljfwyp`)
