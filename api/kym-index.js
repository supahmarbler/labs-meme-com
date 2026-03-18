// Vercel serverless function: KYM indexer (daily cron)
// Runs daily at 14:00 UTC via vercel.json cron
// GET /api/kym-index
//
// Logic: If day ≤ 25, scrape trending → create KYMRACE markets
// Single phase: "Will X finish top 3 Meme of the Month?"

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://csvegolcvwuwssoefxdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEFAULT_LIQUIDITY = 2000000;
const MAX_TRENDING = 30;
const MAX_AGE_DAYS = 90; // Skip memes with KYM entries older than this

// Check if a meme's KYM entry is recent enough (< MAX_AGE_DAYS old)
async function isMemeRecent(slug) {
  try {
    const res = await fetch(`https://knowyourmeme.com/memes/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return true; // Can't verify — allow it
    const html = await res.text();
    const match = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (!match) return true; // No date found — allow it
    const published = new Date(match[1]);
    const ageDays = (Date.now() - published.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays <= MAX_AGE_DAYS;
  } catch {
    return true; // Fetch failed — allow it
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
  }

  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  const now = new Date();
  const utcDay = now.getUTCDate();
  const seasonId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Always use the production alias for self-calls (preview URLs require auth)
  const baseUrl = 'https://labs.meme.com';

  const log = [];

  try {
    if (utcDay <= 25) {
      // Scrape trending and create markets
      let trendData = null;
      try {
        const trendRes = await fetch(`${baseUrl}/api/kym-trending`);
        if (trendRes.ok) {
          trendData = await trendRes.json();
        } else {
          log.push({ step: 'trending_fetch_error', status: trendRes.status, url: `${baseUrl}/api/kym-trending` });
        }
      } catch (trendErr) {
        log.push({ step: 'trending_fetch_error', error: trendErr.message });
      }

      if (trendData?.memes && trendData.memes.length > 0) {
        const topMemes = trendData.memes.slice(0, MAX_TRENDING);
        let created = 0;
        let skipped = 0;
        let tooOld = 0;

        for (const meme of topMemes) {
          // Skip memes with KYM entries older than MAX_AGE_DAYS
          const recent = await isMemeRecent(meme.slug);
          if (!recent) { tooOld++; continue; }

          const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/labs_create_kymrace_system`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              p_meme_name: meme.name,
              p_kym_slug: meme.slug,
              p_image_url: meme.image || '',
              p_liquidity: DEFAULT_LIQUIDITY
            })
          });
          const rpcData = rpcRes.ok ? await rpcRes.json() : null;
          const result = typeof rpcData === 'string' ? JSON.parse(rpcData) : rpcData;
          if (result?.success) {
            created++;
          } else {
            skipped++; // Duplicate or validation error — expected
          }
        }
        log.push({ step: 'create_markets', created, skipped, tooOld, totalTrending: trendData.memes.length });
      } else {
        log.push({ step: 'skip', reason: 'no_trending_data' });
      }
    } else {
      log.push({ step: 'skip', reason: 'day_gt_25', day: utcDay });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, season_id: seasonId, log });
  } catch (e) {
    return res.status(500).json({ error: e.message, log });
  }
}
