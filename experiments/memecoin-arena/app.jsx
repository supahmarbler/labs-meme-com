const { useState, useEffect, useCallback, useRef, useMemo } = React;

// Mobile detection hook
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1000);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1000);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return isMobile;
};

// Supabase client — prod on labs.meme.com, dev everywhere else
const isProd = window.location.hostname === "labs.meme.com";
const SUPABASE_URL = isProd
  ? "https://csvegolcvwuwssoefxdh.supabase.co"
  : "https://vnteehkwrygodkljfwyp.supabase.co";
const SUPABASE_KEY = isProd
  ? "sb_publishable_Qf1O75YbEeBE2qwg4ThmwA_Uxpw9BG4"
  : "sb_publishable_q_M1tOOvwhHnt4x2mgZH8Q_L3FQwgXn";
const supabase = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);

// meme.com API base
const MEME_API = "https://api.v2.meme.com";

// Read meme.com auth token: cookie first, localStorage fallback
const getMemeAuth = () => {
  try {
    // Try cookie first (fresh from meme.com)
    const cookies = document.cookie.split("; ");
    const authCookie = cookies.find(c => c.startsWith("meme_auth_account="));
    if (authCookie) {
      const token = decodeURIComponent(authCookie.substring(authCookie.indexOf("=") + 1));
      if (token) {
        // Cache to localStorage so it survives cookie expiry
        localStorage.setItem("labs_auth_token", token);
        return { token };
      }
    }
    // Fallback to cached token
    const cached = localStorage.getItem("labs_auth_token");
    return cached ? { token: cached } : null;
  } catch (e) {
    return null;
  }
};

const clearCachedAuth = () => {
  try { localStorage.removeItem("labs_auth_token"); } catch (e) {}
};

// Fetch user profile from meme.com API
const fetchMemeUser = async (authToken) => {
  try {
    const res = await fetch(`${MEME_API}/user/private_user_detail`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      id: data.user_id,
      username: data.username,
      image: data.profile_image_url,
      wallets: data.wallets || []
    };
  } catch (e) {
    console.log("Failed to fetch meme user:", e);
    return null;
  }
};

// Fetch labs balance from meme.com API
const fetchLabsBalance = async (authToken) => {
  try {
    const res = await fetch(`${MEME_API}/labs/balance`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return { labsBalance: 0, memescore: 0 };
    const data = await res.json();
    return {
      labsBalance: data.labs_balance || 0,
      memescore: data.memescore || 0
    };
  } catch (e) {
    console.log("Failed to fetch labs balance:", e);
    return { labsBalance: 0, memescore: 0 };
  }
};

// Fetch daily treasure chest quest from meme.com farming quests
const fetchChestQuest = async (authToken) => {
  try {
    const res = await fetch(`${MEME_API}/farming-quests/list_available`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Response is grouped: available_quests, in_progress_quests, claimable_quests, completed_quests
    const allQuests = [
      ...(data.available_quests || []),
      ...(data.in_progress_quests || []),
      ...(data.claimable_quests || []),
      ...(data.completed_quests || [])
    ];
    const quest = allQuests.find(q => q.quest_type === "TREASURE_CHEST");
    if (!quest) return null;
    // Mark whether it's in the available list (ready to claim)
    quest._isAvailable = (data.available_quests || []).some(q => q.quest_type === "TREASURE_CHEST");
    return quest;
  } catch (e) {
    console.log("Failed to fetch chest quest:", e);
    return null;
  }
};

// Claim daily treasure chest (chestIndex = 0, 1, or 2)
const claimChest = async (authToken, questId, chestIndex = 0) => {
  try {
    const res = await fetch(`${MEME_API}/farming-quests/finish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify({
        quest_id: questId,
        quest_input_params: { "treasure-chest": chestIndex }
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Claim failed");
    }
    const data = await res.json();
    return data;
  } catch (e) {
    console.error("Chest claim failed:", e);
    return null;
  }
};

// Get user ID - use meme.com userId if logged in, otherwise generate anonymous
const getUserId = (memeUserId) => {
  if (memeUserId) {
    // Use meme.com user ID as UUID format for consistency
    return `meme-${memeUserId}`;
  }
  // Fallback to anonymous (will be blocked from playing)
  let id = localStorage.getItem("labs_user_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("labs_user_id", id);
  }
  return id;
};

// Persistence helpers (localStorage fallback + Supabase sync)
const STORAGE_KEY = "labs_arena_v1";

const loadState = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) { console.error("Load failed:", e); }
  return null;
};

const saveState = (state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { console.error("Save failed:", e); }
};

// Supabase market sync with retry (upsert to handle new rounds)
const syncMarketToDb = async (m, retries = 2) => {
  if (!supabase) return false;
  try {
    const payload = {
      id: m.id,
      coin_symbol: m.c.sym,
      coin_name: m.c.name,
      coin_image: m.c.img,
      coin_color: m.c.color,
      current_mc: m.mc,
      b: m.b,
      q_yes: Math.max(0, m.qY - m.b),
      q_no: Math.max(0, m.qN - m.b),
      status: m.st,
      result: m.res,
      volume: m.vol,
      players: m.ppl,
      fee_pool: m.fp || 0,
      expires_at: new Date(m.ea).toISOString(),
      price_updated_at: new Date().toISOString(),
      ...(m.type === "BATTLE" ? {
        market_type: "BATTLE",
        coin_b_symbol: m.cB.sym,
        coin_b_name: m.cB.name,
        coin_b_image: m.cB.img,
        coin_b_color: m.cB.color,
        start_mc_b: m.startMcB,
        current_mc_b: m.mcB
      } : {})
    };
    const { error } = await supabase
      .from("labs_markets")
      .upsert(payload, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.error("Market sync error:", error, "market:", m.id, "payload:", payload);
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 500));
        return syncMarketToDb(m, retries - 1);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error("Market sync failed:", e);
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return syncMarketToDb(m, retries - 1);
    }
    return false;
  }
};

const loadMarketsFromDb = async (includeResolved = false) => {
  if (!supabase) return null;
  try {
    let query = supabase.from("labs_markets").select("*");
    if (!includeResolved) query = query.eq("status", "OPEN");
    const { data, error } = await query;
    if (error) throw error;
    // Filter out stale 5-min markets — only keep OPEN or markets expiring at 13:xx UTC
    return (data || []).filter(m => {
      if (m.status === "OPEN") return true;
      const h = new Date(m.expires_at).getUTCHours();
      return h === 13;
    });
  } catch (e) {
    console.error("Load markets failed:", e);
    return null;
  }
};

// Load per-side invested sums for open markets (for return estimates)
const loadSideInvested = async () => {
  if (!supabase) return {};
  try {
    const { data, error } = await supabase.from("labs_positions").select("market_id,side,invested");
    if (error) throw error;
    const map = {};
    (data || []).forEach(p => {
      if (!map[p.market_id]) map[p.market_id] = { YES: 0, NO: 0 };
      map[p.market_id][p.side] += Number(p.invested) || 0;
    });
    return map;
  } catch (e) { return {}; }
};

// Ensure user exists in database, update profile if available
const ensureUserInDb = async (userId, memeUser) => {
  if (!supabase) return;
  try {
    const { data: existing } = await supabase
      .from("labs_users")
      .select("id")
      .eq("id", userId)
      .single();

    if (!existing) {
      await supabase.from("labs_users").insert({
        id: userId,
        username: memeUser?.username || null,
        profile_image: memeUser?.image || null,
        labs_balance: 0,
        total_volume: 0,
        wins: 0,
        losses: 0,
        current_streak: 0,
        best_streak: 0
      });
    } else if (memeUser) {
      // Update profile image and username from meme.com
      await supabase.from("labs_users").update({
        username: memeUser.username || null,
        profile_image: memeUser.image || null
      }).eq("id", userId);
    }
  } catch (e) {
    console.log("User check:", e.message);
  }
};

// Sync user stats to database (balance is NOT synced here — only RPCs modify it)
// Uses UPDATE (not upsert) so it can never accidentally create a row with labs_balance=0
const syncUserToDb = async (userId, _totalVolume, wins, losses, streak, bestStreak) => {
  if (!supabase) return;
  try {
    // Note: total_volume is NOT synced from client — it's computed from labs_trades server-side
    // to avoid client-side state (pos+hist) overwriting the correct DB value
    await supabase.from("labs_users").update({
      wins: wins,
      losses: losses,
      current_streak: streak,
      best_streak: bestStreak,
      updated_at: new Date().toISOString()
    }).eq("id", userId);
  } catch (e) { console.error("User sync failed:", e); }
};

// Load user data from database
const loadUserFromDb = async (userId) => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("labs_users")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) throw error;
    return data;
  } catch (e) {
    console.log("User load:", e.message);
    return null;
  }
};

// Sync position to database
const syncPositionToDb = async (userId, marketId, position) => {
  if (!supabase) return;
  try {
    if (position) {
      const { error } = await supabase.from("labs_positions").upsert({
        user_id: userId,
        market_id: marketId,
        side: position.side,
        shares: position.sh,
        invested: position.inv,
        claimed: position.claimed || false
      }, { onConflict: 'user_id,market_id' });
      if (error) console.error("Position sync error:", error);
    } else {
      // Position was sold/removed
      const { error } = await supabase.from("labs_positions")
        .delete()
        .eq("user_id", userId)
        .eq("market_id", marketId);
      if (error) console.error("Position delete error:", error);
    }
  } catch (e) { console.error("Position sync failed:", e); }
};

// Load user positions from database
const loadPositionsFromDb = async (userId) => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("labs_positions")
      .select("*")
      .eq("user_id", userId);
    if (error) throw error;

    // Convert to local format
    const positions = {};
    data.forEach(p => {
      positions[p.market_id] = {
        side: p.side,
        sh: Number(p.shares),
        inv: Number(p.invested),
        claimed: p.claimed
      };
    });
    return positions;
  } catch (e) {
    console.error("Positions load failed:", e);
    return null;
  }
};

// Load all market players with profile images (for avatar display)
const loadMarketPlayersFromDb = async () => {
  if (!supabase) return {};
  try {
    const { data, error } = await supabase
      .from("labs_positions")
      .select("market_id, user_id, invested, labs_users(profile_image)")
      .order("invested", { ascending: false });
    if (error) throw error;
    const byMarket = {};
    (data || []).forEach(p => {
      if (!byMarket[p.market_id]) byMarket[p.market_id] = [];
      byMarket[p.market_id].push({
        userId: p.user_id,
        img: p.labs_users?.profile_image || null,
        inv: Number(p.invested)
      });
    });
    return byMarket;
  } catch (e) {
    console.error("Market players load failed:", e);
    return {};
  }
};

// Record trade in database
const recordTradeInDb = async (userId, marketId, coinSymbol, side, shares, amount, tradeType, result = null, pnl = null) => {
  if (!supabase) return;
  try {
    await supabase.from("labs_trades").insert({
      user_id: userId,
      market_id: marketId,
      coin_symbol: coinSymbol,
      side: side,
      shares: shares,
      amount: amount,
      trade_type: tradeType,
      result: result,
      pnl: pnl
    });
  } catch (e) { console.error("Trade record failed:", e); }
};

// Load leaderboard from database
const loadLeaderboardFromDb = async () => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("labs_users")
      .select("id, username, profile_image, labs_balance, total_volume, total_profit, wins, losses, current_streak, created_at")
      .not("username", "is", null)
      .not("username", "in", '("flashmob96","Tyrberg","mickross_","supahmarbler","tomtomtom0x")')
      .gt("total_volume", 0)
      .order("total_profit", { ascending: false })
      .limit(10);
    if (error) throw error;
    return data;
  } catch (e) {
    console.error("Leaderboard load failed:", e);
    return null;
  }
};

// Load recent market results (up to 5 per coin for form guide)
const loadMarketHistoryFromDb = async () => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("labs_markets")
      .select("id, coin_symbol, coin_image, coin_color, start_mc, current_mc, result, expires_at, volume")
      .eq("status", "RES")
      .order("expires_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    // Filter out stale 5-min test markets — only keep markets expiring at 13:xx UTC
    return (data || []).filter(m => {
      const h = new Date(m.expires_at).getUTCHours();
      return h === 13;
    });
  } catch (e) {
    console.error("History load failed:", e);
    return null;
  }
};

// Load user's recent trade history from database (claimed trades)
const loadTradeHistoryFromDb = async (userId) => {
  if (!supabase || !userId) return null;
  try {
    const { data, error } = await supabase
      .from("labs_trades")
      .select("coin_symbol, side, amount, trade_type, result, pnl")
      .eq("user_id", userId)
      .eq("trade_type", "CLAIM")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return (data || []).map(t => ({
      sym: t.coin_symbol,
      side: t.side,
      result: t.result,
      inv: t.amount,
      rw: t.pnl > 0 ? t.amount + t.pnl : 0
    }));
  } catch (e) {
    console.error("Trade history load failed:", e);
    return null;
  }
};

// Deduplicate: one OPEN market per coin (or per battle pair), keep highest round. Keep all RES with positions.
const dedup = (mks) => {
  const openByKey = {};
  const result = [];
  const dedupKey = (m) => m.type === "BATTLE" ? battlePairKey(m.c.sym, m.cB.sym) : m.c.sym;
  // First pass: find highest-round OPEN market per key
  mks.forEach(m => {
    if (m.st === "OPEN") {
      const k = dedupKey(m);
      if (!openByKey[k] || m.rn > openByKey[k].rn) openByKey[k] = m;
    }
  });
  // Second pass: keep RES markets + one OPEN per key
  const seen = new Set();
  mks.forEach(m => {
    if (m.st === "OPEN") {
      const k = dedupKey(m);
      if (openByKey[k]?.id === m.id && !seen.has(m.id)) { seen.add(m.id); result.push(m); }
    } else {
      if (!seen.has(m.id)) { seen.add(m.id); result.push(m); }
    }
  });
  return result;
};

const dbMarketToLocal = (db, coinData, coinDataB) => {
  const mcap = Number(db.current_mc) || 0;
  const b = Number(db.b) || getB(mcap);
  const base = {
    id: db.id,
    c: {
      sym: db.coin_symbol,
      name: db.coin_name,
      img: coinData?.img || db.coin_image,
      color: coinData?.color || db.coin_color,
      mcap: mcap
    },
    rn: parseInt(db.id.split("-").pop()) || 1,
    mc: mcap,
    startMc: Number(db.start_mc) || 0,
    qY: (Number(db.q_yes) || 0) + b,
    qN: (Number(db.q_no) || 0) + b,
    b: b,
    fp: Number(db.fee_pool) || 0,
    pot: Number(db.total_pot) || 0,
    wws: Number(db.winner_weight_sum) || 0,
    wis: Number(db.winner_invested_sum) || 0,
    yInv: 0, nInv: 0,
    st: db.status || "OPEN",
    res: db.result,
    vol: Number(db.volume) || 0,
    ppl: Number(db.players) || 0,
    ea: new Date(db.expires_at).getTime()
  };
  if (db.market_type === "BATTLE") {
    base.type = "BATTLE";
    base.cB = {
      sym: db.coin_b_symbol,
      name: db.coin_b_name,
      img: coinDataB?.img || db.coin_b_image,
      color: coinDataB?.color || db.coin_b_color,
      mcap: Number(db.current_mc_b) || 0
    };
    base.mcB = Number(db.current_mc_b) || 0;
    base.startMcB = Number(db.start_mc_b) || 0;
  }
  return base;
};

// meme.com API (for initial coin data)
const API_BASE = "https://api.v2.meme.com";
const COIN_SYMBOLS = ["joe", "stnk", "pepe", "mog"];
const COIN_COLORS = { joe:"#f7931a", stnk:"#84CC16", pepe:"#4ADE80", mog:"#1e3a5f" };

// CoinGecko Pro for reliable price updates
const CG_API = "https://api.coingecko.com/api/v3";
const CG_HEADERS = {};
const COINGECKO_IDS = {
  joe: "joe-coin",
  stnk: "stonks-4",
  pepe: "pepe",
  mog: "mog-coin"
};
const MEME_SLUGS = { JOE:"joe-coin", STNK:"stonks-4", PEPE:"pepe", MOG:"mog-coin" };

// Battle coins pool (33 coins, no overlap with UP/DOWN)
const BATTLE_COINS = {
  PENGU:"pudgy-penguins", DOG:"dog-go-to-the-moon", PAIN:"pain",
  BONK:"bonk", REKT:"rekt-2", ELONRWA:"elonrwa",
  BITCOIN:"harrypotterobamasonic10inu-2-0", APU:"apu-apustaja",
  SPX:"spx6900", TRUMP:"official-trump", TOSHI:"toshi",
  PONKE:"ponke", GIGA:"gigachad-2", FARTCOIN:"fartcoin",
  BOBO:"bobo", MIGGLES:"mister-miggles", KEKEC:"the-balkan-dwarf",
  SHIB:"shiba-inu", CULT:"cult-dao",
  TROLL:"troll-2", POPCAT:"popcat", WOJAK:"wojak",
  MEW:"cat-in-a-dogs-world", MUMU:"mumu-the-bull-3",
  TURBO:"turbo", BRETT:"based-brett", RETARDIO:"retardio",
  DOLAN:"dolan-duck", WIF:"dogwifhat",
  NPC:"non-playable-coin", KEYCAT:"keyboard-cat"
};

// Battle coin colors — distinct palette so each side is visually clear
const BATTLE_COLORS = {
  PENGU:"#4FC3F7", DOG:"#FF8A65", PAIN:"#E53935", BONK:"#FFB74D",
  REKT:"#B71C1C", ELONRWA:"#7E57C2", BITCOIN:"#FF6F00", APU:"#66BB6A",
  SPX:"#E91E63", TRUMP:"#1565C0", TOSHI:"#00ACC1", PONKE:"#8D6E63",
  GIGA:"#F44336", FARTCOIN:"#5C6BC0", BOBO:"#795548", MIGGLES:"#26A69A",
  KEKEC:"#9CCC65", SHIB:"#FF7043", CULT:"#AB47BC", TROLL:"#78909C",
  POPCAT:"#EC407A", WOJAK:"#29B6F6", MEW:"#FFA726", MUMU:"#43A047",
  TURBO:"#00E5FF", BRETT:"#2979FF", RETARDIO:"#FF1744", DOLAN:"#FFEE58",
  WIF:"#CE93D8", NPC:"#90A4AE", KEYCAT:"#FF8A80"
};

// CoinGecko Pro for battle coin prices (separate from free tier for UP/DOWN)
const CG_PRO_API = "https://pro-api.coingecko.com/api/v3";
const CG_PRO_KEY = "CG-PWFqjufsd6mZpoNsR62ukuiT";
const CG_PRO_HEADERS = { "x-cg-pro-api-key": CG_PRO_KEY };
let lastBattlePriceCall = 0;

// Fallback coin data when APIs are rate limited
const FALLBACK_COINS = [
  { sym: "JOE", name: "Joe Coin", mcap: 7000000, color: "#f7931a", img: "https://cdn.meme.com/images/meme_assets/2025-07-16/1752687196279dnFN.png" },
  { sym: "STNK", name: "Stonks", mcap: 6000000, color: "#3d7a1c", img: "https://cdn.meme.com/images/meme_assets/2025-10-24/17613344323935piQ.png" },
  { sym: "PEPE", name: "Pepe", mcap: 1700000000, color: "#4ADE80", img: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779740059DXOD.png" },
  { sym: "MOG", name: "Mog Coin", mcap: 66000000, color: "#1e3a5f", img: "https://cdn.meme.com/images/meme_assets/2024-04-15/1713170597024m28Z.png" }
];

// --- On-demand per-user wallet census ---

const CENSUS_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const CENSUS_TIERS = [
  { name: "GOLD", min: 10000 },
  { name: "SILVER", min: 1000 },
  { name: "BRONZE", min: 100 },
];

const getCensusTier = (usdValue) => {
  for (const t of CENSUS_TIERS) if (usdValue >= t.min) return t.name;
  return null;
};

// ERC20 balanceOf(address) selector
const BALANCE_OF_SEL = "0x70a08231";

// Free public RPCs (one per EVM chain)
const SCAN_RPCS = {
  ethereum: "https://eth.llamarpc.com",
  base: "https://base.llamarpc.com",
};
const SOLANA_SCAN_RPC = "https://api.mainnet-beta.solana.com";

// Load labs_coins + CoinGecko prices (one HTTP call)
const fetchCoinsWithPrices = async () => {
  if (!supabase) return [];
  const { data, error } = await supabase.from("labs_coins").select("*").eq("active", true);
  if (error || !data?.length) return [];
  const cgIds = data.map(c => c.coingecko_id).join(",");
  let prices = {};
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`);
    if (res.ok) prices = await res.json();
  } catch {}
  return data.map(row => ({ ...row, price: prices[row.coingecko_id]?.usd || 0 })).filter(c => c.price > 0);
};

// Scan one EVM wallet — JSON-RPC batch of eth_call per chain (no ethers.js)
const scanEvmWallet = async (walletAddress, coins) => {
  const results = [];
  const evmCoins = coins.filter(c => c.evm_contract);
  if (!evmCoins.length) return results;

  // Group by platform
  const byPlatform = {};
  evmCoins.forEach(c => {
    const p = c.evm_platform || "ethereum";
    (byPlatform[p] = byPlatform[p] || []).push(c);
  });

  const paddedAddr = walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");

  for (const [platform, pCoins] of Object.entries(byPlatform)) {
    const rpcUrl = SCAN_RPCS[platform];
    if (!rpcUrl) continue;

    const batch = pCoins.map((coin, i) => ({
      jsonrpc: "2.0", id: i, method: "eth_call",
      params: [{ to: coin.evm_contract, data: BALANCE_OF_SEL + paddedAddr }, "latest"]
    }));

    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch)
      });
      const responses = await res.json();
      for (const resp of (Array.isArray(responses) ? responses : [responses])) {
        if (resp.error || !resp.result || resp.result === "0x" || BigInt(resp.result) === 0n) continue;
        const coin = pCoins[resp.id];
        const rawBal = BigInt(resp.result);
        const tokenBal = Number(rawBal) / (10 ** (coin.evm_decimals || 18));
        const usdVal = tokenBal * coin.price;
        const tier = getCensusTier(usdVal);
        if (tier) results.push({
          coin_symbol: coin.symbol, coin_name: coin.name, coin_image: coin.image,
          wallet_address: walletAddress, chain: "EVM",
          token_balance: tokenBal, usd_value: usdVal, tier
        });
      }
    } catch (err) { console.warn(`EVM scan ${platform}:`, err.message); }
  }
  return results;
};

