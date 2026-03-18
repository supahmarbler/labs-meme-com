// Vercel serverless function: scrape KYM Meme of the Month nominees (voting page)
// GET /api/kym-nominees?month=march&year=2026
// Returns { nominees: [{ name, slug }] } or { nominees: null, reason: 'page_not_found' }

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
  const voteUrl = `https://knowyourmeme.com/editorials/poll/cast-your-vote-for-${monthLower}-${year}s-meme-of-the-month`;

  try {
    let html = null;

    // Primary: Cloudflare Browser Rendering with render: true (voting page loads dynamically)
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
            body: JSON.stringify([{ url: voteUrl, render: true }])
          }
        );
        if (cfRes.ok) {
          const cfData = await cfRes.json();
          if (cfData.result?.[0]?.html) {
            html = cfData.result[0].html;
          }
        }
      } catch (_) {
        // Fall through
      }
    }

    // Fallback: direct fetch
    if (!html) {
      const directRes = await fetch(voteUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeLabsBot/1.0)' }
      });
      if (directRes.status === 404) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
        return res.status(200).json({ nominees: null, reason: 'page_not_found' });
      }
      if (!directRes.ok) {
        return res.status(502).json({ error: 'KYM fetch failed', status: directRes.status });
      }
      html = await directRes.text();
    }

    // Check if this is actually the voting page (not a redirect/404)
    if (!html.includes('meme-of-the-month') && !html.includes('cast-your-vote')) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
      return res.status(200).json({ nominees: null, reason: 'page_not_found' });
    }

    // Extract nominee slugs from /memes/{slug} links
    const nominees = [];
    const seen = new Set();

    // Pattern: links to /memes/SLUG within voting sections
    const slugPattern = /href="\/memes\/([a-z0-9-]+)"/gi;
    let match;
    while ((match = slugPattern.exec(html)) !== null) {
      const slug = match[1];
      if (seen.has(slug)) continue;
      // Skip navigation/generic slugs
      if (['trending', 'popular', 'new', 'top', 'random', 'deadpool', 'spread', 'researching'].includes(slug)) continue;
      seen.add(slug);

      // Try to find name near the link
      const afterLink = html.substring(match.index, match.index + 500);
      const nameMatch = afterLink.match(new RegExp(slug + '"[^>]*>([^<]+)', 'i'))
        || afterLink.match(/alt="([^"]+)"/i)
        || afterLink.match(/<(?:span|h[2-4])[^>]*>([^<]+)/i);
      let name = nameMatch ? nameMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      if (!name) {
        name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }

      nominees.push({ name, slug });
    }

    if (nominees.length === 0) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=900');
      return res.status(200).json({ nominees: null, reason: 'no_nominees_found', source_url: voteUrl });
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    return res.status(200).json({ nominees, count: nominees.length, source_url: voteUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
