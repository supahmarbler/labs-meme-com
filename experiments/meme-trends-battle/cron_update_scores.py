#!/usr/bin/env python3
"""
Cron: Update Google Trends scores for active battles.
Run every 4-6 hours (Google Trends data has ~4h lag).

Crontab example:
  0 */4 * * * cd /path/to/meme-trends-battle && python cron_update_scores.py

Or as a Supabase Edge Function / Vercel Cron.
"""

import os
import sys
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Ensure module is importable
sys.path.insert(0, os.path.dirname(__file__))

from supabase_integration import update_all_active_trends, update_all_active_mememarket


def main():
    logger.info("Starting trend score update...")
    failed = False
    try:
        count = update_all_active_trends()
        logger.info(f"Updated {count} active TRENDS market(s)")
    except Exception as e:
        logger.error(f"TRENDS update failed: {e}", exc_info=True)
        failed = True

    try:
        mm_count = update_all_active_mememarket()
        logger.info(f"Updated {mm_count} active MEMEMARKET market(s)")
    except Exception as e:
        logger.error(f"MEMEMARKET update failed: {e}", exc_info=True)
        failed = True

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
