"""
Meme Trend Discovery
====================
Discovers trending memes via Google Trends (Pytrends) and fetches canonical images.

Usage:
    from trends_discovery import discover_trending_memes
    memes = discover_trending_memes(count=15)
"""

import os
import json
import time
import logging
from datetime import datetime, timedelta
from typing import Optional
from pathlib import Path

from pytrends.request import TrendReq
import requests

logger = logging.getLogger(__name__)

# ─── CONFIG ───
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GOOGLE_CSE_API_KEY = os.environ.get("GOOGLE_CSE_API_KEY", "")
GOOGLE_CSE_CX = os.environ.get("GOOGLE_CSE_CX", "")
CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

# Seed terms — broad meme culture queries to discover what's trending
# Pytrends related_queries() will expand these into specific trending memes
SEED_TERMS = [
    "meme",
    "viral meme",
    "trending meme",
    "funny meme",
    "new meme",
]

# Fallback watchlist — well-known memes we can always compare against each other
# Used if Pytrends discovery returns too few results
WATCHLIST = [
    "doge", "pepe the frog", "wojak", "gigachad", "distracted boyfriend",
    "drake hotline bling", "woman yelling at cat", "change my mind",
    "this is fine", "stonks", "always has been", "roll safe",
    "expanding brain", "surprised pikachu", "uno reverse card",
    "galaxy brain", "trade offer", "grim reaper knocking",
    "bernie sanders mittens", "nyan cat", "rickroll", "grumpy cat",
    "harambe", "salt bae", "hide the pain harold", "disaster girl",
    "success kid", "bad luck brian", "one does not simply",
    "shut up and take my money",
]


def _pytrends_client() -> TrendReq:
    """Create a Pytrends client with retry."""
    return TrendReq(hl="en-US", tz=0, retries=3, backoff_factor=1.0)


def discover_via_related_queries(count: int = 15) -> list[dict]:
    """
    Use Pytrends related_queries() on seed terms to find trending memes.
    Returns list of {name, trend_term, score, rising_pct}.
    """
    pt = _pytrends_client()
    discovered = {}

    for seed in SEED_TERMS:
        try:
            pt.build_payload([seed], timeframe="now 7-d")
            related = pt.related_queries()

            if seed in related:
                # "rising" queries are the interesting ones — memes gaining momentum
                rising = related[seed].get("rising")
                if rising is not None and not rising.empty:
                    for _, row in rising.iterrows():
                        term = row["query"].strip().lower()
                        val = row["value"]  # % increase or "Breakout"
                        if term not in discovered:
                            discovered[term] = {
                                "name": row["query"].strip().title(),
                                "trend_term": row["query"].strip(),
                                "rising_pct": val if isinstance(val, (int, float)) else 5000,
                            }

                # "top" queries for baseline popular memes
                top = related[seed].get("top")
                if top is not None and not top.empty:
                    for _, row in top.iterrows():
                        term = row["query"].strip().lower()
                        if term not in discovered:
                            discovered[term] = {
                                "name": row["query"].strip().title(),
                                "trend_term": row["query"].strip(),
                                "rising_pct": 0,
                            }

            time.sleep(1)  # Rate limit courtesy
        except Exception as e:
            logger.warning(f"Pytrends related_queries failed for '{seed}': {e}")
            continue

    # Sort by rising_pct (breakouts first), take top N
    results = sorted(discovered.values(), key=lambda x: x["rising_pct"], reverse=True)
    return results[:count]


def discover_via_trending_searches() -> list[dict]:
    """
    Use Pytrends trending_searches() for real-time trending topics.
    Filters for meme-related terms (heuristic).
    """
    pt = _pytrends_client()
    try:
        trending = pt.trending_searches(pn="united_states")
        results = []
        for term in trending[0].tolist():
            term_lower = term.lower()
            # Simple heuristic: include if it contains meme-related keywords
            # In production, use an LLM or classifier to filter
            if any(kw in term_lower for kw in ["meme", "viral", "funny", "trend"]):
                results.append({
                    "name": term.strip().title(),
                    "trend_term": term.strip(),
                    "rising_pct": 9999,  # Currently trending = very hot
                })
        return results
    except Exception as e:
        logger.warning(f"Pytrends trending_searches failed: {e}")
        return []


