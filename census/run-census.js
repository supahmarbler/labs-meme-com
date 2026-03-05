/**
 * DEPRECATED — Batch census replaced by per-user on-demand scanning.
 *
 * Scanning 26k wallets doesn't work with free RPCs. Instead, each user scans
 * their own 1-3 wallets via a "SCAN NOW" button in the profile popup.
 * See: app.jsx runWalletCensus() + migration-per-user-census.sql
 *
 * Keeping this file for reference. Do not delete yet.
 *
 * --- Original description ---
 * Weekly On-Chain Census for Memecoin Arena
 *
 * Pipeline: Load coins (Supabase) → Fetch prices (CoinGecko) → Scan EVM → Scan Solana → Write
 *
 * Coin metadata + contract addresses live in labs_coins table (seeded once).
 * Only CoinGecko /simple/price is called at runtime — one request for all coins.
 *
 * Phase 1: Hardcoded wallets (Johan's). Phase 2 adds all users from meme-api-v2.
 */

import { createClient } from "@supabase/supabase-js";
import { Contract, Interface, JsonRpcProvider } from "ethers";
import pg from "pg";

// --- Config ---

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MEME_DB_URL = process.env.MEME_DB_URL;
const EVM_RPCS = {
  ethereum: process.env.EVM_RPC_URL || "https://eth.llamarpc.com",
  base: process.env.BASE_RPC_URL || "https://base.llamarpc.com",
};
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Fallback for local testing without meme-api-v2 DB
const FALLBACK_USER_ID = "meme-6";
const FALLBACK_WALLETS = {
  EVM: ["0x69Ed24795649c23F9C13BFE317432fe0e679f1F6"],
  SOLANA: ["Azk7B3EE5mFhPNBm6dMQ1LCqpnVDT2vL6sgyuCYEug3t"],
};

// Tier thresholds (USD) — matches meme.com farming_config
const TIERS = [
  { name: "GOLD", min: 10000 },
  { name: "SILVER", min: 1000 },
  { name: "BRONZE", min: 100 },
];

// Multicall3 address (same on all EVM chains)
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// ERC20 ABI fragment for balanceOf
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// --- Helpers ---

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function fatal(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function getTier(usdValue) {
  for (const t of TIERS) {
    if (usdValue >= t.min) return t.name;
  }
  return null; // Below minimum, skip
}

// --- Step 0: Gather wallets ---

async function gatherWallets(supabase) {
  // Priority 1: Direct meme-api-v2 DB connection (has freshest data)
  if (MEME_DB_URL) {
    log("WALLETS", "Querying meme-api-v2 wallet table...");
    const pool = new pg.Pool({ connectionString: MEME_DB_URL, max: 2 });

    try {
      const { rows } = await pool.query(
        "SELECT wallet_address, wallet_type, meme_user_id FROM wallet WHERE meme_user_id IS NOT NULL"
      );
      return buildWalletResult(rows.map((r) => ({
        wallet_address: r.wallet_address,
        chain: r.wallet_type?.toUpperCase() === "SOL" ? "SOLANA" : r.wallet_type?.toUpperCase(),
        user_id: `meme-${r.meme_user_id}`,
      })));
    } finally {
      await pool.end();
    }
  }

  // Priority 2: Supabase labs_user_wallets table (snapshot from dump)
  if (supabase) {
    log("WALLETS", "Querying labs_user_wallets from Supabase...");
    const allRows = [];
    const PAGE = 1000;
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("labs_user_wallets")
        .select("user_id, wallet_address, chain")
        .range(from, from + PAGE - 1);

      if (error) fatal(`Failed to query labs_user_wallets: ${error.message}`);
      if (!data || data.length === 0) break;
      allRows.push(...data);
      hasMore = data.length === PAGE;
      from += PAGE;
    }

    if (allRows.length > 0) {
      return buildWalletResult(allRows);
    }
    log("WALLETS", "labs_user_wallets is empty, falling through to fallback");
  }

  // Priority 3: Hardcoded fallback for local testing
  log("WALLETS", "Using fallback wallets");
  const walletToUser = new Map();
  for (const addr of FALLBACK_WALLETS.EVM) {
    walletToUser.set(addr.toLowerCase(), FALLBACK_USER_ID);
  }
  for (const addr of FALLBACK_WALLETS.SOLANA) {
    walletToUser.set(addr, FALLBACK_USER_ID);
  }
  return {
    evmWallets: FALLBACK_WALLETS.EVM,
    solanaWallets: FALLBACK_WALLETS.SOLANA,
    walletToUser,
  };
}