// Scan one Solana wallet — single getTokenAccountsByOwner call
const scanSolanaWallet = async (walletAddress, coins) => {
  const results = [];
  const solCoins = coins.filter(c => c.solana_mint);
  if (!solCoins.length) return results;
  const mintMap = {};
  solCoins.forEach(c => { mintMap[c.solana_mint] = c; });

  try {
    const res = await fetch(SOLANA_SCAN_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
        params: [walletAddress, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]
      })
    });
    const data = await res.json();
    if (data.error) return results;
    for (const acct of (data.result?.value || [])) {
      const info = acct.account?.data?.parsed?.info;
      if (!info) continue;
      const coin = mintMap[info.mint];
      if (!coin) continue;
      const tokenBal = Number(info.tokenAmount?.uiAmount || 0);
      const usdVal = tokenBal * coin.price;
      const tier = getCensusTier(usdVal);
      if (tier) results.push({
        coin_symbol: coin.symbol, coin_name: coin.name, coin_image: coin.image,
        wallet_address: walletAddress, chain: "SOLANA",
        token_balance: tokenBal, usd_value: usdVal, tier
      });
    }
  } catch (err) { console.warn("Solana scan:", err.message); }
  return results;
};

// Orchestrate: classify wallets → fetch prices → scan in parallel → save via RPC
const runWalletCensus = async (uid, wallets) => {
  if (!supabase || !wallets?.length) throw new Error("No wallets to scan");

  const coins = await fetchCoinsWithPrices();
  if (!coins.length) throw new Error("No coins with prices available");

  // Classify wallets — API returns plain strings, detect by format
  const addrs = wallets.map(w => typeof w === "string" ? w : (w.wallet_address || w.address || ""));
  const evmAddrs = addrs.filter(a => a.startsWith("0x"));
  const solAddrs = addrs.filter(a => a && !a.startsWith("0x"));

  console.log(`[CENSUS] Scanning ${evmAddrs.length} EVM + ${solAddrs.length} Solana wallets, ${coins.length} coins`);

  const all = (await Promise.all([
    ...evmAddrs.map(a => scanEvmWallet(a, coins)),
    ...solAddrs.map(a => scanSolanaWallet(a, coins))
  ])).flat();

  console.log(`[CENSUS] Found ${all.length} holdings above threshold`);

  const { error } = await supabase.rpc("labs_save_census", {
    p_user_id: uid,
    p_holdings: all
  });
  if (error) throw new Error(error.message);

  return all;
};

// Battle coin map (populated from CoinGecko Pro, correct images/names)
let battleCoinMap = {};

// Fetch battle coin metadata from CoinGecko Pro (correct images + names)
async function fetchBattleCoinMetadata() {
  try {
    const ids = Object.values(BATTLE_COINS).filter(Boolean);
    // Fetch in batches of 50
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = await fetch(
        `${CG_PRO_API}/coins/markets?vs_currency=usd&ids=${batch.join(",")}&order=market_cap_desc&per_page=50`,
        { headers: CG_PRO_HEADERS }
      );
      if (!res.ok) continue;
      const data = await res.json();
      data.forEach(coin => {
        // Find our symbol from CG ID
        const entry = Object.entries(BATTLE_COINS).find(([, cgId]) => cgId === coin.id);
        if (entry) {
          const sym = entry[0];
          battleCoinMap[sym] = {
            sym,
            name: coin.name,
            mcap: coin.market_cap,
            price: coin.current_price,
            color: BATTLE_COLORS[sym] || "#71BAFF",
            img: coin.image // CoinGecko thumbnail
          };
        }
      });
    }
    lastBattlePriceCall = Date.now();
  } catch (e) {
    console.warn("Battle coin metadata fetch failed:", e);
  }
}

async function fetchCoins() {
  try {
    // Get metadata from meme.com for UPDOWN coins only
    const res = await fetch(`${API_BASE}/farm/coins_leaderboard?page=1&page_size=100`);
    const data = await res.json();
    const allItems = data.items || [];

    const coins = allItems.filter(c => COIN_SYMBOLS.includes(c.symbol.toLowerCase())).map(c => ({
      sym: c.symbol.toUpperCase(),
      name: c.name,
      mcap: c.market_capitalization,
      price: c.price_now,
      color: COIN_COLORS[c.symbol.toLowerCase()] || "#71BAFF",
      img: c.coin_image_url,
      id: c.id,
      key: c.key
    }));

    // Try to get prices from CoinGecko for consistency
    try {
      const ids = Object.values(COINGECKO_IDS);
      const cgRes = await fetch(
        `${CG_API}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc`,
        { headers: CG_HEADERS }
      );
      if (cgRes.ok) {
        const cgData = await cgRes.json();
        coins.forEach(c => {
          const cgId = COINGECKO_IDS[c.sym.toLowerCase()];
          const cgCoin = cgData.find(x => x.id === cgId);
          if (cgCoin) {
            c.mcap = cgCoin.market_cap;
            c.price = cgCoin.current_price;
          }
        });
      }
    } catch (cgErr) {
      console.warn("CoinGecko fetch failed, using meme.com prices:", cgErr);
    }

    return coins;
  } catch (err) {
    console.error("Failed to fetch coins, using fallback:", err);
    return FALLBACK_COINS;
  }
}

