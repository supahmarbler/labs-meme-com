// Vercel serverless function: fetch Google Trends interest score via SerpAPI
// GET /api/trend-score?term=doge+meme
// Returns 6-hour rolling average of hourly data for smooth, frequent updates

const SERPAPI_KEY = '398dde61a26ab84b47320c1ed443d428adc64656cf02e6a71703b732070ed959';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { term, months } = req.query;
  if (!term || term.length < 2) {
    return res.status(400).json({ error: 'term required (min 2 chars)' });
  }
  const m = Math.min(12, Math.max(1, parseInt(months) || 3));

  try {
    const url = `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(term)}&data_type=TIMESERIES&date=today+${m}-m&api_key=${SERPAPI_KEY}`;
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

    const vals = timeline.map(t => t.values[0].extracted_value);

    // 24-hour rolling average of daily data for smooth scores
    let end = vals.length;
    while (end > 1 && vals[end - 1] === 0) end--;
    const window = vals.slice(Math.max(0, end - 3), end);
    const avg = window.length > 0 ? Math.round(window.reduce((a, b) => a + b, 0) / window.length) : 1;
    const latestScore = Math.max(1, avg);

    // Start score: first 3 data points average
    const startWindow = vals.slice(0, Math.min(3, vals.length));
    const startAvg = startWindow.length > 0 ? Math.round(startWindow.reduce((a, b) => a + b, 0) / startWindow.length) : 1;
    const startScore = Math.max(1, startAvg);

    res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate=3600');
    return res.status(200).json({ score: latestScore, startScore, points: timeline.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
