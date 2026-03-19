// Vercel serverless function: KYM indexer (daily cron)
// Runs daily at 14:00 UTC via vercel.json cron
// GET /api/kym-index
//
// Logic: If day ≤ 25, scrape trending → create KYMRACE markets
// Single phase: "Will X finish top 3 Meme of the Month?"

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://csvegolcvwuwssoefxdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DEFAULT_LIQUIDITY = 2000000;
const MAX_TRENDING = 30;
const MAX_AGE_DAYS = 45; // Skip memes with KYM entries older than ~6 weeks

const STOP_WORDS = new Set(['a','an','the','of','to','is','in','for','and','or','on','at','by','it','as','be','no','my','do','so','up','if','me']);

function tokenize(name) {
  const words = name.toLowerCase()
    .replace(/['']/g, '') // didn't → didnt
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  // Expand contractions: "didnt" → "did", "doesnt" → "does", "cant" → "can", etc.
  const expanded = [];
  for (const w of words) {
    const m = w.match(/^(.+?)(nt)$/);
    if (m && m[1].length > 1) expanded.push(m[1], 'not');
    else expanded.push(w);
  }
  return expanded.filter(w => !STOP_WORDS.has(w));
}

function findSimilar(newName, existingMarkets) {
  const newTokens = new Set(tokenize(newName));
  if (newTokens.size === 0) return null;
  let bestMatch = null;
  let bestCount = 0;
  for (const m of existingMarkets) {
    const existingTokens = new Set(tokenize(m.coin_name));
    const overlap = [...newTokens].filter(w => existingTokens.has(w));
    if (overlap.length >= 2 && overlap.length > bestCount) {
      bestCount = overlap.length;
      bestMatch = { name: m.coin_name, slug: m.kym_slug, overlap, count: overlap.length };
    }
  }
  return bestMatch;
}

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
        let dupWarnings = [];

        // Fetch existing open KYMRACE markets for similarity check
        let existingMarkets = [];
        try {
          const mktsRes = await fetch(
            `${SUPABASE_URL}/rest/v1/labs_markets?market_type=eq.KYMRACE&status=eq.OPEN&season_id=eq.${seasonId}&select=coin_name,kym_slug`,
            { headers }
          );
          if (mktsRes.ok) existingMarkets = await mktsRes.json();
        } catch {}

        for (const meme of topMemes) {
          // Check for similar existing market (different slug) before creating
          const similar = findSimilar(meme.name, existingMarkets.filter(m => m.kym_slug !== meme.slug));
          if (similar) {
            dupWarnings.push({ new: meme.name, newSlug: meme.slug, existing: similar.name, existingSlug: similar.slug, overlap: similar.overlap });
            continue;
          }

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
        // Notify Discord about potential duplicates
        if (dupWarnings.length > 0 && DISCORD_WEBHOOK_URL) {
          const lines = dupWarnings.map(d =>
            `• **"${d.new}"** (\`${d.newSlug}\`) looks like **"${d.existing}"** (\`${d.existingSlug}\`) — overlap: ${d.overlap.join(', ')}`
          ).join('\n');
          try {
            await fetch(DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: `⚠️ **KYM Indexer — ${dupWarnings.length} potential duplicate(s) skipped**\n\n${lines}`
              })
            });
          } catch {}
        }

        log.push({ step: 'create_markets', created, skipped, tooOld, dupSkipped: dupWarnings.length, totalTrending: trendData.memes.length });
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