async function fetchPrices(coins) {
  try {
    // Use CoinGecko for faster updates
    const ids = coins.map(c => COINGECKO_IDS[c.sym.toLowerCase()]).filter(Boolean);
    if (ids.length === 0) return {};

    const res = await fetch(
      `${CG_API}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc`,
      { headers: CG_HEADERS }
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("CoinGecko returned non-array");

    const priceMap = {};
    data.forEach(coin => {
      // Find our symbol from CoinGecko ID
      const sym = Object.entries(COINGECKO_IDS).find(([k, v]) => v === coin.id)?.[0];
      if (sym) {
        priceMap[sym] = {
          price: coin.current_price,
          mcap: coin.market_cap
        };
      }
    });
    return priceMap;
  } catch (err) {
    console.error("CoinGecko free failed, trying CG Pro:", err);
    // Fallback to CoinGecko Pro
    try {
      const ids = coins.map(c => COINGECKO_IDS[c.sym.toLowerCase()]).filter(Boolean);
      if (ids.length === 0) return {};
      const res = await fetch(
        `${CG_PRO_API}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc`,
        { headers: CG_PRO_HEADERS }
      );
      if (!res.ok) throw new Error(`CG Pro ${res.status}`);
      const data = await res.json();
      const priceMap = {};
      data.forEach(coin => {
        const sym = Object.entries(COINGECKO_IDS).find(([k, v]) => v === coin.id)?.[0];
        if (sym) {
          priceMap[sym] = { price: coin.current_price, mcap: coin.market_cap };
        }
      });
      return priceMap;
    } catch (e) {
      console.error("CG Pro fallback also failed:", e);
      return {};
    }
  }
}

// LMSR (Logarithmic Market Scoring Rule) - proper implementation
// Cost function: C(qY, qN) = B * ln(exp(qY/B) + exp(qN/B))
const costFn = (qY, qN, B) => {
  const m = Math.max(qY, qN) / B;
  return B * (m + Math.log(Math.exp(qY/B - m) + Math.exp(qN/B - m)));
};

// Memescore currently in market (net user investment)
const marketPool = (qY, qN, B) => {
  const current = costFn(qY, qN, B);
  const initial = costFn(B, B, B);  // B * (1 + ln(2))
  return Math.max(0, Math.round(current - initial));
};

// Probability of YES
const yP = (qY, qN, B) => {
  if (!B || isNaN(qY) || isNaN(qN)) return 50;
  const y = Number(qY) || 0;
  const n = Number(qN) || 0;
  const m = Math.max(y, n) / B;
  const eY = Math.exp(y/B - m), eN = Math.exp(n/B - m);
  const result = Math.round(eY / (eY + eN) * 100);
  return isNaN(result) ? 50 : Math.min(99, Math.max(1, result));
};

// Buy shares: cost -> shares (using binary search for numerical stability)
const buyShares = (qY, qN, B, cost, side) => {
  if (cost <= 0) return 0;
  const oldCost = costFn(qY, qN, B);
  // Upper bound must account for cheap minority-side shares
  const m = Math.max(qY, qN) / B;
  const eY = Math.exp(qY/B - m), eN = Math.exp(qN/B - m);
  const p = side === "YES" ? eY / (eY + eN) : eN / (eY + eN);
  let lo = 0, hi = Math.max(cost * 2, cost / Math.max(p, 0.01) * 2);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const newQY = side === "YES" ? qY + mid : qY;
    const newQN = side === "NO" ? qN + mid : qN;
    const newCost = costFn(newQY, newQN, B);
    if (newCost - oldCost < cost) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
};

// Sell shares: shares -> refund
const sellShares = (qY, qN, B, shares, side) => {
  if (shares <= 0) return 0;
  const oldCost = costFn(qY, qN, B);
  const newQY = side === "YES" ? Math.max(0, qY - shares) : qY;
  const newQN = side === "NO" ? Math.max(0, qN - shares) : qN;
  const newCost = costFn(newQY, newQN, B);
  return Math.max(0, Math.round(oldCost - newCost));
};

const fM = v => v>=1e12?"$"+(v/1e12).toFixed(2)+"T":v>=1e9?"$"+(v/1e9).toFixed(2)+"B":v>=1e6?"$"+(v/1e6).toFixed(2)+"M":"$"+(v/1e3).toFixed(0)+"K";
const fT = s => s<=0?"RESOLVING...":String(Math.floor(s/3600)).padStart(2,"0")+":"+String(Math.floor((s%3600)/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
const gld = { background:"linear-gradient(193deg,#f7931a -49%,#fab248 -14%,#fff1a6 58%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" };

// Next round expiry: 13:59:59 UTC daily (1s before 14:00 so pg_cron catches it)
const nextRoundExpiry = () => {
  const now = new Date();
  const today14 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 59, 59));
  if (now.getTime() >= today14.getTime()) {
    today14.setUTCDate(today14.getUTCDate() + 1);
  }
  return today14.getTime();
};

// B controls market depth - higher B = more liquidity, less price impact
// Base liquidity should be proportional to B for LMSR to work correctly
const getB = () => 100000;

const mk = (c, r) => {
  const b = getB(c.mcap);
  return {
    id:c.sym+"-"+(r||1), c, rn:r||1, mc:c.mcap, startMc:c.mcap,
    qY:b, qN:b, // Start with equal shares = 50/50 odds
    b:b, fp:0,
    st:"OPEN", res:null, ea:nextRoundExpiry(), vol:0, ppl:0
  };
};

// Battle market: exactly 48h from creation
const nextBattleExpiry = () => Date.now() + 48 * 3600 * 1000;

const battlePairKey = (symA, symB) => [symA, symB].sort().join("-vs-");

const mkBattle = (coinA, coinB, r) => {
  const b = getB();
  return {
    id: "BATTLE-" + coinA.sym + "-" + coinB.sym + "-" + (r || 1),
    type: "BATTLE",
    c: coinA, cB: coinB,
    rn: r || 1,
    mc: coinA.mcap, startMc: coinA.mcap,
    mcB: coinB.mcap, startMcB: coinB.mcap,
    qY: b, qN: b, b: b, fp: 0,
    st: "OPEN", res: null,
    ea: nextBattleExpiry(), vol: 0, ppl: 0
  };
};

const pickBattleMatchup = (coinMap) => {
  // Filter to battle coins with valid CG IDs that exist in coinMap
  const eligible = Object.entries(BATTLE_COINS)
    .filter(([sym, cgId]) => cgId && coinMap[sym])
    .map(([sym]) => sym);
  if (eligible.length < 2) return null;
  // Fisher-Yates shuffle
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return [shuffled[0], shuffled[1]];
};

const CoinImg = ({ src, color, size, sym }) => {
  const s = size||40;
  const [imgErr, setImgErr] = React.useState(false);
  return (
    <div style={{
      width:s, height:s, borderRadius:12, position:"relative",
      border:"1px solid "+(color||"#fff")+"1a",
      background:"linear-gradient(135deg, "+(color||"#fff")+"15, "+(color||"#fff")+"08)",
      overflow:"hidden", flexShrink:0,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'Londrina Solid',sans-serif",
      fontSize:s*.45, color:"#fff", fontWeight:900,
      textShadow:"0 1px 3px rgba(0,0,0,.4)"
    }}>
      {!imgErr && <img src={src} alt=""
        style={{
          position:"absolute", inset:0,
          width:"100%", height:"100%", objectFit:"cover", borderRadius:11
        }}
        onError={() => setImgErr(true)}/>}
      {imgErr && <span>{(sym||"?")[0]}</span>}
    </div>
  );
};

// Deposit/Withdraw modal (login prompt for guests, deposit/withdraw for logged-in)
const DepositModal = ({ isOpen, onClose, onDeposit, memeUser, memescore, labsBalance, authToken, isMobile }) => {
  const [mode, setMode] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const LABS_CAP = 100000;
  const depositRoom = Math.max(0, LABS_CAP - labsBalance);
  const maxAmount = mode === "deposit" ? Math.min(memescore, depositRoom) : labsBalance;
  const atCap = mode === "deposit" && labsBalance >= LABS_CAP;

  const handleSubmit = async () => {
    if (atCap) { setError("Labs balance is at the 100k cap"); return; }
    const amt = parseInt(amount) || 0;
    if (amt <= 0 || amt > maxAmount) {
      setError(amt > maxAmount
        ? (mode === "deposit"
          ? (depositRoom === 0 ? "Labs balance is at the 100k cap" : `Max deposit: ${depositRoom.toLocaleString()} (100k cap)`)
          : "Insufficient Labs balance")
        : "Enter a valid amount");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const endpoint = mode === "deposit" ? "/labs/deposit" : "/labs/withdraw";
      const res = await fetch(`${MEME_API}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`
        },
        body: JSON.stringify({ amount: amt })
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {}; }
      if (!res.ok) throw new Error(data.message || data.detail || text || `${mode} failed`);

      onDeposit(amt, mode, data.new_memescore);
      setAmount("");
      onClose();
    } catch (e) {
      console.error(`${mode} error:`, e);
      setError(e.message || `${mode} failed. Please try again.`);
    } finally {
      setLoading(false);
    }
  };

  const modalBase = {
    position:"fixed", inset:0, background:"rgba(0,0,0,0.8)",
    display:"flex", alignItems: isMobile ? "flex-end" : "center", justifyContent:"center", zIndex:100
  };
  const panelBase = {
    background:"linear-gradient(180deg,#1a2332,#0c1018)",
    borderRadius: isMobile ? "20px 20px 0 0" : 20,
    padding: isMobile ? "24px 16px 32px" : 32,
    width: isMobile ? "100%" : "auto",
    minWidth: isMobile ? "auto" : 340,
    maxWidth: isMobile ? "100%" : 400,
    border:"1px solid #ffffff15",
    textAlign:"center"
  };

  // Guest: show login prompt
  if (!memeUser) {
    return (
      <div style={modalBase} onClick={onClose}>
        <div style={panelBase} onClick={e => e.stopPropagation()}>
          <div style={{
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.4em",
            marginBottom:20
          }}>Login Required</div>
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize:".9em",
            color:"#94a3b8", marginBottom:24, lineHeight:1.5
          }}>Connect your meme.com account to start playing.</div>
          <a href="https://meme.com" target="_blank" rel="noopener noreferrer" style={{
            display:"block", width:"100%", height:48, borderRadius:12, border:"none",
            background:"linear-gradient(90deg,#71BAFF,#4023C3)",
            color:"#fff", cursor:"pointer", textDecoration:"none",
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em",
            lineHeight:"48px"
          }}>Login on meme.com</a>
          <button onClick={onClose} style={{
            marginTop:12, width:"100%", height:40, borderRadius:10, border:"none",
            background:"transparent", color:"#ffffff60", cursor:"pointer",
            fontFamily:"'Jersey 25',sans-serif", fontSize:".85em"
          }}>Cancel</button>
        </div>
      </div>
    );
  }

  // Logged in: deposit/withdraw UI
  return (
    <div style={modalBase} onClick={onClose}>
      <div style={panelBase} onClick={e => e.stopPropagation()}>
        <div style={{
          fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.4em",
          marginBottom:16
        }}>Labs Balance</div>

        <div style={{
          display:"flex", justifyContent:"space-around", marginBottom:16,
          padding:"12px 0", borderRadius:12, background:"#0c101855"
        }}>
          <div>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#ffffff50" }}>MEMESCORE</div>
            <div style={{ ...gld, fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.2em" }}>
              {memescore.toLocaleString()}
            </div>
          </div>
          <div style={{ width:1, background:"#ffffff15" }}/>
          <div>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#ffffff50" }}>LABS BALANCE</div>
            <div style={{ fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.2em", color:"#71BAFF" }}>
              {labsBalance.toLocaleString()}
            </div>
          </div>
        </div>

        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          {["deposit","withdraw"].map(m => (
            <button key={m} onClick={() => { setMode(m); setAmount(""); setError(null); }} style={{
              flex:1, height:36, borderRadius:10, border:"none", cursor:"pointer",
              fontFamily:"'Jersey 25',sans-serif", fontSize:".9em", textTransform:"uppercase",
              background: mode===m ? "linear-gradient(90deg,#71BAFF,#4023C3)" : "#ffffff10",
              color: mode===m ? "#fff" : "#ffffff60"
            }}>{m}</button>
          ))}
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff50",
            textAlign:"right", marginBottom:4
          }}>
            {mode === "deposit" ? "MEMESCORE" : "LABS"}: {maxAmount.toLocaleString()}
          </div>
          <input type="number" inputMode="numeric" pattern="[0-9]*"
            placeholder={`Amount to ${mode}...`}
            value={amount} onChange={e => { setAmount(e.target.value); setError(null); }}
            style={{
              height:42, border:"1px solid #4c5159", borderRadius:15,
              textAlign:"center", color:"#fff", background:"transparent",
              fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", outline:"none",
              width:"100%", boxSizing:"border-box"
            }}/>
          <div style={{ display:"flex", gap:6, marginTop:6 }}>
            {[25,50,75,100].map(p =>
              <button key={p}
                onClick={() => setAmount(String(Math.floor(maxAmount*p/100)))}
                style={{
                  flex:1, padding:"4px 0", borderRadius:8,
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
                  background:"#00000042", border:"1px solid #ffffff15",
                  color:"#ffffff80", cursor:"pointer"
                }}>{p}%</button>
            )}
          </div>
        </div>

        {error && <div style={{
          fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
          color:"#f65e5e", marginBottom:10
        }}>{error}</div>}

        {atCap && <div style={{
          fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
          color:"#f7931a", marginBottom:10
        }}>Labs balance is at the 100k cap. Withdraw or play to deposit more.</div>}

        <button onClick={handleSubmit} disabled={loading || atCap || !amount || parseInt(amount)<=0}
          style={{
            width:"100%", height:48, borderRadius:12, border:"none",
            background: (loading || atCap) ? "#ffffff20" : "linear-gradient(90deg,#71BAFF,#4023C3)",
            color:"#fff", cursor: (loading || atCap) ? "not-allowed" : "pointer",
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em",
            opacity: (atCap || !amount || parseInt(amount)<=0) ? 0.5 : 1
          }}>
          {loading ? "Processing..." : mode === "deposit" ? "Deposit to Labs" : "Withdraw to Memescore"}
        </button>

        <button onClick={onClose} style={{
          marginTop:12, width:"100%", height:40, borderRadius:10, border:"none",
          background:"transparent", color:"#ffffff60", cursor:"pointer",
          fontFamily:"'Jersey 25',sans-serif", fontSize:".85em"
        }}>Cancel</button>

        <div style={{
          fontFamily:"'Jersey 25',sans-serif", fontSize:".7em",
          color:"#ffffff30", marginTop:16, lineHeight:1.4
        }}>Having issues? Try logging out and back in on meme.com</div>
      </div>
    </div>
  );
};

const Card = ({ m, bal, pos, players, onBuy, onSell, onClaim, streak, isMobile, memeUser, onLoginRequired }) => {
  const [step, setStep] = useState("sel");
  const [side, setSide] = useState(null);
  const [amt, setAmt] = useState("");
  const [sec, setSec] = useState(0);
  const [priceFlash, setPriceFlash] = useState(null); // "up" | "down" | null
  const prevMc = React.useRef(m.mc);

  useEffect(() => {
    const t = () => setSec(Math.max(0,Math.floor((m.ea-Date.now())/1000)));
    t();
    const i = setInterval(t,1000);
    return () => clearInterval(i);
  }, [m.ea]);

  useEffect(() => {
    if (prevMc.current && m.mc !== prevMc.current) {
      setPriceFlash(m.mc > prevMc.current ? "up" : "down");
      const t = setTimeout(() => setPriceFlash(null), 1200);
      prevMc.current = m.mc;
      return () => clearTimeout(t);
    }
    prevMc.current = m.mc;
  }, [m.mc]);

  useEffect(() => {
    if (m.st==="RES" && pos) setStep("res");
    else if (m.st==="OPEN" && pos && !pos.claimed) setStep("pos");
    else if (m.st==="OPEN") setStep("sel");
  }, [m.st, pos]);

  const yp = yP(m.qY, m.qN, m.b);
  const np = 100-yp;
  const pctChange = m.startMc > 0 ? ((m.mc - m.startMc) / m.startMc * 100) : 0;
  const isUp = pctChange > 0;
  const grossRf = pos ? sellShares(m.qY, m.qN, m.b, pos.sh, pos.side) : 0;
  const sellFee = pos && m.st === "OPEN" ? Math.round(grossRf * 0.02) : 0;
  const rf = grossRf - sellFee;
  const pnl = pos ? rf - pos.inv : 0;

  const doBuy = () => {
    const a = parseInt(amt)||0;
    if (a<=0 || a>bal) return;
    onBuy(m.id, side, a);
    setAmt("");
    setStep("pos");
  };

  const bx = {
    height:38, display:"flex", alignItems:"center", justifyContent:"center",
    width:"100%", fontFamily:"'Jersey 25',sans-serif", fontSize:"1em",
    textTransform:"uppercase", borderRadius:15, cursor:"pointer",
    border:"none", color:"#fff"
  };

  return (
    <div style={{
      background:"linear-gradient(360deg,#212936,#4e596c)",
      boxShadow:"0 4px 44px #ffffff12,0 4px 12px #000000b8",
      borderRadius:"16px 16px 25px 25px", padding:"5px 6px 10px"
    }}>
      <div style={{
        background:"#191f29", borderRadius:14, padding:"14px 18px",
        minHeight:192, display:"flex", flexDirection:"column",
        justifyContent:"space-between"
      }}>
        <div style={{ display:"flex", alignItems:"center", marginBottom:12, gap:11, justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:11 }}>
            <CoinImg src={m.c.img} color={"#ffffff"} size={40} sym={m.c.sym}/>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
              textTransform:"uppercase",
              textShadow:"0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
              lineHeight:1.2
            }}><a href={`https://meme.com/coin/${MEME_SLUGS[m.c.sym] || m.c.sym.toLowerCase()}`} target="_blank" rel="noopener noreferrer" style={{ ...gld, textDecoration:"none", textShadow:"none" }}>${m.c.sym}</a> Up or Down</div>
          </div>
          <div style={{
            padding:"2px 8px", borderRadius:8,
            background: sec <= 300 ? "rgba(247,147,26,0.12)" : "rgba(255,255,255,0.04)",
            border: sec <= 300 ? "1px solid rgba(247,147,26,0.3)" : "1px solid transparent",
            animation: sec <= 300 ? "timerPulse 1s ease-in-out infinite" : undefined
          }}>
            <span style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em",
              letterSpacing:"1px", ...gld
            }}>{fT(sec)}</span>
          </div>
        </div>

        <div style={{
          display:"flex", alignItems:"flex-start", gap:12, marginBottom:10,
          flexWrap:"wrap"
        }}>
          {pos && !pos.claimed && (
            <>
              <div style={{ whiteSpace:"nowrap" }}>
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                  color:"#ffffff40", marginBottom:2
                }}>YOUR BET</div>
                <div style={{
                  display:"flex", alignItems:"center", gap:4,
                  fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em"
                }}>
                  <span style={{ color: pos.side==="YES" ? "#71baff" : "#a78bfa" }}>
                    {rf.toLocaleString()} {pos.side==="YES" ? "UP" : "DOWN"}
                  </span>
                  <span style={{
                    fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                    color: pnl>=0 ? "#4ade80" : "#f65e5e"
                  }}>
                    {pnl>=0 ? "▲" : "▼"} {pnl>=0 ? "+" : ""}{pnl.toLocaleString()}
                  </span>
                </div>
              </div>
              <div style={{ width:1, height:36, background:"#ffffff20", flexShrink:0 }}/>
            </>
          )}
          <div style={{ whiteSpace:"nowrap" }}>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
              color:"#ffffff40", marginBottom:2
            }}>CURRENT PRICE</div>
            <div style={{
              display:"flex", alignItems:"center", gap:4,
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em"
            }}>
              <span style={{
                ...gld,
                transition:"transform 0.3s ease, opacity 0.3s ease",
                transform: priceFlash === "up" ? "scale(1.15)" : "scale(1)",
                opacity: priceFlash === "down" ? 0.6 : 1,
                display:"inline-block"
              }}>{fM(m.mc)}</span>
              <span style={{
                fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                color: priceFlash === "up" ? "#4ade80" : priceFlash === "down" ? "#f65e5e" : isUp ? "#4ade80" : pctChange < 0 ? "#f65e5e" : "#ffffff40",
                transition:"color 0.3s ease",
                animation: priceFlash ? "priceFlash 1.2s ease-out" : undefined
              }}>
                {isUp ? "▲" : pctChange < 0 ? "▼" : ""} {Math.abs(pctChange).toFixed(1)}%
              </span>
            </div>
          </div>
          <div style={{ width:1, height:36, background:"#ffffff20", flexShrink:0 }}/>
          <div style={{ whiteSpace:"nowrap" }}>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
              color:"#ffffff40", marginBottom:2
            }}>PRICE TO BEAT</div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
              color:"#94a3b8"
            }}>{fM(m.startMc)}</div>
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
          <span style={{
            fontSize:".75em", fontFamily:"'Jersey 25',sans-serif",
            minWidth:28, textAlign:"center"
          }}>{yp}%</span>
          <div style={{
            flex:1, height:12, borderRadius:62,
            border:"1px solid #ffffff4d", overflow:"hidden", position:"relative"
          }}>
            <div style={{
              position:"absolute", top:2, bottom:2, left:2,
              width:"calc("+yp+"% - 2px)",
              background:"linear-gradient(270deg,#FFFAC0 4%,#AED8FF 25%,#71BAFF 62%)",
              borderRadius:"62px 0 0 62px"
            }}/>
            <div style={{
              position:"absolute", top:2, bottom:2, right:2, left:yp+"%",
              background:"linear-gradient(90deg,#8398FF 25%,#4023C3 62%)",
              borderRadius:"0 62px 62px 0"
            }}/>
          </div>
          <span style={{
            fontSize:".75em", fontFamily:"'Jersey 25',sans-serif",
            minWidth:28, textAlign:"center"
          }}>{np}%</span>
        </div>

        <div style={{ minHeight:48 }}>
          {step==="sel" && m.st==="OPEN" && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); }}>
                UP
              </button>
              <button style={{ ...bx, background:"#234bc29e", border:"2px solid #c8dbff52" }}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); }}>
                DOWN
              </button>
            </div>
          )}

          {step==="amt" && (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <div style={{
                display:"flex", justifyContent:"flex-end", alignItems:"center",
                fontFamily:"'Jersey 25',sans-serif", fontSize:".75em"
              }}>
                <span style={gld}>BAL: {bal.toLocaleString()}</span>
              </div>
              <input type="number" inputMode="numeric" pattern="[0-9]*" placeholder="Amount..."
                value={amt} onChange={e => setAmt(e.target.value)} autoFocus
                style={{
                  height:42, border:"1px solid #4c5159", borderRadius:15,
                  textAlign:"center", color:"#fff", background:"transparent",
                  fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", outline:"none",
                  width:"100%"
                }}/>
              <div style={{ display:"flex", gap:6, marginBottom:4 }}>
                {[10,25,50,100].map(p =>
                  <button key={p}
                    onClick={() => setAmt(String(Math.floor(bal*p/100)))}
                    style={{
                      flex:1, padding:"4px 0", borderRadius:8,
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
                      background:"#00000042", border:"1px solid #ffffff15",
                      color:"#ffffff80", cursor:"pointer"
                    }}>{p}%</button>
                )}
              </div>
              {amt && parseInt(amt) > 0 && (() => {
                const a = parseInt(amt);
                const net = a - Math.round(a * 0.02);
                const feeStr = net.toLocaleString() + " after 2% fee";
                if (net <= 0) return (
                  <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff60", textAlign:"center", marginBottom:2 }}>{feeStr}</div>
                );
                const sh = buyShares(m.qY, m.qN, m.b, net, side);
                if (sh <= 0) return (
                  <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff60", textAlign:"center", marginBottom:2 }}>{feeStr}</div>
                );
                const loserInv = side === "YES" ? m.nInv : m.yInv;
                if (loserInv <= 0) return (
                  <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff60", textAlign:"center", marginBottom:2 }}>
                    {feeStr} / ~1.0x if {side==="YES"?"UP":"DOWN"} wins
                  </div>
                );
                const winnerSh = (side === "YES" ? m.qY - m.b + sh : m.qN - m.b + sh);
                const payout = Math.min(net + Math.round(sh / winnerSh * loserInv), net * 10);
                const mult = Math.min(payout / net, 10).toFixed(1);
                return (
                  <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff60", textAlign:"center", marginBottom:2 }}>
                    {feeStr} / ~{mult}x if {side==="YES"?"UP":"DOWN"} wins
                  </div>
                );
              })()}
              <div style={{ display:"flex", gap:10 }}>
                <button style={{ ...bx, background:"#00000042", flex:"0 0 40px" }}
                  onClick={() => { setStep("sel"); setSide(null); setAmt(""); }}>
                  X
                </button>
                <button
                  style={{ ...bx, flex:"1 1 auto", background:side==="YES"?"#71baff8a":"#234bc29e" }}
                  onClick={doBuy}
                  disabled={!amt || parseInt(amt)<=0 || parseInt(amt)>bal}>
                  BET {side==="YES"?"UP":"DOWN"} {amt ? "("+parseInt(amt).toLocaleString()+")" : ""}
                </button>
              </div>
            </div>
          )}

          {step==="pos" && pos && m.st==="OPEN" && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff" }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>
                ADD MORE {pos.side === "YES" ? "UP" : "DOWN"}
              </button>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => onSell(m.id)}>
                SELL
              </button>
            </div>
          )}

          {step==="res" && (() => {
            const won = pos && m.res === pos.side;
            const baseReward = won && m.wws > 0
              ? Math.min(pos.inv + Math.round(pos.sh / m.wws * (m.pot - m.wis)), pos.inv * 10)
              : 0;
            return (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {pos && !pos.claimed && (
                <button
                  style={{ ...bx, background: won ? "#71baff" : "#f65e5e30" }}
                  onClick={() => onClaim(m.id)}>
                  {won
                    ? "CLAIM " + baseReward.toLocaleString()
                    : "YOU LOST. CLOSE."}
                </button>
              )}
              {pos && pos.claimed && (
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", textAlign:"center", padding:8
                }}>CLAIMED</div>
              )}
            </div>
            );
          })()}
        </div>
      </div>

      <div style={{
        display:"flex", alignItems:"center", marginTop:10,
        padding:"0 16px 0 14px", justifyContent:"space-between"
      }}>
        <div style={{ display:"flex", alignItems:"center", fontSize:".75em", gap:8 }}>
          {players.length > 0 && marketPool(m.qY, m.qN, m.b) > 0 && (
            <div style={{ display:"flex", alignItems:"center" }}>
              {players.slice(0, 3).map((p, i) => (
                <div key={p.userId} style={{
                  width:24, height:24, borderRadius:"50%", border:"2px solid #191f29",
                  marginLeft: i > 0 ? -8 : 0, zIndex: 3 - i,
                  background: p.img ? `url(${p.img}) center/cover` : "linear-gradient(135deg,#4e596c,#212936)",
                  position:"relative"
                }}/>
              ))}
              {players.length > 3 && (
                <span style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".85em",
                  color:"#ffffff60", marginLeft:4
                }}>+{players.length - 3}</span>
              )}
            </div>
          )}
        </div>
        {marketPool(m.qY, m.qN, m.b) > 0 && <span style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".85em" }}>
          <span style={{ color:"#ffffff30", marginRight:4 }}></span>
          <span style={gld}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</span>
        </span>}
      </div>
    </div>
  );
};

