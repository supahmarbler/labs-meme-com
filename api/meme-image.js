// Vercel serverless function: fetch meme image from Know Your Meme
// GET /api/meme-image?term=pepe+the+frog

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { term } = req.query;
  if (!term || term.length < 2) {
    return res.status(400).json({ error: 'term required' });
  }

  try {
    // Search Know Your Meme
    const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const urls = [
      `https://knowyourmeme.com/memes/${slug}`,
      `https://knowyourmeme.com/memes/${slug}-meme`,
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeBot/1.0)' },
          redirect: 'follow',
        });
        if (!resp.ok) continue;
        const html = await resp.text();

        // Extract og:image meta tag
        const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
          || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
        if (ogMatch && ogMatch[1] && ogMatch[1].includes('kym-cdn.com')) {
          res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
          return res.status(200).json({ image: ogMatch[1] });
        }

        // Fallback: entry icon
        const iconMatch = html.match(/i\.kym-cdn\.com\/entries\/icons\/original\/[^"'\s]+/);
        if (iconMatch) {
          res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
          return res.status(200).json({ image: 'https://' + iconMatch[0] });
        }
      } catch (_) { /* try next URL */ }
    }

    // Fallback: Google image search via SerpAPI (reuse existing key)
    const SERPAPI_KEY = '398dde61a26ab84b47320c1ed443d428adc64656cf02e6a71703b732070ed959';
    const serpUrl = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(term + ' meme')}&num=1&api_key=${SERPAPI_KEY}`;
    const serpRes = await fetch(serpUrl);
    if (serpRes.ok) {
      const data = await serpRes.json();
      const img = data.images_results?.[0]?.original;
      if (img) {
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
        return res.status(200).json({ image: img });
      }
    }

    return res.status(404).json({ error: 'No image found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
