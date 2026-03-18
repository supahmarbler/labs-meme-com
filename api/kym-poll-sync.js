// Vercel serverless function: sync KYMRACE markets with KYM finalist poll
// GET /api/kym-poll-sync
//
// Triggered by kym-rss-check when "Cast Your Vote" article detected in RSS.
// Also runs daily via cron on days 25-31 as fallback.
//
// 1. Fetches nominees from /api/kym-nominees for the current month
// 2. Creates markets for any finalists we're missing
// 3. Notifies Discord with a preview of markets to resolve (non-finalists)
//    Manual approval required to actually resolve non-finalist markets.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://csvegolcvwuwssoefxdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DEFAULT_LIQUIDITY = 2000000;
const RESOLVE_SECRET = process.env.RESOLVE_SECRET || 'motm-resolve-2026';

const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december'
];

async function fetchKymImage(slug) {
  try {
    const r = await fetch(`https://knowyourmeme.com/memes/${slug}`, {
      headers: { 'User-Agent': 'MemeArena/1.0' },
      redirect: 'follow'
    });
    if (!r.ok) return '';
    const html = await r.text();
    const match = html.match(/<meta[^>]+property=['"]og:image['"][^>]+content=['"]([^'"]+)['"]/);
    if (!match) return '';
    // Upgrade to full resolution if it's a KYM CDN URL
    return match[1].replace('/icons/newsfeed/', '/icons/original/');
  } catch {
    return '';
  }
}

async function callApi(path) {
  const url = `https://labs.meme.com${path}`;
  const r = await fetch(url);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { return { error: 'non_json', body: text.slice(0, 200) }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
  }

  const { execute, key } = req.query;
  const shouldExecute = execute === 'true' && key === RESOLVE_SECRET;

  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const monthName = MONTH_NAMES[utcMonth];
  const seasonId = `${utcYear}-${String(utcMonth + 1).padStart(2, '0')}`;

  try {
    // 1. Fetch nominees from KYM poll page
    const nomData = await callApi(`/api/kym-nominees?month=${monthName}&year=${utcYear}`);

    if (!nomData.nominees || nomData.nominees.length === 0) {
      return res.status(200).json({
        synced: false,
        reason: nomData.reason || 'no_nominees',
        season_id: seasonId,
        month: monthName
      });
    }

    const nomineeSlugs = new Set(nomData.nominees.map(n => n.slug.toLowerCase()));

    // 2. Fetch our open KYMRACE markets for this season
    const mktsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/labs_markets?market_type=eq.KYMRACE&status=eq.OPEN&season_id=eq.${seasonId}&select=id,kym_slug,coin_name,coin_image`,
      { headers }
    );
    if (!mktsRes.ok) {
      return res.status(500).json({ error: 'DB query failed', status: mktsRes.status });
    }
    const ourMarkets = await mktsRes.json();
    const ourSlugs = new Set(ourMarkets.map(m => m.kym_slug?.toLowerCase()).filter(Boolean));

    // 3. Create markets for finalists we're missing
    const missing = nomData.nominees.filter(n => !ourSlugs.has(n.slug.toLowerCase()));
    let created = 0;
    for (const nom of missing) {
      // Fetch image from KYM meme page (nominees only have name + slug)
      const imageUrl = nom.image || await fetchKymImage(nom.slug);
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/labs_create_kymrace_system`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_meme_name: nom.name,
          p_kym_slug: nom.slug,
          p_image_url: imageUrl,
          p_liquidity: DEFAULT_LIQUIDITY
        })
      });
      if (rpcRes.ok) {
        const data = await rpcRes.json();
        const result = typeof data === 'string' ? JSON.parse(data) : data;
        if (result?.success) created++;
      }
    }

    // 4. Find markets for memes NOT in the finalist poll
    const nonFinalists = ourMarkets.filter(m =>
      m.kym_slug && !nomineeSlugs.has(m.kym_slug.toLowerCase())
    );

    const preview = {
      season_id: seasonId,
      month: monthName,
      nominees_count: nomData.nominees.length,
      our_markets_count: ourMarkets.length,
      created_missing: created,
      missing_finalists: missing.map(n => n.slug),
      non_finalists_count: nonFinalists.length,
      non_finalists: nonFinalists.map(m => ({ id: m.id, slug: m.kym_slug, name: m.coin_name })),
    };

    // 5. If execute mode: resolve non-finalist markets as NO
    if (shouldExecute && nonFinalists.length > 0) {
      let resolved = 0;
      for (const m of nonFinalists) {
        // Resolve as NO (result = 'NO', status = 'RES')
        const upRes = await fetch(
          `${SUPABASE_URL}/rest/v1/labs_markets?id=eq.${encodeURIComponent(m.id)}`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'RES', result: 'NO' })
          }
        );
        if (upRes.ok) resolved++;
      }
      preview.resolved_as_no = resolved;
      preview.mode = 'executed';

      if (DISCORD_WEBHOOK_URL) {
        try {
          await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `✅ **Poll Sync Executed — ${monthName} ${utcYear}**\n${resolved} non-finalist markets resolved as NO.\n${created} missing finalist markets created.`
            })
          });
        } catch (_) {}
      }

      return res.status(200).json(preview);
    }

    // 6. Preview mode: notify Discord with what would happen
    if (nonFinalists.length > 0 || created > 0) {
      const executeUrl = `https://labs.meme.com/api/kym-poll-sync?execute=true&key=${RESOLVE_SECRET}`;

      if (DISCORD_WEBHOOK_URL) {
        const nonFinalistList = nonFinalists.length > 0
          ? nonFinalists.map(m => `• ${m.name} (\`${m.kym_slug}\`)`).join('\n')
          : '_None_';

        try {
          await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `📋 **MOTM Poll Detected — ${monthName} ${utcYear}**\n\n**${nomData.nominees.length} finalists** in KYM poll\n**${created} markets created** for missing finalists\n**${nonFinalists.length} markets to resolve as NO** (not in poll):\n${nonFinalistList}\n\n**[👉 Execute Resolution](${executeUrl})**`
            })
          });
        } catch (_) {}
      }

      preview.mode = 'preview';
      preview.execute_url = `https://labs.meme.com/api/kym-poll-sync?execute=true&key=${RESOLVE_SECRET}`;
    }

    return res.status(200).json(preview);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