function buildWalletResult(rows) {
  const evmWallets = [];
  const solanaWallets = [];
  const walletToUser = new Map();

  for (const row of rows) {
    const userId = row.user_id;
    const addr = row.wallet_address;
    const chain = row.chain?.toUpperCase();

    if (chain === "SOLANA") {
      solanaWallets.push(addr);
      walletToUser.set(addr, userId);
    } else {
      evmWallets.push(addr);
      walletToUser.set(addr.toLowerCase(), userId);
    }
  }

  log(
    "WALLETS",
    `Found ${evmWallets.length} EVM + ${solanaWallets.length} Solana wallets across ${new Set([...walletToUser.values()]).size} users`
  );
  return { evmWallets, solanaWallets, walletToUser };
}

// --- Step 0b: Ensure users exist in labs_users ---

async function ensureUsersExist(supabase, userIds) {
  if (userIds.length === 0) return;

  log("USERS", `Ensuring ${userIds.length} users exist in labs_users...`);
  const BATCH = 500;
  let upserted = 0;

  for (let i = 0; i < userIds.length; i += BATCH) {
    const batch = userIds.slice(i, i + BATCH);
    const rows = batch.map((id) => ({ user_id: id, labs_balance: 0 }));

    const { error } = await supabase
      .from("labs_users")
      .upsert(rows, { onConflict: "user_id", ignoreDuplicates: true });

    if (error) {
      log("USERS", `  Batch ${Math.floor(i / BATCH) + 1} failed: ${error.message}`);
    } else {
      upserted += batch.length;
    }
  }

  log("USERS", `Ensured ${upserted}/${userIds.length} users exist`);
}

// --- Step 1: Load coins from Supabase + fetch prices ---

