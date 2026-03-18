// Vercel serverless function: scrape KYM memes from multiple sources
// GET /api/kym-trending
// Returns { memes: [{ name, slug, image }], count, sources }
//
// Sources (in order):
// 1. Homepage — editorially featured/trending memes
// 2. Newest (sort=newest) — recently added memes
// 3. Confirmed+newest — confirmed status memes (higher quality signal)
// 4. Editorials — "what is X meme" articles (fetches articles for /memes/ links)

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const EXCLUDE_SLUGS = new Set([
  'trending', 'popular', 'new', 'top', 'random', 'deadpool', 'spread',
  'researching', 'submissions', 'sort', 'categories', 'search', 'memes',
  'events', 'sites', 'sensitive', 'subcultures', 'people',
  // Evergreen classics that appear in navigation — never MOTM candidates
  'loss', 'baneposting', 'meet-potential-man', 'im-something-of-a-scientist-myself',
  'navy-seal-copypasta', 'slender-man', 'doge', 'forever-alone', 'zerg-rush',
  'trollface', 'me-gusta', 'big-chungus', 'do-a-barrel-roll', 'hello-there',
  'ugandan-knuckles', 'ermahgerd', 'the-missile-knows-where-it-is',
  'good-answer-nephew', 'eladeselesobinubaliepraso',
  // Meta/generic categories — too broad to be MOTM candidates
  'brain-rot-brainrot', 'copypasta', 'reaction-images', 'catchphrases',
  'snowclones', 'exploitables', 'image-macros', 'viral-videos',
  'rage-comics', 'advice-animals', 'meme-man', 'gif', 'anime-manga',
  'npc-non-playable-character', 'aura-slang', 'quandale-dingle',
  'tiktok', 'youtube', 'instagram', 'reddit', 'twitter', 'facebook',
  'reaction-videos', 'shitposting', 'cringe', 'cursed-images',
  // Old evergreens that appear in sidebars/related sections
  'btw-i-use-arch', 'rickroll', 'harambe', 'pepe-the-frog',
  'wojak', 'chad', 'soyjak', 'npc-wojak', 'gigachad',
  'nyquil-chicken-sleepy-chicken', 'buff-dedede', 'chrisposting',
  'sybau-picture-sybau-guy', 'mustard-analog-horror',
  'that-fucking-bird-that-i-hate', 'mike-wazowski-sulley-face-swap'
]);

