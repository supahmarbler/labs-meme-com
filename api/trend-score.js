// Vercel serverless function: fetch Google Trends interest score via SerpAPI
// GET /api/trend-score?term=doge+meme

const SERPAPI_KEY = '398dde61a26ab84b47320c1ed443d428adc64656cf02e6a71703b732070ed959';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { term } = req.query;
  if (!term || term.length < 2) {
    return res.status(400).json({ error: 'term required (min 2 chars)' });
  }

  try {
    const url = `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(term)}&data_type=TIMESERIES&date=now+7-d&api_key=${SERPAPI_KEY}`;
    const serpRes = await fetch(url);
    if (!serpRes.ok) {
      const errText = await serpRes.text();
      return res.status(502).json({ error: 'SerpAPI failed', status: serpRes.status, detail: errText.slice(0, 200) });
    }
    const data = await serpRes.json();

    const timeline = data.interest_over_time?.timeline_data;
    if (!timeline || timeline.length === 0) {
      return res.status(502).json({ error: 'No timeline data from SerpAPI' });
    }

    // Use latest value, but skip at most 1 trailing zero (incomplete current hour)
    const last = timeline[timeline.length - 1].values[0].extracted_value;
    const raw = (last === 0 && timeline.length >= 2)
      ? timeline[timeline.length - 2].values[0].extracted_value
      : last;
    const latestScore = Math.max(1, raw);
    const startScore = timeline[0].values[0].extracted_value;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ score: latestScore, startScore, points: timeline.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
