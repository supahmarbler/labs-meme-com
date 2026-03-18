// Vercel serverless function: poll KYM editorials RSS for MOTM articles
// Cron: every hour on days 1-10 (winner detection) + days 24-31 (poll detection)
// GET /api/kym-rss-check
//
// Detects two types of articles:
// 1. Winner announcement → triggers /api/kym-resolve (preview + Discord notify)
// 2. Voting poll article → triggers /api/kym-poll-sync (creates missing markets, resolves non-finalists)

const RESOLVE_SECRET = process.env.RESOLVE_SECRET || 'motm-resolve-2026';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://csvegolcvwuwssoefxdh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Qf1O75YbEeBE2qwg4ThmwA_Uxpw9BG4';

const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december'
];

async function hasOpenMarkets(seasonId) {
  const url = `${SUPABASE_URL}/rest/v1/labs_markets?market_type=eq.KYMRACE&status=eq.OPEN&season_id=eq.${seasonId}&select=id&limit=1`;
  try {
    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!r.ok) return true; // on error, assume markets exist (safe fallback)
    const rows = await r.json();
    return rows.length > 0;
  } catch {
    return true;
  }
}

async function callResolve(path) {
  const url = `https://labs.meme.com${path}`;
  const r = await fetch(url);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'non_json_response', status: r.status, body: text.slice(0, 200) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const now = new Date();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate();
  const currentMonthName = MONTH_NAMES[utcMonth];
  const prevMonth = utcMonth === 0 ? 11 : utcMonth - 1;
  const prevMonthName = MONTH_NAMES[prevMonth];

  try {
    // Fetch KYM editorials RSS (plain XML, no JS rendering needed)
    const rssRes = await fetch('https://knowyourmeme.com/editorials.rss', {
      headers: { 'User-Agent': 'MemeArena/1.0 RSS Reader' }
    });

    if (!rssRes.ok) {
      return res.status(502).json({ error: 'RSS fetch failed', status: rssRes.status });
    }

    const xml = await rssRes.text();

    // Check we actually got RSS, not a captcha page
    if (!xml.includes('<rss') && !xml.includes('<channel>')) {
      return res.status(502).json({ error: 'RSS returned non-XML response', snippet: xml.slice(0, 200) });
    }

    // Extract <item> blocks with title and pubDate
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/) || block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
      items.push({ title, pubDate });
    }

    // Look for winner announcement for the previous month
    // Pattern: "Winner Of {Month} {Year}'s Meme Of The Month"
    const winnerItem = items.find(item => {
      const lower = item.title.toLowerCase();
      return lower.includes('winner') &&
             lower.includes('meme of the month') &&
             lower.includes(prevMonthName);
    });

    // Also look for voting poll article for the CURRENT month
    // Pattern: "Cast Your Vote For {Month} {Year}'s Meme Of The Month"
    const pollItem = items.find(item => {
      const lower = item.title.toLowerCase();
      return (lower.includes('cast your vote') || lower.includes('vote for')) &&
             lower.includes('meme of the month') &&
             lower.includes(currentMonthName);
    });

    if (!winnerItem && !pollItem) {
      return res.status(200).json({
        detected: false,
        looking_for_winner: prevMonthName,
        looking_for_poll: currentMonthName,
        items_checked: items.length,
        recent_titles: items.slice(0, 5).map(i => i.title)
      });
    }

    // Check if relevant markets are already resolved before triggering downstream
    const utcYear = now.getUTCFullYear();
    const currentSeasonId = `${utcYear}-${String(utcMonth + 1).padStart(2, '0')}`;
    const prevYear = prevMonth === 11 ? utcYear - 1 : utcYear;
    const prevSeasonId = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;

    if (winnerItem) {
      const hasOpen = await hasOpenMarkets(prevSeasonId);
      if (!hasOpen) {
        return res.status(200).json({
          detected: true,
          already_resolved: true,
          rss_title: winnerItem.title,
          season_id: prevSeasonId
        });
      }
    }

    if (pollItem && !winnerItem) {
      const hasOpen = await hasOpenMarkets(currentSeasonId);
      if (!hasOpen) {
        return res.status(200).json({
          detected: 'poll',
          already_resolved: true,
          rss_title: pollItem.title,
          season_id: currentSeasonId
        });
      }
    }

    // Handle poll detection — trigger poll sync
    if (pollItem && !winnerItem) {
      if (DISCORD_WEBHOOK_URL) {
        try {
          await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `📋 **MOTM Voting Poll Detected via RSS!**\n"${pollItem.title}"\nPublished: ${pollItem.pubDate}\n\nTriggering poll sync...`
            })
          });
        } catch (_) {}
      }

      const syncData = await callResolve('/api/kym-poll-sync');

      return res.status(200).json({
        detected: 'poll',
        rss_title: pollItem.title,
        rss_date: pollItem.pubDate,
        poll_sync: syncData
      });
    }

    // Winner detected! Notify Discord immediately
    if (DISCORD_WEBHOOK_URL) {
      try {
        await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🚨 **MOTM Winner Detected via RSS!**\n"${winnerItem.title}"\nPublished: ${winnerItem.pubDate}\n\nAuto-triggering resolution...`
          })
        });
      } catch (_) {}
    }

    // Auto-trigger resolution: first preview
    const previewData = await callResolve('/api/kym-resolve');

    // If preview found results, auto-execute
    if (previewData.mode === 'preview' && previewData.will_win) {
      const executeData = await callResolve(`/api/kym-resolve?execute=true&key=${RESOLVE_SECRET}`);

      return res.status(200).json({
        detected: true,
        rss_title: winnerItem.title,
        rss_date: winnerItem.pubDate,
        resolution: executeData
      });
    }

    // Preview didn't find actionable results
    return res.status(200).json({
      detected: true,
      rss_title: winnerItem.title,
      rss_date: winnerItem.pubDate,
      resolution: 'preview_no_results',
      preview: previewData
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
