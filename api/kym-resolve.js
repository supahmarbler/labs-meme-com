// Vercel serverless function: resolve KYMRACE markets via KYM winner detection
// Triggered by Vercel cron daily from 1st-15th of each month
// GET /api/kym-resolve           → preview only (cron default), pings Discord if results found
// GET /api/kym-resolve?execute=true&key=SECRET → actually resolves markets
//
// Resolution rules:
// - Fetch KYM's full ranked results for the previous month
// - Cross-reference with our open KYMRACE markets for that season
// - Top 3 of OUR listed memes (by KYM rank) win → YES
// - All other markets → NO
// - If none of our memes appear in KYM results, all lose

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://csvegolcvwuwssoefxdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const RESOLVE_SECRET = process.env.RESOLVE_SECRET || 'motm-resolve-2026';

async function notifyDiscord(preview, seasonLabel, executeUrl) {
  if (!DISCORD_WEBHOOK_URL) return;
  const winners = preview.our_top3;
  const winnerLines = winners.length > 0
    ? winners.map((w, i) => `**${i + 1}.** ${w.name} (#${w.kym_rank + 1} on KYM, ${w.vote_pct ?? '?'}%)`).join('\n')
    : '_None of our memes appeared in KYM results — all bets lose_';

  const embed = {
    title: `🏆 MOTM Results Ready — ${seasonLabel}`,
    color: 0x71BAFF,
    fields: [
      { name: 'Our Winners', value: winnerLines },
      { name: 'Markets', value: `${preview.total_markets} total, ${preview.our_ranked_count} ranked on KYM`, inline: true },
      { name: 'KYM Winner', value: preview.kym_winner || 'Unknown', inline: true },
    ],
    footer: { text: 'Review and click Execute when ready' }
  };

  const content = `**[👉 Execute Resolution](${executeUrl})**\n**[Preview](https://labs.meme.com/api/kym-resolve)**`;

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, embeds: [embed] })
    });
  } catch (_) {
    // Non-critical — don't fail resolution over notification
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
  }

  const { execute, key } = req.query;
  const shouldExecute = execute === 'true' && key === RESOLVE_SECRET;

  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  // Determine previous month
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate();

  // Only run from 1st-15th of the month (skip check if manual execute)
  if (utcDay > 15 && !shouldExecute) {
    return res.status(200).json({ skipped: true, reason: 'past_15th' });
  }

  // Previous month
  const prevMonth = utcMonth === 0 ? 11 : utcMonth - 1;
  const prevYear = utcMonth === 0 ? utcYear - 1 : utcYear;
  const prevSeasonId = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const prevMonthName = monthNames[prevMonth];
  const seasonLabel = `${prevMonthName} ${prevYear}`;

  try {
    // Check if any unresolved KYMRACE markets exist for previous month
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/labs_markets?market_type=eq.KYMRACE&status=eq.OPEN&season_id=eq.${prevSeasonId}&select=id,kym_slug,coin_name`,
      { headers }
    );
    if (!checkRes.ok) {
      return res.status(500).json({ error: 'DB query failed', status: checkRes.status });
    }
    const openMarkets = await checkRes.json();

    if (!openMarkets || openMarkets.length === 0) {
      return res.status(200).json({ skipped: true, reason: 'no_open_markets', season_id: prevSeasonId });
    }

    // Fetch KYM winner for previous month
    const baseUrl = 'https://labs.meme.com';
    const winnerRes = await fetch(`${baseUrl}/api/kym-winner?month=${prevMonthName.toLowerCase()}&year=${prevYear}`);

    if (!winnerRes.ok) {
      return res.status(502).json({ error: 'kym-winner API failed', status: winnerRes.status });
    }

    const winnerData = await winnerRes.json();

    // Need ranked results for resolution
    const allRanked = winnerData.all_ranked || winnerData.top3 || [];

    if (allRanked.length === 0 && !winnerData.winner_slug) {
      return res.status(200).json({
        resolved: false,
        reason: 'no_winner_yet',
        season_id: prevSeasonId,
        month: prevMonthName,
        year: prevYear
      });
    }

    // Build a rank map from KYM results: slug → { rank, vote_pct, name }
    const kymRankMap = {};
    allRanked.forEach((entry, idx) => {
      kymRankMap[entry.slug.toLowerCase()] = { rank: idx, vote_pct: entry.vote_pct, name: entry.name };
    });

    // If only winner_slug available (no full rankings), treat it as rank 0
    if (allRanked.length === 0 && winnerData.winner_slug) {
      kymRankMap[winnerData.winner_slug.toLowerCase()] = { rank: 0, vote_pct: null, name: winnerData.winner_name };
    }

    // Cross-reference: find which of OUR markets appear in KYM results
    const ourRanked = openMarkets
      .filter(m => m.kym_slug && kymRankMap[m.kym_slug.toLowerCase()] !== undefined)
      .sort((a, b) => kymRankMap[a.kym_slug.toLowerCase()].rank - kymRankMap[b.kym_slug.toLowerCase()].rank);

    // Top 3 of our ranked markets win
    const ourTop3 = ourRanked.slice(0, 3);
    const winnerSlugs = ourTop3.map(m => m.kym_slug);

    const preview = {
      season_id: prevSeasonId,
      season_label: seasonLabel,
      total_markets: openMarkets.length,
      kym_ranked_count: allRanked.length,
      our_ranked_count: ourRanked.length,
      kym_winner: winnerData.winner_name || winnerData.winner_slug,
      our_top3: ourTop3.map(m => {
        const info = kymRankMap[m.kym_slug.toLowerCase()];
        return { id: m.id, slug: m.kym_slug, name: m.coin_name, kym_rank: info.rank, vote_pct: info.vote_pct };
      }),
      all_our_ranked: ourRanked.map(m => {
        const info = kymRankMap[m.kym_slug.toLowerCase()];
        return { id: m.id, slug: m.kym_slug, name: m.coin_name, kym_rank: info.rank, vote_pct: info.vote_pct };
      }),
      will_win: winnerSlugs,
      will_lose_count: openMarkets.length - ourTop3.length
    };

    // Preview mode (default): show what would happen, notify Discord
    if (!shouldExecute) {
      const executeUrl = `https://labs.meme.com/api/kym-resolve?execute=true&key=${RESOLVE_SECRET}`;
      await notifyDiscord(preview, seasonLabel, executeUrl);

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        mode: 'preview',
        ...preview,
        execute_url: executeUrl,
        note: 'This is a preview. Add ?execute=true&key=SECRET to actually resolve.'
      });
    }

    // Execute mode: actually resolve markets
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/labs_resolve_kymrace`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_season_id: prevSeasonId,
        p_top3_slugs: winnerSlugs.length > 0 ? winnerSlugs : ['__none__']
      })
    });

    if (!rpcRes.ok) {
      const errText = await rpcRes.text();
      return res.status(500).json({ error: 'RPC failed', detail: errText.slice(0, 500) });
    }

    const data = await rpcRes.json();
    const result = typeof data === 'string' ? JSON.parse(data) : data;

    // Notify Discord that resolution was executed
    if (DISCORD_WEBHOOK_URL) {
      try {
        await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `✅ **MOTM ${seasonLabel} resolved!** ${result.resolved_count} markets resolved. Winners: ${winnerSlugs.join(', ') || 'none'}`
          })
        });
      } catch (_) {}
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      mode: 'executed',
      ...result,
      ...preview
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