const BattleCard = ({ m, bal, pos, players, onBuy, onSell, onClaim, streak, isMobile, memeUser, onLoginRequired }) => {
  const [step, setStep] = useState("sel");
  const [side, setSide] = useState(null);
  const [amt, setAmt] = useState("");
  const [sec, setSec] = useState(0);

  useEffect(() => {
    const t = () => setSec(Math.max(0, Math.floor((m.ea - Date.now()) / 1000)));
    t();
    const i = setInterval(t, 1000);
    return () => clearInterval(i);
  }, [m.ea]);

  useEffect(() => {
    if (m.st === "RES" && pos) setStep("res");
    else if (m.st === "OPEN" && pos && !pos.claimed) setStep("pos");
    else if (m.st === "OPEN") setStep("sel");
  }, [m.st, pos]);

  const yp = yP(m.qY, m.qN, m.b);
  const np = 100 - yp;
  const pctA = m.startMc > 0 ? ((m.mc - m.startMc) / m.startMc * 100) : 0;
  const pctB = m.startMcB > 0 ? ((m.mcB - m.startMcB) / m.startMcB * 100) : 0;
  const grossRf = pos ? sellShares(m.qY, m.qN, m.b, pos.sh, pos.side) : 0;
  const sellFee = pos && m.st === "OPEN" ? Math.round(grossRf * 0.02) : 0;
  const rf = grossRf - sellFee;
  const pnl = pos ? rf - pos.inv : 0;
  const colorA = m.c.color || "#71BAFF";
  const colorB = m.cB?.color || "#a78bfa";

  const doBuy = () => {
    const a = parseInt(amt) || 0;
    if (a <= 0 || a > bal) return;
    onBuy(m.id, side, a);
    setAmt("");
    setStep("pos");
  };

  const bx = {
    height: 38, display: "flex", alignItems: "center", justifyContent: "center",
    width: "100%", fontFamily: "'Jersey 25',sans-serif", fontSize: "1em",
    textTransform: "uppercase", borderRadius: 15, cursor: "pointer",
    border: "none", color: "#fff"
  };

  const sideLabel = (s) => s === "YES" ? "$" + m.c.sym : "$" + (m.cB?.sym || "?");

  return (
    <div style={{
      background: "linear-gradient(360deg,#212936,#4e596c)",
      boxShadow: "0 4px 44px #ffffff12,0 4px 12px #000000b8",
      borderRadius: "16px 16px 25px 25px", padding: "5px 6px 10px"
    }}>
      <div style={{
        background: "#191f29", borderRadius: 14, padding: "14px 18px",
        minHeight: 192, display: "flex", flexDirection: "column",
        justifyContent: "space-between"
      }}>
        {/* Face-off header: Coin A image | $A VS $B + Clock | Coin B image */}
        <div style={{
          display: "flex", alignItems: "center", marginBottom: 14
        }}>
          <div style={{ flex: "0 0 72px" }}>
            <CoinImg src={m.c.img} color={colorA} size={72} sym={m.c.sym}/>
          </div>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{
              fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.35em",
              textTransform: "uppercase", lineHeight: 1.2,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8
            }}>
              <a href={`https://meme.com/coin/${MEME_SLUGS[m.c.sym] || m.c.sym.toLowerCase()}`} target="_blank" rel="noopener noreferrer" style={{ ...gld, textDecoration: "none", textShadow: "none" }}>${m.c.sym}</a>
              <span style={{ fontSize: ".85em", color: "#ffffff" }}>VS</span>
              <a href={`https://meme.com/coin/${MEME_SLUGS[m.cB?.sym] || (m.cB?.sym || "").toLowerCase()}`} target="_blank" rel="noopener noreferrer" style={{ ...gld, textDecoration: "none", textShadow: "none" }}>${m.cB?.sym}</a>
            </div>
            <div style={{
              display: "inline-block", padding: "1px 8px", borderRadius: 6, marginTop: 4,
              background: sec <= 300 ? "rgba(247,147,26,0.12)" : "rgba(255,255,255,0.04)",
              border: sec <= 300 ? "1px solid rgba(247,147,26,0.3)" : "1px solid transparent",
              animation: sec <= 300 ? "timerPulse 1s ease-in-out infinite" : undefined
            }}>
              <span style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em",
                letterSpacing: "1px", ...gld
              }}>{fT(sec)}</span>
            </div>
          </div>
          <div style={{ flex: "0 0 72px", display: "flex", justifyContent: "flex-end" }}>
            <CoinImg src={m.cB?.img} color={colorB} size={72} sym={m.cB?.sym}/>
          </div>
        </div>

        {/* Price section: side-by-side % change with leader indicator */}
        {(() => {
          const aLeads = pctA > pctB;
          const bLeads = pctB > pctA;
          const tied = pctA === pctB;
          const isLosingA = bLeads;
          const isLosingB = aLeads;
          const pctStyle = (pct, leads, gold, losing) => ({
            fontFamily: "'Jersey 25',sans-serif", fontSize: "1.4em", fontWeight: 900, letterSpacing: 1,
            background: leads
              ? (gold ? "linear-gradient(135deg, #FFD54F, #FF9800, #FFE082)" : "linear-gradient(135deg, #82B1FF, #448AFF, #B388FF)")
              : losing ? (pct >= 0 ? "linear-gradient(135deg, #ccc, #fff, #ccc)" : "linear-gradient(135deg, #b71c1c, #d32f2f, #e53935)")
              : (pct >= 0 ? "linear-gradient(135deg, #4ade80, #22c55e)" : "linear-gradient(135deg, #f65e5e, #ef4444)"),
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            filter: leads ? `drop-shadow(0 0 8px ${gold ? "#FF980066" : "#448AFF66"})` : "none",
            transition: "all 0.3s ease"
          });
          const hasBet = pos && !pos.claimed && m.st === "OPEN";
          return (
          <div style={{
            display: "flex", alignItems: "center", marginBottom: 14, justifyContent: "space-between"
          }}>
            <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start",
              padding: "4px 10px", borderRadius: 8,
              background: aLeads ? "#FFD54F0a" : bLeads ? "#f65e5e0a" : "transparent",
              border: aLeads ? "1px solid #FFD54F25" : bLeads ? "1px solid #f65e5e20" : "1px solid transparent",
              transition: "all 0.3s ease"
            }}>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".45em", marginBottom: 1,
                color: aLeads ? "#FFD54F" : bLeads ? "#f65e5e" : "#ffffff30"
              }}>{aLeads ? "WINNING" : bLeads ? "LOSING" : tied ? "TIED" : ""}&nbsp;</div>
              <span style={pctStyle(pctA, aLeads, true, isLosingA)}>
                {pctA >= 0 ? "+" : ""}{pctA.toFixed(1)}%
              </span>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".45em", color: "#ffffff58", marginTop: 2
              }}>{fM(m.startMc)} → {fM(m.mc)}</div>
            </div>
            {hasBet && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, marginTop: -6 }}>
                <div style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em",
                  color: "#ffffff40", marginBottom: 2
                }}>YOUR BET</div>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{
                    fontFamily: "'Jersey 25',sans-serif", fontSize: "1.4em",
                    color: pos.side === "YES" ? colorA : colorB
                  }}>
                    {rf.toLocaleString()} {pos.side === "YES" ? m.c.sym : (m.cB?.sym || "?")}
                  </span>
                  <span style={{
                    fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em",
                    color: pnl >= 0 ? "#4ade80" : "#f65e5e"
                  }}>
                    {pnl >= 0 ? "+" : ""}{pnl.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
            <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end",
              padding: "4px 10px", borderRadius: 8,
              background: bLeads ? "#82B1FF0a" : aLeads ? "#f65e5e0a" : "transparent",
              border: bLeads ? "1px solid #82B1FF25" : aLeads ? "1px solid #f65e5e20" : "1px solid transparent",
              transition: "all 0.3s ease"
            }}>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".45em", marginBottom: 1,
                color: bLeads ? "#82B1FF" : aLeads ? "#f65e5e" : "#ffffff30"
              }}>{bLeads ? "WINNING" : aLeads ? "LOSING" : tied ? "TIED" : ""}&nbsp;</div>
              <span style={pctStyle(pctB, bLeads, false, isLosingB)}>
                {pctB >= 0 ? "+" : ""}{pctB.toFixed(1)}%
              </span>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".45em", color: "#ffffff58", marginTop: 2
              }}>{fM(m.startMcB)} → {fM(m.mcB)}</div>
            </div>
          </div>
          );
        })()}

        {/* Probability bar: same style as normal markets */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span style={{
            fontSize: ".75em", fontFamily: "'Jersey 25',sans-serif",
            minWidth: 28, textAlign: "center"
          }}>{yp}%</span>
          <div style={{
            flex: 1, height: 12, borderRadius: 62,
            border: "1px solid #ffffff4d", overflow: "hidden", position: "relative"
          }}>
            <div style={{
              position: "absolute", top: 2, bottom: 2, left: 2,
              width: "calc(" + yp + "% - 2px)",
              background: "linear-gradient(270deg,#FFFAC0 4%,#AED8FF 25%,#71BAFF 62%)",
              borderRadius: "62px 0 0 62px"
            }}/>
            <div style={{
              position: "absolute", top: 2, bottom: 2, right: 2, left: yp + "%",
              background: "linear-gradient(90deg,#8398FF 25%,#4023C3 62%)",
              borderRadius: "0 62px 62px 0"
            }}/>
          </div>
          <span style={{
            fontSize: ".75em", fontFamily: "'Jersey 25',sans-serif",
            minWidth: 28, textAlign: "center"
          }}>{np}%</span>
        </div>

        {/* Action buttons */}
        <div style={{ minHeight: 48 }}>
          {step === "sel" && m.st === "OPEN" && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: colorA + "8a" }}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); }}>
                ${m.c.sym}
              </button>
              <button style={{ ...bx, background: colorB + "8a" }}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); }}>
                ${m.cB?.sym}
              </button>
            </div>
          )}

          {step === "amt" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{
                display: "flex", justifyContent: "flex-end", alignItems: "center",
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em"
              }}>
                <span style={gld}>BAL: {bal.toLocaleString()}</span>
              </div>
              <input type="number" inputMode="numeric" pattern="[0-9]*" placeholder="Amount..."
                value={amt} onChange={e => setAmt(e.target.value)} autoFocus
                style={{
                  height: 42, border: "1px solid #4c5159", borderRadius: 15,
                  textAlign: "center", color: "#fff", background: "transparent",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1em", outline: "none",
                  width: "100%"
                }}/>
              <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                {[10, 25, 50, 100].map(p =>
                  <button key={p}
                    onClick={() => setAmt(String(Math.floor(bal * p / 100)))}
                    style={{
                      flex: 1, padding: "4px 0", borderRadius: 8,
                      fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em",
                      background: "#00000042", border: "1px solid #ffffff15",
                      color: "#ffffff80", cursor: "pointer"
                    }}>{p}%</button>
                )}
              </div>
              {amt && parseInt(amt) > 0 && (() => {
                const a = parseInt(amt);
                const net = a - Math.round(a * 0.02);
                const feeStr = net.toLocaleString() + " after 2% fee";
                if (net <= 0) return (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", textAlign: "center", marginBottom: 2 }}>{feeStr}</div>
                );
                const sh = buyShares(m.qY, m.qN, m.b, net, side);
                if (sh <= 0) return (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", textAlign: "center", marginBottom: 2 }}>{feeStr}</div>
                );
                const loserInv = side === "YES" ? m.nInv : m.yInv;
                if (loserInv <= 0) return (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", textAlign: "center", marginBottom: 2 }}>
                    {feeStr} / ~1.0x if {sideLabel(side)} wins
                  </div>
                );
                const winnerSh = (side === "YES" ? m.qY - m.b + sh : m.qN - m.b + sh);
                const payout = Math.min(net + Math.round(sh / winnerSh * loserInv), net * 10);
                const mult = Math.min(payout / net, 10).toFixed(1);
                return (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", textAlign: "center", marginBottom: 2 }}>
                    {feeStr} / ~{mult}x if {sideLabel(side)} wins
                  </div>
                );
              })()}
              <div style={{ display: "flex", gap: 10 }}>
                <button style={{ ...bx, background: "#00000042", flex: "0 0 40px" }}
                  onClick={() => { setStep("sel"); setSide(null); setAmt(""); }}>X</button>
                <button
                  style={{ ...bx, flex: "1 1 auto", background: side === "YES" ? colorA + "8a" : colorB + "8a" }}
                  onClick={doBuy}
                  disabled={!amt || parseInt(amt) <= 0 || parseInt(amt) > bal}>
                  BET {sideLabel(side)} {amt ? "(" + parseInt(amt).toLocaleString() + ")" : ""}
                </button>
              </div>
            </div>
          )}

          {step === "pos" && pos && m.st === "OPEN" && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: pos.side === "YES" ? colorA : colorB }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>ADD MORE {pos.side === "YES" ? m.c.sym : (m.cB?.sym || "?")}</button>
              <button style={{ ...bx, background: (pos.side === "YES" ? colorA : colorB) + "8a" }}
                onClick={() => onSell(m.id)}>SELL</button>
            </div>
          )}

          {step === "res" && (() => {
            const won = pos && m.res === pos.side;
            const baseReward = won && m.wws > 0
              ? Math.min(pos.inv + Math.round(pos.sh / m.wws * (m.pot - m.wis)), pos.inv * 10)
              : 0;
            const winnerSym = m.res === "YES" ? m.c.sym : m.cB?.sym;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{
                  fontFamily: "'Londrina Solid',sans-serif", fontSize: ".9em",
                  textAlign: "center", marginBottom: 4,
                  color: m.res === "YES" ? colorA : colorB
                }}>${winnerSym} WON!</div>
                {pos && !pos.claimed && (
                  <button style={{ ...bx, background: won ? "#71baff" : "#f65e5e30" }}
                    onClick={() => onClaim(m.id)}>
                    {won
                      ? "CLAIM " + baseReward.toLocaleString()
                      : "YOU LOST. CLOSE."}
                  </button>
                )}
                {pos && pos.claimed && (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", textAlign: "center", padding: 8 }}>CLAIMED</div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Footer: players + pool */}
      <div style={{
        display: "flex", alignItems: "center", marginTop: 10,
        padding: "0 16px 0 14px", justifyContent: "space-between"
      }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: ".75em", gap: 8 }}>
          {players.length > 0 && marketPool(m.qY, m.qN, m.b) > 0 && (
            <div style={{ display: "flex", alignItems: "center" }}>
              {players.slice(0, 3).map((p, i) => (
                <div key={p.userId} style={{
                  width: 24, height: 24, borderRadius: "50%", border: "2px solid #191f29",
                  marginLeft: i > 0 ? -8 : 0, zIndex: 3 - i,
                  background: p.img ? `url(${p.img}) center/cover` : "linear-gradient(135deg,#4e596c,#212936)",
                  position: "relative"
                }}/>
              ))}
              {players.length > 3 && (
                <span style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em",
                  color: "#ffffff60", marginLeft: 4
                }}>+{players.length - 3}</span>
              )}
            </div>
          )}
          <span style={{
            fontFamily: "'Jersey 25',sans-serif", fontSize: ".7em",
            background: "linear-gradient(90deg, " + colorA + "40, " + colorB + "40)",
            padding: "2px 6px", borderRadius: 4, color: "#ffffffcc"
          }}>48H BATTLE</span>
        </div>
        {marketPool(m.qY, m.qN, m.b) > 0 && <span style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
          <span style={{ color: "#ffffff30", marginRight: 4 }}></span>
          <span style={gld}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</span>
        </span>}
      </div>
    </div>
  );
};