def get_interest_scores(terms: list[str]) -> dict[str, int]:
    """
    Get Google Trends interest scores (0-100) for a list of terms.
    Compares all terms against each other in batches of 5.
    """
    if not terms:
        return {}

    pt = _pytrends_client()
    scores = {}

    # Pytrends allows max 5 terms per request
    for i in range(0, len(terms), 5):
        batch = terms[i:i + 5]
        try:
            pt.build_payload(batch, timeframe="now 7-d")
            iot = pt.interest_over_time()
            if not iot.empty:
                for term in batch:
                    if term in iot.columns:
                        # Current score = last data point
                        scores[term] = int(iot[term].iloc[-1])
                        # Also compute 7-day change
            time.sleep(1)
        except Exception as e:
            logger.warning(f"Pytrends interest_over_time failed for batch: {e}")
            continue

    return scores


def get_head_to_head(term_a: str, term_b: str) -> dict:
    """
    Compare two terms in a single Pytrends query for relative scoring.
    Returns {start_a, current_a, change_a, start_b, current_b, change_b}.
    """
    pt = _pytrends_client()
    try:
        pt.build_payload([term_a, term_b], timeframe="now 7-d")
        iot = pt.interest_over_time()
        if not iot.empty:
            result = {}
            for label, term in [("a", term_a), ("b", term_b)]:
                if term in iot.columns:
                    vals = iot[term].tolist()
                    start = vals[0] if vals else 50
                    current = vals[-1] if vals else 50
                    change = ((current - start) / max(start, 1)) * 100
                    result[f"start_{label}"] = start
                    result[f"current_{label}"] = current
                    result[f"change_{label}"] = round(change, 1)
                else:
                    result[f"start_{label}"] = 50
                    result[f"current_{label}"] = 50
                    result[f"change_{label}"] = 0.0
            return result
    except Exception as e:
        logger.warning(f"Pytrends head-to-head failed for '{term_a}' vs '{term_b}': {e}")
    return {"start_a": 50, "current_a": 50, "change_a": 0.0,
            "start_b": 50, "current_b": 50, "change_b": 0.0}


def get_trend_change(term: str) -> tuple[int, int, float]:
    """
    Get start score, current score, and % change for a single term over 7 days.
    Returns (start_score, current_score, change_pct).
    """
    pt = _pytrends_client()
    try:
        pt.build_payload([term], timeframe="now 7-d")
        iot = pt.interest_over_time()
        if not iot.empty and term in iot.columns:
            vals = iot[term].tolist()
            start = vals[0] if vals else 50
            current = vals[-1] if vals else 50
            change = ((current - start) / max(start, 1)) * 100
            return start, current, round(change, 1)
    except Exception as e:
        logger.warning(f"Pytrends interest_over_time failed for '{term}': {e}")
    return 50, 50, 0.0


def fetch_meme_image(meme_name: str) -> Optional[str]:
    """
    Fetch a canonical image for a meme using Google Custom Search API.
    Falls back to DuckDuckGo if Google CSE not configured.
    Results are cached to .cache/ directory.
    """
    # Check cache first
    cache_key = meme_name.lower().replace(" ", "_")
    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text())
            if data.get("image_url") and data.get("fetched_at"):
                # Cache for 7 days
                fetched = datetime.fromisoformat(data["fetched_at"])
                if datetime.now() - fetched < timedelta(days=7):
                    return data["image_url"]
        except Exception:
            pass

    image_url = None

    # Try Google Custom Search API
    if GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX:
        image_url = _google_image_search(meme_name)

    # Fallback: DuckDuckGo (no API key needed)
    if not image_url:
        image_url = _ddg_image_search(meme_name)

    # Cache result
    if image_url:
        cache_file.write_text(json.dumps({
            "meme_name": meme_name,
            "image_url": image_url,
            "fetched_at": datetime.now().isoformat(),
        }))

    return image_url


