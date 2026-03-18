// Vercel serverless function: detect KYM Meme of the Month winner + top 3
// GET /api/kym-winner?month=march&year=2026
// Returns { winner_name, winner_slug, top3: [{slug, name, vote_pct}], all_ranked }
// or { winner: null, reason: '...' }

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { month, year } = req.query;
  if (!month || !year) {
    return res.status(400).json({ error: 'month and year required' });
  }

  const monthLower = month.toLowerCase();
  const winnerUrl = `https://knowyourmeme.com/editorials/meme-review/see-the-winner-of-${monthLower}-${year}s-meme-of-the-month`;

  try {
    let html = null;

    // Primary: Cloudflare Browser Rendering /crawl API (if credentials available)
    if (CF_ACCOUNT_ID && CF_API_TOKEN) {
      try {
        const cfRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/crawl`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${CF_API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify([{ url: winnerUrl, render: false }])
          }
        );
        if (cfRes.ok) {
          const cfData = await cfRes.json();
          if (cfData.result?.[0]?.html) {
            html = cfData.result[0].html;
          }
        }
      } catch (_) {
        // Fall through to direct fetch
      }
    }

    // Fallback: direct fetch (KYM is server-rendered)
    if (!html) {
      const directRes = await fetch(winnerUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MemeLabsBot/1.0)'
        }
      });
      if (directRes.status === 404) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
        return res.status(200).json({ winner: null, reason: 'page_not_found' });
      }
      if (!directRes.ok) {
        return res.status(502).json({ error: 'KYM fetch failed', status: directRes.status });
      }
      html = await directRes.text();
    }

    // Extract winner name via regex
    const winnerMatch = html.match(/winner of .+?Meme of the Month.+?is\s*(?:…|\.\.\.)\s*(.+?)!/i);
    const winnerName = winnerMatch ? winnerMatch[1].replace(/<[^>]*>/g, '').trim() : null;

    // Extract all ranked results with vote percentages
    // Pattern: meme entries with vote percentages, linked to /memes/slug
    const allRanked = [];
    const seen = new Set();

    // Try to find ranked entries with percentages
    // Common pattern: "X% ... <a href="/memes/slug">Name</a>" or similar
    const rankedPattern = /(\d+(?:\.\d+)?)\s*(?:%|percent)[\s\S]{0,300}?href="\/memes\/([a-z0-9-]+)"[^>]*>([^<]+)/gi;
    let match;
    while ((match = rankedPattern.exec(html)) !== null) {
      const votePct = parseFloat(match[1]);
      const slug = match[2];
      const name = match[3].replace(/<[^>]*>/g, '').trim();
      if (seen.has(slug) || !slug || !name) continue;
      seen.add(slug);
      allRanked.push({ slug, name, vote_pct: votePct });
    }

    // Alternative: href before percentage
    if (allRanked.length === 0) {
      const altPattern = /href="\/memes\/([a-z0-9-]+)"[^>]*>([^<]+)<[\s\S]{0,300}?(\d+(?:\.\d+)?)\s*(?:%|percent)/gi;
      while ((match = altPattern.exec(html)) !== null) {
        const slug = match[1];
        const name = match[2].replace(/<[^>]*>/g, '').trim();
        const votePct = parseFloat(match[3]);
        if (seen.has(slug) || !slug || !name) continue;
        seen.add(slug);
        allRanked.push({ slug, name, vote_pct: votePct });
      }
    }

    // Sort by vote percentage descending
    allRanked.sort((a, b) => b.vote_pct - a.vote_pct);

    // Extract winner slug (first from ranked list, fallback to first href)
    let winnerSlug = allRanked.length > 0 ? allRanked[0].slug : null;
    if (!winnerSlug) {
      const slugMatch = html.match(/href="\/memes\/([a-z0-9-]+)"/i);
      winnerSlug = slugMatch ? slugMatch[1] : null;
    }

    const top3 = allRanked.slice(0, 3);

    if (winnerName || winnerSlug) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
      return res.status(200).json({
        winner_name: winnerName || (top3[0]?.name || null),
        winner_slug: winnerSlug,
        top3: top3.length > 0 ? top3 : null,
        all_ranked: allRanked.length > 0 ? allRanked : null,
        source_url: winnerUrl
      });
    }

    // Page exists but couldn't extract winner
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    return res.status(200).json({ winner: null, reason: 'no_winner_found', source_url: winnerUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