const TreasureChestDialog = ({ questId, authToken, onClose, isMobile }) => {
  const [step, setStep] = useState("picking"); // picking | opening | reward
  const [selected, setSelected] = useState(null); // 0, 1, 2
  const [hovering, setHovering] = useState(null);
  const [reward, setReward] = useState(0);
  const [fading, setFading] = useState(false);

  const CHEST_IMG = "https://meme.com/assets/images/farm/quest/daily-chest-closed.webp";
  const CHEST_OPEN = "https://meme.com/assets/images/farm/quest/daily-chest-opened.webp";

  const handleOpen = async () => {
    if (selected === null) return;
    setStep("opening");
    setFading(true);

    // Fire API call in parallel with animation
    const apiPromise = claimChest(authToken, questId, selected);

    // Animation: fade non-selected, then center selected
    await new Promise(r => setTimeout(r, 600));

    const result = await apiPromise;
    if (result && result.rewarded_meme_score != null) {
      setReward(result.rewarded_meme_score);
      // Brief pause before showing reward
      await new Promise(r => setTimeout(r, 400));
      setStep("reward");
    } else {
      onClose(null);
    }
  };

  const modalBase = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
    display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", zIndex: 100
  };

  return (
    <div style={modalBase} onClick={() => step === "picking" && onClose(null)}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "url(https://meme.com/assets/images/farm/quest/quest-daily-dialog-bg-v1.webp) center/cover",
        borderRadius: isMobile ? "20px 20px 0 0" : 20,
        padding: 0, width: isMobile ? "100%" : "auto",
        minWidth: isMobile ? "auto" : 380, maxWidth: isMobile ? "100%" : 440,
        position: "relative", overflow: "hidden"
      }}>
        {/* Dark overlay */}
        <div style={{
          position: "absolute", inset: 0,
          background: "rgba(12,16,24,0.55)", pointerEvents: "none"
        }}/>

        <div style={{ position: "relative", zIndex: 1, padding: isMobile ? "28px 20px 32px" : "32px 32px 28px" }}>
          {/* Close button */}
          {step === "picking" && (
            <button onClick={() => onClose(null)} style={{
              position: "absolute", top: 12, right: 12, background: "none",
              border: "none", color: "#ffffff60", cursor: "pointer", fontSize: "1.2em", zIndex: 2
            }}>✕</button>
          )}

          {/* Title */}
          <div style={{
            fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.4em",
            textAlign: "center", marginBottom: 4,
            opacity: step === "opening" && fading ? 0 : 1,
            transition: "opacity 0.4s"
          }}>
            {step === "reward" ? (
              <span style={gld}>Chest Opened!</span>
            ) : (
              <><span style={gld}>Daily</span> Treasure Chest</>
            )}
          </div>

          {step === "picking" && (
            <div style={{
              fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em",
              color: "#ffffff50", textAlign: "center", marginBottom: 16
            }}>Pick a chest</div>
          )}

          {/* Three chests */}
          <div style={{
            display: "flex", justifyContent: "center", gap: isMobile ? 12 : 20,
            margin: "8px 0 20px", minHeight: 110, alignItems: "center",
            position: "relative"
          }}>
            {[0, 1, 2].map(i => {
              const isSelected = selected === i;
              const isOther = selected !== null && !isSelected;
              const hide = fading && isOther;
              const centered = step !== "picking" && isSelected;

              return (
                <div key={i} style={{
                  width: centered ? 120 : 90, height: centered ? 120 : 90,
                  cursor: step === "picking" ? "pointer" : "default",
                  opacity: hide ? 0 : 1,
                  transform: hide ? "translateY(20px) scale(0.8)" : (
                    centered ? "scale(1)" : (
                      isSelected && step === "picking" ? "scale(1.08)" : "scale(1)"
                    )
                  ),
                  transition: "all 0.5s cubic-bezier(0.4,0,0.2,1)",
                  position: centered ? "absolute" : "relative",
                  left: centered ? "50%" : "auto",
                  marginLeft: centered ? -60 : 0,
                  filter: isSelected && step === "picking"
                    ? "drop-shadow(0 0 12px rgba(247,147,26,0.5))"
                    : (hovering === i ? "drop-shadow(0 0 8px rgba(113,186,255,0.4))" : "none"),
                  animation: (hovering === i && step === "picking" && !isSelected)
                    ? "chestShake 1.5s cubic-bezier(0.36,0.07,0.19,0.97) both"
                    : (isSelected && step === "picking" ? "chestSelectedPulse 2s ease-in-out infinite" : undefined),
                  zIndex: isSelected ? 2 : 1
                }}
                  onMouseEnter={() => step === "picking" && setHovering(i)}
                  onMouseLeave={() => setHovering(null)}
                  onClick={() => step === "picking" && setSelected(i)}
                >
                  <img
                    src={step === "reward" && isSelected ? CHEST_OPEN : CHEST_IMG}
                    alt={`Chest ${i + 1}`}
                    style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none", pointerEvents: "none" }}
                    onError={e => { e.target.style.display = "none"; }}
                  />
                </div>
              );
            })}
          </div>

          {/* Reward display */}
          {step === "reward" && (
            <div style={{ textAlign: "center", animation: "rewardPop 0.5s ease-out", marginBottom: 8 }}>
              <div style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: "2em", ...gld
              }}>+{reward.toLocaleString()}</div>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".9em", color: "#ffffff60"
              }}>MEMESCORE</div>
            </div>
          )}

          {/* Opening spinner */}
          {step === "opening" && (
            <div style={{ textAlign: "center", marginBottom: 8 }}>
              <div style={{
                width: 28, height: 28, border: "3px solid #ffffff20",
                borderTopColor: "#f7931a", borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
                margin: "0 auto"
              }}/>
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: "flex", justifyContent: "center" }}>
            {step === "picking" && (
              <button onClick={handleOpen} disabled={selected === null} style={{
                width: "100%", height: 44, borderRadius: 15, border: "none",
                background: selected !== null ? "#71baff" : "#ffffff15",
                color: selected !== null ? "#fff" : "#ffffff40",
                cursor: selected !== null ? "pointer" : "not-allowed",
                fontFamily: "'Jersey 25',sans-serif", fontSize: "1.1em",
                textTransform: "uppercase", transition: "all 0.2s"
              }}>OPEN</button>
            )}
            {step === "reward" && (
              <button onClick={() => onClose(reward)} style={{
                width: "100%", height: 44, borderRadius: 15, border: "none",
                background: "#71baff", color: "#fff", cursor: "pointer",
                fontFamily: "'Jersey 25',sans-serif", fontSize: "1.1em",
                textTransform: "uppercase"
              }}>CLAIM</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const TreasureChestCard = ({ chestState, chestCooldown, chestReward, chestQuest, onClaim, isMobile }) => {
  const minReward = chestQuest?.params?.questInfo?.minimumReward || chestQuest?.params?.minimum_reward || 1000;
  const maxReward = chestQuest?.params?.questInfo?.maximumReward || chestQuest?.params?.maximum_reward || 50000;

  const isAvailable = chestState === "available";
  const isOpening = chestState === "opening";
  const isReward = chestState === "reward";
  const isCooldown = chestState === "cooldown";
  const locked = isCooldown && chestCooldown > 0;

  const chestImg = isReward
    ? "https://meme.com/assets/images/farm/quest/daily-chest-opened.webp"
    : "https://meme.com/assets/images/farm/quest/daily-chest-closed.webp";

  const hours = String(Math.floor(chestCooldown / 3600)).padStart(2, "0");
  const mins = String(Math.floor((chestCooldown % 3600) / 60)).padStart(2, "0");
  const secs = String(chestCooldown % 60).padStart(2, "0");

  const bx = {
    height: 38, display: "flex", alignItems: "center", justifyContent: "center",
    width: "100%", fontFamily: "'Jersey 25',sans-serif", fontSize: "1em",
    textTransform: "uppercase", borderRadius: 15, cursor: "pointer",
    border: "none", color: "#fff"
  };

  return (
    <div style={{
      background: "linear-gradient(360deg,#212936,#4e596c)",
      boxShadow: "0 4px 44px #ffffff12,0 4px 12px #000000b8",
      borderRadius: "16px 16px 25px 25px", padding: "5px 6px 10px",
      opacity: locked ? 0.6 : 1, transition: "opacity 0.2s"
    }}>
      <div style={{
        background: "url(https://meme.com/assets/images/farm/quest/quest-daily-v1.webp) center/cover",
        borderRadius: 14, padding: "14px 18px",
        minHeight: 192, display: "flex", flexDirection: "column",
        justifyContent: "space-between", position: "relative", overflow: "hidden"
      }}>
        {/* Dark overlay */}
        <div style={{
          position: "absolute", inset: 0, borderRadius: 14,
          background: "rgba(25,31,41,0.82)", pointerEvents: "none"
        }}/>

        {/* Content on top of overlay */}
        <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          {/* Header row */}
          <div style={{
            display: "flex", alignItems: "center", gap: 11, alignSelf: "flex-start", marginBottom: 8
          }}>
            <div style={{
              fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.05em",
              textTransform: "uppercase",
              textShadow: "0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
              lineHeight: 1.2
            }}><span style={gld}>Daily</span> Treasure Chest</div>
          </div>

          {/* Chest image */}
          <div style={{
            position: "relative", width: 80, height: 80, margin: "2px 0 8px",
            animation: (isAvailable || (isCooldown && chestCooldown === 0)) ? "chestShake 5s cubic-bezier(0.36,0.07,0.19,0.97) both infinite" : undefined
          }}>
            <img src={chestImg} alt="Treasure Chest"
              style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none", pointerEvents: "none" }}
              onError={e => { e.target.style.display = "none"; }}/>
            {isOpening && (
              <div style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center",
                justifyContent: "center", background: "rgba(0,0,0,0.4)", borderRadius: 8
              }}>
                <div style={{
                  width: 24, height: 24, border: "3px solid #ffffff30",
                  borderTopColor: "#f7931a", borderRadius: "50%",
                  animation: "spin 0.8s linear infinite"
                }}/>
              </div>
            )}
          </div>

          {/* Reward or description + action */}
          {isReward ? (
            <div style={{ animation: "rewardPop 0.5s ease-out", marginBottom: 4 }}>
              <div style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.3em", ...gld
              }}>+{chestReward.toLocaleString()}</div>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em", color: "#ffffff60"
              }}>MEMESCORE EARNED!</div>
            </div>
          ) : (
            <div style={{ width: "100%" }}>
              <div style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: ".8em",
                lineHeight: 1.4, color: "#ffffff90", marginBottom: 10
              }}>
                Open to earn between <span style={gld}>{minReward.toLocaleString()}–{maxReward.toLocaleString()}</span> memescore
              </div>
              {isAvailable && (
                <button onClick={onClaim} style={{ ...bx, background: "#71baff8a" }}>OPEN CHEST</button>
              )}
              {isCooldown && chestCooldown === 0 && (
                <button onClick={onClaim} style={{ ...bx, background: "linear-gradient(90deg,#71BAFF,#4023C3)" }}>LOGIN TO OPEN</button>
              )}
              {isOpening && (
                <div style={{ ...bx, background: "#ffffff10", cursor: "default" }}>OPENING...</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer — same as market cards */}
      <div style={{
        display: "flex", alignItems: "center", marginTop: 10,
        padding: "0 16px 0 14px", justifyContent: "space-between"
      }}>
        <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", color: "#ffffff50", display: "flex", alignItems: "center", gap: 6 }}>
          {locked && (
            <span style={{ ...gld, letterSpacing: 1, fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em" }}>
              {hours}:{mins}:{secs}
            </span>
          )}
          {isAvailable && <span style={{ color: "#4ade80", fontFamily: "'Jersey 25',sans-serif" }}>READY</span>}
          {isReward && <span style={{ fontFamily: "'Jersey 25',sans-serif", color: "#f7931a" }}>CLAIMED</span>}
        </div>
        <span style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
          <span style={gld}>+{minReward.toLocaleString()}–{maxReward.toLocaleString()}</span>
        </span>
      </div>
    </div>
  );
};

function App() {
  const [mks, setMks] = useState([]);
  const [pos, setPos] = useState({});
  const [bal, setBal] = useState(0);
  const [hist, setHist] = useState([]);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [totalVolume, setTotalVolume] = useState(0);
  const [myProfit, setMyProfit] = useState(0);
  const [loading, setLoading] = useState(true);
  const dbLoaded = React.useRef(false);
  const [marketPlayers, setMarketPlayers] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [, tick] = useState(0);
  const [memeUser, setMemeUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [memescore, setMemescore] = useState(0);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [holdings, setHoldings] = useState(null); // null = not loaded, [] = empty
  const [leaderboard, setLeaderboard] = useState([]);
  const [marketHistory, setMarketHistory] = useState([]);
  const [chestQuest, setChestQuest] = useState(null);
  const [chestCooldown, setChestCooldown] = useState(0);
  const [chestState, setChestState] = useState("cooldown"); // "available" | "cooldown" | "opening" | "reward"
  const [chestReward, setChestReward] = useState(0);
  const [showChestDialog, setShowChestDialog] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [lastCensusAt, setLastCensusAt] = useState(null);
  const [scanError, setScanError] = useState(null);

  // Refresh leaderboard and market history from database
  const refreshLeaderboard = useCallback(async () => {
    const leaders = await loadLeaderboardFromDb();
    if (leaders) setLeaderboard(leaders);
    const players = await loadMarketPlayersFromDb();
    setMarketPlayers(players);
    const history = await loadMarketHistoryFromDb();
    if (history) setMarketHistory(history);
  }, []);

  // Load inventory from census data
  const loadInventory = useCallback(async (uid) => {
    if (!supabase || !uid) return;
    try {
      const { data, error } = await supabase
        .from("labs_user_inventory")
        .select("coin_symbol, coin_name, coin_image, tier, usd_value")
        .eq("user_id", uid)
        .order("usd_value", { ascending: false });
      if (error) { console.warn("Inventory load failed:", error.message); return; }
      setHoldings(data || []);
    } catch (e) { console.warn("Inventory load error:", e); }
  }, []);

  const [notification, setNotification] = useState(null);
  const initialized = useRef(false);
  const seenResolutions = useRef(new Set());
  const userId = useRef(null);
  const isMobile = useIsMobile();

  // Auth + init on mount (sequential to avoid race condition)
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const initAll = async () => {
      // Step 1: Check auth and set userId before anything else
      const auth = getMemeAuth();
      let currentUser = null;
      if (auth) {
        const user = await fetchMemeUser(auth.token);
        if (user) {
          currentUser = user;
          setAuthToken(auth.token);
          setMemeUser(user);
          userId.current = getUserId(user.id);

          // Fetch memescore from meme.com API (for deposit modal)
          const balances = await fetchLabsBalance(auth.token);
          setMemescore(balances.memescore);

          // Fetch daily treasure chest quest
          const quest = await fetchChestQuest(auth.token);
          if (quest) {
            setChestQuest(quest);
            if (quest._isAvailable) {
              setChestState("available");
            } else {
              // On cooldown — check params for remaining time
              const cooldownUntil = quest.params?.cooldown_until;
              if (cooldownUntil) {
                const remaining = Math.max(0, Math.floor((new Date(cooldownUntil).getTime() - Date.now()) / 1000));
                setChestCooldown(remaining);
                setChestState(remaining > 0 ? "cooldown" : "available");
              } else {
                setChestCooldown(24 * 3600);
                setChestState("cooldown");
              }
            }
          }
        } else {
          // Token rejected (expired/invalid) — clear cached token
          clearCachedAuth();
          userId.current = getUserId(null);
        }
      } else {
        userId.current = getUserId(null);
      }

      // Migrate data from old anonymous ID to new meme ID (one-time)
      if (currentUser && supabase) {
        const oldAnonId = localStorage.getItem("labs_user_id");
        if (oldAnonId && oldAnonId !== userId.current) {
          try {
            // Move positions from old ID to new ID
            await supabase.from("labs_positions")
              .update({ user_id: userId.current })
              .eq("user_id", oldAnonId);
            // Move trades from old ID to new ID
            await supabase.from("labs_trades")
              .update({ user_id: userId.current })
              .eq("user_id", oldAnonId);
            // Copy stats from old user record
            const { data: oldUser } = await supabase.from("labs_users")
              .select("*").eq("id", oldAnonId).single();
            if (oldUser) {
              await supabase.from("labs_users").upsert({
                id: userId.current,
                username: currentUser.username,
                profile_image: currentUser.image,
                labs_balance: oldUser.labs_balance,
                total_volume: oldUser.total_volume,
                wins: oldUser.wins,
                losses: oldUser.losses,
                current_streak: oldUser.current_streak,
                best_streak: oldUser.best_streak
              });
              // Clean up old anonymous record
              await supabase.from("labs_users").delete().eq("id", oldAnonId);
            }
            // Mark migration done
            localStorage.removeItem("labs_user_id");
            console.log("Migrated user data from", oldAnonId, "to", userId.current);
          } catch (e) {
            console.log("Migration skipped:", e.message);
          }
        }
      }

      // Step 2: Initialize app state (userId is now set)
      const saved = loadState();
      await ensureUserInDb(userId.current, currentUser);

      // Load leaderboard and history
      const leaders = await loadLeaderboardFromDb();
      if (leaders) setLeaderboard(leaders);

      const history = await loadMarketHistoryFromDb();
      if (history) setMarketHistory(history);

      const coins = await fetchCoins();
      if (coins.length === 0) {
        setLoading(false);
        return;
      }

      // Fetch battle coin metadata from CoinGecko Pro (correct images/names)
      await fetchBattleCoinMetadata();

      const coinMap = {};
      coins.forEach(c => { coinMap[c.sym] = c; });

      // Try loading from Supabase first
      const dbPositions = await loadPositionsFromDb(userId.current);
      // Load all markets (including resolved) so we can show claim UI for unclaimed positions
      const dbMarkets = await loadMarketsFromDb(true);
      const dbUser = await loadUserFromDb(userId.current);
      const players = await loadMarketPlayersFromDb();
      const sideInv = await loadSideInvested();
      setMarketPlayers(players);

      if (dbMarkets && dbMarkets.length > 0) {
        // Show OPEN markets + resolved markets with unclaimed positions
        const posMarketIds = dbPositions ? new Set(Object.keys(dbPositions)) : new Set();
        const relevantMarkets = dbMarkets.filter(db =>
          db.status === "OPEN" || (db.status === "RES" && posMarketIds.has(db.id))
        );
        const localMks = relevantMarkets.map(db => {
          const m = dbMarketToLocal(db, coinMap[db.coin_symbol], battleCoinMap[db.coin_b_symbol]);
          if (sideInv[db.id]) { m.yInv = sideInv[db.id].YES || 0; m.nInv = sideInv[db.id].NO || 0; }
          return m;
        });
        // Create UPDOWN markets for any coins missing an OPEN market
        const openSyms = new Set(dbMarkets.filter(db => db.status === "OPEN" && (db.market_type || "UPDOWN") === "UPDOWN").map(db => db.coin_symbol));
        coins.forEach(c => {
          if (!openSyms.has(c.sym)) {
            const highest = dbMarkets.filter(db => db.coin_symbol === c.sym && (db.market_type || "UPDOWN") === "UPDOWN")
              .reduce((max, db) => { const rn = parseInt(db.id.split("-")[1]) || 0; return rn > max ? rn : max; }, 0);
            const newM = mk(c, highest + 1);
            localMks.push(newM);
            syncMarketToDb(newM);
          }
        });
        // Create battle market if none exists (battleCoinMap already populated by fetchBattleCoinMetadata)
        const hasOpenBattle = dbMarkets.some(db => db.status === "OPEN" && db.market_type === "BATTLE");
        if (!hasOpenBattle && Object.keys(battleCoinMap).length >= 2) {
          const matchup = pickBattleMatchup(battleCoinMap);
          if (matchup) {
            const [symA, symB] = matchup;
            const cA = battleCoinMap[symA];
            const cB = battleCoinMap[symB];
            const highestBattle = dbMarkets.filter(db => db.market_type === "BATTLE")
              .reduce((max, db) => { const rn = parseInt(db.id.split("-").pop()) || 0; return rn > max ? rn : max; }, 0);
            const battleM = mkBattle(cA, cB, highestBattle + 1);
            localMks.push(battleM);
            syncMarketToDb(battleM);
          }
        }
        setMks(dedup(localMks));

        // Load user data from database — Supabase is source of truth for arena balance
        if (dbUser) {
          setBal(dbUser.labs_balance ?? 0);
          setStreak(dbUser.current_streak ?? 0);
          setBestStreak(dbUser.best_streak ?? 0);
          setWins(dbUser.wins ?? 0);
          setLosses(dbUser.losses ?? 0);
          setTotalVolume(dbUser.total_volume ?? 0);
          setMyProfit(dbUser.total_profit ?? 0);
          setLastCensusAt(dbUser.last_census_at || null);
        } else if (!currentUser && saved) {
          // Only fall back to localStorage for anonymous users (not logged-in users)
          if (saved.bal > 0) setBal(saved.bal);
          setStreak(saved.streak || 0);
        }

        // Load positions from database (null = DB error, empty = no positions)
        if (dbPositions !== null) {
          setPos(dbPositions);
        } else if (saved) {
          setPos(saved.pos || {});
        }

        // Load trade history from database
        const dbHist = await loadTradeHistoryFromDb(userId.current);
        if (dbHist && dbHist.length > 0) {
          setHist(dbHist.reverse()); // oldest first (display reverses again)
        } else if (saved) {
          setHist(saved.hist || []);
        }
      } else if (saved && saved.mks && saved.mks.length > 0) {
        // Fallback to localStorage
        const restoredMks = saved.mks.map(m => {
          const freshCoin = coinMap[m.c.sym];
          if (freshCoin) {
            return { ...m, c: { ...m.c, img: freshCoin.img, color: freshCoin.color } };
          }
          return m;
        }).filter(m => m);

        setMks(restoredMks);
        setPos(saved.pos || {});
        setBal(saved.bal ?? 0);
        setHist(saved.hist || []);
        setStreak(saved.streak || 0);

        // Sync to Supabase
        restoredMks.forEach(m => syncMarketToDb(m));
      } else {
        // First time - create fresh markets
        const newMks = coins.map(c => mk(c, 1));
        setMks(newMks);

        // Sync new markets to Supabase
        newMks.forEach(m => syncMarketToDb(m));
      }
      dbLoaded.current = true;
      setLoading(false);
    };

    initAll();
  }, []);

  // wins, losses, totalVolume are loaded from DB (source of truth)
  // totalVolume is incremented by labs_buy RPC on each trade

  // Save state whenever it changes (only after DB values are loaded)
  useEffect(() => {
    if (loading || !dbLoaded.current || mks.length === 0) return;
    saveState({ mks, pos, bal, hist, streak, bestStreak, savedAt: Date.now() });

    // Sync user stats to database (balance managed by RPCs only, volume by labs_buy RPC)
    syncUserToDb(userId.current, totalVolume, wins, losses, streak, bestStreak);
  }, [mks, pos, bal, hist, streak, bestStreak, loading, wins, losses]);

  // Chest cooldown timer
  useEffect(() => {
    if (chestState !== "cooldown") return;
    const i = setInterval(() => {
      setChestCooldown(prev => {
        if (prev <= 1) {
          setChestState("available");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(i);
  }, [chestState]);

  // Chest claim handler — opens the picking dialog
  const handleChestClaim = useCallback(() => {
    if (!authToken || !chestQuest || chestState !== "available") return;
    setShowChestDialog(true);
  }, [authToken, chestQuest, chestState]);

  // Dialog close handler — receives reward or null
  const handleChestDialogClose = useCallback(async (reward) => {
    setShowChestDialog(false);
    if (reward && reward > 0) {
      setChestReward(reward);
      setChestState("reward");
      // Refresh memescore
      const balances = await fetchLabsBalance(authToken);
      setMemescore(balances.memescore);
      // Transition to cooldown after showing reward on card
      setTimeout(() => {
        setChestCooldown(24 * 3600);
        setChestState("cooldown");
      }, 3000);
    }
  }, [authToken]);

  // Price feed from CoinGecko (every 60s for UPDOWN, separate CG Pro for battles), synced to DB
  useEffect(() => {
    if (mks.length === 0) return;

    const updatePrices = async () => {
      // UPDOWN price feed (free tier)
      const updownMarkets = mks.filter(m => m.st === "OPEN" && m.type !== "BATTLE");
      if (updownMarkets.length > 0) {
        const coins = updownMarkets.map(m => m.c);
        const prices = await fetchPrices(coins);
        if (supabase && Object.keys(prices).length > 0) {
          const now = new Date().toISOString();
          for (const m of updownMarkets) {
            const data = prices[m.c.sym.toLowerCase()];
            // Only update if price changed by >0.5% to avoid source jitter
            if (data && data.mcap && m.mc > 0) {
              const pctDiff = Math.abs(data.mcap - m.mc) / m.mc;
              if (pctDiff > 0.005) {
                await supabase.from("labs_markets").update({
                  current_mc: data.mcap,
                  price_updated_at: now
                }).eq("id", m.id);
              }
            }
          }
        }
      }

      // Battle price feed (CG Pro, rate limited to 1 call per 60s)
      const battleMarket = mks.find(m => m.st === "OPEN" && m.type === "BATTLE");
      if (battleMarket && supabase && Date.now() - lastBattlePriceCall >= 60000) {
        try {
          const cgIdA = BATTLE_COINS[battleMarket.c.sym];
          const cgIdB = BATTLE_COINS[battleMarket.cB?.sym];
          if (cgIdA && cgIdB) {
            const cgRes = await fetch(
              `${CG_PRO_API}/coins/markets?vs_currency=usd&ids=${cgIdA},${cgIdB}&order=market_cap_desc`,
              { headers: CG_PRO_HEADERS }
            );
            if (cgRes.ok) {
              const cgData = await cgRes.json();
              const coinACg = cgData.find(x => x.id === cgIdA);
              const coinBCg = cgData.find(x => x.id === cgIdB);
              const update = { price_updated_at: new Date().toISOString() };
              if (coinACg) update.current_mc = coinACg.market_cap;
              if (coinBCg) update.current_mc_b = coinBCg.market_cap;
              await supabase.from("labs_markets").update(update).eq("id", battleMarket.id);
            }
            lastBattlePriceCall = Date.now();
          }
        } catch (e) {
          console.warn("Battle CG Pro price fetch failed:", e);
        }
      }
    };

    updatePrices();
    const i = setInterval(updatePrices, 60000);
    return () => clearInterval(i);
  }, [mks.length]);

  // Periodic leaderboard refresh (every 30 seconds)
  useEffect(() => {
    if (loading) return;
    const i = setInterval(refreshLeaderboard, 30000);
    return () => clearInterval(i);
  }, [loading, refreshLeaderboard]);

  // Periodic market state refresh from DB (every 15 seconds)
  useEffect(() => {
    if (loading || mks.length === 0) return;
    const refreshMarkets = async () => {
      const [dbMarkets, sideInv] = await Promise.all([loadMarketsFromDb(true), loadSideInvested()]);
      if (!dbMarkets || dbMarkets.length === 0) return;
      const dbMap = {};
      dbMarkets.forEach(db => { dbMap[db.id] = db; });

      setMks(prev => {
        const localIds = new Set(prev.map(m => m.id));
        let updated = prev.map(m => {
          const db = dbMap[m.id];
          if (!db) return m;
          const b = m.b;
          const si = sideInv[m.id] || {};
          const battleExtra = m.type === "BATTLE" ? {
            mcB: Number(db.current_mc_b) || m.mcB,
            startMcB: Number(db.start_mc_b) || m.startMcB
          } : {};
          // If DB says resolved but local says open, sync resolution
          if (db.status === "RES" && m.st === "OPEN") {
            return { ...m, st: "RES", res: db.result,
              mc: Number(db.current_mc) || m.mc,
              qY: (Number(db.q_yes) || 0) + b,
              qN: (Number(db.q_no) || 0) + b,
              fp: Number(db.fee_pool) || 0,
              pot: Number(db.total_pot) || 0,
              wws: Number(db.winner_weight_sum) || 0,
              wis: Number(db.winner_invested_sum) || 0,
              yInv: si.YES || 0, nInv: si.NO || 0,
              vol: Number(db.volume) || m.vol,
              ppl: Number(db.players) || m.ppl,
              ...battleExtra
            };
          }
          if (m.st !== "OPEN") return { ...m, fp: Number(db.fee_pool) || m.fp || 0, pot: Number(db.total_pot) || m.pot || 0, wws: Number(db.winner_weight_sum) || m.wws || 0, wis: Number(db.winner_invested_sum) || m.wis || 0, yInv: si.YES || m.yInv || 0, nInv: si.NO || m.nInv || 0, ...battleExtra };
          return {
            ...m,
            mc: Number(db.current_mc) || m.mc,
            startMc: Number(db.start_mc) || m.startMc,
            ea: db.expires_at ? new Date(db.expires_at).getTime() : m.ea,
            qY: (Number(db.q_yes) || 0) + b,
            qN: (Number(db.q_no) || 0) + b,
            fp: Number(db.fee_pool) || 0,
            vol: Number(db.volume) || m.vol,
            ppl: Number(db.players) || m.ppl,
            yInv: si.YES || m.yInv || 0, nInv: si.NO || m.nInv || 0,
            ...battleExtra
          };
        });
        // Add any new markets from DB that we don't have locally (OPEN, or resolved with position)
        dbMarkets.filter(db => !localIds.has(db.id) && (db.status === "OPEN" || (db.status === "RES" && pos[db.id] && !pos[db.id].claimed))).forEach(db => {
          const coinData = prev.find(m => m.c.sym === db.coin_symbol)?.c || (db.market_type === "BATTLE" ? battleCoinMap[db.coin_symbol] : null);
          const coinDataB = db.coin_b_symbol ? (prev.find(m => m.cB?.sym === db.coin_b_symbol)?.cB || battleCoinMap[db.coin_b_symbol]) : null;
          updated.push(dbMarketToLocal(db, coinData, coinDataB));
        });
        return dedup(updated);
      });
    };
    const refreshAll = async () => {
      await refreshMarkets();
      const players = await loadMarketPlayersFromDb();
      setMarketPlayers(players);
      setLastUpdate(new Date());
    };
    const i = setInterval(refreshAll, 15000);
    return () => clearInterval(i);
  }, [loading, mks.length]);

  // Timer tick (for countdown display)
  useEffect(() => {
    const i = setInterval(() => tick(t => t+1), 1000);
    return () => clearInterval(i);
  }, []);

  // Auto-create new markets after resolution (DB trigger prevents duplicates)
  useEffect(() => {
    const i = setInterval(() => {
      setMks(p => {
        const openByKey = new Set(p.filter(m => m.st === "OPEN").map(m =>
          m.type === "BATTLE" ? "BATTLE" : m.c.sym
        ));
        const resolved = p.filter(m => m.st === "RES");
        const newMarkets = [];
        resolved.forEach(m => {
          // Skip if user has unclaimed position
          if (pos[m.id] && !pos[m.id].claimed) return;
          const key = m.type === "BATTLE" ? "BATTLE" : m.c.sym;
          if (openByKey.has(key)) return;
          if (m.type === "BATTLE") {
            // New random matchup for battle
            const matchup = pickBattleMatchup(battleCoinMap);
            if (matchup) {
              const [symA, symB] = matchup;
              const newM = mkBattle(battleCoinMap[symA], battleCoinMap[symB], m.rn + 1);
              newMarkets.push(newM);
              openByKey.add("BATTLE");
            }
          } else {
            const newM = mk({ ...m.c, mcap: m.mc }, m.rn + 1);
            newMarkets.push(newM);
            openByKey.add(m.c.sym);
          }
        });
        if (newMarkets.length === 0) return p;
        // Sync new markets to DB (prevent_duplicate_open trigger is safety net)
        newMarkets.forEach(m => syncMarketToDb(m));
        // Remove old resolved markets (that had no unclaimed position) and add new ones
        const resolvedIds = new Set(resolved.filter(m => !pos[m.id] || pos[m.id].claimed).map(m => m.id));
        return dedup([...p.filter(m => !resolvedIds.has(m.id)), ...newMarkets]);
      });
    }, 5000);
    return () => clearInterval(i);
  }, [pos]);

  // Show notification when market resolves and user has unclaimed position
  useEffect(() => {
    mks.forEach(m => {
      if (m.st === "RES" && !seenResolutions.current.has(m.id)) {
        const userPos = pos[m.id];
        if (userPos && !userPos.claimed) {
          seenResolutions.current.add(m.id);
          const won = m.res === userPos.side;
          const reward = won ? Math.round(userPos.sh) : 0;
          const hasBonus = won && (m.fp || 0) > 0;
          setNotification({
            id: m.id,
            coin: m.type === "BATTLE" ? m.c.sym + " vs " + m.cB?.sym : m.c.sym,
            result: m.res,
            won,
            reward,
            hasBonus,
            isBattle: m.type === "BATTLE",
            winnerSym: m.type === "BATTLE" ? (m.res === "YES" ? m.c.sym : m.cB?.sym) : null
          });
          // Auto-dismiss after 5 seconds
          setTimeout(() => setNotification(n => n?.id === m.id ? null : n), 5000);
        }
      }
    });
  }, [mks, pos]);

  const onBuy = useCallback(async (mid, side, amt) => {
    if (!memeUser) { setShowDeposit(true); return; }
    const m = mks.find(x => x.id===mid);
    if (!m || m.st !== "OPEN") return;

    // 2% entry fee — shares bought from net amount
    const fee = Math.round(amt * 0.02);
    const net = amt - fee;

    // Optimistic update for UI responsiveness
    const shares = buyShares(m.qY, m.qN, m.b, net, side);
    const isNewPlayer = !pos[mid];
    const updatedMarket = {
      ...m,
      qY: side==="YES" ? m.qY + shares : m.qY,
      qN: side==="NO" ? m.qN + shares : m.qN,
      fp: (m.fp || 0) + fee,
      vol: m.vol + amt,
      ppl: m.ppl + (isNewPlayer ? 1 : 0)
    };
    const existingPos = pos[mid];
    const newPosition = existingPos && existingPos.side === side
      ? { ...existingPos, sh: existingPos.sh + shares, inv: existingPos.inv + amt }
      : { side, sh: shares, inv: amt, claimed: false };

    setMks(p => p.map(mk => mk.id !== mid ? mk : updatedMarket));
    setPos(p => ({ ...p, [mid]: newPosition }));

    // Try atomic database function first, fall back to sync
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('labs_buy', {
          p_user_id: userId.current,
          p_market_id: mid,
          p_side: side,
          p_amount: amt
        });
        if (!error && data?.success) {
          // Update with server values (RPC already deducted balance, recorded trade, incremented volume)
          setMks(p => p.map(mk => {
            if (mk.id !== mid) return mk;
            return { ...mk, qY: mk.b + data.new_q_yes, qN: mk.b + data.new_q_no, fp: data.fee_pool || mk.fp };
          }));
          setBal(data.new_balance);
          setTimeout(refreshLeaderboard, 500);
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback: deduct locally and sync
    setBal(b => b - amt);
    syncMarketToDb(updatedMarket);
    syncPositionToDb(userId.current, mid, newPosition);
    recordTradeInDb(userId.current, mid, m.c.sym, side, shares, amt, 'BUY');
    // Deduct balance in DB atomically
    if (supabase) {
      await supabase.rpc('labs_adjust_balance', { p_user_id: userId.current, p_delta: -amt });
    }
    // Refresh leaderboard after fallback sync
    setTimeout(refreshLeaderboard, 500);
  }, [mks, pos, memeUser, refreshLeaderboard]);

  const onSell = useCallback(async (mid) => {
    if (!memeUser) { setShowDeposit(true); return; }
    const pp = pos[mid];
    const m = mks.find(x => x.id===mid);
    if (!pp || !m) return;
    const grossRf = sellShares(m.qY, m.qN, m.b, pp.sh, pp.side);
    // 2% exit fee
    const sellFee = Math.round(grossRf * 0.02);
    const netRf = grossRf - sellFee;
    const pnl = netRf - pp.inv;

    // Optimistic update for UI responsiveness
    const updatedMarket = {
      ...m,
      qY: pp.side==="YES" ? Math.max(0, m.qY - pp.sh) : m.qY,
      qN: pp.side==="NO" ? Math.max(0, m.qN - pp.sh) : m.qN,
      fp: (m.fp || 0) + sellFee,
      vol: m.vol + grossRf,
      ppl: Math.max(0, m.ppl - 1)
    };

    setMks(p => p.map(x => x.id !== mid ? x : updatedMarket));
    setPos(p => { const n={...p}; delete n[mid]; return n; });

    // Try atomic database function first, fall back to sync
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('labs_sell', {
          p_user_id: userId.current,
          p_market_id: mid
        });
        if (!error && data?.success) {
          // Update with server values (RPC already credited net balance)
          setMks(p => p.map(mk => {
            if (mk.id !== mid) return mk;
            return { ...mk, qY: mk.b + data.new_q_yes, qN: mk.b + data.new_q_no, fp: data.fee_pool || mk.fp };
          }));
          if (data.new_balance != null) setBal(data.new_balance);
          else setBal(b => b + netRf);
          setTimeout(refreshLeaderboard, 500);
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback: credit locally and sync
    setBal(b => b + netRf);
    syncMarketToDb(updatedMarket);
    syncPositionToDb(userId.current, mid, null);
    recordTradeInDb(userId.current, mid, m.c.sym, pp.side, pp.sh, netRf, 'SELL', null, pnl);
    // Credit balance and profit in DB atomically
    if (supabase) {
      await supabase.rpc('labs_adjust_balance', { p_user_id: userId.current, p_delta: netRf });
      await supabase.rpc('labs_adjust_profit', { p_user_id: userId.current, p_delta: pnl });
    }
    // Refresh leaderboard after fallback sync
    setTimeout(refreshLeaderboard, 500);
  }, [pos, mks, memeUser, refreshLeaderboard]);

  const onClaim = useCallback(async (mid) => {
    if (!memeUser) { setShowDeposit(true); return; }
    const pp = pos[mid];
    const m = mks.find(x => x.id===mid);
    if (!pp || !m || m.st!=="RES") return;

    // Use atomic labs_claim RPC
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('labs_claim', {
          p_user_id: userId.current,
          p_market_id: mid
        });
        if (!error && data?.success) {
          setBal(data.new_balance);
          setWins(data.new_wins);
          setLosses(data.new_losses);
          setStreak(data.new_streak);
          setBestStreak(data.new_best_streak);
          setMyProfit(mp => mp + data.pnl);
          setPos(p => ({ ...p, [mid]: { ...p[mid], claimed: true } }));
          setHist(h => [...h, {
            sym: m.c.sym, rn: m.rn, side: pp.side, result: m.res,
            rw: data.total_payout, inv: pp.inv, bonus: data.fee_bonus || 0
          }]);
          // Update fee pool locally
          if (data.fee_bonus > 0) {
            setMks(p => p.map(mk => mk.id !== mid ? mk : { ...mk, fp: Math.max(0, (mk.fp || 0) - data.fee_bonus) }));
          }
          setTimeout(refreshLeaderboard, 500);
          return;
        }
      } catch (e) {
        console.log("labs_claim RPC failed, using fallback:", e);
      }
    }

    // Fallback: manual claim (no fee bonus)
    const won = m.res===pp.side;
    const rw = won && m.wws > 0
      ? Math.min(pp.inv + Math.round(pp.sh / m.wws * (m.pot - m.wis)), pp.inv * 10)
      : 0;
    const pnl = rw - pp.inv;

    setBal(b => b+rw);
    setPos(p => ({ ...p, [mid]:{ ...p[mid], claimed:true }}));
    setHist(h => [...h, { sym:m.c.sym, rn:m.rn, side:pp.side, result:m.res, rw, inv:pp.inv }]);

    if (won) {
      setWins(w => w + 1);
      setStreak(s => {
        const newStreak = s + 1;
        setBestStreak(bs => Math.max(bs, newStreak));
        return newStreak;
      });
    } else {
      setLosses(l => l + 1);
      setStreak(0);
    }

    syncPositionToDb(userId.current, mid, null);
    recordTradeInDb(userId.current, mid, m.c.sym, pp.side, pp.sh, rw, 'CLAIM', m.res, pnl);
    if (supabase && rw > 0) {
      await supabase.rpc('labs_adjust_balance', { p_user_id: userId.current, p_delta: rw });
    }
    if (supabase) {
      await supabase.rpc('labs_adjust_profit', { p_user_id: userId.current, p_delta: pnl });
      setTimeout(refreshLeaderboard, 500);
    }
  }, [pos, mks, memeUser, refreshLeaderboard]);

  // Build display list: resolved with unclaimed position takes priority over OPEN for same key
  const ranked = useMemo(() => {
    const resByKey = {};
    const mKey = (m) => m.type === "BATTLE" ? battlePairKey(m.c.sym, m.cB?.sym || "") : m.c.sym;
    mks.forEach(m => {
      if (m.st === "RES" && pos[m.id] && !pos[m.id].claimed) resByKey[mKey(m)] = m;
    });
    const filtered = mks.filter(m => {
      if (m.st === "OPEN" && resByKey[mKey(m)]) return false;
      if (m.st === "RES" && (!pos[m.id] || pos[m.id].claimed)) return false;
      return true;
    });
    // Stable order: UPDOWN markets by symbol, battles go last
    const updown = filtered.filter(m => m.type !== "BATTLE");
    const battles = filtered.filter(m => m.type === "BATTLE");
    updown.sort((a, b) => a.c.sym.localeCompare(b.c.sym));
    return [...updown, ...battles];
  }, [mks, pos]);

  if (loading) {
    return (
      <div style={{
        minHeight:"100vh", background:"#0c1018", color:"#fff",
        display:"flex", alignItems:"center", justifyContent:"center",
        fontFamily:"'Jersey 25',sans-serif", fontSize:"1.5em"
      }}>
        Loading markets...
      </div>
    );
  }

  return (
    <div style={{
      minHeight:"100vh", background:"#0c1018", color:"#fff",
      fontFamily:"'Mulish',sans-serif",
      zoom: "150%"
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Londrina+Solid:wght@400;900&family=Jersey+25&family=Mulish:wght@400;700&display=swap" rel="stylesheet"/>

      {notification && (
        <div style={{
          position:"fixed", top:20, left:"50%", transform:"translateX(-50%)",
          zIndex:1000, padding:"16px 24px", borderRadius:16,
          background: notification.won ? "linear-gradient(135deg, #22c55e, #16a34a)" : "linear-gradient(135deg, #ef4444, #dc2626)",
          boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
          display:"flex", alignItems:"center", gap:12,
          animation:"slideDown 0.3s ease-out"
        }}>
          <style>{`@keyframes slideDown { from { opacity:0; transform:translateX(-50%) translateY(-20px); } to { opacity:1; transform:translateX(-50%) translateY(0); } } @keyframes timerPulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } } @keyframes priceFlash { 0% { opacity:1; transform:scale(1.2); } 30% { opacity:1; transform:scale(1); } 100% { opacity:1; transform:scale(1); } } @keyframes chestShake { 0%,100% { transform:translateX(0) rotateZ(0deg); } 4% { transform:translateX(-6px) rotateZ(-8deg); } 8% { transform:translateX(6px) rotateZ(6deg); } 12% { transform:translateX(-4px) rotateZ(-6deg); } 16% { transform:translateX(4px) rotateZ(4deg); } 20% { transform:translateX(-2px) rotateZ(-3deg); } 24% { transform:translateX(0) rotateZ(0deg); } } @keyframes spin { to { transform:rotate(360deg); } } @keyframes rewardPop { from { opacity:0; transform:scale(0.5); } to { opacity:1; transform:scale(1); } } @keyframes chestSelectedPulse { 0%,100% { transform:scale(1.08); filter:drop-shadow(0 0 12px rgba(247,147,26,0.5)); } 50% { transform:scale(1.14); filter:drop-shadow(0 0 20px rgba(247,147,26,0.7)); } }`}</style>
          <span style={{ fontSize:"1.5em" }}>{notification.isBattle ? "⚔️" : notification.result === "YES" ? "📈" : "📉"}</span>
          <div>
            <div style={{ fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em" }}>
              {notification.isBattle
                ? `$${notification.winnerSym} WON the battle!`
                : `$${notification.coin} ${notification.result === "YES" ? "WENT UP!" : "WENT DOWN"}`}
            </div>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".9em", opacity:.9 }}>
              {notification.won ? `You won! Claim ${notification.reward.toLocaleString()}${notification.hasBonus ? " + bonus" : ""}` : "Better luck next time"}
            </div>
          </div>
          <button
            onClick={() => setNotification(null)}
            style={{ background:"none", border:"none", color:"#fff", cursor:"pointer", fontSize:"1.2em", marginLeft:8 }}
          >×</button>
        </div>
      )}

      <div style={{
        padding: isMobile ? "10px 12px" : "12px 24px",
        borderBottom:"1px solid #ffffff0d",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        background:"#0f1620", position:"sticky", top:0, zIndex:10,
        gap: isMobile ? 8 : 16
      }}>
        <div style={{ flexShrink: 0 }}>
          <span style={{
            fontFamily:"'Londrina Solid',sans-serif",
            fontSize: isMobile ? "1.1em" : "1.5em",
            textTransform:"uppercase"
          }}>MEME.COM</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap: isMobile ? 8 : 16, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button onClick={() => setShowDeposit(true)} style={{
            display:"flex", alignItems:"center", gap: isMobile ? 6 : 10,
            background:"#0c1018", padding: isMobile ? "6px 10px" : "8px 14px", borderRadius:12,
            border:"1px solid #ffffff15", cursor:"pointer"
          }}>
            {!isMobile && <span style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", color:"#fff"
            }}>🧪 LABS:</span>}
            <span style={{
              ...gld, fontFamily:"'Jersey 25',sans-serif", fontSize: isMobile ? ".95em" : "1.05em"
            }}>{bal.toLocaleString()}</span>
            <span style={{
              background:"linear-gradient(90deg,#71BAFF,#4023C3)",
              borderRadius:5, padding: isMobile ? "2px 5px" : "3px 8px",
              fontFamily:"'Jersey 25',sans-serif", fontSize: isMobile ? ".6em" : ".7em",
              color:"#fff"
            }}>DEPOSIT</span>
          </button>
          <div onClick={() => { setShowProfile(true); loadInventory(userId.current); }} style={{
            display:"flex", alignItems:"center", gap: isMobile ? 5 : 8, cursor:"pointer",
            padding:"3px 10px 3px 3px", borderRadius:20,
            background:"#ffffff0a", border:"1px solid #ffffff12",
            transition:"background .15s, border-color .15s"
          }}
          onMouseEnter={e => { e.currentTarget.style.background="#ffffff15"; e.currentTarget.style.borderColor="#ffffff25"; }}
          onMouseLeave={e => { e.currentTarget.style.background="#ffffff0a"; e.currentTarget.style.borderColor="#ffffff12"; }}
          >
            <div style={{
              width: isMobile ? 22 : 24, height: isMobile ? 22 : 24, borderRadius: "50%", overflow:"hidden",
              background:"linear-gradient(135deg,#71BAFF,#4023C3)",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize: isMobile ? 11 : 12, fontWeight:700, flexShrink:0
            }}>
              {memeUser?.image
                ? <img src={memeUser.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                : <span>{(memeUser?.username || "G")[0].toUpperCase()}</span>
              }
            </div>
            {!isMobile && <span style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:".95em"
            }}>{memeUser?.username || "Guest"}</span>}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:"72em", margin:"0 auto", padding: isMobile ? "12px 12px 24px" : "20px 2.5% 48px" }}>
        <div style={{ marginBottom: isMobile ? 8 : 16 }}>
          <div style={{
            fontFamily:"'Londrina Solid',sans-serif", fontSize: isMobile ? "1.3em" : "1.6em",
            textTransform:"uppercase", textShadow:"0 2px 4px rgba(0,0,0,.5)"
          }}>Meme Arena{!isProd && <span style={{
            fontSize:".45em", background:"#ff4444", color:"#fff", padding:"2px 8px",
            borderRadius:4, marginLeft:10, verticalAlign:"middle", letterSpacing:1
          }}>DEV</span>}</div>
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize: isMobile ? ".75em" : ".9em",
            color:"#ffffff60"
          }}>
            {isMobile ? "24h prediction rounds" : "Predict targets. Vote with conviction on your favorite memes. "}
          </div>
        </div>

        <div style={{
          display: isMobile ? "flex" : "grid",
          flexDirection: isMobile ? "column" : undefined,
          gridTemplateColumns: isMobile ? undefined : "1fr 20em",
          gap: 20,
          alignItems: isMobile ? "stretch" : "start"
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(17em, 1fr))",
            gap: isMobile ? 12 : 16
          }}>
            {ranked.map(m =>
              m.type === "BATTLE"
                ? <div key={m.id} style={{ gridColumn: isMobile ? undefined : "span 2" }}>
                    <BattleCard m={m} bal={bal} streak={streak}
                      pos={pos[m.id]||null}
                      players={marketPlayers[m.id]||[]}
                      onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                      isMobile={isMobile}
                      memeUser={memeUser}
                      onLoginRequired={() => setShowDeposit(true)}/>
                  </div>
                : <Card key={m.id} m={m} bal={bal} streak={streak}
                    pos={pos[m.id]||null}
                    players={marketPlayers[m.id]||[]}
                    onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                    isMobile={isMobile}
                    memeUser={memeUser}
                    onLoginRequired={() => setShowDeposit(true)}/>
            )}
            <TreasureChestCard
              chestState={memeUser && chestQuest ? chestState : "cooldown"}
              chestCooldown={memeUser && chestQuest ? chestCooldown : 0}
              chestReward={chestReward}
              chestQuest={chestQuest}
              onClaim={memeUser ? handleChestClaim : () => setShowDeposit(true)}
              isMobile={isMobile}/>
          </div>

          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            position: isMobile ? "static" : "sticky",
            top: isMobile ? undefined : 60
          }}>
            <div style={{
              background:"linear-gradient(360deg,#212936,#4e596c)",
              borderRadius:25, overflow:"hidden"
            }}>
              <div style={{
                padding:"12px 16px",
                fontFamily:"'Londrina Solid',sans-serif",
                textTransform:"uppercase", background:"#191f29",
                borderBottom:"1px solid #ffffff0d",
                display:"flex", alignItems:"center"
              }}>
                <span style={{ flex:1, ...(ranked.filter(m => m.type !== "BATTLE").length > 0 && ranked.filter(m => m.type !== "BATTLE").every(m => yP(m.qY,m.qN,m.b) < 25) ? { color:"#f65e5e" } : {}) }}>{ranked.filter(m => m.type !== "BATTLE").length > 0 && ranked.filter(m => m.type !== "BATTLE").every(m => yP(m.qY,m.qN,m.b) < 25) ? "REKT BOARD" : "CONVICTION BOARD"}</span>
                <div style={{ display:"flex", fontFamily:"'Jersey 25',sans-serif", fontSize:".6em", color:"#ffffff30", textTransform:"uppercase" }}>
                  <span style={{ width:50, textAlign:"right", marginRight:8 }}>streak</span>
                  <span style={{ width:70, textAlign:"right" }}>pool</span>
                </div>
              </div>
              {ranked.filter(m => m.type !== "BATTLE").map((m,i) => {
                const coinForm = (marketHistory || [])
                  .filter(h => h.coin_symbol === m.c.sym)
                  .slice(0, 5);
                return (
                <div key={m.id} style={{
                  display:"flex", alignItems:"center", gap:10,
                  padding:"10px 16px", background:"#191f29",
                  borderBottom:"1px solid #ffffff08"
                }}>
                  <span style={{
                    fontFamily:"'Jersey 25',sans-serif", minWidth:28,
                    color:["#f7931a","#94a3b8","#b45309"][i] || "#ffffff40"
                  }}>#{i+1}</span>
                  <CoinImg src={m.c.img} color={m.c.color} size={26} sym={m.c.sym}/>
                  <div style={{ flex:1 }}>
                    <div style={{
                      fontFamily:"'Londrina Solid',sans-serif", fontSize:".9em"
                    }}><a href={`https://meme.com/coin/${MEME_SLUGS[m.c.sym] || m.c.sym.toLowerCase()}`} target="_blank" rel="noopener noreferrer" style={{ ...gld, textDecoration:"none" }}>${m.c.sym}</a></div>
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".65em",
                      color: ranked.filter(r => r.type !== "BATTLE").length > 0 && ranked.filter(r => r.type !== "BATTLE").every(r => yP(r.qY,r.qN,r.b) < 25) ? "#f65e5e" : "#ffffff50"
                    }}>{yP(m.qY,m.qN,m.b)}% on UP</div>
                  </div>
                  {coinForm.length > 0 && (
                    <div style={{ display:"flex", gap:3, alignItems:"center", justifyContent:"flex-end", width:50, flexShrink:0 }}>
                      {coinForm.map((h,j) => (
                        <div key={j} style={{
                          width:14, height:14, borderRadius:"50%",
                          background: h.result === "YES" ? "#22c55e" : "#ef4444",
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:8, fontWeight:700, color:"#fff"
                        }}>{h.result === "YES" ? "↑" : "↓"}</div>
                      ))}
                    </div>
                  )}
                  <div style={{
                    ...gld, fontFamily:"'Jersey 25',sans-serif", textAlign:"right", width:70, flexShrink:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"
                  }}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</div>
                </div>
                );
              })}
            </div>

            <div style={{
              background:"linear-gradient(360deg,#212936,#4e596c)",
              borderRadius:25, overflow:"hidden"
            }}>
              <div style={{
                padding:"12px 16px",
                fontFamily:"'Londrina Solid',sans-serif",
                textTransform:"uppercase", background:"#191f29",
                borderBottom:"1px solid #ffffff0d"
              }}>TOP GAINS</div>
              {(() => {
                // Generate fun anonymous names from user ID
                const anonName = (id) => {
                  const adjectives = ['Swift', 'Lucky', 'Bold', 'Wise', 'Keen', 'Sharp', 'Slick', 'Quick'];
                  const nouns = ['Ape', 'Bull', 'Degen', 'Whale', 'Chad', 'Frog', 'Moon', 'Diamond'];
                  const hash = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                  return `${adjectives[hash % adjectives.length]}${nouns[(hash >> 4) % nouns.length]}`;
                };
                // Combine leaderboard from DB with current user
                const currentUser = {
                  id: userId.current,
                  name: "You",
                  profit: myProfit,
                  vol: totalVolume,
                  w: wins,
                  l: losses,
                  img: memeUser?.image || null,
                  isCurrentUser: true
                };
                const leaders = leaderboard
                  .filter(u => u.id !== userId.current)
                  .map(u => ({
                    id: u.id,
                    name: (u.username || anonName(u.id)).replace(/\d{4,}$/, ''),
                    profit: u.total_profit || 0,
                    vol: u.total_volume || 0,
                    w: u.wins || 0,
                    l: u.losses || 0,
                    img: u.profile_image,
                    isCurrentUser: false
                  }));
                const sorted = [...leaders, currentUser].sort((a,b) => b.profit - a.profit);
                const top5 = sorted.slice(0, 5);
                const playerInTop5 = top5.some(p => p.isCurrentUser);
                const playerRank = sorted.findIndex(p => p.isCurrentUser) + 1;

                const renderRow = (p, rank, showRank = true, compact = false) => (
                  <div key={p.id || rank} style={{
                    display:"flex", alignItems:"center", gap:10,
                    padding: compact ? "5px 16px 10px" : "10px 16px", background:"#191f29",
                    borderBottom:"1px solid #ffffff08"
                  }}>
                    <span style={{
                      fontFamily:"'Jersey 25',sans-serif", minWidth:28,
                      color:["#f7931a","#94a3b8","#b45309"][rank-1] || "#ffffff40",
                      visibility: showRank ? "visible" : "hidden"
                    }}>{showRank ? `#${rank}` : "#"}</span>
                    <div style={{
                      width:26, height:26, borderRadius:13, overflow:"hidden",
                      background: p.isCurrentUser ? "linear-gradient(135deg,#71BAFF,#4023C3)" : "#333",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:12, fontWeight:700, flexShrink:0
                    }}>
                      {p.img
                        ? <img src={p.img} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}
                            onError={e => { e.target.style.display="none"; }}/>
                        : <span>{p.name[0]}</span>
                      }
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{
                        fontFamily:"'Londrina Solid',sans-serif", fontSize:".85em",
                        color: p.isCurrentUser ? "#71BAFF" : "#fff"
                      }}>{p.name}</div>
                    </div>
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".9em",
                      color: p.profit >= 0 ? "#4ade80" : "#f65e5e"
                    }}>{p.profit >= 0 ? "+" : ""}{p.profit.toLocaleString()}</div>
                  </div>
                );

                return (<>
                  {top5.map((p, i) => renderRow(p, i + 1))}
                  {!playerInTop5 && (<>
                    <div style={{
                      padding:"0 16px", background:"#191f29",
                      textAlign:"center", fontFamily:"'Jersey 25',sans-serif",
                      fontSize:".7em", color:"#ffffff30", letterSpacing:4
                    }}>...</div>
                    {renderRow(currentUser, playerRank, false, true)}
                  </>)}
                </>);
              })()}
            </div>

            {hist.length > 0 && (
              <div style={{
                background:"linear-gradient(360deg,#212936,#4e596c)",
                borderRadius:25, overflow:"hidden"
              }}>
                <div style={{
                  padding:"12px 16px",
                  fontFamily:"'Londrina Solid',sans-serif",
                  textTransform:"uppercase", background:"#191f29",
                  borderBottom:"1px solid #ffffff0d"
                }}>YOUR HISTORY</div>
                {hist.slice(-5).reverse().map((h,i) => (
                  <div key={i} style={{
                    display:"flex", justifyContent:"space-between",
                    padding:"10px 16px", background:"#191f29",
                    borderBottom:"1px solid #ffffff08"
                  }}>
                    <span style={{
                      fontFamily:"'Jersey 25',sans-serif",
                      fontSize:".85em", color:"#ffffff60"
                    }}>${h.sym}</span>
                    <span style={{
                      fontFamily:"'Jersey 25',sans-serif",
                      color: h.result===h.side ? "#b6ffac" : "#f65e5e"
                    }}>{h.result===h.side ? "+"+h.rw : "-"+h.inv}</span>
                  </div>
                ))}
              </div>
            )}

          </div>
        </div>
      </div>

      {showProfile && (() => {
        const dbTierMap = { GOLD:"gold", SILVER:"purple", BRONZE:"green" };
        const tierColors = { gold:"#ff7900", purple:"#e900d7", green:"#69b69b" };
        const tierColors2 = { gold:"#ffcb15", purple:"#fe6aff", green:"#d4ffed" };
        const inv = (holdings || []).map(h => ({
          sym: h.coin_symbol,
          tier: dbTierMap[h.tier] || "green",
          img: h.coin_image,
        }));
        return (<>
          <div onClick={() => setShowProfile(false)} style={{
            position:"fixed", inset:0, background:"#000000cc", zIndex:50,
            backdropFilter:"blur(8px)"
          }}/>
          <div style={{
            position:"fixed", top:"50%", left:"50%", transform:"translate(-50%,-50%)",
            width:"min(680px, 92vw)", maxHeight:"85vh", overflowY:"auto",
            background:"linear-gradient(180deg, #0c1018 0%, #151d2b 100%)",
            border:"1px solid #ffffff15", borderRadius:20,
            zIndex:51, padding:0,
            boxShadow:"0 0 80px #00000080, 0 0 200px #71BAFF10"
          }}>
            <div style={{
              padding:"16px 24px", display:"flex", justifyContent:"space-between",
              alignItems:"center", borderBottom:"1px solid #ffffff0d"
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{
                  width:40, height:40, borderRadius:20, overflow:"hidden",
                  background:"linear-gradient(135deg,#71BAFF,#4023C3)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:17, fontWeight:700, flexShrink:0,
                  border:"none"
                }}>
                  {memeUser?.image
                    ? <img src={memeUser.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                    : <span>{(memeUser?.username || "G")[0].toUpperCase()}</span>
                  }
                </div>
                <div>
                  <div style={{
                    fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em"
                  }}>{memeUser?.username || "Guest"}</div>
                  <div style={{
                    fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff40"
                  }}>
                    <span style={gld}>{bal.toLocaleString()} MEMESCORE</span>
                    {streak > 0 && <span style={{ color:"#f65e5e", marginLeft:8 }}>{streak}W streak</span>}
                  </div>
                </div>
              </div>
              <span onClick={() => setShowProfile(false)} style={{
                cursor:"pointer", color:"#ffffff40", fontSize:"1.4em", padding:"4px 8px",
                lineHeight:1
              }}>✕</span>
            </div>
            <div style={{ padding:"20px 24px" }}>
              <div style={{
                fontFamily:"'Londrina Solid',sans-serif", fontSize:".85em",
                textTransform:"uppercase", color:"#ffffff50", marginBottom:6,
                letterSpacing:".08em", display:"flex", alignItems:"center", justifyContent:"space-between"
              }}>
                <span>MEME INVENTORY</span>
                {(() => {
                  const hasWallets = memeUser?.wallets?.length > 0;
                  const canScan = hasWallets && !scanning && (!lastCensusAt || Date.now() - new Date(lastCensusAt).getTime() >= CENSUS_COOLDOWN_MS);
                  if (!hasWallets) return null;
                  if (scanning) return <span style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", color:"#71BAFF" }}>Scanning...</span>;
                  if (canScan) return (
                    <span onClick={async () => {
                      setScanning(true); setScanError(null);
                      try {
                        await runWalletCensus(userId.current, memeUser.wallets);
                        setLastCensusAt(new Date().toISOString());
                        await loadInventory(userId.current);
                      } catch (e) { setScanError(e.message); }
                      setScanning(false);
                    }} style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", color:"#0c1018",
                      background:"linear-gradient(90deg,#f7931a,#ffcb15)", padding:"3px 12px",
                      borderRadius:8, cursor:"pointer", fontWeight:700, letterSpacing:".05em"
                    }}>SCAN NOW</span>
                  );
                  // On cooldown — show timer
                  const msLeft = Math.max(0, CENSUS_COOLDOWN_MS - (Date.now() - new Date(lastCensusAt).getTime()));
                  const d = Math.floor(msLeft / (24*60*60*1000));
                  const h = Math.floor((msLeft % (24*60*60*1000)) / (60*60*1000));
                  return <span style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#ffffff30" }}>Next in {d}d {h}h</span>;
                })()}
              </div>
              {<div style={{ height:6 }}/>}
              {scanError && <div style={{
                fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#f65e5e",
                marginBottom:10, textAlign:"center"
              }}>Scan failed: {scanError}</div>}
              {holdings === null ? (
                <div style={{ color:"#ffffff30", fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", textAlign:"center", padding:"20px 0" }}>Loading...</div>
              ) : inv.length === 0 ? (
                <div style={{ color:"#ffffff30", fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", textAlign:"center", padding:"20px 0" }}>
                  {scanning ? "Scanning wallets..." : memeUser?.wallets?.length > 0 ? "Hit Scan Now to check your holdings" : "Link wallets on meme.com to see holdings"}
                </div>
              ) : (
              <div style={{
                display:"grid",
                gridTemplateColumns:"repeat(auto-fill, minmax(88px, 1fr))",
                gap:12
              }}>
                {inv.map((h, i) => {
                  const tc = tierColors[h.tier];
                  const tc2 = tierColors2[h.tier];
                  return (
                    <div key={i} style={{
                      background:"#1a1a1a",
                      border:"2.5px solid " + tc,
                      borderRadius:12,
                      overflow:"hidden",
                      display:"flex", flexDirection:"column",
                      boxShadow:"0 0 12px " + tc + "33, inset 0 0 16px " + tc + "0a",
                      cursor:"pointer", transition:"transform .15s, box-shadow .15s"
                    }}
                    onMouseEnter={e => { e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.boxShadow="0 0 24px "+tc+"55, inset 0 0 16px "+tc+"15"; }}
                    onMouseLeave={e => { e.currentTarget.style.transform=""; e.currentTarget.style.boxShadow="0 0 12px "+tc+"33, inset 0 0 16px "+tc+"0a"; }}
                    >
                      <div style={{
                        width:"100%", aspectRatio:"1", position:"relative",
                        background:"linear-gradient(180deg, " + tc + "11, " + tc + "05)",
                        display:"flex", alignItems:"center", justifyContent:"center",
                        overflow:"hidden"
                      }}>
                        {h.img ? <img src={h.img} alt={h.sym}
                          style={{ width:"100%", height:"100%", objectFit:"cover" }}
                          onError={e => { e.target.style.display="none"; }}
                        /> : <div style={{
                          fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.8em",
                          color:tc, opacity:.5
                        }}>{h.sym[0]}</div>}
                      </div>
                      <div style={{
                        background:"linear-gradient(180deg, " + tc + "cc, " + tc2 + "99)",
                        padding:"6px 8px",
                        display:"flex", alignItems:"center", justifyContent:"space-between"
                      }}>
                        <div style={{
                          fontFamily:"'Londrina Solid',sans-serif", fontSize:".75em",
                          color:"#fff", textShadow:"0 1px 2px rgba(0,0,0,.4)"
                        }}>${h.sym}</div>
                        <img src="https://meme.com/assets/images/farm/simple-diamond.svg" alt="" style={{
                          width:13, height:9
                        }}/>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          </div>
        </>);
      })()}

      <DepositModal
        isOpen={showDeposit}
        onClose={() => setShowDeposit(false)}
        onDeposit={async (amount, depositMode, newMemescore) => {
          const delta = depositMode === "deposit" ? amount : -amount;
          setBal(b => b + delta);
          setMemescore(newMemescore);
          // Update DB balance atomically
          if (supabase) {
            await supabase.rpc('labs_adjust_balance', { p_user_id: userId.current, p_delta: delta });
          }
        }}
        memeUser={memeUser}
        memescore={memescore}
        labsBalance={bal}
        authToken={authToken}
        isMobile={isMobile}
      />

      {showChestDialog && chestQuest && (
        <TreasureChestDialog
          questId={chestQuest.id}
          authToken={authToken}
          onClose={handleChestDialogClose}
          isMobile={isMobile}
        />
      )}

    </div>
  );
}