def _google_image_search(query: str) -> Optional[str]:
    """Google Custom Search API image search."""
    try:
        resp = requests.get(
            "https://www.googleapis.com/customsearch/v1",
            params={
                "key": GOOGLE_CSE_API_KEY,
                "cx": GOOGLE_CSE_CX,
                "q": f"{query} meme",
                "searchType": "image",
                "num": 1,
                "safe": "active",
            },
            timeout=10,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if items:
            return items[0]["link"]
    except Exception as e:
        logger.warning(f"Google CSE image search failed for '{query}': {e}")
    return None


def _ddg_image_search(query: str) -> Optional[str]:
    """DuckDuckGo image search fallback (no API key needed)."""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.images(f"{query} meme", max_results=1))
            if results:
                return results[0]["image"]
    except ImportError:
        logger.warning("duckduckgo_search not installed, skipping DDG fallback")
    except Exception as e:
        logger.warning(f"DDG image search failed for '{query}': {e}")
    return None


def discover_trending_memes(count: int = 15) -> list[dict]:
    """
    Main discovery function. Returns a curated list of trending memes with images.
    
    Returns:
        list of {
            "name": "Distracted Boyfriend",
            "trend_term": "distracted boyfriend meme",
            "score": 85,
            "start_score": 72,
            "change_pct": 18.1,
            "rising_pct": 500,
            "image_url": "https://...",
        }
    """
    logger.info("Discovering trending memes...")

    # Step 1: Discover candidates
    candidates = discover_via_related_queries(count=count * 2)

    # Add real-time trending if we don't have enough
    if len(candidates) < count:
        trending = discover_via_trending_searches()
        existing_terms = {c["trend_term"].lower() for c in candidates}
        for t in trending:
            if t["trend_term"].lower() not in existing_terms:
                candidates.append(t)

    # Pad with watchlist if still short
    if len(candidates) < count:
        existing_terms = {c["trend_term"].lower() for c in candidates}
        for term in WATCHLIST:
            if term.lower() not in existing_terms and len(candidates) < count * 2:
                candidates.append({
                    "name": term.title(),
                    "trend_term": term,
                    "rising_pct": 0,
                })

    # Step 2: Get interest scores for top candidates
    terms = [c["trend_term"] for c in candidates[:count]]
    for c in candidates[:count]:
        start, current, change = get_trend_change(c["trend_term"])
        c["start_score"] = start
        c["score"] = current
        c["change_pct"] = change

    # Step 3: Fetch images
    for c in candidates[:count]:
        c["image_url"] = fetch_meme_image(c["name"]) or fetch_meme_image(c["trend_term"])

    # Step 4: Filter out anything without an image, sort by score
    results = [c for c in candidates[:count] if c.get("image_url")]
    results.sort(key=lambda x: x.get("score", 0), reverse=True)

    logger.info(f"Discovered {len(results)} trending memes")
    return results[:count]