// Fetch a URL via Cloudflare Browser Rendering or direct fetch
async function fetchPage(url, followRedirects = false) {
  if (CF_ACCOUNT_ID && CF_API_TOKEN && !followRedirects) {
    try {
      const cfRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/crawl`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([{ url, render: false }])
        }
      );
      if (cfRes.ok) {
        const cfData = await cfRes.json();
        if (cfData.result?.[0]?.html) return cfData.result[0].html;
      }
    } catch (_) {}
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeLabsBot/1.0)' },
    redirect: followRedirects ? 'follow' : 'manual'
  });
  if (res.status === 301 || res.status === 302) {
    const loc = res.headers.get('location');
    if (loc && followRedirects) {
      const r2 = await fetch(loc, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeLabsBot/1.0)' }
      });
      if (r2.ok) return r2.text();
    }
    return null;
  }
  if (!res.ok) return null;
  return res.text();
}

// Extract memes from HTML using multiple patterns
function extractMemes(html, seen) {
  const memes = [];
  let match;

  // Pattern 1: item entries (listing pages)
  const itemPattern = /<a[^>]+class="item"[^>]+data-title="([^"]+)"[^>]+href="\/memes\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = itemPattern.exec(html)) !== null) {
    const name = match[1].trim();
    const slug = match[2];
    if (EXCLUDE_SLUGS.has(slug) || seen.has(slug) || slug.includes('/')) continue;
    if (!name) continue;
    const cardHtml = match[3];
    const imgMatch = cardHtml.match(/src="(https?:\/\/i\.kym-cdn\.com[^"]+)"/i)
      || cardHtml.match(/data-image="(https?:\/\/i\.kym-cdn\.com[^"]+)"/i);
    const image = imgMatch ? imgMatch[1].replace('/icons/newsfeed/', '/icons/original/') : '';
    seen.add(slug);
    memes.push({ name, slug, image });
  }

  // Pattern 2: overlayed-card entries (homepage featured)
  const cardPattern = /<a[^>]+class="overlayed-card"[^>]+href="\/memes\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = cardPattern.exec(html)) !== null) {
    const slug = match[1];
    if (EXCLUDE_SLUGS.has(slug) || seen.has(slug) || slug.includes('/')) continue;
    const cardHtml = match[2];
    const nameMatch = cardHtml.match(/<h3[^>]*class="title"[^>]*>([\s\S]*?)<\/h3>/i);
    const name = nameMatch ? nameMatch[1].replace(/<[^>]*>/g, '').trim() : null;
    if (!name) continue;
    const imgMatch = cardHtml.match(/src="(https?:\/\/i\.kym-cdn\.com[^"]+)"/i);
    const image = imgMatch ? imgMatch[1].replace('/icons/newsfeed/', '/icons/original/') : '';
    seen.add(slug);
    memes.push({ name, slug, image });
  }

  // Pattern 3: any /memes/SLUG links not yet seen — derive name from slug
  const linkPattern = /href="\/memes\/([a-z0-9][a-z0-9-]+)"/gi;
  while ((match = linkPattern.exec(html)) !== null) {
    const slug = match[1];
    if (EXCLUDE_SLUGS.has(slug) || seen.has(slug) || slug.includes('/')) continue;
    const after = html.substring(match.index, match.index + 500);
    const titleMatch = after.match(/data-title="([^"]{2,80})"/i)
      || after.match(/title="([^"]{2,80})"/i)
      || after.match(/<(?:h[2-6]|span)[^>]*>([^<]{2,80})<\/(?:h[2-6]|span)>/i);
    let name = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
    if (!name || name.length < 3 || /^(meme|entry|image|photo)$/i.test(name)
        || /\b(image example|image of|photo of|screenshot)\b/i.test(name)) {
      name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    const imgMatch = after.match(/src="(https?:\/\/i\.kym-cdn\.com[^"]+)"/i);
    const image = imgMatch ? imgMatch[1].replace('/icons/newsfeed/', '/icons/original/') : '';
    seen.add(slug);
    memes.push({ name, slug, image });
  }

  return memes;
}

// Extract editorial article URLs and fetch each to find meme entry links
async function scrapeEditorials(seen) {
  const memes = [];
  const editorialsHtml = await fetchPage('https://knowyourmeme.com/editorials');
  if (!editorialsHtml) return memes;

  // Find editorial article URLs (focus on "what-is" explainer articles)
  const urlPattern = /href="(https:\/\/knowyourmeme\.com\/editorials\/(?:what-is|whats-up)[^"]+)"/gi;
  const articleUrls = [];
  let match;
  while ((match = urlPattern.exec(editorialsHtml)) !== null) {
    articleUrls.push(match[1]);
  }

  // Also extract image from editorial card for the first meme found
  const cardImages = {};
  const imgPattern = /href="(https:\/\/knowyourmeme\.com\/editorials\/[^"]+)"[^>]*>\s*<img[^>]*src-large="([^"]+)"/gi;
  while ((match = imgPattern.exec(editorialsHtml)) !== null) {
    cardImages[match[1]] = match[2];
  }

  // Fetch up to 8 editorial articles in parallel to find meme slugs
  const fetches = articleUrls.slice(0, 8).map(async (url) => {
    const html = await fetchPage(url, true);
    if (!html) return null;

    // Extract all /memes/SLUG links from the article
    const slugs = [];
    const slugPattern = /href="(?:https:\/\/knowyourmeme\.com)?\/memes\/([a-z0-9][a-z0-9-]+)"/gi;
    let m;
    while ((m = slugPattern.exec(html)) !== null) {
      const slug = m[1];
      if (!EXCLUDE_SLUGS.has(slug) && !slug.includes('/')) slugs.push(slug);
    }
    if (slugs.length === 0) return null;

    // Return all unique non-seen slugs from article (max 3)
    const uniqueSlugs = slugs.filter(s => !seen.has(s));
    if (uniqueSlugs.length === 0) return null;

    return uniqueSlugs.slice(0, 3).map(slug => {
      const nameMatch = html.match(new RegExp(slug + '"[^>]*>([^<]+)', 'i'));
      let name = nameMatch ? nameMatch[1].replace(/[.,;:!]+$/, '').trim() : '';
      if (!name || name.length < 3 || /^[a-z]+$/i.test(name) || /\b(image|photo|screenshot)\b/i.test(name)) {
        name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      const imgMatch = html.match(new RegExp('/entries/icons/(?:original|newsfeed)/[^"]*' + slug.slice(0, 10) + '[^"]*', 'i'));
      const image = imgMatch
        ? 'https://i.kym-cdn.com' + imgMatch[0].replace('/icons/newsfeed/', '/icons/original/')
        : '';
      return { name, slug, image };
    });
  });

  const results = await Promise.all(fetches);
  for (const r of results) {
    if (!r) continue;
    const items = Array.isArray(r) ? r : [r];
    for (const m of items) {
      if (m && !seen.has(m.slug)) {
        seen.add(m.slug);
        memes.push(m);
      }
    }
  }

  return memes;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const seen = new Set();
    const allMemes = [];
    const sources = {};

    // Fetch homepage + meme listings in parallel
    const [homepageHtml, newestHtml, confirmedHtml] = await Promise.all([
      fetchPage('https://knowyourmeme.com'),
      fetchPage('https://knowyourmeme.com/memes?sort=newest'),
      fetchPage('https://knowyourmeme.com/memes?status=confirmed&sort=newest'),
    ]);

    // 1. Homepage
    if (homepageHtml) {
      const homeMemes = extractMemes(homepageHtml, seen);
      sources.homepage = homeMemes.length;
      allMemes.push(...homeMemes);
    }

    // 2. Newest
    if (newestHtml) {
      const newMemes = extractMemes(newestHtml, seen);
      sources.newest = newMemes.length;
      allMemes.push(...newMemes);
    }

    // 3. Confirmed
    if (confirmedHtml) {
      const confMemes = extractMemes(confirmedHtml, seen);
      sources.confirmed = confMemes.length;
      allMemes.push(...confMemes);
    }

    // 4. Editorials — fetch article pages to find meme entry links
    const editorialMemes = await scrapeEditorials(seen);
    sources.editorials = editorialMemes.length;
    allMemes.push(...editorialMemes);

    // 5. Fetch entry pages for editorial memes (resolve images + check recency)
    // Editorial articles often reference old memes in sidebars — filter them out.
    // Listing pages (homepage, newest, confirmed) inherently return recent memes.
    const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
    const editorialSlugs = new Set(editorialMemes.map(m => m.slug));
    const needFetch = allMemes.filter(m => !m.image || editorialSlugs.has(m.slug));
    if (needFetch.length > 0) {
      await Promise.all(needFetch.map(async (m) => {
        const html = await fetchPage(`https://knowyourmeme.com/memes/${m.slug}`, true);
        if (!html) return;
        // Resolve missing image
        if (!m.image) {
          const imgMatch = html.match(/https:\/\/i\.kym-cdn\.com\/entries\/icons\/(?:original|newsfeed)\/[^"'\s]+/i);
          if (imgMatch) m.image = imgMatch[0].replace('/icons/newsfeed/', '/icons/original/');
        }
        // Check recency for editorial-sourced memes
        if (editorialSlugs.has(m.slug)) {
          const dateMatch = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/);
          if (dateMatch && new Date(dateMatch[1]) < sixMonthsAgo) {
            m._stale = true;
          }
        }
      }));
    }
    // Remove stale editorial memes
    const freshMemes = allMemes.filter(m => !m._stale);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    return res.status(200).json({ memes: freshMemes, count: freshMemes.length, sources });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
