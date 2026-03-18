// Vercel serverless function: daily cron to cache Google Trends scores
// GET /api/trend-score-update
// Fetches trend scores for ALL open KYMRACE markets, upserts to labs_google_trends

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://csvegolcvwuwssoefxdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

  const baseUrl = 'https://labs.meme.com';
  const log = [];

  try {
    // All open KYMRACE markets
    const marketsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/labs_markets?select=id,coin_name&status=eq.OPEN&market_type=eq.KYMRACE`,
      { headers }
    );
    if (!marketsRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch markets', status: marketsRes.status });
    }
    const markets = await marketsRes.json();
    log.push({ step: 'markets', count: markets.length });

    if (markets.length === 0) {
      return res.status(200).json({ ok: true, updated: 0, log });
    }

    // Try fetching trend score for a term, returns data or null
    async function fetchTrend(term) {
      const r = await fetch(`${baseUrl}/api/trend-score?term=${encodeURIComponent(term)}&months=3`);
      if (!r.ok) return null;
      const d = await r.json();
      return d.error ? null : d;
    }

    // Fetch trend scores — batch 5 at a time to avoid hammering SerpAPI
    // On failure, retry with shorter term (first 3 words, then first 2)
    const rows = [];
    const noData = [];
    for (let i = 0; i < markets.length; i += 5) {
      const batch = markets.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(async (m) => {
        const fullTerm = m.coin_name.split('/')[0].trim();
        const words = fullTerm.split(/\s+/);

        // Try full term, then first 3 words, then first 2
        const candidates = [fullTerm];
        if (words.length > 3) candidates.push(words.slice(0, 3).join(' '));
        if (words.length > 2) candidates.push(words.slice(0, 2).join(' '));

        for (const term of candidates) {
          const data = await fetchTrend(term);
          if (data) {
            const pctChange = data.startScore > 0
              ? Math.round((data.score - data.startScore) / data.startScore * 100)
              : 0;
            return { market_id: m.id, term, score: data.score, start_score: data.startScore, pct_change: pctChange };
          }
        }
        // No data from any variant — store score 0
        noData.push(fullTerm);
        return { market_id: m.id, term: fullTerm, score: 0, start_score: 0, pct_change: 0 };
      }));
      results.forEach(r => { if (r.status === 'fulfilled' && r.value) rows.push(r.value); });
    }

    if (noData.length > 0) {
      log.push({ step: 'no_trend_data', count: noData.length, terms: noData });
    }

    // Upsert successful results
    if (rows.length > 0) {
      const upsertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/labs_google_trends?on_conflict=market_id`,
        {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() })))
        }
      );
      if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        log.push({ step: 'upsert_error', status: upsertRes.status, detail: errText.slice(0, 200) });
      } else {
        log.push({ step: 'upserted', count: rows.length });
      }
    }

    return res.status(200).json({ ok: true, updated: rows.length, total: markets.length, log });
  } catch (e) {
    return res.status(500).json({ error: e.message, log });
  }
}
