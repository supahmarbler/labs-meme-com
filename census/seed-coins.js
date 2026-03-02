/**
 * One-time seed: populate labs_coins with contract addresses from CoinGecko.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node seed-coins.js
 *
 * Safe to re-run — upserts by symbol.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// All coins on the meme.com leaderboard with their CoinGecko IDs + images
const COINS = [
  { symbol: "PEPE", name: "Pepe", coingecko_id: "pepe", image: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779740059DXOD.png" },
  { symbol: "MOG", name: "Mog Coin", coingecko_id: "mog-coin", image: "https://cdn.meme.com/images/meme_assets/2024-04-15/1713170597024m28Z.png" },
  { symbol: "JOE", name: "Joe Coin", coingecko_id: "joe-coin", image: "https://cdn.meme.com/images/meme_assets/2025-07-16/1752687196279dnFN.png" },
  { symbol: "STNK", name: "Stonks", coingecko_id: "stonks-4", image: "https://cdn.meme.com/images/meme_assets/2025-10-24/17613344323935piQ.png" },
  { symbol: "DOGE", name: "Dogecoin", coingecko_id: "dogecoin", image: "https://cdn.meme.com/images-4/meme_assets/2024-11-08/1731078819010sFOw.png" },
  { symbol: "SHIB", name: "Shiba Inu", coingecko_id: "shiba-inu", image: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779796043iIxj.png" },
  { symbol: "BONK", name: "Bonk", coingecko_id: "bonk", image: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779886770nxKq.png" },
  { symbol: "WIF", name: "dogwifhat", coingecko_id: "dogwifcoin", image: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779875476rS8D.png" },
  { symbol: "FLOKI", name: "Floki", coingecko_id: "floki", image: "https://cdn.meme.com/images/meme_assets/2024-04-10/17127798105730G6W.png" },
  { symbol: "PENGU", name: "Pudgy Penguins", coingecko_id: "pudgy-penguins", image: "https://cdn.meme.com/images-4/meme_assets/2024-12-17/1734446159208EJOa.png" },
];

const EVM_PLATFORMS = [
  "ethereum", "base", "arbitrum-one", "optimistic-ethereum",
  "polygon-pos", "avalanche", "binance-smart-chain",
];

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY required");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  for (const coin of COINS) {
    console.log(`Fetching ${coin.symbol} (${coin.coingecko_id})...`);

    let row = {
      symbol: coin.symbol,
      name: coin.name,
      image: coin.image,
      coingecko_id: coin.coingecko_id,
      active: true,
    };

    try {
      // Respect CoinGecko rate limits
      await new Promise((r) => setTimeout(r, 2500));

      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coin.coingecko_id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();

      const platforms = data.detail_platforms || {};
      for (const [platform, info] of Object.entries(platforms)) {
        if (!info?.contract_address) continue;

        if (EVM_PLATFORMS.includes(platform) && !row.evm_contract) {
          row.evm_contract = info.contract_address;
          row.evm_decimals = info.decimal_place ?? 18;
          row.evm_platform = platform;
          console.log(`  EVM (${platform}): ${info.contract_address}`);
        }

        if (platform === "solana" && !row.solana_mint) {
          row.solana_mint = info.contract_address;
          row.solana_decimals = info.decimal_place ?? 9;
          console.log(`  Solana: ${info.contract_address}`);
        }
      }
    } catch (err) {
      console.warn(`  CoinGecko failed: ${err.message}, saving without contracts`);
    }

    const { error } = await supabase
      .from("labs_coins")
      .upsert(row, { onConflict: "symbol" });

    if (error) {
      console.error(`  DB error: ${error.message}`);
    } else {
      console.log(`  Saved ${coin.symbol}`);
    }
  }

  console.log("Done. Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
