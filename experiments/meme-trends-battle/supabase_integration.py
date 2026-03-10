"""
Supabase Integration for Trends Battles
========================================
Creates and manages TRENDS battle markets in the labs_markets table.
Uses the same table and similar structure as BATTLE (coin vs coin) markets.

Fields repurposed for trends:
  - coin_symbol     → meme A display name (e.g. "Distracted Boyfriend")
  - coin_b_symbol   → meme B display name
  - coin_b_name     → meme B full name
  - coin_b_image    → meme B image URL
  - coin_b_color    → meme B color
  - start_mc        → meme A starting Google Trends score (0-100)
  - current_mc      → meme A current Google Trends score
  - start_mc_b      → meme B starting Google Trends score
  - current_mc_b    → meme B current Google Trends score
  
New fields (from migration-trends.sql):
  - trend_term_a    → Google Trends search term for meme A
  - trend_term_b    → Google Trends search term for meme B
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from supabase import create_client, Client

logger = logging.getLogger(__name__)

# ─── CONFIG ───
USE_DEV = os.environ.get("USE_DEV", "0") == "1"

if USE_DEV:
    SUPABASE_URL = "https://vnteehkwrygodkljfwyp.supabase.co"
    SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
else:
    SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://csvegolcvwuwssoefxdh.supabase.co")
    SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# LMSR base liquidity (MUST match app.jsx getB())
B = 100_000

# Battle duration
BATTLE_DURATION_DAYS = 7

# Assign distinct colors per side for the battle card
COLOR_A = "#71BAFF"  # Matches BattleCard default
COLOR_B = "#a78bfa"  # Matches BattleCard default


def _get_client() -> Client:
    """Get Supabase client with service role key (bypasses RLS)."""
    if not SUPABASE_KEY:
        raise ValueError("SUPABASE_SERVICE_KEY not set")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def _next_round_number() -> int:
    """Get the next round number for TRENDS markets."""
    sb = _get_client()
    result = sb.table("labs_markets") \
        .select("id") \
        .eq("market_type", "TRENDS") \
        .order("id", desc=True) \
        .limit(1) \
        .execute()

    if result.data:
        # Extract round number from ID like "TRENDS-Doge-Pepe-3"
        last_id = result.data[0]["id"]
        parts = last_id.rsplit("-", 1)
        try:
            return int(parts[-1]) + 1
        except (ValueError, IndexError):
            pass
    return 1


def create_trends_market(meme_a: dict, meme_b: dict) -> dict:
    """
    Create a new TRENDS battle market in Supabase.
    
    Args:
        meme_a: {name, trend_term, score, start_score, image_url, ...}
        meme_b: {name, trend_term, score, start_score, image_url, ...}
    
    Returns:
        The created market record.
    """
    sb = _get_client()

    # Build a clean symbol from the name (uppercase, max 12 chars)
    sym_a = meme_a["name"].upper().replace(" ", "")[:12]
    sym_b = meme_b["name"].upper().replace(" ", "")[:12]

    round_num = _next_round_number()
    market_id = f"TRENDS-{sym_a}-{sym_b}-{round_num}"

    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=BATTLE_DURATION_DAYS)

    score_a = meme_a.get("score", meme_a.get("start_score", 50))
    score_b = meme_b.get("score", meme_b.get("start_score", 50))

    market = {
        "id": market_id,
        "market_type": "TRENDS",
        "status": "OPEN",

        # Meme A (YES side)
        "coin_symbol": meme_a["name"],
        "coin_name": meme_a["name"],
        "coin_image": meme_a.get("image_url", ""),
        "coin_color": COLOR_A,
        "start_mc": score_a,
        "current_mc": score_a,

        # Meme B (NO side)
        "coin_b_symbol": meme_b["name"],
        "coin_b_name": meme_b["name"],
        "coin_b_image": meme_b.get("image_url", ""),
        "coin_b_color": COLOR_B,
        "start_mc_b": score_b,
        "current_mc_b": score_b,

        # Trend-specific fields
        "trend_term_a": meme_a["trend_term"],
        "trend_term_b": meme_b["trend_term"],

        # LMSR initial state (neutral — both sides start at B)
        "q_yes": 0,  # Stored without base liquidity, frontend adds B back
        "q_no": 0,
        "b": B,

        # Market metadata
        "expires_at": expires.isoformat(),
        "volume": 0,
        "players": 0,
        "created_at": now.isoformat(),

        # Fee/payout fields
        "fee_pool": 0,
        "total_pot": 0,
        "winner_weight_sum": 0,
        "winner_invested_sum": 0,
    }

    result = sb.table("labs_markets").insert(market).execute()

    if result.data:
        logger.info(f"Created TRENDS market: {market_id}")
        return result.data[0]
    else:
        raise Exception(f"Failed to create market: {result}")


def get_active_trends_battle() -> Optional[dict]:
    """Get the currently active TRENDS battle market, if any."""
    sb = _get_client()
    result = sb.table("labs_markets") \
        .select("*") \
        .eq("market_type", "TRENDS") \
        .eq("status", "OPEN") \
        .limit(1) \
        .execute()

    return result.data[0] if result.data else None


def update_trend_scores(battle: dict) -> dict:
    """
    Fetch latest Google Trends scores for an active battle and update Supabase.
    Called by Discord bot (!battle_resolve) or by a cron job.
    
    Returns: {score_a, score_b}
    """
    from trends_discovery import get_head_to_head

    term_a = battle.get("trend_term_a", battle.get("coin_symbol", ""))
    term_b = battle.get("trend_term_b", battle.get("coin_b_symbol", ""))

    h2h = get_head_to_head(term_a, term_b)
    score_a = h2h["current_a"]
    score_b = h2h["current_b"]

    sb = _get_client()
    sb.table("labs_markets").update({
        "current_mc": score_a,
        "current_mc_b": score_b,
        "price_updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", battle["id"]).execute()

    logger.info(f"Updated scores for {battle['id']}: A={score_a}, B={score_b}")
    return {"score_a": score_a, "score_b": score_b}


def update_all_active_mememarket() -> int:
    """
    Update trend scores for ALL active MEMEMARKET markets.
    Uses batched get_interest_scores (5 terms per Pytrends call) for efficiency.
    On first update, sets start_mc to the real score (replacing placeholder 50).
    Returns number of markets updated.
    """
    import time as _time
    from trends_discovery import get_interest_scores

    sb = _get_client()
    result = sb.table("labs_markets") \
        .select("*") \
        .eq("market_type", "MEMEMARKET") \
        .eq("status", "OPEN") \
        .execute()

    markets = result.data or []
    if not markets:
        return 0

    # Collect unique trend terms
    term_to_markets = {}
    for mkt in markets:
        term = mkt.get("trend_term_a", "")
        if term:
            term_to_markets.setdefault(term, []).append(mkt)

    # Batch fetch scores (get_interest_scores handles batching in groups of 5)
    all_terms = list(term_to_markets.keys())
    scores = {}
    for i in range(0, len(all_terms), 5):
        batch = all_terms[i:i + 5]
        try:
            batch_scores = get_interest_scores(batch)
            scores.update(batch_scores)
        except Exception as e:
            logger.error(f"Failed to fetch scores for batch {batch}: {e}")
        if i + 5 < len(all_terms):
            _time.sleep(2)

    updated = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for term, mkts in term_to_markets.items():
        if term not in scores:
            continue
        current_score = scores[term]
        for mkt in mkts:
            try:
                update_data = {
                    "current_mc": current_score,
                    "price_updated_at": now_iso,
                }
                # On first update: replace placeholder start_mc (50) with real score
                if mkt.get("start_mc") == 50 and current_score != 50:
                    update_data["start_mc"] = current_score

                sb.table("labs_markets").update(update_data).eq("id", mkt["id"]).execute()

                # Store snapshot for sparkline
                sb.table("labs_trend_snapshots").insert({
                    "market_id": mkt["id"],
                    "score_a": current_score,
                    "score_b": 0,
                    "recorded_at": now_iso,
                }).execute()

                updated += 1
                logger.info(f"Updated MEMEMARKET {mkt['id']}: score={current_score}")
            except Exception as e:
                logger.error(f"Failed to update MEMEMARKET {mkt['id']}: {e}")

    return updated


def update_all_active_trends() -> int:
    """
    Update trend scores for ALL active TRENDS markets.
    Designed to be called by a cron job every 4-6 hours.
    Returns number of markets updated.
    """
    sb = _get_client()
    result = sb.table("labs_markets") \
        .select("*") \
        .eq("market_type", "TRENDS") \
        .eq("status", "OPEN") \
        .execute()

    updated = 0
    for battle in result.data or []:
        try:
            update_trend_scores(battle)
            updated += 1
        except Exception as e:
            logger.error(f"Failed to update {battle['id']}: {e}")

    return updated


if __name__ == "__main__":
    """Quick test: create a dummy market on dev."""
    import sys
    os.environ["USE_DEV"] = "1"

    if len(sys.argv) > 1 and sys.argv[1] == "test":
        market = create_trends_market(
            {"name": "Doge", "trend_term": "doge meme", "score": 72, "image_url": "https://api.memegen.link/images/doge.jpg"},
            {"name": "Distracted Boyfriend", "trend_term": "distracted boyfriend meme", "score": 58, "image_url": "https://api.memegen.link/images/db.jpg"},
        )
        print(f"Created: {market['id']}")
    elif len(sys.argv) > 1 and sys.argv[1] == "status":
        battle = get_active_trends_battle()
        print(json.dumps(battle, indent=2, default=str) if battle else "No active battle")
    else:
        print("Usage: python supabase_integration.py [test|status]")
