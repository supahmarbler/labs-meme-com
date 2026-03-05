"""
Meme Trends Battle — Discord Commands
======================================
Add to your existing Discord bot as a cog:

    from discord_commands import TrendsBattleCog
    await bot.add_cog(TrendsBattleCog(bot))

Or if the bot uses a different pattern, just import the functions
and wire them into whatever command system you already have.

Commands:
    !trends          — Discover & post trending memes (team picks from this list)
    !battle 3 7      — Create a market: meme #3 vs meme #7 from latest !trends
    !battle_status   — Show current active trends battle
    !battle_resolve  — Manually trigger resolution check
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import discord
from discord.ext import commands

from trends_discovery import discover_trending_memes
from supabase_integration import create_trends_market, get_active_trends_battle, update_trend_scores

logger = logging.getLogger(__name__)

# Channel where battle curation happens (set via env or override)
BATTLE_CHANNEL_ID = int(os.environ.get("DISCORD_BATTLE_CHANNEL_ID", "0"))


class TrendsBattleCog(commands.Cog, name="Trends Battle"):
    """Meme vs Meme battles powered by Google Trends."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.latest_trends: list[dict] = []  # Cache from last !trends call

    @commands.command(name="trends")
    async def trends_command(self, ctx: commands.Context, count: int = 12):
        """Discover trending memes and post the roster for matchup selection.
        
        Usage: !trends [count]
        """
        await ctx.send("🔍 Scanning Google Trends for trending memes...")

        try:
            memes = discover_trending_memes(count=min(count, 20))
        except Exception as e:
            await ctx.send(f"❌ Trend discovery failed: {e}")
            return

        if not memes:
            await ctx.send("No trending memes found. Try again later.")
            return

        self.latest_trends = memes

        # Build the embed
        embed = discord.Embed(
            title="🔥 TRENDING MEMES — Pick Your Fighters",
            description="Reply with `!battle <A> <B>` to create a 7-day trends battle.\nExample: `!battle 3 7`",
            color=0xF7931A,  # meme.com gold
            timestamp=datetime.now(timezone.utc),
        )

        for i, m in enumerate(memes, 1):
            score = m.get("score", "?")
            change = m.get("change_pct", 0)
            rising = m.get("rising_pct", 0)

            # Emoji indicators
            if change > 20:
                indicator = "🚀"
            elif change > 5:
                indicator = "📈"
            elif change > -5:
                indicator = "➡️"
            else:
                indicator = "📉"

            change_str = f"+{change}%" if change >= 0 else f"{change}%"
            rising_str = f" (🔥 {rising}% rising)" if rising > 100 else ""

            embed.add_field(
                name=f"`{i:2d}` {indicator} {m['name']}",
                value=f"Score: **{score}**/100 | 7d: **{change_str}**{rising_str}",
                inline=True,
            )

        # Show thumbnail of first meme
        if memes[0].get("image_url"):
            embed.set_thumbnail(url=memes[0]["image_url"])

        embed.set_footer(text="Google Trends data • meme.com Trends Arena")

        await ctx.send(embed=embed)

        # Also post individual images for top 6 so team can see them
        image_embeds = []
        for i, m in enumerate(memes[:6], 1):
            if m.get("image_url"):
                img_embed = discord.Embed(
                    title=f"#{i} — {m['name']}",
                    color=0x191F29,
                )
                img_embed.set_image(url=m["image_url"])
                image_embeds.append(img_embed)

        if image_embeds:
            # Send in batches of 3 (Discord embed limit per message)
            for j in range(0, len(image_embeds), 3):
                await ctx.send(embeds=image_embeds[j:j + 3])

    @commands.command(name="battle")
    async def battle_command(self, ctx: commands.Context, a: int, b: int):
        """Create a trends battle market from the latest !trends list.
        
        Usage: !battle 3 7
        """
        if not self.latest_trends:
            await ctx.send("⚠️ No trends data available. Run `!trends` first.")
            return

        if a == b:
            await ctx.send("❌ Can't battle a meme against itself!")
            return

        if a < 1 or a > len(self.latest_trends) or b < 1 or b > len(self.latest_trends):
            await ctx.send(f"❌ Pick numbers between 1 and {len(self.latest_trends)}")
            return

        meme_a = self.latest_trends[a - 1]
        meme_b = self.latest_trends[b - 1]

        # Check for existing active battle
        existing = get_active_trends_battle()
        if existing:
            await ctx.send(
                f"⚠️ There's already an active trends battle: "
                f"**{existing.get('coin_symbol', '?')}** vs **{existing.get('coin_b_symbol', '?')}**\n"
                f"Wait for it to resolve or use `!battle_resolve` to check."
            )
            return

        await ctx.send(
            f"⚔️ Creating battle: **{meme_a['name']}** vs **{meme_b['name']}**..."
        )

        try:
            market = create_trends_market(meme_a, meme_b)
        except Exception as e:
            await ctx.send(f"❌ Failed to create market: {e}")
            return

        # Confirmation embed
        embed = discord.Embed(
            title=f"⚔️ TRENDS BATTLE CREATED",
            description=f"**{meme_a['name']}** vs **{meme_b['name']}**",
            color=0x4ade80,
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(
            name=meme_a["name"],
            value=f"Score: {meme_a.get('score', '?')}/100\nTrend: {meme_a['trend_term']}",
            inline=True,
        )
        embed.add_field(
            name="VS",
            value="⚔️",
            inline=True,
        )
        embed.add_field(
            name=meme_b["name"],
            value=f"Score: {meme_b.get('score', '?')}/100\nTrend: {meme_b['trend_term']}",
            inline=True,
        )
        embed.add_field(
            name="Resolution",
            value="7 days — meme with higher Google Trends % growth wins",
            inline=False,
        )
        embed.add_field(
            name="Market ID",
            value=f"`{market.get('id', '?')}`",
            inline=False,
        )

        if meme_a.get("image_url"):
            embed.set_thumbnail(url=meme_a["image_url"])

        embed.set_footer(text="Live on labs.meme.com • Trends Arena")
        await ctx.send(embed=embed)

    @commands.command(name="battle_status")
    async def battle_status_command(self, ctx: commands.Context):
        """Show the current active trends battle."""
        battle = get_active_trends_battle()
        if not battle:
            await ctx.send("No active trends battle. Use `!trends` then `!battle` to create one.")
            return

        pct_a = 0
        pct_b = 0
        if battle.get("start_mc") and battle["start_mc"] > 0:
            pct_a = ((battle.get("current_mc", 0) - battle["start_mc"]) / battle["start_mc"]) * 100
        if battle.get("start_mc_b") and battle["start_mc_b"] > 0:
            pct_b = ((battle.get("current_mc_b", 0) - battle["start_mc_b"]) / battle["start_mc_b"]) * 100

        leader = "TIED"
        if pct_a > pct_b:
            leader = f"{battle.get('coin_symbol', '?')} WINNING"
        elif pct_b > pct_a:
            leader = f"{battle.get('coin_b_symbol', '?')} WINNING"

        embed = discord.Embed(
            title=f"📊 {battle.get('coin_symbol', '?')} vs {battle.get('coin_b_symbol', '?')}",
            description=f"**{leader}**",
            color=0xF7931A,
        )
        embed.add_field(
            name=battle.get("coin_symbol", "?"),
            value=f"Start: {battle.get('start_mc', '?')}/100\nNow: {battle.get('current_mc', '?')}/100\nChange: {pct_a:+.1f}%",
            inline=True,
        )
        embed.add_field(
            name=battle.get("coin_b_symbol", "?"),
            value=f"Start: {battle.get('start_mc_b', '?')}/100\nNow: {battle.get('current_mc_b', '?')}/100\nChange: {pct_b:+.1f}%",
            inline=True,
        )
        embed.add_field(
            name="Expires",
            value=f"<t:{int(datetime.fromisoformat(battle['expires_at']).timestamp())}:R>" if battle.get("expires_at") else "?",
            inline=False,
        )
        await ctx.send(embed=embed)

    @commands.command(name="battle_resolve")
    async def battle_resolve_command(self, ctx: commands.Context):
        """Manually trigger a trend score update for the active battle."""
        battle = get_active_trends_battle()
        if not battle:
            await ctx.send("No active trends battle to update.")
            return

        await ctx.send("📊 Fetching latest Google Trends scores...")

        try:
            result = update_trend_scores(battle)
            await ctx.send(
                f"✅ Scores updated:\n"
                f"**{battle.get('coin_symbol', '?')}**: {result.get('score_a', '?')}/100\n"
                f"**{battle.get('coin_b_symbol', '?')}**: {result.get('score_b', '?')}/100"
            )
        except Exception as e:
            await ctx.send(f"❌ Score update failed: {e}")


# ─── Setup function for adding to existing bot ───
async def setup(bot: commands.Bot):
    """Standard discord.py cog setup. Load with: await bot.load_extension('discord_commands')"""
    await bot.add_cog(TrendsBattleCog(bot))