def _sb_headers() -> dict:
    """Supabase REST headers using service role key."""
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def update_trend_scores() -> None:
    """
    Full score-update cycle for the active TRENDS battle.
    Mirrors the logic from trends.ts updateTrendScores().
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")

    base = f"{SUPABASE_URL}/rest/v1"
    headers = _sb_headers()

    # 1. GET active TRENDS battle
    resp = requests.get(f"{base}/labs_markets", headers=headers, params={
        "market_type": "eq.TRENDS",
        "status": "eq.OPEN",
        "limit": 1,
    }, timeout=15)
    resp.raise_for_status()
    markets = resp.json()
    if not markets:
        logger.info("No active TRENDS battle found — nothing to update")
        return

    battle = markets[0]
    market_id = battle["id"]
    term_a = battle.get("trend_term_a") or battle["coin_symbol"]
    term_b = battle.get("trend_term_b") or battle["coin_b_symbol"]

    # 2. Get fresh scores from Google Trends
    h2h = get_head_to_head(term_a, term_b)
    score_a = h2h["current_a"]
    score_b = h2h["current_b"]

    # 3. Skip if either score ≤ 0 (Google Trends glitch guard)
    if score_a <= 0 or score_b <= 0:
        logger.warning(f"Skipping update — bad scores: A={score_a}, B={score_b}")
        return

    # 4. POST raw snapshot
    requests.post(f"{base}/labs_trend_snapshots", headers=headers, json={
        "market_id": market_id,
        "score_a": score_a,
        "score_b": score_b,
    }, timeout=15).raise_for_status()

    # 5. GET recent snapshots (last 24h), compute rolling average
    since = (datetime.utcnow() - timedelta(hours=24)).isoformat() + "Z"
    snap_resp = requests.get(f"{base}/labs_trend_snapshots", headers=headers, params={
        "market_id": f"eq.{market_id}",
        "recorded_at": f"gte.{since}",
        "order": "recorded_at.desc",
    }, timeout=15)
    snap_resp.raise_for_status()
    recent = snap_resp.json()

    avg_a, avg_b = score_a, score_b
    if recent:
        sum_a = sum(int(r["score_a"]) for r in recent) + score_a
        sum_b = sum(int(r["score_b"]) for r in recent) + score_b
        count = len(recent) + 1  # snapshots + current reading
        avg_a = round(sum_a / count)
        avg_b = round(sum_b / count)

    # 5b. Warmup blend — ramp from start_score to rolling avg over first 24h
    created_at = battle.get("created_at", "")
    start_a = battle.get("start_mc", avg_a)
    start_b = battle.get("start_mc_b", avg_b)
    if created_at:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00")).replace(tzinfo=None)
        age_hours = (datetime.utcnow() - created).total_seconds() / 3600
        alpha = min(age_hours / 24, 1.0)
        avg_a = round(alpha * avg_a + (1 - alpha) * start_a)
        avg_b = round(alpha * avg_b + (1 - alpha) * start_b)

    # 6. PATCH market with averaged scores
    patch_resp = requests.patch(
        f"{base}/labs_markets?id=eq.{market_id}",
        headers=headers,
        json={
            "current_mc": avg_a,
            "current_mc_b": avg_b,
            "price_updated_at": datetime.utcnow().isoformat() + "Z",
        },
        timeout=15,
    )
    patch_resp.raise_for_status()

    logger.info(f"Updated {market_id}: raw A={score_a} B={score_b}, avg A={avg_a} B={avg_b}")


if __name__ == "__main__":
    import sys
    import argparse

    # All logging to stderr so stdout is clean JSON for bot consumption
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)

    parser = argparse.ArgumentParser(description="Meme Trend Discovery")
    parser.add_argument("--json", action="store_true", help="Output trending memes as JSON to stdout")
    parser.add_argument("--score", nargs=2, metavar=("TERM_A", "TERM_B"), help="Get current scores for two terms as JSON")
    parser.add_argument("--update", action="store_true", help="Update active TRENDS battle scores in Supabase")
    parser.add_argument("--count", type=int, default=15, help="Number of memes to discover (default: 15)")
    args = parser.parse_args()

    if args.update:
        update_trend_scores()
    elif args.score:
        term_a, term_b = args.score
        h2h = get_head_to_head(term_a, term_b)
        print(json.dumps({
            "term_a": term_a, "score_a": h2h["current_a"], "start_a": h2h["start_a"], "change_a": h2h["change_a"],
            "term_b": term_b, "score_b": h2h["current_b"], "start_b": h2h["start_b"], "change_b": h2h["change_b"],
        }))
    elif args.json:
        memes = discover_trending_memes(count=args.count)
        print(json.dumps(memes))
    else:
        # Human-readable output (default)
        memes = discover_trending_memes(count=args.count)
        for i, m in enumerate(memes, 1):
            print(f"{i:2d}. {m['name']:<30s} score={m.get('score', '?'):>3} "
                  f"change={m.get('change_pct', '?'):>6}% "
                  f"img={'YES' if m.get('image_url') else 'NO'}")