async function loadCoins(supabase) {
  log("COINS", "Loading coins from labs_coins...");

  const { data, error } = await supabase
    .from("labs_coins")
    .select("*")
    .eq("active", true);

  if (error) fatal(`Failed to load coins: ${error.message}`);
  if (!data || data.length === 0) fatal("No active coins in labs_coins table");

  log("COINS", `Loaded ${data.length} active coins`);

  // Fetch prices from CoinGecko in one batch call
  const cgIds = data.map((c) => c.coingecko_id).join(",");
  log("COINS", `Fetching prices from CoinGecko for: ${cgIds}`);

  let prices = {};
  try {
    const priceData = await fetchJSON(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`
    );
    prices = priceData;
  } catch (err) {
    fatal(`CoinGecko price fetch failed: ${err.message}`);
  }

  // Build coin objects for scanning
  const coins = [];
  for (const row of data) {
    const price = prices[row.coingecko_id]?.usd || 0;
    if (price === 0) {
      log("COINS", `  ${row.symbol}: no price, skipping`);
      continue;
    }

    const contracts = {};
    if (row.evm_contract) {
      contracts.EVM = {
        address: row.evm_contract,
        decimals: row.evm_decimals || 18,
        platform: row.evm_platform || "ethereum",
      };
    }
    if (row.solana_mint) {
      contracts.SOLANA = {
        address: row.solana_mint,
        decimals: row.solana_decimals || 9,
      };
    }

    if (Object.keys(contracts).length === 0) {
      log("COINS", `  ${row.symbol}: no contracts, skipping`);
      continue;
    }

    coins.push({
      symbol: row.symbol,
      name: row.name,
      image: row.image,
      coingeckoId: row.coingecko_id,
      contracts,
      price,
    });

    const chains = Object.keys(contracts).join(", ");
    log("COINS", `  ${row.symbol}: $${price.toFixed(6)}, chains: ${chains}`);
  }

  log("COINS", `${coins.length} coins ready to scan`);
  return coins;
}

// --- Step 2: Scan EVM ---

async function scanEVM(coins, wallets) {
  const evmCoins = coins.filter((c) => c.contracts.EVM);
  if (evmCoins.length === 0 || wallets.length === 0) {
    log("EVM", "No EVM coins or wallets to scan");
    return [];
  }

  // Group coins by platform (ethereum, base, etc.)
  const byChain = {};
  for (const coin of evmCoins) {
    const platform = coin.contracts.EVM.platform;
    if (!byChain[platform]) byChain[platform] = [];
    byChain[platform].push(coin);
  }

  const iface = new Interface(ERC20_ABI);
  const results = [];

  for (const [platform, chainCoins] of Object.entries(byChain)) {
    const rpcUrl = EVM_RPCS[platform];
    if (!rpcUrl) {
      log("EVM", `No RPC for ${platform} (${chainCoins.length} coins), skipping`);
      continue;
    }

    log("EVM", `Scanning ${platform}: ${chainCoins.length} tokens across ${wallets.length} wallets...`);

    const provider = new JsonRpcProvider(rpcUrl);
    const multicall = new Contract(
      MULTICALL3,
      ["function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])"],
      provider
    );

    const calls = [];
    const callMeta = [];

    for (const coin of chainCoins) {
      const { address } = coin.contracts.EVM;
      for (const wallet of wallets) {
        calls.push({
          target: address,
          allowFailure: true,
          callData: iface.encodeFunctionData("balanceOf", [wallet]),
        });
        callMeta.push({ coin, wallet });
      }
    }

    const CHUNK = 200;
    const totalChunks = Math.ceil(calls.length / CHUNK);
    for (let i = 0; i < calls.length; i += CHUNK) {
      const chunk = calls.slice(i, i + CHUNK);
      const meta = callMeta.slice(i, i + CHUNK);
      const chunkNum = Math.floor(i / CHUNK) + 1;

      // Rate limit: 150ms between chunks to avoid RPC throttling
      if (i > 0) await new Promise((r) => setTimeout(r, 150));

      try {
        const response = await multicall.aggregate3(chunk);

        for (let j = 0; j < response.length; j++) {
          const [success, returnData] = response[j];
          if (!success || returnData === "0x") continue;

          const { coin, wallet } = meta[j];
          try {
            const [balance] = iface.decodeFunctionResult("balanceOf", returnData);
            const decimals = coin.contracts.EVM.decimals;
            const tokenBalance = Number(balance) / 10 ** decimals;
            const usdValue = tokenBalance * coin.price;
            const tier = getTier(usdValue);

            if (tier) {
              results.push({ coin, wallet, chain: "EVM", tokenBalance, usdValue, tier });
              log("EVM", `  ${coin.symbol}: ${tokenBalance.toFixed(2)} tokens ($${usdValue.toFixed(2)}) → ${tier}`);
            }
          } catch {
            // Decode error, skip
          }
        }
      } catch (err) {
        log("EVM", `  ${platform} multicall chunk ${chunkNum}/${totalChunks} failed: ${err.message}, skipping`);
      }

      if (chunkNum % 100 === 0) {
        log("EVM", `  ${platform}: ${chunkNum}/${totalChunks} chunks processed`);
      }
    }
  }

  log("EVM", `Found ${results.length} holdings above threshold`);
  return results;
}

// --- Step 3: Scan Solana ---

async function scanSolana(coins, wallets) {
  const solCoins = coins.filter((c) => c.contracts.SOLANA);
  if (solCoins.length === 0 || wallets.length === 0) {
    log("SOLANA", "No Solana coins or wallets to scan");
    return [];
  }

  log(
    "SOLANA",
    `Scanning ${solCoins.length} tokens across ${wallets.length} wallets...`
  );

  // Build mint→coin lookup
  const mintMap = {};
  for (const coin of solCoins) {
    mintMap[coin.contracts.SOLANA.address] = coin;
  }

  const results = [];

  for (let wi = 0; wi < wallets.length; wi++) {
    const wallet = wallets[wi];

    // Rate limit: 1 RPC call per wallet, ~4 req/s to stay under public RPC limits
    if (wi > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (wi > 0 && wi % 500 === 0) {
      log("SOLANA", `  Progress: ${wi}/${wallets.length} wallets scanned`);
    }

    try {
      const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

      const res = await fetch(SOLANA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            wallet,
            { programId: TOKEN_PROGRAM },
            { encoding: "jsonParsed" },
          ],
        }),
      });

      const data = await res.json();
      if (data.error) {
        log("SOLANA", `  RPC error for ${wallet}: ${data.error.message}`);
        continue;
      }

      const accounts = data.result?.value || [];
      for (const acct of accounts) {
        const info = acct.account?.data?.parsed?.info;
        if (!info) continue;

        const mint = info.mint;
        const coin = mintMap[mint];
        if (!coin) continue;

        const tokenBalance = Number(info.tokenAmount?.uiAmount || 0);
        const usdValue = tokenBalance * coin.price;
        const tier = getTier(usdValue);

        if (tier) {
          results.push({ coin, wallet, chain: "SOLANA", tokenBalance, usdValue, tier });
          log(
            "SOLANA",
            `  ${coin.symbol}: ${tokenBalance.toFixed(2)} tokens ($${usdValue.toFixed(2)}) → ${tier}`
          );
        }
      }
    } catch (err) {
      log(
        "SOLANA",
        `  Wallet ${wallet} scan failed: ${err.message}, skipping`
      );
    }
  }

  log("SOLANA", `Found ${results.length} holdings above threshold`);
  return results;
}

// --- Step 4: Write to Supabase ---

async function writeHoldings(supabase, holdings, walletToUser, censusAt) {
  if (holdings.length === 0) {
    log("WRITE", "No holdings to write");
    return;
  }

  log("WRITE", `Writing ${holdings.length} holdings to Supabase...`);

  const rows = holdings.map((h) => {
    const key =
      h.chain === "EVM" ? h.wallet.toLowerCase() : h.wallet;
    return {
      user_id: walletToUser.get(key),
      coin_symbol: h.coin.symbol,
      coin_name: h.coin.name,
      coin_image: h.coin.image,
      wallet_address: h.wallet,
      chain: h.chain,
      token_balance: h.tokenBalance,
      usd_value: h.usdValue,
      tier: h.tier,
      census_at: censusAt,
    };
  });

  // Upsert in batches of 100
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from("labs_user_holdings").upsert(batch, {
      onConflict: "user_id,coin_symbol,wallet_address,census_at",
    });

    if (error) {
      log("WRITE", `  Batch ${i / BATCH + 1} failed: ${error.message}`);
    } else {
      log("WRITE", `  Batch ${i / BATCH + 1}: ${batch.length} rows upserted`);
    }
  }
}

// --- Main ---

async function main() {
  console.log("=== Memecoin Arena Weekly Census ===");
  console.log(`Time: ${new Date().toISOString()}`);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    fatal("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const censusAt = new Date().toISOString();

  // Step 0: Gather wallets (DB → Supabase → fallback)
  const { evmWallets, solanaWallets, walletToUser } = await gatherWallets(supabase);

  // Step 1: Load coins from DB + fetch prices (1 CoinGecko call)
  const coins = await loadCoins(supabase);
  if (coins.length === 0) {
    log("DONE", "No coins to scan, exiting");
    return;
  }

  // Step 2 & 3: Scan wallets (EVM + Solana in parallel)
  const [evmHoldings, solHoldings] = await Promise.all([
    scanEVM(coins, evmWallets),
    scanSolana(coins, solanaWallets),
  ]);

  const allHoldings = [...evmHoldings, ...solHoldings];
  log(
    "SCAN",
    `Total: ${allHoldings.length} holdings (${evmHoldings.length} EVM, ${solHoldings.length} Solana)`
  );

  // Step 3b: Ensure all discovered users exist in labs_users
  const userIds = [...new Set(walletToUser.values())];
  await ensureUsersExist(supabase, userIds);

  // Step 4: Write to Supabase
  await writeHoldings(supabase, allHoldings, walletToUser, censusAt);

  log("DONE", `Census complete. ${allHoldings.length} holdings recorded for ${userIds.length} users.`);
}

main().catch((err) => {
  console.error("Census failed:", err);
  process.exit(1);
});
