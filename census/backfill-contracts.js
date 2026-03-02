/**
 * Backfill contract addresses for coins missing them.
 * Fetches from CoinGecko one at a time with rate limit delays.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node backfill-contracts.js
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

  // Get coins missing contracts
  const { data: coins, error } = await supabase
    .from("labs_coins")
    .select("symbol, coingecko_id")
    .eq("active", true)
    .is("evm_contract", null)
    .is("solana_mint", null);

  if (error) { console.error(error.message); process.exit(1); }
  console.log(`${coins.length} coins need contracts`);

  let updated = 0;
  let failed = 0;

  for (const coin of coins) {
    await new Promise(r => setTimeout(r, 6500)); // Conservative rate limit

    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coin.coingecko_id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`
      );

      if (res.status === 429) {
        console.log(`  ${coin.symbol}: rate limited, waiting 60s...`);
        await new Promise(r => setTimeout(r, 60000));
        failed++;
        continue;
      }

      if (!res.ok) {
        console.log(`  ${coin.symbol}: ${res.status} (${coin.coingecko_id}), skipping`);
        failed++;
        continue;
      }

      const data = await res.json();
      const platforms = data.detail_platforms || {};

      const update = {};
      for (const [platform, info] of Object.entries(platforms)) {
        if (!info?.contract_address) continue;
        if (EVM_PLATFORMS.includes(platform) && !update.evm_contract) {
          update.evm_contract = info.contract_address;
          update.evm_decimals = info.decimal_place ?? 18;
          update.evm_platform = platform;
        }
        if (platform === "solana" && !update.solana_mint) {
          update.solana_mint = info.contract_address;
          update.solana_decimals = info.decimal_place ?? 9;
        }
      }

      if (Object.keys(update).length > 0) {
        const { error: upErr } = await supabase
          .from("labs_coins")
          .update(update)
          .eq("symbol", coin.symbol);
        if (upErr) {
          console.log(`  ${coin.symbol}: DB error: ${upErr.message}`);
        } else {
          const chains = [update.evm_contract && "EVM", update.solana_mint && "SOL"].filter(Boolean).join("+");
          console.log(`  ${coin.symbol}: ${chains}`);
          updated++;
        }
      } else {
        console.log(`  ${coin.symbol}: no contracts found`);
      }
    } catch (err) {
      console.log(`  ${coin.symbol}: ${err.message}`);
      failed++;
    }
  }

  console.log(`Done. Updated ${updated}, failed/skipped ${failed}, no-contracts ${coins.length - updated - failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
