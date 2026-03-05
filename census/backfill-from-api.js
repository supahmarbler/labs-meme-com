/**
 * One-time backfill: Pre-populate all users' holdings from meme.com API.
 *
 * Calls GET /farm/get_user_coins for each active user, maps LEVEL_1/2/3 to
 * BRONZE/SILVER/GOLD, saves via labs_save_census RPC.
 *
 * After this, users see their inventory immediately. They can later click
 * "SCAN NOW" for fresh on-chain data (replaces API-derived data).
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_... node backfill-from-api.js
 *   SUPABASE_ACCESS_TOKEN=sbp_... node backfill-from-api.js --dev  (for dev DB)
 */

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: SUPABASE_ACCESS_TOKEN required"); process.exit(1); }

const isDev = process.argv.includes("--dev");
const PROJECT = isDev ? "vnteehkwrygodkljfwyp" : "csvegolcvwuwssoefxdh";
const ENV = isDev ? "DEV" : "PROD";

const MEME_API = "https://api.v2.meme.com";

const LEVEL_TO_TIER = { LEVEL_1: "BRONZE", LEVEL_2: "SILVER", LEVEL_3: "GOLD" };
const TIER_USD = { BRONZE: 100, SILVER: 1000, GOLD: 10000 };

async function runQuery(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// coin_key → ticker symbol (covers all arena + battle coins + common memes)
const KEY_TO_SYMBOL = {
  // Arena coins
  "joe-coin": "JOE", "stonks-4": "STNK", "pepe": "PEPE", "mog-coin": "MOG",
  // Battle pool + common memes
  "pudgy-penguins": "PENGU", "dog-go-to-the-moon": "DOG", "pain": "PAIN",
  "bonk": "BONK", "rekt-2": "REKT", "rekt-4": "REKT", "elonrwa": "ELONRWA",
  "harrypotterobamasonic10inu-2-0": "BITCOIN", "harrypotterobamasonic10in": "BITCOIN",
  "apu-apustaja": "APU", "spx6900": "SPX", "official-trump": "TRUMP",
  "toshi": "TOSHI", "ponke": "PONKE", "gigachad-2": "GIGA", "fartcoin": "FARTCOIN",
  "bobo": "BOBO", "mister-miggles": "MIGGLES", "the-balkan-dwarf": "KEKEC",
  "shiba-inu": "SHIB", "cult-dao": "CULT", "troll-2": "TROLL", "popcat": "POPCAT",
  "wojak": "WOJAK", "cat-in-a-dogs-world": "MEW", "mumu-the-bull-3": "MUMU",
  "turbo": "TURBO", "based-brett": "BRETT", "retardio": "RETARDIO",
  "dolan-duck": "DOLAN", "dogwifhat": "WIF", "dogwifcoin": "WIF",
  "non-playable-coin": "NPC", "keyboard-cat": "KEYCAT",
  "dogecoin": "DOGE", "floki": "FLOKI", "elizaos": "ELIZAOS",
  "skibidi-toilet": "SKIBIDI", "unicorn-meat": "UNICORN",
  "feisty-doge-nft": "FEISTY", "guacamole": "GUAC",
};

function deriveSymbol(coinName, coinKey) {
  // Exact match on coin_key
  if (coinKey && KEY_TO_SYMBOL[coinKey]) return KEY_TO_SYMBOL[coinKey];
  // Partial match: try prefix (handles "rekt-4" matching "rekt")
  if (coinKey) {
    const prefix = coinKey.split("-")[0];
    for (const [k, v] of Object.entries(KEY_TO_SYMBOL)) {
      if (k.startsWith(prefix + "-") || k === prefix) return v;
    }
  }
  if (!coinName && !coinKey) return "?";
  // Fallback: first word of name, uppercase
  if (coinName) {
    const first = coinName.split(/[\s(]/)[0].toUpperCase();
    if (first.length <= 8) return first;
    return first.substring(0, 6);
  }
  return (coinKey || "").split("-")[0].toUpperCase();
}

function escapeSQL(str) {
  return str.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

async function main() {
  console.log(`=== Backfill Holdings from meme.com API [${ENV}] ===`);

  // Get all meme-* users
  const users = await runQuery(
    "SELECT id FROM labs_users WHERE id LIKE 'meme-%' ORDER BY id;"
  );
  console.log(`Found ${users.length} users to backfill`);

  let success = 0, skipped = 0, failed = 0, totalHoldings = 0;

  for (let i = 0; i < users.length; i++) {
    const userId = users[i].id;
    const memeId = userId.replace("meme-", "");

    try {
      // Fetch holdings from meme.com API
      const res = await fetch(`${MEME_API}/farm/get_user_coins?meme_user_id=${memeId}`);
      if (!res.ok) {
        skipped++;
        continue;
      }
      const data = await res.json();
      const balances = data.coin_balances || [];

      if (balances.length === 0) {
        skipped++;
        continue;
      }

      // Map to holdings format
      const holdings = balances
        .filter((c) => c.user_coin_balance_level)
        .map((c) => {
          const tier = LEVEL_TO_TIER[c.user_coin_balance_level] || "BRONZE";
          return {
            coin_symbol: deriveSymbol(c.coin_name, c.coin_key),
            coin_name: c.coin_name || c.coin_key || "",
            coin_image: c.coin_image_url || "",
            wallet_address: "api",
            chain: "API",
            token_balance: 0,
            usd_value: TIER_USD[tier],
            tier,
          };
        });

      if (holdings.length === 0) {
        skipped++;
        continue;
      }

      // Save via labs_save_census RPC (atomic: DELETE old → INSERT new → UPDATE last_census_at)
      const holdingsJson = escapeSQL(JSON.stringify(holdings));
      await runQuery(
        `SELECT labs_save_census('${escapeSQL(userId)}', '${holdingsJson}'::jsonb);`
      );

      totalHoldings += holdings.length;
      success++;

      if (success % 50 === 0 || i === users.length - 1) {
        console.log(
          `  [${i + 1}/${users.length}] ${success} users backfilled, ${totalHoldings} holdings, ${skipped} skipped`
        );
      }

      // Rate limit: ~3 req/sec (meme.com API has 1h cache, so these are cheap)
      await new Promise((r) => setTimeout(r, 350));
    } catch (e) {
      console.error(`  FAIL ${userId}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Success: ${success} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log(`Total holdings saved: ${totalHoldings}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
