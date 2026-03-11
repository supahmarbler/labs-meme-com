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

// Fetch all farming quests from meme.com (single call, used for chest + retweet)
const fetchFarmingQuests = async (authToken) => {
  try {
    const res = await fetch(`${MEME_API}/farming-quests/list_available`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("Failed to fetch farming quests:", e);
    return null;
  }
};

// Extract a quest by type from the grouped farming quests response
const extractQuest = (data, questType) => {
  if (!data) return null;
  const allQuests = [
    ...(data.available_quests || []),
    ...(data.in_progress_quests || []),
    ...(data.claimable_quests || []),
    ...(data.completed_quests || [])
  ];
  const quest = allQuests.find(q => q.quest_type === questType);
  if (!quest) return null;
  quest._isAvailable = (data.available_quests || []).some(q => q.quest_type === questType);
  quest._isInProgress = (data.in_progress_quests || []).some(q => q.quest_type === questType);
  quest._isCompleted = (data.completed_quests || []).some(q => q.quest_type === questType);
  return quest;
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

// Fetch the current retweet quest tweet
const fetchQuestTweet = async (authToken, memeUserId) => {
  try {
    const res = await fetch(`${MEME_API}/farm/get_quest_tweet?meme_user_id=${memeUserId}`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("Failed to fetch quest tweet:", e);
    return null;
  }
};

// Claim retweet reward points
const claimRetweetReward = async (authToken, tweetIdInternal) => {
  try {
    const res = await fetch(`${MEME_API}/farm/claim_retweet_reward_points`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify({ tweet_id_internal: tweetIdInternal })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Retweet claim failed");
    }
    return await res.json();
  } catch (e) {
    console.error("Retweet claim failed:", e);
    return null;
  }
};

// Fetch prediction markets from meme.com
const fetchPredictionMarkets = async (authToken) => {
  try {
    const headers = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const res = await fetch(`${MEME_API}/prediction_markets/get_markets?page=1&page_size=30`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).filter(m => m.market_type === "SINGLE");
  } catch (e) {
    console.log("Failed to fetch prediction markets:", e);
    return [];
  }
};

// Buy prediction market shares
const pmBuy = async (authToken, marketId, amount, sharesType) => {
  const res = await fetch(`${MEME_API}/prediction_markets/buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
    body: JSON.stringify({ market_id: marketId, memescore_amount: amount, shares_type: sharesType })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t || "Buy failed"); }
  return res.json();
};

// Sell prediction market shares (100% sell)
const pmSell = async (authToken, marketId, sharesType, expectedRefund) => {
  const res = await fetch(`${MEME_API}/prediction_markets/sell`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
    body: JSON.stringify({ market_id: marketId, shares_percentage: "1", shares_type: sharesType, expected_refund: expectedRefund })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t || "Sell failed"); }
  return res.json();
};

// Claim resolved prediction market
const pmClaim = async (authToken, marketId) => {
  const res = await fetch(`${MEME_API}/prediction_markets/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
    body: JSON.stringify({ market_id: marketId })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t || "Claim failed"); }
  return res.json();
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
    const isTrends = m.type === "TRENDS";
    const isBattleOrTrends = m.type === "BATTLE" || isTrends;
    const { error } = await supabase.rpc('labs_sync_market', {
      p_id: m.id,
      p_coin_symbol: m.c.sym,
      p_coin_name: m.c.name,
      p_coin_image: m.c.img,
      p_coin_color: m.c.color,
      p_current_mc: isTrends ? null : m.mc,
      p_start_mc: m.startMc || m.mc,
      p_b: m.b,
      p_q_yes: Math.max(0, m.qY - m.b),
      p_q_no: Math.max(0, m.qN - m.b),
      p_status: m.st,
      p_result: m.res,
      p_volume: m.vol,
      p_players: m.ppl,
      p_fee_pool: m.fp || 0,
      p_expires_at: new Date(m.ea).toISOString(),
      ...(isBattleOrTrends ? {
        p_market_type: m.type,
        p_coin_b_symbol: m.cB.sym,
        p_coin_b_name: m.cB.name,
        p_coin_b_image: m.cB.img,
        p_coin_b_color: m.cB.color,
        p_start_mc_b: m.startMcB,
        p_current_mc_b: isTrends ? null : m.mcB
      } : {})
    });
    if (error) {
      console.error("Market sync error:", error, "market:", m.id);
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
      if (m.market_type === "BATTLE" || m.market_type === "TRENDS" || m.market_type === "CUSTOM" || m.market_type === "MEMEMARKET") return true;
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
    await supabase.rpc('labs_upsert_user', {
      p_user_id: userId,
      p_username: memeUser?.username || null,
      p_profile_image: memeUser?.image || null
    });
  } catch (e) {
    console.log("User check:", e.message);
  }
};

// Sync user stats to database (balance is NOT synced here — only RPCs modify it)
// Uses UPDATE (not upsert) so it can never accidentally create a row with labs_balance=0
const syncUserToDb = async (userId, _totalVolume, wins, losses, streak, bestStreak) => {
  if (!supabase) return;
  try {
    await supabase.rpc('labs_sync_stats', {
      p_user_id: userId,
      p_wins: wins,
      p_losses: losses,
      p_streak: streak,
      p_best_streak: bestStreak
    });
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
      const { error } = await supabase.rpc('labs_sync_position', {
        p_user_id: userId,
        p_market_id: marketId,
        p_side: position.side,
        p_shares: position.sh,
        p_invested: position.inv,
        p_claimed: position.claimed || false
      });
      if (error) console.error("Position sync error:", error);
    } else {
      const { error } = await supabase.rpc('labs_sync_position', {
        p_user_id: userId,
        p_market_id: marketId,
        p_delete: true
      });
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
    await supabase.rpc('labs_record_trade', {
      p_user_id: userId,
      p_market_id: marketId,
      p_coin_symbol: coinSymbol,
      p_side: side,
      p_shares: shares,
      p_amount: amount,
      p_trade_type: tradeType,
      p_result: result,
      p_pnl: pnl
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
      .select("id, coin_symbol, coin_image, coin_color, start_mc, current_mc, result, expires_at, volume, market_type")
      .eq("status", "RES")
      .order("expires_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    // Filter out stale 5-min test markets — only keep markets expiring at 13:xx UTC
    return (data || []).filter(m => {
      if (m.market_type === "BATTLE" || m.market_type === "TRENDS" || m.market_type === "CUSTOM" || m.market_type === "MEMEMARKET") return true;
      const h = new Date(m.expires_at).getUTCHours();
      return h === 13;
    });
  } catch (e) {
    console.error("History load failed:", e);
    return null;
  }
};

// Load user's recent trade history from database
const loadTradeHistoryFromDb = async (userId) => {
  if (!supabase || !userId) return null;
  try {
    const { data, error } = await supabase
      .from("labs_trades")
      .select("coin_symbol, side, amount, trade_type, result, pnl")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return (data || []).map(t => ({
      sym: t.coin_symbol,
      side: t.side,
      type: t.trade_type,
      result: t.result,
      amount: t.amount,
      pnl: t.pnl
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
  const dedupKey = (m) => (m.type === "BATTLE" || m.type === "TRENDS") ? battlePairKey(m.c.sym, m.cB.sym) : m.type === "MEMEMARKET" ? m.id : m.c.sym;
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
    ea: new Date(db.expires_at).getTime(),
    ca: db.created_at ? new Date(db.created_at).getTime() : null
  };
  if (db.market_type === "BATTLE" || db.market_type === "TRENDS") {
    base.type = db.market_type;
    base.cB = {
      sym: db.coin_b_symbol,
      name: db.coin_b_name,
      img: coinDataB?.img || db.coin_b_image,
      color: coinDataB?.color || db.coin_b_color,
      mcap: Number(db.current_mc_b) || 0
    };
    base.mcB = Number(db.current_mc_b) || 0;
    base.startMcB = Number(db.start_mc_b) || 0;
    if (db.trend_term_a) base.trendTermA = db.trend_term_a;
    if (db.trend_term_b) base.trendTermB = db.trend_term_b;
  }
  if (db.market_type === "CUSTOM") {
    base.type = "CUSTOM";
    base.customTitle = db.custom_title;
    base.customImageUrl = db.custom_image_url;
    base.customDescription = db.custom_description;
    base.labelYes = db.label_yes || "YES";
    base.labelNo = db.label_no || "NO";
  }
  if (db.market_type === "MEMEMARKET") {
    base.type = "MEMEMARKET";
    base.customTitle = db.custom_title;
    base.trendTermA = db.trend_term_a;
    base.createdBy = db.created_by;
    base.creationFee = Number(db.creation_fee) || 0;
    base.b = Number(db.b) || 100000;
    base.qY = (Number(db.q_yes) || 0) + base.b;
    base.qN = (Number(db.q_no) || 0) + base.b;
  }
  return base;
};

// meme.com API
const API_BASE = "https://api.v2.meme.com";
const MEME_SLUGS = { JOE:"joe-coin", STNK:"stonks-4", PEPE:"pepe", MOG:"mog-coin" };

// Coin pool — UP/DOWN picks random coins, Battle picks matchups
const BATTLE_COINS = {
  PENGU:"pudgy-penguins", DOG:"own-the-doge", PAIN:"pain",
  REKT:"rekt-2", ELONRWA:"elonrwa", PEPE:"pepe",
  BITCOIN:"harrypotterobamasonic10in", APU:"apu-s-club",
  SPX:"spx6900", TOSHI:"toshi",
  PONKE:"ponke", GIGA:"gigachad-2", FARTCOIN:"fartcoin",
  BOBO:"bobo-coin", MIGGLES:"mister-miggles", KEKEC:"the-balkan-dwarf",
  TROLL:"troll-2", POPCAT:"popcat", WOJAK:"wojak",
  MEW:"cat-in-a-dogs-world", MUMU:"mumu-the-bull-3",
  TURBO:"turbo", BRETT:"based-brett", RETARDIO:"retardio",
  DOLAN:"dolan-duck", WIF:"dogwifhat",
  NPC:"non-playable-coin", KEYCAT:"keyboard-cat-base"
};

// Battle coin colors — distinct palette so each side is visually clear
const BATTLE_COLORS = {
  PENGU:"#4FC3F7", DOG:"#FF8A65", PAIN:"#E53935", BONK:"#FFB74D", PEPE:"#4CAF50",
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

// --- On-demand per-user wallet census ---

const CENSUS_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const HOLDINGS_DAILY_RATES = { GOLD: 10000, SILVER: 7000, BRONZE: 1500 };

const calcHoldingsReward = (holdingsList, dhBoost) => {
  if (!holdingsList?.length || dhBoost <= 0) return 0;
  let daily = 0;
  for (const h of holdingsList) daily += HOLDINGS_DAILY_RATES[h.tier] || 0;
  return Math.floor(daily * 3 * (dhBoost / 10));
};

// Scan holdings via meme.com API — fetch user's coins and save via RPC
const runHoldingsScan = async (uid, memeUserId, authToken) => {
  if (!supabase || !memeUserId || !authToken) throw new Error("Login required to scan holdings");

  const res = await fetch(`${MEME_API}/farm/get_user_coins?meme_user_id=${memeUserId}`, {
    headers: { "Authorization": `Bearer ${authToken}` }
  });
  if (!res.ok) throw new Error("Failed to fetch coins from meme.com (status " + res.status + ")");
  const data = await res.json();
  const coins = data.coin_balances || [];
  if (!coins.length) throw new Error("No coin holdings found on meme.com. Your existing holdings are unchanged.");

  const levelToTier = { LEVEL_1: "BRONZE", LEVEL_2: "SILVER", LEVEL_3: "GOLD" };
  const holdings = coins
    .filter(c => c.user_coin_balance_level && levelToTier[c.user_coin_balance_level])
    .map(c => ({
      coin_symbol: (c.coin_key || "").toUpperCase(),
      coin_name: c.coin_name || c.coin_key || "",
      coin_image: c.coin_image_url || "",
      wallet_address: "meme.com",
      chain: "API",
      token_balance: 0,
      usd_value: 0,
      tier: levelToTier[c.user_coin_balance_level]
    }));

  if (!holdings.length) throw new Error("No holdings above threshold. Your existing holdings are unchanged.");

  const { error } = await supabase.rpc("labs_save_census", {
    p_user_id: uid,
    p_holdings: holdings
  });
  if (error) throw new Error(error.message);

  return holdings;
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

// Max bet amount before hitting 0.1% probability floor on other side
const maxBetForFloor = (qY, qN, B, side) => {
  // After buying maxShares on `side`, other side prob must stay >= 0.1%
  // For YES: exp(qN/B) / (exp((qY+sh)/B) + exp(qN/B)) >= 0.001
  // => sh <= B * ln(999) + qN - qY
  const maxShares = side === "YES"
    ? B * Math.log(999) + qN - qY
    : B * Math.log(999) + qY - qN;
  if (maxShares <= 0) return 0;
  const oldCost = costFn(qY, qN, B);
  const newQY = side === "YES" ? qY + maxShares : qY;
  const newQN = side === "NO" ? qN + maxShares : qN;
  const netCost = Math.floor(costFn(newQY, newQN, B) - oldCost);
  // Add back 2% fee: netCost is after fee, so gross = netCost / 0.98
  return Math.floor(netCost / 0.98);
};

const fM = v => v>=1e12?"$"+(v/1e12).toFixed(2)+"T":v>=1e9?"$"+(v/1e9).toFixed(2)+"B":v>=1e6?"$"+(v/1e6).toFixed(2)+"M":"$"+(v/1e3).toFixed(0)+"K";
const fT = s => {if(s<=0)return"RESOLVED";const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),mn=Math.floor((s%3600)/60),sc=s%60;if(d>0)return d+"d "+h+"h";return String(h).padStart(2,"0")+":"+String(mn).padStart(2,"0")+":"+String(sc).padStart(2,"0");};
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

const NUM_UPDOWN_MARKETS = 2;

const pickUpdownCoin = (excludeSyms) => {
  const eligible = Object.keys(BATTLE_COINS).filter(sym => battleCoinMap[sym] && !excludeSyms.has(sym));
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
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

// How to Play modal
const HowToPlayModal = ({ isOpen, onClose, isMobile }) => {
  if (!isOpen) return null;
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
    maxWidth: isMobile ? "100%" : 420,
    border:"1px solid #ffffff15",
    textAlign:"left"
  };
  const stepStyle = {
    fontFamily:"'Jersey 25',sans-serif", fontSize:".95em",
    color:"#c8d6e5", lineHeight:1.6, marginBottom:8
  };
  return (
    <div style={modalBase} onClick={onClose}>
      <div style={panelBase} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.5em", color:"#fff" }}>HOW TO PLAY</div>
          <button onClick={onClose} style={{
            background:"none", border:"none", color:"#94a3b8", fontSize:"1.4em", cursor:"pointer", padding:4
          }}>&times;</button>
        </div>
        <div style={stepStyle}><span style={{ color:"#71BAFF" }}>1.</span> Deposit memescore to get your arena balance</div>
        <div style={stepStyle}><span style={{ color:"#71BAFF" }}>2.</span> Pick a coin and bet UP or DOWN</div>
        <div style={stepStyle}><span style={{ color:"#71BAFF" }}>3.</span> Odds shift as more players join — early bets pay more</div>
        <div style={stepStyle}><span style={{ color:"#71BAFF" }}>4.</span> Markets resolve at 14:00 UTC daily based on real prices</div>
        <div style={stepStyle}><span style={{ color:"#71BAFF" }}>5.</span> Win? Claim your payout. Lose? Better luck next round</div>
        <div style={{
          fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
          color:"#64748b", marginTop:16, textAlign:"center"
        }}>Sell anytime before resolution to lock in profit or cut losses.</div>
      </div>
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
  const pnl = pos ? grossRf - pos.inv : 0;

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
          <div className="tip" data-tip={new Date(m.ea).toLocaleString()} style={{
            padding:"2px 8px", borderRadius:8, cursor:"default",
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
          display:"flex", alignItems:"flex-start", gap:8, marginBottom:10,
          flexWrap:"nowrap", overflow:"hidden"
        }}>
          {pos && !pos.claimed && (
            <>
              <div style={{ minWidth:0, flexShrink:1 }}>
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                  color:"#ffffff40", marginBottom:2
                }}>YOUR BET</div>
                <div style={{
                  fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em", lineHeight:1
                }}>
                  <span style={{ color: pos.side==="YES" ? "#71baff" : "#a78bfa", whiteSpace:"nowrap" }}>
                    {grossRf.toLocaleString()} {pos.side==="YES" ? "UP" : "DOWN"}
                  </span>{" "}
                  <span style={{
                    fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                    color: pnl>=0 ? "#4ade80" : "#f65e5e",
                    whiteSpace:"nowrap"
                  }}>
                    {pnl>=0 ? "▲" : "▼"} {pnl>=0 ? "+" : ""}{pnl.toLocaleString()}
                  </span>
                </div>
              </div>
              <div style={{ width:1, height:36, background:"#ffffff20", flexShrink:0 }}/>
            </>
          )}
          <div style={{ minWidth:0, flexShrink:1 }}>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
              color:"#ffffff40", marginBottom:2
            }}>CURRENT PRICE</div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em", lineHeight:1
            }}>
              <span style={{
                ...gld,
                transition:"transform 0.3s ease, opacity 0.3s ease",
                transform: priceFlash === "up" ? "scale(1.15)" : "scale(1)",
                opacity: priceFlash === "down" ? 0.6 : 1,
                display:"inline-block", whiteSpace:"nowrap"
              }}>{fM(m.mc)}</span>{" "}
              <span style={{
                fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                color: priceFlash === "up" ? "#4ade80" : priceFlash === "down" ? "#f65e5e" : isUp ? "#4ade80" : pctChange < 0 ? "#f65e5e" : "#ffffff40",
                transition:"color 0.3s ease",
                animation: priceFlash ? "priceFlash 1.2s ease-out" : undefined,
                whiteSpace:"nowrap"
              }}>
                {isUp ? "▲" : pctChange < 0 ? "▼" : ""} {Math.abs(pctChange).toFixed(1)}%
              </span>
            </div>
          </div>
          <div style={{ width:1, height:36, background:"#ffffff20", flexShrink:0 }}/>
          <div style={{ minWidth:0, flexShrink:1 }}>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
              color:"#ffffff40", marginBottom:2
            }}>PRICE TO BEAT</div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
              color:"#94a3b8", whiteSpace:"nowrap"
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
          {step==="sel" && m.st==="OPEN" && !pos && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff8a", opacity: yp < 1 ? 0.3 : 1 }}
                disabled={yp < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); }}>
                UP {yp < 1 ? "(locked)" : ""}
              </button>
              <button style={{ ...bx, background:"#234bc29e", border:"2px solid #c8dbff52", opacity: np < 1 ? 0.3 : 1 }}
                disabled={np < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); }}>
                DOWN {np < 1 ? "(locked)" : ""}
              </button>
            </div>
          )}
          {step==="sel" && m.st==="OPEN" && pos && !pos.claimed && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff" }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>
                ADD MORE {pos.side === "YES" ? "UP" : "DOWN"}
              </button>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => setStep("sellConfirm")}>
                SELL
              </button>
            </div>
          )}

          {step==="amt" && (() => {
            const floorMax = maxBetForFloor(m.qY, m.qN, m.b, side);
            const effectiveMax = Math.min(bal, floorMax);
            const isFloorLimited = floorMax < bal;
            return (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <div style={{
                display:"flex", justifyContent:"flex-end", alignItems:"center",
                fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", gap:8
              }}>
                {isFloorLimited && <span style={{ color:"#f7931a" }}>MAX: {effectiveMax.toLocaleString()}</span>}
                <span style={gld}>BAL: {bal.toLocaleString()}</span>
              </div>
              <input type="number" inputMode="numeric" pattern="[0-9]*" placeholder="Amount..."
                value={amt} onChange={e => setAmt(e.target.value)} onFocus={e => e.target.select()} autoFocus
                style={{
                  height:42, border:"1px solid #4c5159", borderRadius:15,
                  textAlign:"center", color:"#fff", background:"transparent",
                  fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", outline:"none",
                  width:"100%"
                }}/>
              <div style={{ display:"flex", gap:6, marginBottom:4 }}>
                {[10,25,50,100].map(p =>
                  <button key={p}
                    onClick={() => setAmt(String(Math.floor(effectiveMax*p/100)))}
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
                // POOL-SPLIT-V1: const loserInv = side === "YES" ? m.nInv : m.yInv;
                // POOL-SPLIT-V1: const winnerSh = (side === "YES" ? m.qY - m.b + sh : m.qN - m.b + sh);
                // POOL-SPLIT-V1: const poolPayout = loserInv > 0 ? net + Math.round(sh / winnerSh * loserInv) : net;
                // POOL-SPLIT-V1: const payout = Math.max(poolPayout, sh);
                const payout = sh;  // Pure LMSR: 1 per winning share
                const multRaw = payout / net;
                const mult = multRaw < 2 ? multRaw.toFixed(2) : multRaw.toFixed(1);
                return (
                  <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff60", textAlign:"center", marginBottom:2 }}>
                    {feeStr} / ~{mult}x if {side==="YES"?"UP":"DOWN"} wins
                  </div>
                );
              })()}
              {isFloorLimited && parseInt(amt) > effectiveMax && (
                <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#f7931a", textAlign:"center", marginBottom:2 }}>
                  Max bet {effectiveMax.toLocaleString()} (odds limit)
                </div>
              )}
              <div style={{ display:"flex", gap:10 }}>
                <button style={{ ...bx, background:"#00000042", flex:"0 0 40px" }}
                  onClick={() => { setStep("sel"); setSide(null); setAmt(""); }}>
                  X
                </button>
                <button
                  style={{ ...bx, flex:"1 1 auto", background:side==="YES"?"#71baff8a":"#234bc29e" }}
                  onClick={doBuy}
                  disabled={!amt || parseInt(amt)<=0 || parseInt(amt)>effectiveMax}>
                  BET {side==="YES"?"UP":"DOWN"} {amt ? "("+parseInt(amt).toLocaleString()+")" : ""}
                </button>
              </div>
            </div>
          );})()}

          {step==="pos" && pos && m.st==="OPEN" && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff" }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>
                ADD MORE {pos.side === "YES" ? "UP" : "DOWN"}
              </button>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => setStep("sellConfirm")}>
                SELL
              </button>
            </div>
          )}

          {step==="sellConfirm" && pos && m.st==="OPEN" && (() => {
            const grossRf = sellShares(m.qY, m.qN, m.b, pos.sh, pos.side);
            const netRf = grossRf - Math.round(grossRf * 0.02);
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".85em", textAlign:"center",
                  color:"#fff", background:"#242a35", borderRadius:8, padding:"8px 12px"
                }}>YOU WILL WITHDRAW 100% OF YOUR CURRENT POSITION.</div>
                <div style={{ display:"flex", gap:10 }}>
                  <button style={{ ...bx, background:"#00000042", flex:"0 0 50px" }}
                    onClick={() => setStep("pos")}>✕</button>
                  <button style={{ ...bx, background:"#71baff8a", flex:1 }}
                    onClick={() => { setStep("pos"); onSell(m.id); }}>
                    WITHDRAW TO GET {netRf.toLocaleString()}P
                  </button>
                </div>
              </div>
            );
          })()}

          {step==="res" && (() => {
            const won = pos && m.res === pos.side;
            // POOL-SPLIT-V1: const poolReward = won && m.wws > 0 ? pos.inv + Math.round(pos.sh / m.wws * (m.pot - m.wis)) : 0;
            // POOL-SPLIT-V1: const baseReward = won ? Math.max(poolReward, pos.sh) : 0;
            const baseReward = won ? Math.round(pos.sh) : 0;
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

const CustomPredictionCard = ({ m, bal, pos, players, onBuy, onSell, onClaim, isMobile, memeUser, onLoginRequired }) => {
  const [step, setStep] = useState("sel");
  const [side, setSide] = useState(null);
  const [amt, setAmt] = useState("");
  const [sec, setSec] = useState(0);

  useEffect(() => {
    const t = () => setSec(Math.max(0,Math.floor((m.ea-Date.now())/1000)));
    t();
    const i = setInterval(t,1000);
    return () => clearInterval(i);
  }, [m.ea]);

  useEffect(() => {
    if (m.st==="RES" && pos) setStep("res");
    else if (m.st==="OPEN" && pos && !pos.claimed) setStep("pos");
    else if (m.st==="OPEN") setStep("sel");
  }, [m.st, pos]);

  const yp = yP(m.qY, m.qN, m.b);
  const np = 100-yp;
  const grossRf = pos ? sellShares(m.qY, m.qN, m.b, pos.sh, pos.side) : 0;
  const sellFee = pos && m.st === "OPEN" ? Math.round(grossRf * 0.02) : 0;
  const rf = grossRf - sellFee;
  const pnl = pos ? grossRf - pos.inv : 0;
  const labelYes = m.labelYes || "YES";
  const labelNo = m.labelNo || "NO";

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
        {/* Header: image + title + countdown */}
        <div style={{ display:"flex", alignItems:"center", marginBottom:12, gap:11, justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:11, minWidth:0, flex:1 }}>
            <div style={{
              width:40, height:40, borderRadius:12, flexShrink:0, overflow:"hidden",
              border:"1px solid #ffffff1a", background:"#0c1018"
            }}>
              <img src={m.customImageUrl} alt="" style={{
                width:"100%", height:"100%", objectFit:"cover", borderRadius:11
              }} onError={e => { e.target.style.display="none"; }}/>
            </div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:".95em",
              lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis",
              display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical"
            }}>{m.customTitle}</div>
          </div>
          <div className="tip" data-tip={new Date(m.ea).toLocaleString()} style={{
            padding:"2px 8px", borderRadius:8, flexShrink:0, cursor:"default",
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

        {/* Position display */}
        {pos && !pos.claimed && (
          <div style={{
            display:"flex", alignItems:"flex-start", gap:8, marginBottom:10,
            flexWrap:"nowrap", overflow:"hidden"
          }}>
            <div style={{ minWidth:0, flexShrink:1 }}>
              <div style={{
                fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                color:"#ffffff40", marginBottom:2
              }}>YOUR BET</div>
              <div style={{
                display:"flex", alignItems:"center", gap:4,
                fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
                whiteSpace:"nowrap"
              }}>
                <span style={{ color: pos.side==="YES" ? "#71baff" : "#a78bfa" }}>
                  {grossRf.toLocaleString()} {pos.side==="YES" ? labelYes : labelNo}
                </span>
                <span style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                  color: pnl>=0 ? "#4ade80" : "#f65e5e"
                }}>
                  {pnl>=0 ? "▲" : "▼"} {pnl>=0 ? "+" : ""}{pnl.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Probability bar */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
          <span style={{
            fontSize:".65em", fontFamily:"'Jersey 25',sans-serif",
            minWidth:42, textAlign:"center", color:"#71baff"
          }}>{yp}% {labelYes}</span>
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
            fontSize:".65em", fontFamily:"'Jersey 25',sans-serif",
            minWidth:42, textAlign:"center", color:"#a78bfa"
          }}>{np}% {labelNo}</span>
        </div>

        {/* Action buttons */}
        <div style={{ minHeight:48 }}>
          {step==="sel" && m.st==="OPEN" && !pos && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff8a", opacity: yp < 1 ? 0.3 : 1 }}
                disabled={yp < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); }}>
                {labelYes} {yp < 1 ? "(locked)" : ""}
              </button>
              <button style={{ ...bx, background:"#234bc29e", border:"2px solid #c8dbff52", opacity: np < 1 ? 0.3 : 1 }}
                disabled={np < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); }}>
                {labelNo} {np < 1 ? "(locked)" : ""}
              </button>
            </div>
          )}
          {step==="sel" && m.st==="OPEN" && pos && !pos.claimed && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff" }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>
                ADD MORE {pos.side === "YES" ? labelYes : labelNo}
              </button>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => setStep("sellConfirm")}>
                SELL
              </button>
            </div>
          )}

          {step==="amt" && (() => {
            const floorMax = maxBetForFloor(m.qY, m.qN, m.b, side);
            const effectiveMax = Math.min(bal, floorMax);
            const isFloorLimited = floorMax < bal;
            return (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <div style={{
                display:"flex", justifyContent:"flex-end", alignItems:"center",
                fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", gap:8
              }}>
                {isFloorLimited && <span style={{ color:"#f7931a" }}>MAX: {effectiveMax.toLocaleString()}</span>}
                <span style={gld}>BAL: {bal.toLocaleString()}</span>
              </div>
              <input type="number" inputMode="numeric" pattern="[0-9]*" placeholder="Amount..."
                value={amt} onChange={e => setAmt(e.target.value)} onFocus={e => e.target.select()} autoFocus
                style={{
                  height:42, border:"1px solid #4c5159", borderRadius:15,
                  textAlign:"center", color:"#fff", background:"transparent",
                  fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", outline:"none",
                  width:"100%"
                }}/>
              <div style={{ display:"flex", gap:6, marginBottom:4 }}>
                {[10,25,50,100].map(p =>
                  <button key={p}
                    onClick={() => setAmt(String(Math.floor(effectiveMax*p/100)))}
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
                const payout = sh;
                const multRaw = payout / net;
                const mult = multRaw < 2 ? multRaw.toFixed(2) : multRaw.toFixed(1);
                return (
                  <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#ffffff60", textAlign:"center", marginBottom:2 }}>
                    {feeStr} / ~{mult}x if {side==="YES"?labelYes:labelNo} wins
                  </div>
                );
              })()}
              {isFloorLimited && parseInt(amt) > effectiveMax && (
                <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#f7931a", textAlign:"center", marginBottom:2 }}>
                  Max bet {effectiveMax.toLocaleString()} (odds limit)
                </div>
              )}
              <div style={{ display:"flex", gap:10 }}>
                <button style={{ ...bx, background:"#00000042", flex:"0 0 40px" }}
                  onClick={() => { setStep("sel"); setSide(null); setAmt(""); }}>
                  X
                </button>
                <button
                  style={{ ...bx, flex:"1 1 auto", background:side==="YES"?"#71baff8a":"#234bc29e" }}
                  onClick={doBuy}
                  disabled={!amt || parseInt(amt)<=0 || parseInt(amt)>effectiveMax}>
                  BET {side==="YES"?labelYes:labelNo} {amt ? "("+parseInt(amt).toLocaleString()+")" : ""}
                </button>
              </div>
            </div>
          );})()}

          {step==="pos" && pos && m.st==="OPEN" && (
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...bx, background:"#71baff" }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>
                ADD MORE {pos.side === "YES" ? labelYes : labelNo}
              </button>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => setStep("sellConfirm")}>
                SELL
              </button>
            </div>
          )}

          {step==="sellConfirm" && pos && m.st==="OPEN" && (() => {
            const grossRf = sellShares(m.qY, m.qN, m.b, pos.sh, pos.side);
            const netRf = grossRf - Math.round(grossRf * 0.02);
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".85em", textAlign:"center",
                  color:"#fff", background:"#242a35", borderRadius:8, padding:"8px 12px"
                }}>YOU WILL WITHDRAW 100% OF YOUR CURRENT POSITION.</div>
                <div style={{ display:"flex", gap:10 }}>
                  <button style={{ ...bx, background:"#00000042", flex:"0 0 50px" }}
                    onClick={() => setStep("pos")}>✕</button>
                  <button style={{ ...bx, background:"#71baff8a", flex:1 }}
                    onClick={() => { setStep("pos"); onSell(m.id); }}>
                    WITHDRAW TO GET {netRf.toLocaleString()}P
                  </button>
                </div>
              </div>
            );
          })()}

          {step==="res" && (() => {
            const won = pos && m.res === pos.side;
            const baseReward = won ? Math.round(pos.sh) : 0;
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

      {/* Footer */}
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
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize:".7em",
            color:"#f7931a", background:"#f7931a15", padding:"2px 6px",
            borderRadius:4, textTransform:"uppercase"
          }}>PREDICTION</span>
          {marketPool(m.qY, m.qN, m.b) > 0 && <span style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".85em" }}>
            <span style={gld}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</span>
          </span>}
        </div>
      </div>
    </div>
  );
};

const TrendDualChart = ({ snapshots, m, aLeads, bLeads, colorOverride }) => {
  const startA = Number(m.startMc) || 0;
  const startB = Number(m.startMcB) || 0;

  // Use latest snapshot as current value so chart endpoint matches the numbers
  const last = snapshots && snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const curA = last ? (Number(last.score_a) || Number(m.mc) || 0) : (Number(m.mc) || 0);
  const curB = last ? (Number(last.score_b) || Number(m.mcB) || 0) : (Number(m.mcB) || 0);

  // Build parallel point arrays as % change from start
  const buildPoints = (startVal, curVal, scoreKey) => {
    const base = startVal || 1;
    const pts = [{ score: 0, t: 0 }];
    if (snapshots && snapshots.length > 0) {
      // Filter out snapshots with 0/missing values (bad CoinGecko data)
      const valid = snapshots.filter(s => Number(s.score_a) > 0 && Number(s.score_b) > 0);
      const t0 = valid.length > 0 ? new Date(valid[0].recorded_at).getTime() : Date.now();
      const span = Date.now() - t0 || 1;
      valid.forEach(s => {
        const raw = Number(s[scoreKey]) || 0;
        pts.push({ score: ((raw - base) / base) * 100, t: (new Date(s.recorded_at).getTime() - t0) / span });
      });
    }
    pts.push({ score: ((curVal - base) / base) * 100, t: 1 });
    return pts;
  };
  const ptsA = buildPoints(startA, curA, 'score_a');
  const ptsB = buildPoints(startB, curB, 'score_b');

  const W = 200, H = 56, PAD = 4;
  const allScores = [...ptsA.map(p => p.score), ...ptsB.map(p => p.score)];
  const min = Math.min(...allScores, 0) - 2, max = Math.max(...allScores, 0) + 2;
  const range = max - min || 1;

  const toPath = (pts) => pts.map((p, i) => {
    const x = PAD + p.t * (W - PAD * 2);
    const y = PAD + (1 - (p.score - min) / range) * (H - PAD * 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const endY = (pts) => {
    const last = pts[pts.length - 1];
    return PAD + (1 - (last.score - min) / range) * (H - PAD * 2);
  };

  const colorA = colorOverride?.a || "#64B5F6", colorB = colorOverride?.b || "#a78bfa";

  return React.createElement('div', { style: { width: '100%' } },
    React.createElement('svg', { width: '100%', viewBox: '0 0 ' + W + ' ' + H, style: { overflow: 'visible', display: 'block' } },
      React.createElement('path', { d: toPath(ptsA), fill: 'none', stroke: colorA, strokeWidth: aLeads ? 2.2 : 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      React.createElement('path', { d: toPath(ptsB), fill: 'none', stroke: colorB, strokeWidth: bLeads ? 2.2 : 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      React.createElement('circle', { cx: W - PAD, cy: endY(ptsA), r: 2.5, fill: colorA }),
      React.createElement('circle', { cx: W - PAD, cy: endY(ptsB), r: 2.5, fill: colorB })
    )
  );
};

const BattleCard = ({ m, bal, pos, players, onBuy, onSell, onClaim, streak, isMobile, memeUser, onLoginRequired, trendSnaps = {} }) => {
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
  const pnl = pos ? grossRf - pos.inv : 0;
  const colorA = m.c.color || "#71BAFF";
  const colorB = m.cB?.color || "#a78bfa";

  // Snapshot-aware price computations (hoisted for use in header + price section)
  let curA = m.mc, curB = m.mcB;
  if (m.type === "TRENDS") {
    const snaps = trendSnaps[m.id];
    if (snaps && snaps.length > 0) {
      const last = snaps[snaps.length - 1];
      curA = Number(last.score_a) || m.mc;
      curB = Number(last.score_b) || m.mcB;
    }
  }
  const tPctA = m.type === "TRENDS" ? (m.startMc > 0 ? ((curA - m.startMc) / m.startMc * 100) : 0) : pctA;
  const tPctB = m.type === "TRENDS" ? (m.startMcB > 0 ? ((curB - m.startMcB) / m.startMcB * 100) : 0) : pctB;
  const aLeads = tPctA > tPctB;
  const bLeads = tPctB > tPctA;
  const tied = tPctA === tPctB;
  const isLosingA = bLeads;
  const isLosingB = aLeads;
  const pctGradStyle = (pct, leads, gold, losing) => {
    const grad = leads
      ? (gold ? "linear-gradient(135deg, #FFD54F, #FF9800, #FFE082)" : "linear-gradient(135deg, #82B1FF, #448AFF, #B388FF)")
      : losing ? (pct >= 0 ? "linear-gradient(135deg, #777, #999, #777)" : "linear-gradient(135deg, #b71c1c, #d32f2f, #e53935)")
      : (pct >= 0 ? "linear-gradient(135deg, #4ade80, #22c55e)" : "linear-gradient(135deg, #f65e5e, #ef4444)");
    const fallback = leads ? (gold ? "#FF9800" : "#448AFF") : losing ? (pct >= 0 ? "#999" : "#d32f2f") : (pct >= 0 ? "#4ade80" : "#f65e5e");
    return {
      fontFamily: "'Jersey 25',sans-serif", fontSize: "1.6em", fontWeight: 900, letterSpacing: 1,
      color: fallback,
      backgroundImage: grad,
      backgroundClip: "text", WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      filter: leads ? `drop-shadow(0 0 8px ${gold ? "#FF980066" : "#448AFF66"})` : "none",
      transition: "all 0.3s ease"
    };
  };
  const hasBet = pos && !pos.claimed && m.st === "OPEN";

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

  const sideLabel = (s) => s === "YES" ? (m.type === "TRENDS" ? m.c.sym : "$" + m.c.sym) : (m.type === "TRENDS" ? (m.cB?.sym || "?") : "$" + (m.cB?.sym || "?"));

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
        {/* Unified header: 3-column grid — sides have image + % box, middle has title/clock + graph */}
        <div style={{
          display: "flex", alignItems: "flex-start", marginBottom: 14
        }}>
          {/* Left column: Coin A image + % box */}
          <div style={{ flex: "0 0 92px", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            <CoinImg src={m.c.img} color={colorA} size={92} sym={m.c.sym}/>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start",
              width: 92, boxSizing: "border-box", padding: "3px 8px", borderRadius: 8, marginTop: 10,
              background: aLeads ? "#FF98000a" : bLeads ? "#f65e5e0a" : "transparent",
              border: aLeads ? "1px solid #FF980025" : bLeads ? "1px solid #f65e5e20" : "1px solid transparent",
              transition: "all 0.3s ease"
            }}>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".5em", marginBottom: 1,
                color: aLeads ? "#FF9800" : bLeads ? "#f65e5e" : "#ffffff30"
              }}>{aLeads ? "WINNING" : bLeads ? "LOSING" : tied ? "TIED" : ""}&nbsp;</div>
              {m.type === "TRENDS" ? (() => {
                const chg = m.startMc > 0 ? ((curA - m.startMc) / m.startMc * 100) : 0;
                const chgColor = aLeads ? "#4ade80" : chg >= 0 ? "#999" : "#f65e5e";
                return <span style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1.4em", color: chgColor
                }}>{chg >= 0 ? "+" : ""}{chg.toFixed(0)}%</span>;
              })() : <span style={pctGradStyle(pctA, aLeads, true, isLosingA)}>
                {pctA >= 0 ? "+" : ""}{pctA.toFixed(1)}%
              </span>}
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".58em", color: "#ffffff58", marginTop: 1
              }}>{m.type === "TRENDS" ? (<>{Math.round(m.startMc)} <span style={{ color: "#ffffff40" }}>→</span> {Math.round(curA)}</>) : (<>{fM(m.startMc)} → {fM(m.mc)}</>)}</div>
            </div>
          </div>
          {/* Middle column: title/clock on top, graph below */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{
              fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.35em",
              textTransform: "uppercase", lineHeight: 1.2,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8
            }}>
              {(() => {
                const trendsUrl = m.type === "TRENDS" ? `https://trends.google.com/trends/explore?q=${encodeURIComponent(m.trendTermA || m.c.sym)},${encodeURIComponent(m.trendTermB || m.cB?.sym)}&date=today+1-m` : null;
                return <>
                  {m.type === "TRENDS"
                    ? <a href={trendsUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#64B5F6", textDecoration: "none" }}>{m.c.sym}</a>
                    : <a href={`https://meme.com/coin/${MEME_SLUGS[m.c.sym] || m.c.sym.toLowerCase()}`} target="_blank" rel="noopener noreferrer" style={{ color: colorA, textDecoration: "none" }}>${m.c.sym}</a>}
                  <span style={{ fontSize: ".85em", color: "#ffffff" }}>VS</span>
                  {m.type === "TRENDS"
                    ? <a href={trendsUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#a78bfa", textDecoration: "none" }}>{m.cB?.sym}</a>
                    : <a href={`https://meme.com/coin/${MEME_SLUGS[m.cB?.sym] || (m.cB?.sym || "").toLowerCase()}`} target="_blank" rel="noopener noreferrer" style={{ color: colorB, textDecoration: "none" }}>${m.cB?.sym}</a>}
                </>;
              })()}
            </div>
            <div className="tip" data-tip={new Date(m.ea).toLocaleString()} style={{
              display: "inline-block", padding: "1px 8px", borderRadius: 6, marginTop: 4, cursor: "default",
              background: sec <= 300 ? "rgba(247,147,26,0.12)" : "rgba(255,255,255,0.04)",
              border: sec <= 300 ? "1px solid rgba(247,147,26,0.3)" : "1px solid transparent",
              animation: sec <= 300 ? "timerPulse 1s ease-in-out infinite" : undefined
            }}>
              <span style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em",
                letterSpacing: "1px", ...gld
              }}>{fT(sec)}</span>
            </div>
            {(m.type === "TRENDS" || m.type === "BATTLE") && <div style={{ width: "75%", marginTop: 6 }}>
              {React.createElement(TrendDualChart, {
                snapshots: trendSnaps[m.id] || [],
                m: m, aLeads: aLeads, bLeads: bLeads,
                colorOverride: m.type === "BATTLE" ? { a: colorA, b: colorB } : undefined
              })}
            </div>}
          </div>
          {/* Right column: Coin B image + % box */}
          <div style={{ flex: "0 0 92px", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <CoinImg src={m.cB?.img} color={colorB} size={92} sym={m.cB?.sym}/>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end",
              width: 92, boxSizing: "border-box", padding: "3px 8px", borderRadius: 8, marginTop: 10,
              background: bLeads ? "#448AFF0a" : aLeads ? "#f65e5e0a" : "transparent",
              border: bLeads ? "1px solid #448AFF25" : aLeads ? "1px solid #f65e5e20" : "1px solid transparent",
              transition: "all 0.3s ease"
            }}>
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".5em", marginBottom: 1,
                color: bLeads ? "#448AFF" : aLeads ? "#f65e5e" : "#ffffff30"
              }}>{bLeads ? "WINNING" : aLeads ? "LOSING" : tied ? "TIED" : ""}&nbsp;</div>
              {m.type === "TRENDS" ? (() => {
                const chg = m.startMcB > 0 ? ((curB - m.startMcB) / m.startMcB * 100) : 0;
                const chgColor = bLeads ? "#4ade80" : chg >= 0 ? "#999" : "#f65e5e";
                return <span style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1.4em", color: chgColor
                }}>{chg >= 0 ? "+" : ""}{chg.toFixed(0)}%</span>;
              })() : <span style={pctGradStyle(pctB, bLeads, false, isLosingB)}>
                {pctB >= 0 ? "+" : ""}{pctB.toFixed(1)}%
              </span>}
              <div style={{
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".58em", color: "#ffffff58", marginTop: 1
              }}>{m.type === "TRENDS" ? (<>{Math.round(m.startMcB)} <span style={{ color: "#ffffff40" }}>→</span> {Math.round(curB)}</>) : (<>{fM(m.startMcB)} → {fM(m.mcB)}</>)}</div>
            </div>
          </div>
        </div>
        {hasBet && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{
              fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em",
              color: "#ffffff40"
            }}>YOUR BET</span>
            <span style={{
              fontFamily: "'Jersey 25',sans-serif", fontSize: "1.1em",
              color: pos.side === "YES" ? colorA : colorB
            }}>
              {grossRf.toLocaleString()} {pos.side === "YES" ? m.c.sym : (m.cB?.sym || "?")}
            </span>
            <span style={{
              fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em",
              color: pnl >= 0 ? "#4ade80" : "#f65e5e"
            }}>
              {pnl >= 0 ? "+" : ""}{pnl.toLocaleString()}
            </span>
          </div>
        )}

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
          {step === "sel" && m.st === "OPEN" && !pos && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: colorA + "8a", opacity: yp < 1 ? 0.3 : 1 }}
                disabled={yp < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); }}>
                {m.type === "TRENDS" ? m.c.sym : `$${m.c.sym}`} {yp < 1 ? "(locked)" : ""}
              </button>
              <button style={{ ...bx, background: colorB + "8a", opacity: np < 1 ? 0.3 : 1 }}
                disabled={np < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); }}>
                {m.type === "TRENDS" ? (m.cB?.sym || "?") : `$${m.cB?.sym}`} {np < 1 ? "(locked)" : ""}
              </button>
            </div>
          )}
          {step === "sel" && m.st === "OPEN" && pos && !pos.claimed && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: pos.side === "YES" ? colorA : colorB }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>ADD MORE {pos.side === "YES" ? m.c.sym : (m.cB?.sym || "?")}</button>
              <button style={{ ...bx, background: (pos.side === "YES" ? colorA : colorB) + "8a" }}
                onClick={() => setStep("sellConfirm")}>SELL</button>
            </div>
          )}

          {step === "amt" && (() => {
            const floorMax = maxBetForFloor(m.qY, m.qN, m.b, side);
            const effectiveMax = Math.min(bal, floorMax);
            const isFloorLimited = floorMax < bal;
            return (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{
                display: "flex", justifyContent: "flex-end", alignItems: "center",
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", gap: 8
              }}>
                {isFloorLimited && <span style={{ color: "#f7931a" }}>MAX: {effectiveMax.toLocaleString()}</span>}
                <span style={gld}>BAL: {bal.toLocaleString()}</span>
              </div>
              <input type="number" inputMode="numeric" pattern="[0-9]*" placeholder="Amount..."
                value={amt} onChange={e => setAmt(e.target.value)} onFocus={e => e.target.select()} autoFocus
                style={{
                  height: 42, border: "1px solid #4c5159", borderRadius: 15,
                  textAlign: "center", color: "#fff", background: "transparent",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1em", outline: "none",
                  width: "100%"
                }}/>
              <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                {[10, 25, 50, 100].map(p =>
                  <button key={p}
                    onClick={() => setAmt(String(Math.floor(effectiveMax * p / 100)))}
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
                // POOL-SPLIT-V1: const loserInv = side === "YES" ? m.nInv : m.yInv;
                // POOL-SPLIT-V1: const winnerSh = (side === "YES" ? m.qY - m.b + sh : m.qN - m.b + sh);
                // POOL-SPLIT-V1: const poolPayout = loserInv > 0 ? net + Math.round(sh / winnerSh * loserInv) : net;
                // POOL-SPLIT-V1: const payout = Math.max(poolPayout, sh);
                const payout = sh;  // Pure LMSR: 1 per winning share
                const multRaw = payout / net;
                const mult = multRaw < 2 ? multRaw.toFixed(2) : multRaw.toFixed(1);
                return (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", textAlign: "center", marginBottom: 2 }}>
                    {feeStr} / ~{mult}x if {sideLabel(side)} wins
                  </div>
                );
              })()}
              {isFloorLimited && parseInt(amt) > effectiveMax && (
                <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".7em", color: "#f7931a", textAlign: "center", marginBottom: 2 }}>
                  Max bet {effectiveMax.toLocaleString()} (odds limit)
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button style={{ ...bx, background: "#00000042", flex: "0 0 40px" }}
                  onClick={() => { setStep("sel"); setSide(null); setAmt(""); }}>X</button>
                <button
                  style={{ ...bx, flex: "1 1 auto", background: side === "YES" ? colorA + "8a" : colorB + "8a" }}
                  onClick={doBuy}
                  disabled={!amt || parseInt(amt) <= 0 || parseInt(amt) > effectiveMax}>
                  BET {sideLabel(side)} {amt ? "(" + parseInt(amt).toLocaleString() + ")" : ""}
                </button>
              </div>
            </div>
          );})()}

          {step === "pos" && pos && m.st === "OPEN" && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: pos.side === "YES" ? colorA : colorB }}
                onClick={() => { setSide(pos.side); setStep("amt"); }}>ADD MORE {pos.side === "YES" ? m.c.sym : (m.cB?.sym || "?")}</button>
              <button style={{ ...bx, background: (pos.side === "YES" ? colorA : colorB) + "8a" }}
                onClick={() => setStep("sellConfirm")}>SELL</button>
            </div>
          )}

          {step === "sellConfirm" && pos && m.st === "OPEN" && (() => {
            const grossRf = sellShares(m.qY, m.qN, m.b, pos.sh, pos.side);
            const netRf = grossRf - Math.round(grossRf * 0.02);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", textAlign: "center",
                  color: "#fff", background: "#242a35", borderRadius: 8, padding: "8px 12px"
                }}>YOU WILL WITHDRAW 100% OF YOUR CURRENT POSITION.</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button style={{ ...bx, background: "#00000042", flex: "0 0 50px" }}
                    onClick={() => setStep("pos")}>✕</button>
                  <button style={{ ...bx, background: "#71baff8a", flex: 1 }}
                    onClick={() => { setStep("pos"); onSell(m.id); }}>
                    WITHDRAW TO GET {netRf.toLocaleString()}P
                  </button>
                </div>
              </div>
            );
          })()}

          {step === "res" && (() => {
            const won = pos && m.res === pos.side;
            // POOL-SPLIT-V1: const poolReward = won && m.wws > 0 ? pos.inv + Math.round(pos.sh / m.wws * (m.pot - m.wis)) : 0;
            // POOL-SPLIT-V1: const baseReward = won ? Math.max(poolReward, pos.sh) : 0;
            const baseReward = won ? Math.round(pos.sh) : 0;
            const winnerSym = m.res === "YES" ? m.c.sym : m.cB?.sym;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{
                  fontFamily: "'Londrina Solid',sans-serif", fontSize: ".9em",
                  textAlign: "center", marginBottom: 4,
                  color: m.res === "YES" ? colorA : colorB
                }}>{m.type === "TRENDS" ? winnerSym : "$" + winnerSym} WON!</div>
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
            fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em",
            background: "linear-gradient(90deg, " + colorA + "40, " + colorB + "40)",
            padding: "3px 8px", borderRadius: 4, color: "#ffffffcc"
          }}>{m.type === "TRENDS" ? (() => { const days = m.ca ? Math.round((m.ea - m.ca) / 86400000) : 7; return days + "D GOOGLE TRENDS"; })() : "48H COIN BATTLE"}</span>
        </div>
        {marketPool(m.qY, m.qN, m.b) > 0 && <span style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
          <span style={{ color: "#ffffff30", marginRight: 4 }}></span>
          <span style={gld}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</span>
        </span>}
      </div>
    </div>
  );
};

// ─── MEMEMARKET CARD ───
const MemeMarketCard = ({ m, bal, pos, players, onBuy, onSell, onClaim, isMobile, memeUser, onLoginRequired, trendSnaps = {} }) => {
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
  const scoreChange = m.startMc > 0 && m.startMc !== 50 ? ((m.mc - m.startMc) / m.startMc * 100) : 0;
  const grossRf = pos ? sellShares(m.qY, m.qN, m.b, pos.sh, pos.side) : 0;
  const sellFee = pos && m.st === "OPEN" ? Math.round(grossRf * 0.02) : 0;
  const rf = grossRf - sellFee;
  const pnl = pos ? grossRf - pos.inv : 0;
  const isInitializing = m.startMc === 50 && m.mc === 50;

  // Sparkline from snapshots
  const snaps = trendSnaps[m.id] || [];
  const sparkPoints = snaps.length > 1 ? (() => {
    const scores = snaps.map(s => s.score_a);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    const w = 120, h = 28;
    return scores.map((s, i) =>
      `${(i / (scores.length - 1)) * w},${h - ((s - min) / range) * h}`
    ).join(" ");
  })() : null;

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

  const durationLabel = (() => {
    if (!m.ca) return "";
    const hours = Math.round((m.ea - m.ca) / 3600000);
    if (hours <= 24) return "1D";
    if (hours <= 72) return "3D";
    return "7D";
  })();

  return (
    <div style={{
      background: "linear-gradient(360deg,#1a2636,#2a4060)",
      boxShadow: "0 4px 44px #ffffff12,0 4px 12px #000000b8",
      borderRadius: "16px 16px 25px 25px", padding: "5px 6px 10px"
    }}>
      <div style={{
        background: "#191f29", borderRadius: 14, padding: "14px 18px",
        minHeight: 192, display: "flex", flexDirection: "column",
        justifyContent: "space-between"
      }}>
        {/* Header: image + title + countdown */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10, gap: 10, justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
            {m.c.img && (
              <div style={{
                width: 40, height: 40, borderRadius: 12, flexShrink: 0, overflow: "hidden",
                border: "1px solid #ffffff1a", background: "#0c1018"
              }}>
                <img src={m.c.img} alt="" style={{
                  width: "100%", height: "100%", objectFit: "cover", borderRadius: 11
                }} onError={e => { e.target.style.display = "none"; }} />
              </div>
            )}
            <div>
              <div style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: ".95em",
                lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis",
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
              }}>{m.customTitle || `Will ${m.c.name} trend UP?`}</div>
              <a href={`https://trends.google.com/trends/explore?q=${encodeURIComponent(m.trendTermA || m.c.name)}&date=now%207-d`}
                target="_blank" rel="noopener noreferrer"
                style={{ fontSize: ".65em", color: "#71BAFF", textDecoration: "none", fontFamily: "'Jersey 25',sans-serif" }}>
                Google Trends
              </a>
            </div>
          </div>
          <div className="tip" data-tip={new Date(m.ea).toLocaleString()} style={{
            padding: "2px 8px", borderRadius: 8, flexShrink: 0, cursor: "default",
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

        {/* Score display + sparkline */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, padding: "6px 10px", background: "#0c101820", borderRadius: 8 }}>
          <div>
            <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em", color: "#ffffff40" }}>TREND SCORE</div>
            {isInitializing ? (
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", color: "#f7931a" }}>Initializing...</div>
            ) : (
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: "1em" }}>
                <span style={{ color: "#ffffff60" }}>{Math.round(m.startMc)}</span>
                <span style={{ color: "#ffffff30", margin: "0 4px" }}>&rarr;</span>
                <span style={{ color: scoreChange >= 0 ? "#22c55e" : "#ef4444", fontWeight: "bold" }}>{Math.round(m.mc)}</span>
                <span style={{ fontSize: ".8em", color: scoreChange >= 0 ? "#22c55e80" : "#ef444480", marginLeft: 4 }}>
                  {scoreChange >= 0 ? "+" : ""}{scoreChange.toFixed(1)}%
                </span>
              </div>
            )}
          </div>
          {sparkPoints && (
            <svg width="120" height="28" viewBox="0 0 120 28" style={{ flexShrink: 0 }}>
              <polyline points={sparkPoints} fill="none" stroke="#71BAFF" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        {/* Bet display */}
        {pos && !pos.claimed && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "nowrap", overflow: "hidden" }}>
            <div style={{ minWidth: 0, flexShrink: 1 }}>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em", color: "#ffffff40", marginBottom: 2 }}>YOUR BET</div>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
                <span style={{ color: pos.side === "YES" ? "#22c55e" : "#ef4444" }}>
                  {pos.side === "YES" ? "UP" : "DOWN"}
                </span>
                <span style={{ color: "#ffffff40", margin: "0 4px" }}>|</span>
                <span style={gld}>{Math.round(pos.inv).toLocaleString()}</span>
              </div>
            </div>
            <div style={{ minWidth: 0, flexShrink: 1, marginLeft: "auto" }}>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em", color: "#ffffff40", marginBottom: 2 }}>VALUE</div>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
                <span style={gld}>{Math.round(rf).toLocaleString()}</span>
                <span style={{ fontSize: ".8em", color: pnl >= 0 ? "#22c55e80" : "#ef444480", marginLeft: 4 }}>
                  {pnl >= 0 ? "+" : ""}{Math.round(pnl).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Probability bar */}
        <div style={{ display: "flex", height: 22, borderRadius: 8, overflow: "hidden", marginBottom: 10, fontSize: ".75em", fontFamily: "'Jersey 25',sans-serif" }}>
          <div style={{ width: yp + "%", background: "linear-gradient(90deg, #22c55e, #16a34a)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", minWidth: yp > 8 ? undefined : 0 }}>
            {yp > 8 && `UP ${Math.round(yp)}%`}
          </div>
          <div style={{ width: np + "%", background: "linear-gradient(90deg, #dc2626, #ef4444)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", minWidth: np > 8 ? undefined : 0 }}>
            {np > 8 && `DOWN ${Math.round(np)}%`}
          </div>
        </div>

        {/* Action buttons */}
        {step === "sel" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); }}
              style={{ ...bx, background: "linear-gradient(135deg,#22c55e,#16a34a)" }}>BET UP</button>
            <button onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); }}
              style={{ ...bx, background: "linear-gradient(135deg,#ef4444,#dc2626)" }}>BET DOWN</button>
          </div>
        )}
        {step === "amt" && (
          <div>
            <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", marginBottom: 4 }}>
              Amount ({side === "YES" ? "UP" : "DOWN"})
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              {[100, 500, 1000].map(v => (
                <button key={v} onClick={() => setAmt(String(Math.min(v, bal)))}
                  style={{ ...bx, height: 30, fontSize: ".85em", background: amt === String(v) ? "#ffffff30" : "#ffffff10", borderRadius: 8, flex: 1 }}>
                  {v.toLocaleString()}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="number" value={amt} onChange={e => setAmt(e.target.value)}
                placeholder="Custom" style={{
                  flex: 1, height: 36, borderRadius: 10, border: "1px solid #ffffff20",
                  background: "#0c1018", color: "#fff", padding: "0 10px",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1em", outline: "none"
                }} />
              <button onClick={doBuy}
                style={{ ...bx, width: 80, background: side === "YES" ? "linear-gradient(135deg,#22c55e,#16a34a)" : "linear-gradient(135deg,#ef4444,#dc2626)" }}>BET</button>
            </div>
            <button onClick={() => { setStep("sel"); setSide(null); setAmt(""); }}
              style={{ background: "none", border: "none", color: "#ffffff40", cursor: "pointer", fontSize: ".7em", fontFamily: "'Jersey 25',sans-serif", marginTop: 4 }}>Cancel</button>
          </div>
        )}
        {step === "pos" && pos && (
          <div>
            <button onClick={() => setStep("sellConfirm")}
              style={{ ...bx, background: "#ffffff10", marginBottom: 4 }}>
              SELL ({Math.round(rf).toLocaleString()})
            </button>
          </div>
        )}
        {step === "sellConfirm" && pos && (
          <div>
            <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#ffffff60", marginBottom: 6, textAlign: "center" }}>
              Sell for {Math.round(rf).toLocaleString()} ({pnl >= 0 ? "+" : ""}{Math.round(pnl).toLocaleString()} PnL)?{sellFee > 0 && ` Fee: ${sellFee}`}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setStep("pos")}
                style={{ ...bx, background: "#ffffff10" }}>CANCEL</button>
              <button onClick={() => { onSell(m.id); setStep("sel"); }}
                style={{ ...bx, background: "linear-gradient(135deg,#f7931a,#e8720c)" }}>CONFIRM SELL</button>
            </div>
          </div>
        )}
        {step === "res" && pos && (
          <div>
            {m.res === pos.side ? (
              <button onClick={() => onClaim(m.id)}
                style={{ ...bx, background: "linear-gradient(135deg,#22c55e,#16a34a)", animation: "claimPop .4s ease-out, claimGlow 2s ease-in-out" }}>
                CLAIM {Math.round(pos.sh).toLocaleString()}
              </button>
            ) : (
              <button onClick={() => onClaim(m.id)}
                style={{ ...bx, background: "#ffffff10", color: "#ffffff60" }}>
                YOU LOST. CLOSE.
              </button>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontSize: ".75em" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontFamily: "'Jersey 25',sans-serif",
              background: "linear-gradient(90deg, #71BAFF40, #4a90d940)",
              padding: "2px 8px", borderRadius: 4, color: "#71BAFF"
            }}>{durationLabel} MEMEMARKET</span>
            {m.creationFee > 0 && (
              <span style={{
                fontFamily: "'Jersey 25',sans-serif",
                background: "linear-gradient(90deg, #22c55e30, #16a34a20)",
                padding: "2px 8px", borderRadius: 4, color: "#22c55e"
              }}>{m.creationFee >= 1000 ? Math.round(m.creationFee / 1000) + "K" : m.creationFee} LIQ</span>
            )}
          </div>
          {marketPool(m.qY, m.qN, m.b) > 0 && (
            <span style={{ fontFamily: "'Jersey 25',sans-serif" }}>
              <span style={gld}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── MEMEMARKET WATCHLIST ───
const MEME_WATCHLIST = [
  { name: "Doge", term: "doge meme", img: "https://i.imgflip.com/4t0m5.jpg" },
  { name: "Pepe", term: "pepe the frog", img: "https://i.imgflip.com/1ur9b0.jpg" },
  { name: "Wojak", term: "wojak meme", img: "https://i.imgflip.com/2zo1ki.jpg" },
  { name: "Distracted Boyfriend", term: "distracted boyfriend meme", img: "https://i.imgflip.com/1ur9b0.jpg" },
  { name: "Drake", term: "drake meme", img: "https://i.imgflip.com/30b1gx.jpg" },
  { name: "NPC", term: "NPC meme", img: "" },
  { name: "Stonks", term: "stonks meme", img: "" },
  { name: "This Is Fine", term: "this is fine meme", img: "" },
  { name: "Galaxy Brain", term: "galaxy brain meme", img: "" },
  { name: "Chad", term: "chad meme", img: "" },
  { name: "Soyjak", term: "soyjak meme", img: "" },
  { name: "Giga Chad", term: "gigachad meme", img: "" },
  { name: "Brainlet", term: "brainlet meme", img: "" },
  { name: "Cope", term: "copium meme", img: "" },
  { name: "Based", term: "based meme", img: "" },
  { name: "Touching Grass", term: "touch grass meme", img: "" },
  { name: "Rug Pull", term: "rug pull crypto", img: "" },
  { name: "Diamond Hands", term: "diamond hands meme", img: "" },
  { name: "To The Moon", term: "to the moon crypto", img: "" },
  { name: "WAGMI", term: "wagmi crypto", img: "" },
  { name: "Keyboard Cat", term: "keyboard cat meme", img: "" },
  { name: "Rickroll", term: "rickroll meme", img: "" },
  { name: "Grumpy Cat", term: "grumpy cat meme", img: "" },
  { name: "Elon Musk", term: "elon musk meme", img: "" },
  { name: "Shiba Inu", term: "shiba inu meme", img: "" },
  { name: "Bonk", term: "bonk meme", img: "" },
  { name: "Sus", term: "sus among us meme", img: "" },
  { name: "Skibidi", term: "skibidi toilet meme", img: "" },
  { name: "Sigma", term: "sigma male meme", img: "" },
  { name: "Mog", term: "mogging meme", img: "" },
];

// ─── MEMEMARKET CREATE MODAL ───
const MemeMarketCreateModal = ({ show, onClose, bal, onCreated, memeUser, onLoginRequired }) => {
  const [wizStep, setWizStep] = useState(1); // 1=pick, 2=duration, 3=confirm
  const [memeName, setMemeName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [duration, setDuration] = useState(72);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [liquidity, setLiquidity] = useState(100000);
  const MIN_LIQUIDITY = 100000;

  if (!show) return null;

  const filteredWatchlist = search
    ? MEME_WATCHLIST.filter(w => w.name.toLowerCase().includes(search.toLowerCase()))
    : MEME_WATCHLIST;

  const selectMeme = (w) => {
    setMemeName(w.name);
    setImageUrl(w.img || "");
    setWizStep(2);
  };

  const selectCustom = () => {
    if (!memeName.trim() || !imageUrl.trim()) return;
    setWizStep(2);
  };

  const effectiveLiquidity = Math.max(liquidity, MIN_LIQUIDITY);

  const doCreate = async () => {
    if (!memeUser) { onLoginRequired(); return; }
    if (bal < effectiveLiquidity) { setError("Need " + effectiveLiquidity.toLocaleString() + " memescore"); return; }
    setCreating(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc('labs_create_mememarket', {
        p_user_id: memeUser.id || memeUser.user_id,
        p_meme_name: memeName.trim(),
        p_trend_term: memeName.trim(),
        p_image_url: imageUrl.trim(),
        p_duration_hours: duration,
        p_liquidity: effectiveLiquidity,
      });
      if (rpcErr) throw rpcErr;
      const result = typeof data === 'string' ? JSON.parse(data) : data;
      if (!result.success) {
        const msgs = {
          name_invalid: "Name must be 2-50 characters",
          term_invalid: "Trend term must be 2-80 characters",
          duration_invalid: "Invalid duration",
          max_markets_reached: "Max 20 markets reached. Try again later.",
          duplicate_term: "A market for this term already exists!",
          user_not_found: "User not found. Try refreshing.",
          insufficient_balance: "Not enough balance (need " + effectiveLiquidity.toLocaleString() + ")",
        };
        setError(msgs[result.error] || result.error);
        setCreating(false);
        return;
      }
      onCreated(result);
      onClose();
      // Reset
      setWizStep(1);
      setMemeName("");
      setImageUrl("");
      setDuration(72);
      setSearch("");
      setLiquidity(100000);
    } catch (e) {
      setError(e.message || "Failed to create market");
    }
    setCreating(false);
  };

  const durationOpts = [
    { hours: 24, label: "1 DAY" },
    { hours: 72, label: "3 DAYS" },
    { hours: 168, label: "7 DAYS" },
  ];

  const overlayStyle = {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0,0,0,0.7)", zIndex: 1000,
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 16
  };
  const modalStyle = {
    background: "#191f29", borderRadius: 20, padding: "24px 28px",
    maxWidth: 440, width: "100%", maxHeight: "85vh", overflow: "auto",
    boxShadow: "0 8px 48px rgba(0,0,0,0.6)", border: "1px solid #ffffff10"
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.3em" }}>
            {wizStep === 1 ? "Pick a Meme" : wizStep === 2 ? "Choose Duration" : "Confirm Market"}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#ffffff60", cursor: "pointer", fontSize: "1.3em" }}>&times;</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {[1, 2, 3].map(s => (
            <div key={s} style={{
              flex: 1, height: 3, borderRadius: 2,
              background: s <= wizStep ? "linear-gradient(90deg,#71BAFF,#4a90d9)" : "#ffffff15"
            }} />
          ))}
        </div>

        {/* Step 1: Pick meme */}
        {wizStep === 1 && (
          <div>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search memes..." style={{
                width: "100%", height: 36, borderRadius: 10, border: "1px solid #ffffff20",
                background: "#0c1018", color: "#fff", padding: "0 12px",
                fontFamily: "'Mulish',sans-serif", fontSize: ".85em", outline: "none",
                marginBottom: 10, boxSizing: "border-box"
              }} />
            <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12 }}>
              {filteredWatchlist.map(w => (
                <button key={w.name} onClick={() => selectMeme(w)} style={{
                  display: "block", width: "100%", padding: "8px 12px", marginBottom: 4,
                  background: "#ffffff08", border: "1px solid #ffffff10", borderRadius: 8,
                  color: "#fff", cursor: "pointer", textAlign: "left",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".9em"
                }}>
                  {w.name}
                </button>
              ))}
            </div>
            <div style={{ borderTop: "1px solid #ffffff10", paddingTop: 12 }}>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em", color: "#ffffff60", marginBottom: 6 }}>Or create custom:</div>
              <input value={memeName} onChange={e => setMemeName(e.target.value)}
                placeholder="Meme name (e.g. Doge)" style={{
                  width: "100%", height: 32, borderRadius: 8, border: "1px solid #ffffff20",
                  background: "#0c1018", color: "#fff", padding: "0 10px",
                  fontFamily: "'Mulish',sans-serif", fontSize: ".85em", outline: "none",
                  marginBottom: 6, boxSizing: "border-box"
                }} />
              <input value={imageUrl} onChange={e => setImageUrl(e.target.value)}
                placeholder="Image URL" style={{
                  width: "100%", height: 32, borderRadius: 8, border: "1px solid #ffffff20",
                  background: "#0c1018", color: "#fff", padding: "0 10px",
                  fontFamily: "'Mulish',sans-serif", fontSize: ".85em", outline: "none",
                  marginBottom: 8, boxSizing: "border-box"
                }} />
              <button onClick={selectCustom} disabled={!memeName.trim() || !imageUrl.trim()}
                style={{
                  width: "100%", height: 36, borderRadius: 10, border: "none",
                  background: memeName.trim() && imageUrl.trim() ? "linear-gradient(135deg,#71BAFF,#4a90d9)" : "#ffffff15",
                  color: "#fff", cursor: memeName.trim() && imageUrl.trim() ? "pointer" : "default",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1em"
                }}>NEXT</button>
            </div>
          </div>
        )}

        {/* Step 2: Duration */}
        {wizStep === 2 && (
          <div>
            <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", color: "#ffffff80", marginBottom: 12, textAlign: "center" }}>
              "Will <span style={{ color: "#71BAFF" }}>{memeName}</span> trend UP?"
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {durationOpts.map(d => (
                <button key={d.hours} onClick={() => setDuration(d.hours)}
                  style={{
                    flex: 1, height: 48, borderRadius: 12, border: duration === d.hours ? "2px solid #71BAFF" : "1px solid #ffffff15",
                    background: duration === d.hours ? "#71BAFF15" : "#ffffff08",
                    color: duration === d.hours ? "#71BAFF" : "#ffffff80",
                    cursor: "pointer", fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em"
                  }}>{d.label}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setWizStep(1)}
                style={{ flex: 1, height: 36, borderRadius: 10, border: "1px solid #ffffff20", background: "none", color: "#ffffff60", cursor: "pointer", fontFamily: "'Jersey 25',sans-serif" }}>BACK</button>
              <button onClick={() => setWizStep(3)}
                style={{ flex: 2, height: 36, borderRadius: 10, border: "none", background: "linear-gradient(135deg,#71BAFF,#4a90d9)", color: "#fff", cursor: "pointer", fontFamily: "'Jersey 25',sans-serif", fontSize: "1em" }}>NEXT</button>
            </div>
          </div>
        )}

        {/* Step 3: Confirm */}
        {wizStep === 3 && (
          <div>
            <div style={{
              background: "#0c101830", borderRadius: 12, padding: 16, marginBottom: 16,
              border: "1px solid #ffffff10"
            }}>
              <div style={{ fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em", marginBottom: 8 }}>
                Will <span style={{ color: "#71BAFF" }}>{memeName}</span> trend UP in {duration === 24 ? "1 day" : duration === 72 ? "3 days" : "7 days"}?
              </div>
              {imageUrl && (
                <img src={imageUrl} alt="" style={{ width: 60, height: 60, borderRadius: 8, marginTop: 8, objectFit: "cover" }}
                  onError={e => { e.target.style.display = "none"; }} />
              )}
            </div>
            <div style={{ borderTop: "1px solid #ffffff10", paddingTop: 12, marginBottom: 12 }}>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", color: "#ffffff80", marginBottom: 8 }}>
                Your Liquidity
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {[100000, 250000, 500000].map(v => (
                  <button key={v} onClick={() => setLiquidity(v)} style={{
                    flex: 1, height: 34, borderRadius: 8,
                    border: liquidity === v ? "2px solid #71BAFF" : "1px solid #ffffff15",
                    background: liquidity === v ? "#71BAFF15" : "#ffffff08",
                    color: liquidity === v ? "#71BAFF" : "#ffffff80",
                    cursor: "pointer", fontFamily: "'Jersey 25',sans-serif", fontSize: ".9em"
                  }}>{v.toLocaleString()}</button>
                ))}
              </div>
              <input type="number" value={liquidity} min={MIN_LIQUIDITY}
                onChange={e => setLiquidity(Math.max(0, parseInt(e.target.value) || 0))}
                style={{
                  width: "100%", height: 34, borderRadius: 8, border: "1px solid #ffffff20",
                  background: "#0c1018", color: "#fff", padding: "0 10px",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".9em", outline: "none",
                  boxSizing: "border-box", textAlign: "right"
                }} />
              {liquidity < MIN_LIQUIDITY && (
                <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".7em", color: "#ef4444", marginTop: 4 }}>
                  Minimum: {MIN_LIQUIDITY.toLocaleString()}
                </div>
              )}
            </div>
            <div style={{
              display: "flex", justifyContent: "space-between", padding: "6px 0 12px",
              fontFamily: "'Jersey 25',sans-serif", fontSize: ".9em"
            }}>
              <span style={{ color: "#ffffff60" }}>Your Balance</span>
              <span style={{ color: bal >= effectiveLiquidity ? "#22c55e" : "#ef4444" }}>{Math.round(bal).toLocaleString()}</span>
            </div>
            <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".7em", color: "#ffffff40", marginBottom: 10 }}>
              You're the market maker. Your cost scales with how one-sided the result is — up to ~69% on obvious outcomes, near zero on contested ones. You earn 50% of all trading fees.
            </div>
            {error && <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em", color: "#ef4444", marginBottom: 8 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setWizStep(2)}
                style={{ flex: 1, height: 40, borderRadius: 12, border: "1px solid #ffffff20", background: "none", color: "#ffffff60", cursor: "pointer", fontFamily: "'Jersey 25',sans-serif" }}>BACK</button>
              <button onClick={doCreate} disabled={creating || bal < effectiveLiquidity}
                style={{
                  flex: 2, height: 40, borderRadius: 12, border: "none",
                  background: creating || bal < effectiveLiquidity ? "#ffffff15" : "linear-gradient(135deg,#71BAFF,#4a90d9)",
                  color: "#fff", cursor: creating || bal < effectiveLiquidity ? "default" : "pointer",
                  fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em"
                }}>{creating ? "Creating..." : "CREATE MARKET"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const PredictionCard = ({ pm, memescore, authToken, memeUser, onLoginRequired, setMemescore, setPmMarkets, isMobile }) => {
  const [step, setStep] = useState("sel");
  const [side, setSide] = useState(null);
  const [amt, setAmt] = useState("");
  const [sec, setSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [soldInfo, setSoldInfo] = useState(null);

  const pmExpiry = pm.expires_at || pm.ending_date;
  useEffect(() => {
    if (!pmExpiry) return;
    const t = () => setSec(Math.max(0, Math.floor((new Date(pmExpiry).getTime() - Date.now()) / 1000)));
    t();
    const i = setInterval(t, 1000);
    return () => clearInterval(i);
  }, [pmExpiry]);

  // Predictions v1 timer: HH:MM:SS for <24h, "DD MMM" for >=24h
  const pmTimer = (s) => {
    if (s <= 0) return "RESOLVED";
    if (s < 86400) {
      const h = Math.floor(s / 3600), mn = Math.floor((s % 3600) / 60), sc = s % 60;
      return String(h).padStart(2, "0") + ":" + String(mn).padStart(2, "0") + ":" + String(sc).padStart(2, "0");
    }
    const target = new Date(Date.now() + s * 1000);
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(target);
  };

  const up = pm.user_position;
  const posSide = up && (up.yes_shares_amount || 0) > 0 ? "YES" : up && (up.no_shares_amount || 0) > 0 ? "NO" : null;
  const posShares = posSide === "YES" ? (up?.yes_shares_amount || 0) : (up?.no_shares_amount || 0);
  const posInvested = posSide === "YES" ? (up?.invested_yes_memescore || 0) : (up?.invested_no_memescore || 0);
  const hasPos = posSide !== null && posShares > 0;
  const isResolved = pm.status === "RESOLVED";

  useEffect(() => {
    if (isResolved && hasPos && !up?.claimed) setStep("res");
    else if (isResolved) setStep("res");
    else if (!isResolved && hasPos) setStep("pos");
    else setStep("sel");
  }, [pm.status, posSide, up?.claimed]);

  const qY = (pm.total_yes_shares || 0) + (pm.liquidity || 0);
  const qN = (pm.total_no_shares || 0) + (pm.liquidity || 0);
  const B = pm.liquidity || 1;
  const yp = yP(qY, qN, B);
  const np = 100 - yp;

  const posValue = hasPos ? sellShares(qY, qN, B, posShares, posSide) : 0;
  const posPnl = posValue - posInvested;

  const maxPct = pm.max_memescore_invested_percentage;
  const maxBet = maxPct ? Math.min(Math.floor(memescore * maxPct / 100), memescore) : memescore;

  const labelYes = pm.label_yes || "YES";
  const labelNo = pm.label_no || "NO";

  const doBuy = async () => {
    const a = parseInt(amt) || 0;
    if (a <= 0 || a > maxBet) return;
    setLoading(true);
    setError(null);
    try {
      const result = await pmBuy(authToken, pm.market_id, a, side);
      if (result.memescore_update) setMemescore(result.memescore_update.current_memescore);
      setPmMarkets(prev => prev.map(m => m.market_id === pm.market_id ? { ...m, user_position: result.user_position } : m));
      setAmt("");
      setStep("pos");
    } catch (e) {
      setError(e.message || "Buy failed");
    } finally {
      setLoading(false);
    }
  };

  const doSell = async () => {
    if (!hasPos) return;
    setLoading(true);
    setError(null);
    try {
      const expectedRefund = sellShares(qY, qN, B, posShares, posSide);
      const result = await pmSell(authToken, pm.market_id, posSide, expectedRefund);
      if (result.current_memescore != null) setMemescore(result.current_memescore);
      setSoldInfo({ amount: expectedRefund, pnl: expectedRefund - posInvested });
      setPmMarkets(prev => prev.map(m => m.market_id === pm.market_id ? { ...m, user_position: null } : m));
      setTimeout(() => setSoldInfo(null), 3000);
    } catch (e) {
      setError(e.message || "Sell failed");
    } finally {
      setLoading(false);
    }
  };

  const doClaim = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await pmClaim(authToken, pm.market_id);
      if (result.current_memescore != null) setMemescore(result.current_memescore);
      setPmMarkets(prev => prev.map(m => m.market_id === pm.market_id ? { ...m, user_position: { ...m.user_position, claimed: true } } : m));
    } catch (e) {
      setError(e.message || "Claim failed");
    } finally {
      setLoading(false);
    }
  };

  const bx = {
    height: 38, display: "flex", alignItems: "center", justifyContent: "center",
    width: "100%", fontFamily: "'Jersey 25',sans-serif", fontSize: "1em",
    textTransform: "uppercase", borderRadius: 15, cursor: loading ? "wait" : "pointer",
    border: "none", color: "#fff"
  };

  const pool = marketPool(qY, qN, B);
  const traders = pm.users_trading_count || pm.total_traders || 0;

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
        {/* Header: image + title + timer */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12, gap: 11, justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, flex: 1, minWidth: 0 }}>
            {pm.image_url ? (
              <div style={{
                width: 40, height: 40, borderRadius: 12, flexShrink: 0, overflow: "hidden",
                background: "linear-gradient(135deg, #71BAFF15, #4023C308)"
              }}>
                <img src={pm.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  onError={e => { e.target.style.display = "none"; }} />
              </div>
            ) : (
              <div style={{
                width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                background: "linear-gradient(135deg, #71BAFF25, #4023C318)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18
              }}>?</div>
            )}
            <div style={{
              fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.05em",
              lineHeight: 1.2, minWidth: 0,
              textShadow: "0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)"
            }}>{pm.title}</div>
          </div>
          {!isResolved && (
            <div className="tip" data-tip={new Date(pmExpiry).toLocaleString()} style={{
              padding: "2px 8px", borderRadius: 8, flexShrink: 0, cursor: "default",
              background: sec <= 300 ? "rgba(247,147,26,0.12)" : "rgba(255,255,255,0.04)",
              border: sec <= 300 ? "1px solid rgba(247,147,26,0.3)" : "1px solid transparent",
              animation: sec <= 300 ? "timerPulse 1s ease-in-out infinite" : undefined
            }}>
              <span style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em",
                letterSpacing: "1px", ...gld
              }}>{pmTimer(sec)}</span>
            </div>
          )}
        </div>

        {/* Position display */}
        {hasPos && !up?.claimed && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ whiteSpace: "nowrap" }}>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em", color: "#ffffff40", marginBottom: 2 }}>YOUR BET</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.05em" }}>
                <span style={{ color: posSide === "YES" ? "#71baff" : "#a78bfa" }}>
                  {posValue.toLocaleString()} {posSide === "YES" ? labelYes : labelNo}
                </span>
                <span style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".6em",
                  color: posPnl >= 0 ? "#4ade80" : "#f65e5e"
                }}>
                  {posPnl >= 0 ? "\u25B2" : "\u25BC"} {posPnl >= 0 ? "+" : ""}{posPnl.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Probability bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: ".75em", fontFamily: "'Jersey 25',sans-serif", minWidth: 28, textAlign: "center" }}>{yp}%</span>
          <div style={{
            flex: 1, height: 12, borderRadius: 62,
            border: "1px solid #ffffff4d", overflow: "hidden", position: "relative"
          }}>
            <div style={{
              position: "absolute", top: 2, bottom: 2, left: 2,
              width: "calc(" + yp + "% - 2px)",
              background: "linear-gradient(270deg,#FFFAC0 4%,#AED8FF 25%,#71BAFF 62%)",
              borderRadius: "62px 0 0 62px"
            }} />
            <div style={{
              position: "absolute", top: 2, bottom: 2, right: 2, left: yp + "%",
              background: "linear-gradient(90deg,#8398FF 25%,#4023C3 62%)",
              borderRadius: "0 62px 62px 0"
            }} />
          </div>
          <span style={{ fontSize: ".75em", fontFamily: "'Jersey 25',sans-serif", minWidth: 28, textAlign: "center" }}>{np}%</span>
        </div>

        {/* Error display */}
        {error && (
          <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: "#f65e5e", textAlign: "center", marginBottom: 8 }}>{error}</div>
        )}

        {/* Action buttons */}
        <div style={{ minHeight: 48 }}>
          {soldInfo && (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em", color: "#4ade80" }}>
                SOLD!
              </div>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", color: "#ffffffcc" }}>
                +{soldInfo.amount.toLocaleString()} credited to your main Memescore balance
              </div>
              <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em", color: soldInfo.pnl >= 0 ? "#4ade80" : "#f65e5e" }}>
                {soldInfo.pnl >= 0 ? "+" : ""}{soldInfo.pnl.toLocaleString()} PnL
              </div>
            </div>
          )}

          {!soldInfo && step === "sel" && !isResolved && !hasPos && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: "#71baff8a", opacity: yp < 1 ? 0.3 : 1 }}
                disabled={yp < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("YES"); setStep("amt"); setError(null); }}>
                {labelYes} {yp < 1 ? "(locked)" : ""}
              </button>
              <button style={{ ...bx, background: "#234bc29e", border: "2px solid #c8dbff52", opacity: np < 1 ? 0.3 : 1 }}
                disabled={np < 1}
                onClick={() => { if (!memeUser) { onLoginRequired(); return; } setSide("NO"); setStep("amt"); setError(null); }}>
                {labelNo} {np < 1 ? "(locked)" : ""}
              </button>
            </div>
          )}
          {!soldInfo && step === "sel" && !isResolved && hasPos && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: "#71baff" }}
                onClick={() => { setSide(posSide); setStep("amt"); setError(null); }}>
                ADD MORE {posSide === "YES" ? labelYes : labelNo}
              </button>
              <button style={{ ...bx, background: "#71baff8a" }}
                onClick={() => setStep("sellConfirm")}>
                SELL
              </button>
            </div>
          )}

          {step === "amt" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{
                display: "flex", justifyContent: "flex-end", alignItems: "center",
                fontFamily: "'Jersey 25',sans-serif", fontSize: ".75em"
              }}>
                <span style={gld}>MEMESCORE: {maxBet.toLocaleString()}</span>
              </div>
              <input type="number" inputMode="numeric" pattern="[0-9]*" placeholder="Amount..."
                value={amt} onChange={e => { setAmt(e.target.value); setError(null); }} onFocus={e => e.target.select()} autoFocus
                style={{
                  height: 42, border: "1px solid #4c5159", borderRadius: 15,
                  textAlign: "center", color: "#fff", background: "transparent",
                  fontFamily: "'Jersey 25',sans-serif", fontSize: "1em", outline: "none",
                  width: "100%"
                }} />
              <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                {[10, 25, 50, 100].map(p =>
                  <button key={p}
                    onClick={() => setAmt(String(Math.floor(maxBet * p / 100)))}
                    style={{
                      flex: 1, padding: "4px 0", borderRadius: 8,
                      fontFamily: "'Jersey 25',sans-serif", fontSize: ".8em",
                      background: "#00000042", border: "1px solid #ffffff15",
                      color: "#ffffff80", cursor: "pointer"
                    }}>{p}%</button>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={{ ...bx, background: "#00000042", flex: "0 0 40px" }}
                  onClick={() => { setStep(hasPos ? "pos" : "sel"); setSide(null); setAmt(""); setError(null); }}>
                  X
                </button>
                <button
                  style={{ ...bx, flex: "1 1 auto", background: side === "YES" ? "#71baff8a" : "#234bc29e" }}
                  onClick={doBuy}
                  disabled={loading || !amt || parseInt(amt) <= 0 || parseInt(amt) > maxBet}>
                  {loading ? "..." : `BET ${side === "YES" ? labelYes : labelNo} ${amt ? "(" + parseInt(amt).toLocaleString() + ")" : ""}`}
                </button>
              </div>
            </div>
          )}

          {step === "pos" && hasPos && !isResolved && (
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...bx, background: "#71baff" }}
                onClick={() => { setSide(posSide); setStep("amt"); setError(null); }}>
                ADD MORE {posSide === "YES" ? labelYes : labelNo}
              </button>
              <button style={{ ...bx, background: "#71baff8a" }}
                onClick={() => setStep("sellConfirm")}>
                SELL
              </button>
            </div>
          )}

          {step === "sellConfirm" && hasPos && !isResolved && (() => {
            const grossRf = sellShares(qY, qN, B, posShares, posSide);
            const netRf = grossRf;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", textAlign: "center",
                  color: "#fff", background: "#242a35", borderRadius: 8, padding: "8px 12px"
                }}>SELL YOUR ENTIRE {posSide === "YES" ? labelYes : labelNo} POSITION FOR {netRf.toLocaleString()} MEMESCORE?</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button style={{ ...bx, background: "#00000042", flex: "0 0 50px" }}
                    onClick={() => setStep("pos")}>X</button>
                  <button style={{ ...bx, background: "#71baff8a", flex: 1 }}
                    onClick={() => { setStep("pos"); doSell(); }} disabled={loading}>
                    {loading ? "..." : `CONFIRM SELL (${netRf.toLocaleString()})`}
                  </button>
                </div>
              </div>
            );
          })()}

          {step === "res" && (() => {
            const won = hasPos && posSide === pm.result;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {isResolved && pm.result && (
                  <div style={{
                    fontFamily: "'Londrina Solid',sans-serif", fontSize: ".9em",
                    textAlign: "center", marginBottom: 4,
                    color: pm.result === "YES" ? "#71baff" : "#a78bfa"
                  }}>{pm.result === "YES" ? labelYes : labelNo} WON!</div>
                )}
                {hasPos && !up?.claimed && (
                  <button style={{ ...bx, background: won ? "#71baff" : "#f65e5e30" }}
                    onClick={won ? doClaim : () => {
                      setPmMarkets(prev => prev.map(m => m.market_id === pm.market_id ? { ...m, user_position: { ...m.user_position, claimed: true } } : m));
                    }}
                    disabled={loading}>
                    {loading ? "..." : (won ? `CLAIM ${Math.round(posShares).toLocaleString()}` : "YOU LOST. CLOSE.")}
                  </button>
                )}
                {up?.claimed && (
                  <div style={{ fontFamily: "'Jersey 25',sans-serif", textAlign: "center", padding: 8 }}>CLAIMED</div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Footer: avatars + badge + pool */}
      <div style={{
        display: "flex", alignItems: "center", marginTop: 10,
        padding: "0 16px 0 14px", justifyContent: "space-between"
      }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: ".75em", gap: 8 }}>
          {(pm.most_trading_users || []).length > 0 && pool > 0 && (
            <div style={{ display: "flex", alignItems: "center" }}>
              {(pm.most_trading_users || []).slice(0, 3).map((u, i) => (
                <div key={u.username || i} style={{
                  width: 24, height: 24, borderRadius: "50%", border: "2px solid #191f29",
                  marginLeft: i > 0 ? -8 : 0, zIndex: 3 - i,
                  background: u.profile_image_url ? `url(${u.profile_image_url}) center/cover` : "linear-gradient(135deg,#4e596c,#212936)",
                  position: "relative"
                }} />
              ))}
              {traders > 3 && (
                <span style={{
                  fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em",
                  color: "#ffffff60", marginLeft: 4
                }}>+{traders - 3}</span>
              )}
            </div>
          )}
          <span style={{
            fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em",
            background: "linear-gradient(90deg, #71BAFF40, #4023C340)",
            padding: "3px 8px", borderRadius: 4, color: "#ffffffcc"
          }}>PREDICTION</span>
        </div>
        {pool > 0 && <span style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
          <span style={{ color: "#ffffff30", marginRight: 4 }}></span>
          <span style={gld}>{pool.toLocaleString()}</span>
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

const RetweetQuestCard = ({ retweetState, retweetCooldown, retweetReward, retweetQuest, onRetweet, isMobile }) => {
  const reward = retweetQuest?.reward_meme_score || 500;
  const isReady = retweetState === "ready";
  const isRetweeting = retweetState === "retweeting";
  const isCompleted = retweetState === "completed";
  const isCooldown = retweetState === "cooldown";
  const locked = isCooldown || isCompleted;

  const hours = String(Math.floor(retweetCooldown / 3600)).padStart(2, "0");
  const mins = String(Math.floor((retweetCooldown % 3600) / 60)).padStart(2, "0");
  const secs = String(retweetCooldown % 60).padStart(2, "0");

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
        background: "url(https://meme.com/assets/images/farm/quest/quest-retweet-v2.webp) center/cover",
        borderRadius: 14, padding: "14px 18px",
        minHeight: 192, display: "flex", flexDirection: "column",
        justifyContent: "space-between", position: "relative", overflow: "hidden"
      }}>
        {/* Dark overlay */}
        <div style={{
          position: "absolute", inset: 0, borderRadius: 14,
          background: "rgba(25,31,41,0.6)", pointerEvents: "none"
        }}/>

        {/* Content */}
        <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 11, alignSelf: "flex-start", marginBottom: 8
          }}>
            <div style={{
              fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.05em",
              textTransform: "uppercase",
              textShadow: "0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
              lineHeight: 1.2
            }}><span style={{ color: "#71baff" }}>Like &</span> Retweet</div>
          </div>

          {/* Icon */}
          <div style={{
            width: 60, height: 60, margin: "6px 0 12px",
            display: "flex", alignItems: "center", justifyContent: "center"
          }}>
            <svg viewBox="0 0 24 24" width="44" height="44" fill="#71baff" style={{ opacity: isReady ? 1 : 0.5 }}>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
          </div>

          {/* Reward or action */}
          {isCompleted && retweetReward > 0 ? (
            <div style={{ animation: "rewardPop 0.5s ease-out", marginBottom: 4 }}>
              <div style={{
                fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.3em", ...gld
              }}>+{retweetReward.toLocaleString()}</div>
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
                Every journey starts with a simple deed...
              </div>
              {isReady && (
                <button onClick={onRetweet} style={{ ...bx, background: "#71baff8a" }}>LIKE & RT</button>
              )}
              {isRetweeting && (
                <div style={{ ...bx, background: "#ffffff10", cursor: "default" }}>
                  <div style={{
                    width: 18, height: 18, border: "2px solid #ffffff30",
                    borderTopColor: "#71baff", borderRadius: "50%",
                    animation: "spin 0.8s linear infinite"
                  }}/>
                </div>
              )}
              {isCooldown && retweetCooldown > 0 && (
                <div style={{ ...bx, background: "#ffffff10", cursor: "default", color: "#ffffff40" }}>NEXT RT SOON</div>
              )}
              {isCompleted && retweetReward === 0 && (
                <div style={{ ...bx, background: "#ffffff10", cursor: "default", color: "#4ade80" }}>DONE</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        display: "flex", alignItems: "center", marginTop: 10,
        padding: "0 16px 0 14px", justifyContent: "space-between"
      }}>
        <div style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em", color: "#ffffff50", display: "flex", alignItems: "center", gap: 6 }}>
          {isCooldown && retweetCooldown > 0 && (
            <span style={{ ...gld, letterSpacing: 1, fontFamily: "'Londrina Solid',sans-serif", fontSize: "1.1em" }}>
              {hours}:{mins}:{secs}
            </span>
          )}
          {isReady && null}
          {isRetweeting && <span style={{ color: "#71baff", fontFamily: "'Jersey 25',sans-serif" }}>RETWEETING...</span>}
          {isCompleted && <span style={{ fontFamily: "'Jersey 25',sans-serif", color: "#f7931a" }}>CLAIMED</span>}
        </div>
        <span style={{ fontFamily: "'Jersey 25',sans-serif", fontSize: ".85em" }}>
          <span style={gld}>+{reward.toLocaleString()}</span>
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
  const [showHowTo, setShowHowTo] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [flash, setFlash] = useState(null); // { msg, type: "error"|"ok" }
  const [holdings, setHoldings] = useState(null); // null = not loaded, [] = empty
  const [leaderboard, setLeaderboard] = useState([]);
  const [marketHistory, setMarketHistory] = useState([]);
  const [chestQuest, setChestQuest] = useState(null);
  const [chestCooldown, setChestCooldown] = useState(0);
  const [chestState, setChestState] = useState("cooldown"); // "available" | "cooldown" | "opening" | "reward"
  const [chestReward, setChestReward] = useState(0);
  const [showChestDialog, setShowChestDialog] = useState(false);
  const [retweetQuest, setRetweetQuest] = useState(null);
  const [retweetTweet, setRetweetTweet] = useState(null);
  const [retweetState, setRetweetState] = useState("loading"); // loading | ready | retweeting | completed | cooldown
  const [retweetReward, setRetweetReward] = useState(0);
  const [retweetCooldown, setRetweetCooldown] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [lastCensusAt, setLastCensusAt] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [claimReward, setClaimReward] = useState(0);
  const [diamondHands, setDiamondHands] = useState(0); // 0 = none, 1-10 = multiplier
  const [claimTick, setClaimTick] = useState(0);
  useEffect(() => {
    if (!lastCensusAt) return;
    const id = setInterval(() => setClaimTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [lastCensusAt]);
  const [pmMarkets, setPmMarkets] = useState([]);
  const [activeTab, setActiveTab] = useState("arena");
  const [showCreateMemeMarket, setShowCreateMemeMarket] = useState(false);

  // Refresh leaderboard, market history, and trade history from database
  const refreshLeaderboard = useCallback(async () => {
    const leaders = await loadLeaderboardFromDb();
    if (leaders) setLeaderboard(leaders);
    const players = await loadMarketPlayersFromDb();
    setMarketPlayers(players);
    const history = await loadMarketHistoryFromDb();
    if (history) setMarketHistory(history);
    // Refresh user's trade history
    if (userId.current) {
      const dbHist = await loadTradeHistoryFromDb(userId.current);
      if (dbHist && dbHist.length > 0) setHist(dbHist.reverse());
    }
  }, []);

  // Load inventory from census data, resolve CoinGecko ticker symbols
  const loadInventory = useCallback(async (uid) => {
    if (!supabase || !uid) return;
    try {
      const { data, error } = await supabase
        .from("labs_user_inventory")
        .select("coin_symbol, coin_name, coin_image, tier, usd_value")
        .eq("user_id", uid)
        .order("usd_value", { ascending: false });
      if (error) { console.warn("Inventory load failed:", error.message); return; }
      if (!data?.length) { setHoldings(data || []); return; }
      // Resolve CoinGecko ticker symbols (coin_symbol is the CG ID / slug)
      try {
        const cgIds = data.map(h => h.coin_symbol.toLowerCase()).join(",");
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgIds}`);
        if (res.ok) {
          const cgData = await res.json();
          const tickerMap = {};
          for (const c of cgData) tickerMap[c.id] = c.symbol.toUpperCase();
          for (const h of data) {
            const ticker = tickerMap[h.coin_symbol.toLowerCase()];
            if (ticker) h.coin_ticker = ticker;
          }
        }
      } catch (e) { console.warn("CoinGecko ticker lookup failed:", e); }
      // Fallback: if coin_symbol is already a short ticker (no hyphens), use it directly
      for (const h of data) {
        if (!h.coin_ticker && h.coin_symbol && !h.coin_symbol.includes("-") && h.coin_symbol.length <= 10) {
          h.coin_ticker = h.coin_symbol.toUpperCase();
        }
      }
      setHoldings(data || []);
    } catch (e) { console.warn("Inventory load error:", e); }
  }, []);

  // Prepopulate holdings from meme.com API if user has none yet
  const prepopulateHoldings = useCallback(async (uid, memeUserId, authToken) => {
    if (!supabase || !uid || !memeUserId || !authToken) return;
    try {
      const { data: existing } = await supabase.from("labs_user_holdings")
        .select("user_id").eq("user_id", uid).limit(1);
      if (existing && existing.length > 0) return;
      await runHoldingsScan(uid, memeUserId, authToken);
      console.log("[PREPOPULATE] Seeded holdings from meme.com API");
    } catch (e) { console.warn("Holdings prepopulate failed:", e.message); }
  }, []);

  const [notification, setNotification] = useState(null);
  const initialized = useRef(false);
  const seenResolutions = useRef(new Set());
  const userId = useRef(null);
  const maxUpdownRound = useRef(0);
  const battleRenewAttempted = useRef(null); // track which resolved battle we already tried to renew
  const trendSnapsRef = useRef({});
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

          // Fetch farming quests (single API call for chest + retweet)
          const questData = await fetchFarmingQuests(auth.token);

          // --- Treasure Chest ---
          const chest = extractQuest(questData, "TREASURE_CHEST");
          if (chest) {
            setChestQuest(chest);
            if (chest._isAvailable) {
              setChestState("available");
            } else {
              const cooldownUntil = chest.params?.cooldown_until;
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

          // --- Like & Retweet ---
          const rt = extractQuest(questData, "RETWEET");
          if (rt) {
            setRetweetQuest(rt);
            if (rt._isCompleted) {
              setRetweetState("completed");
            } else if (rt._isAvailable || rt._isInProgress) {
              const tweet = await fetchQuestTweet(auth.token, user.id);
              if (tweet && tweet.id != null && tweet.tweet_id_external != null) {
                setRetweetTweet(tweet);
                const cdUntil = tweet.cooldown_until;
                if (cdUntil && new Date(cdUntil).getTime() > Date.now()) {
                  const rem = Math.max(0, Math.floor((new Date(cdUntil).getTime() - Date.now()) / 1000));
                  setRetweetCooldown(rem);
                  setRetweetState("cooldown");
                } else {
                  setRetweetState("ready");
                }
              } else {
                setRetweetState("completed");
              }
            } else {
              setRetweetState("completed");
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
            await supabase.rpc('labs_migrate_user', {
              p_old_id: oldAnonId,
              p_new_id: userId.current,
              p_username: currentUser.username,
              p_profile_image: currentUser.image
            });
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

      // Prepopulate holdings from meme.com API if user has none
      if (currentUser && auth?.token) {
        await prepopulateHoldings(userId.current, currentUser.id, auth.token);
        loadInventory(userId.current);
      }

      // Load leaderboard and history
      const leaders = await loadLeaderboardFromDb();
      if (leaders) setLeaderboard(leaders);

      const history = await loadMarketHistoryFromDb();
      if (history) setMarketHistory(history);

      // Fetch coin metadata from CoinGecko Pro (images, names, prices)
      await fetchBattleCoinMetadata();
      if (Object.keys(battleCoinMap).length === 0) {
        setLoading(false);
        return;
      }

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
          const m = dbMarketToLocal(db, battleCoinMap[db.coin_symbol], battleCoinMap[db.coin_b_symbol]);
          if (sideInv[db.id]) { m.yInv = sideInv[db.id].YES || 0; m.nInv = sideInv[db.id].NO || 0; }
          return m;
        });
        // Compute max existing UP/DOWN round number from DB
        const maxRound = dbMarkets.filter(db => (db.market_type || "UPDOWN") === "UPDOWN")
          .reduce((max, db) => { const rn = parseInt(db.id.split("-")[1]) || 0; return rn > max ? rn : max; }, 0);
        maxUpdownRound.current = maxRound;
        // Create missing UP/DOWN markets on init (DB trigger caps at 2)
        const openSyms = new Set(
          dbMarkets.filter(db => db.status === "OPEN" && (db.market_type || "UPDOWN") === "UPDOWN")
            .map(db => db.coin_symbol)
        );
        let needsRefetch = false;
        while (openSyms.size < NUM_UPDOWN_MARKETS) {
          const sym = pickUpdownCoin(openSyms);
          if (!sym) break;
          const newM = mk(battleCoinMap[sym], ++maxUpdownRound.current);
          localMks.push(newM);
          syncMarketToDb(newM);
          openSyms.add(sym);
          needsRefetch = true;
        }

        // Create battle market if none exists (DB trigger caps at 1)
        const hasOpenBattle = dbMarkets.some(db => db.status === "OPEN" && db.market_type === "BATTLE");
        if (!hasOpenBattle && Object.keys(battleCoinMap).length >= 2) {
          const matchup = pickBattleMatchup(battleCoinMap);
          if (matchup) {
            const [symA, symB] = matchup;
            const highestBattle = dbMarkets
              .filter(db => db.market_type === "BATTLE")
              .reduce((max, db) => { const rn = parseInt(db.id.split("-").pop()) || 0; return rn > max ? rn : max; }, 0);
            const battleM = mkBattle(battleCoinMap[symA], battleCoinMap[symB], highestBattle + 1);
            localMks.push(battleM);
            syncMarketToDb(battleM);
            supabase.rpc("labs_insert_snapshot", { p_market_id: battleM.id, p_score_a: battleM.mc, p_score_b: battleM.mcB });
            needsRefetch = true;
          }
        }

        setMks(dedup(localMks));

        // Re-fetch from DB to pick up markets that actually got created (trigger may reject some)
        if (needsRefetch) {
          setTimeout(async () => {
            const fresh = await loadMarketsFromDb(true);
            if (!fresh) return;
            const freshLocal = fresh.filter(db => db.status === "OPEN").map(db => {
              const coinData = battleCoinMap[db.coin_symbol];
              const coinDataB = db.coin_b_symbol ? battleCoinMap[db.coin_b_symbol] : null;
              return dbMarketToLocal(db, coinData, coinDataB);
            });
            if (freshLocal.length > 0) setMks(prev => dedup([...prev, ...freshLocal]));
          }, 1000);
        }

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
          // Diamond hands: integer multiplier from labs_save_census (0-10)
          setDiamondHands(dbUser.diamond_hands || 0);
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
          const freshCoin = battleCoinMap[m.c.sym];
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
        // First time - create fresh UP/DOWN markets from random battle coins
        const newMks = [];
        const usedSyms = new Set();
        let round = 1;
        while (usedSyms.size < NUM_UPDOWN_MARKETS) {
          const sym = pickUpdownCoin(usedSyms);
          if (!sym) break;
          newMks.push(mk(battleCoinMap[sym], round++));
          usedSyms.add(sym);
        }
        setMks(newMks);

        // Sync new markets to Supabase
        newMks.forEach(m => syncMarketToDb(m));
      }
      // Fetch trend/battle snapshots for initial render (last 200 per market)
      if (dbMarkets) {
        const trendIds = dbMarkets.filter(d => d.market_type === 'TRENDS' || d.market_type === 'BATTLE' || d.market_type === 'MEMEMARKET').map(d => d.id);
        if (trendIds.length > 0) {
          const grouped = {};
          await Promise.all(trendIds.map(async (mid) => {
            const { data: snaps } = await supabase.from('labs_trend_snapshots')
              .select('market_id,score_a,score_b,recorded_at')
              .eq('market_id', mid)
              .order('recorded_at', { ascending: false })
              .limit(200);
            if (snaps && snaps.length > 0) {
              grouped[mid] = snaps.reverse();
            }
          }));
          trendSnapsRef.current = grouped;
        }
      }
      // Fetch prediction markets from meme.com
      const pms = await fetchPredictionMarkets(auth?.token);
      setPmMarkets(pms);

      dbLoaded.current = true;
      setLoading(false);
    };

    initAll();
  }, []);

  // wins, losses, totalVolume are loaded from DB (source of truth)
  // totalVolume is incremented by labs_buy RPC on each trade

  // Save state to localStorage whenever it changes (only after DB values are loaded)
  // Note: wins/losses/streak are managed atomically by labs_claim RPC — never sync them from client
  useEffect(() => {
    if (loading || !dbLoaded.current || mks.length === 0) return;
    saveState({ mks, pos, bal, hist, streak, bestStreak, savedAt: Date.now() });
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

  // Retweet cooldown timer
  useEffect(() => {
    if (retweetState !== "cooldown") return;
    const i = setInterval(() => {
      setRetweetCooldown(prev => {
        if (prev <= 1) {
          setRetweetState("ready");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(i);
  }, [retweetState]);

  // Retweet handler — opens X popup, polls for close, claims reward
  const handleRetweet = useCallback(async () => {
    if (!authToken || !retweetTweet || retweetState !== "ready") return;
    setRetweetState("retweeting");

    const tweetIdExternal = retweetTweet.tweet_id_external;
    const tweetIdInternal = retweetTweet.id;
    const popup = window.open(
      `https://x.com/intent/retweet?tweet_id=${tweetIdExternal}`,
      "rtPopup", "width=600,height=400"
    );

    // Poll until popup closes
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!popup || popup.closed) { clearInterval(check); resolve(); }
      }, 200);
    });

    // Claim reward
    const result = await claimRetweetReward(authToken, tweetIdInternal);
    if (result) {
      const reward = result.updated_by_amount || 0;
      setRetweetReward(reward);
      setRetweetState("completed");
      // Refresh memescore
      const balances = await fetchLabsBalance(authToken);
      setMemescore(balances.memescore);
      // After 3s, hide the card
      setTimeout(() => {
        setRetweetQuest(null);
      }, 3000);
    } else {
      // Claim failed — reset to ready so user can retry
      setRetweetState("ready");
    }
  }, [authToken, retweetTweet, retweetState, memeUser]);

  // Price feed from CoinGecko (every 60s for UPDOWN, separate CG Pro for battles), synced to DB
  useEffect(() => {
    if (mks.length === 0) return;

    const updatePrices = async () => {
      // UPDOWN price feed (CG Pro — coins come from BATTLE_COINS pool)
      const updownMarkets = mks.filter(m => m.st === "OPEN" && m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM");
      if (updownMarkets.length > 0) {
        try {
          const cgIds = updownMarkets.map(m => BATTLE_COINS[m.c.sym]).filter(Boolean);
          if (cgIds.length > 0) {
            const cgRes = await fetch(
              `${CG_PRO_API}/coins/markets?vs_currency=usd&ids=${cgIds.join(",")}&order=market_cap_desc`,
              { headers: CG_PRO_HEADERS }
            );
            if (cgRes.ok) {
              const cgData = await cgRes.json();
              const priceMap = {};
              cgData.forEach(coin => {
                const entry = Object.entries(BATTLE_COINS).find(([, id]) => id === coin.id);
                if (entry) priceMap[entry[0]] = { mcap: coin.market_cap };
              });
              if (supabase) {
                const now = new Date().toISOString();
                for (const m of updownMarkets) {
                  const data = priceMap[m.c.sym];
                  if (data && data.mcap && m.mc > 0) {
                    const pctDiff = Math.abs(data.mcap - m.mc) / m.mc;
                    if (pctDiff > 0.001) {
                      await supabase.rpc('labs_update_prices', {
                        p_market_id: m.id,
                        p_current_mc: data.mcap
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("UPDOWN CG Pro price fetch failed:", e);
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
              await supabase.rpc('labs_update_prices', {
                p_market_id: battleMarket.id,
                p_current_mc: coinACg ? coinACg.market_cap : null,
                p_current_mc_b: coinBCg ? coinBCg.market_cap : null
              });
              // Record snapshot for battle chart (skip if unchanged)
              if (coinACg && coinBCg) {
                const newA = coinACg.market_cap, newB = coinBCg.market_cap;
                if (!newA || !newB) { /* skip snapshot if either market cap missing */ }
                else {
                const lastSnaps = trendSnapsRef.current?.[battleMarket.id];
                const prev = lastSnaps && lastSnaps.length > 0 ? lastSnaps[lastSnaps.length - 1] : null;
                if (!prev || Number(prev.score_a) !== newA || Number(prev.score_b) !== newB) {
                  await supabase.rpc('labs_insert_snapshot', {
                    p_market_id: battleMarket.id,
                    p_score_a: newA,
                    p_score_b: newB
                  });
                }
                }
              }
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

      // Fetch trend/battle snapshots for sparkline (last 200 per market)
      const trendIds = dbMarkets.filter(d => d.market_type === 'TRENDS' || d.market_type === 'BATTLE' || d.market_type === 'MEMEMARKET').map(d => d.id);
      if (trendIds.length > 0) {
        const grouped = {};
        await Promise.all(trendIds.map(async (mid) => {
          const { data: snaps } = await supabase.from('labs_trend_snapshots')
            .select('market_id,score_a,score_b,recorded_at')
            .eq('market_id', mid)
            .order('recorded_at', { ascending: false })
            .limit(200);
          if (snaps && snaps.length > 0) {
            grouped[mid] = snaps.reverse();
          }
        }));
        trendSnapsRef.current = grouped;
      }

      setMks(prev => {
        const localIds = new Set(prev.map(m => m.id));
        let updated = prev.map(m => {
          const db = dbMap[m.id];
          if (!db) return m;
          const b = m.b;
          const si = sideInv[m.id] || {};
          const battleExtra = (m.type === "BATTLE" || m.type === "TRENDS") ? {
            mcB: db.current_mc_b != null ? Number(db.current_mc_b) : m.mcB,
            startMcB: db.start_mc_b != null ? Number(db.start_mc_b) : m.startMcB
          } : {};
          // If DB says resolved but local says open, sync resolution
          if (db.status === "RES" && m.st === "OPEN") {
            return { ...m, st: "RES", res: db.result,
              mc: db.current_mc != null ? Number(db.current_mc) : m.mc,
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
            mc: db.current_mc != null ? Number(db.current_mc) : m.mc,
            startMc: db.start_mc != null ? Number(db.start_mc) : m.startMc,
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
          const coinData = prev.find(m => m.c.sym === db.coin_symbol)?.c || battleCoinMap[db.coin_symbol] || null;
          const coinDataB = db.coin_b_symbol ? (prev.find(m => m.cB?.sym === db.coin_b_symbol)?.cB || battleCoinMap[db.coin_b_symbol]) : null;
          updated.push(dbMarketToLocal(db, coinData, coinDataB));
        });
        // Remove phantom local markets that don't exist in DB (failed inserts the trigger rejected)
        const dbIds = new Set(dbMarkets.map(db => db.id));
        updated = updated.filter(m => dbIds.has(m.id));
        return dedup(updated);
      });

      // Auto-creation disabled — markets managed server-side
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

  // Periodic prediction market refresh (every 30 seconds)
  useEffect(() => {
    if (loading) return;
    const refresh = async () => {
      const pms = await fetchPredictionMarkets(authToken);
      setPmMarkets(pms);
    };
    const i = setInterval(refresh, 30000);
    return () => clearInterval(i);
  }, [loading, authToken]);

  // Timer tick (for countdown display)
  useEffect(() => {
    const i = setInterval(() => tick(t => t+1), 1000);
    return () => clearInterval(i);
  }, []);

  // Auto-create new markets after resolution (DB trigger prevents duplicates)
  useEffect(() => {
    const i = setInterval(() => {
      setMks(p => {
        const openUpdown = p.filter(m => m.st === "OPEN" && !m.type);
        const openUpdownSyms = new Set(openUpdown.map(m => m.c.sym));
        const hasOpenBattle = p.some(m => m.st === "OPEN" && m.type === "BATTLE");
        const resolved = p.filter(m => m.st === "RES");
        const newMarkets = [];
        // Clean up resolved markets the user has claimed/dismissed
        const dismissable = resolved.filter(m => !pos[m.id] || pos[m.id].claimed);
        // Auto-creation disabled — markets managed server-side
        // Clean up dismissed resolved markets from local state
        if (dismissable.length === 0) return p;
        const resolvedIds = new Set(dismissable.map(m => m.id));
        return p.filter(m => !resolvedIds.has(m.id));
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
            coin: m.type === "CUSTOM" ? (m.customTitle || "Prediction") : m.type === "MEMEMARKET" ? m.c.name : (m.type === "BATTLE" || m.type === "TRENDS") ? m.c.sym + " vs " + m.cB?.sym : m.c.sym,
            isMemeMarket: m.type === "MEMEMARKET",
            result: m.res,
            won,
            reward,
            hasBonus,
            isBattle: m.type === "BATTLE" || m.type === "TRENDS",
            isTrends: m.type === "TRENDS",
            isCustom: m.type === "CUSTOM",
            winnerSym: (m.type === "BATTLE" || m.type === "TRENDS") ? (m.res === "YES" ? m.c.sym : m.cB?.sym) : null
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

    // Block buying opposite side of existing position
    const existingPos = pos[mid];
    if (existingPos && existingPos.side !== side) return;

    // 1% probability floor — prevent buying extremely cheap sides
    const sideProb = side === "YES" ? yP(m.qY, m.qN, m.b) : (100 - yP(m.qY, m.qN, m.b));
    if (sideProb < 1) return;

    // 2% entry fee — shares bought from net amount
    const fee = Math.round(amt * 0.02);
    const net = amt - fee;

    // Optimistic update for UI responsiveness
    const shares = buyShares(m.qY, m.qN, m.b, net, side);
    const prevPos = pos[mid] || null;
    const isNewPlayer = !prevPos;
    const updatedMarket = {
      ...m,
      qY: side==="YES" ? m.qY + shares : m.qY,
      qN: side==="NO" ? m.qN + shares : m.qN,
      fp: (m.fp || 0) + fee,
      vol: m.vol + amt,
      ppl: m.ppl + (isNewPlayer ? 1 : 0)
    };
    const newPosition = prevPos && prevPos.side === side
      ? { ...prevPos, sh: prevPos.sh + shares, inv: prevPos.inv + amt }
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
          setHist(h => [...h, { sym: m.c.sym, side, type: "BUY", result: null, amount: amt, pnl: null }]);
          setTimeout(refreshLeaderboard, 500);
          return;
        }
        if (data && !data.success) {
          // RPC rejected — revert optimistic update and show error
          console.warn("labs_buy rejected:", data.error);
          const msgs = {
            insufficient_balance: "Not enough balance",
            market_closed: "Market is closed",
            different_side: "You already have a position on the other side",
            probability_too_low: "Price too extreme to buy",
            market_not_found: "Market not found",
          };
          setFlash({ msg: msgs[data.error] || "Bet failed — please try again", type: "error" });
          setTimeout(() => setFlash(null), 4000);
          setMks(p => p.map(mk => mk.id !== mid ? mk : m));
          if (prevPos) setPos(p => ({ ...p, [mid]: prevPos }));
          else setPos(p => { const n = { ...p }; delete n[mid]; return n; });
          return;
        }
        if (error) {
          setFlash({ msg: "Bet failed — please try again", type: "error" });
          setTimeout(() => setFlash(null), 4000);
          setMks(p => p.map(mk => mk.id !== mid ? mk : m));
          if (prevPos) setPos(p => ({ ...p, [mid]: prevPos }));
          else setPos(p => { const n = { ...p }; delete n[mid]; return n; });
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback: deduct locally and sync
    setBal(b => b - amt);
    setHist(h => [...h, { sym: m.c.sym, side, type: "BUY", result: null, amount: amt, pnl: null }]);
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
          setHist(h => [...h, { sym: m.c.sym, side: pp.side, type: "SELL", result: null, amount: netRf, pnl }]);
          setTimeout(refreshLeaderboard, 500);
          return;
        }
        if ((data && !data.success) || error) {
          // Sell failed — revert optimistic update
          setFlash({ msg: "Sell failed — please try again", type: "error" });
          setTimeout(() => setFlash(null), 4000);
          setMks(p => p.map(x => x.id !== mid ? x : m));
          setPos(p => ({ ...p, [mid]: pp }));
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback: credit locally and sync
    setBal(b => b + netRf);
    setHist(h => [...h, { sym: m.c.sym, side: pp.side, type: "SELL", result: null, amount: netRf, pnl }]);
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
            sym: m.c.sym, side: pp.side, type: "CLAIM",
            result: m.res, amount: data.total_payout, pnl: data.pnl
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
    // POOL-SPLIT-V1: const poolRw = won && m.wws > 0 ? pp.inv + Math.round(pp.sh / m.wws * (m.pot - m.wis)) : 0;
    // POOL-SPLIT-V1: const rw = won ? Math.max(poolRw, pp.sh) : 0;
    const rw = won ? pp.sh : 0;
    const pnl = rw - pp.inv;

    setBal(b => b+rw);
    setPos(p => ({ ...p, [mid]:{ ...p[mid], claimed:true }}));
    setHist(h => [...h, { sym:m.c.sym, side:pp.side, type:"CLAIM", result:m.res, amount:rw, pnl }]);

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
    const mKey = (m) => (m.type === "BATTLE") ? "BATTLE" : (m.type === "TRENDS") ? "TRENDS" : (m.type === "CUSTOM") ? m.id : (m.type === "MEMEMARKET") ? m.id : m.c.sym;
    mks.forEach(m => {
      if (m.st === "RES" && pos[m.id] && !pos[m.id].claimed) resByKey[mKey(m)] = m;
    });
    const filtered = mks.filter(m => {
      if (m.type === "MEMEMARKET") return false; // MEMEMARKET shown in separate tab
      if (m.st === "OPEN" && resByKey[mKey(m)]) return false;
      if (m.st === "RES" && (!pos[m.id] || pos[m.id].claimed)) return false;
      return true;
    });
    // Stable order: UPDOWN markets by symbol, battles/trends, then customs last
    const updown = filtered.filter(m => m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM");
    const battles = filtered.filter(m => m.type === "BATTLE" || m.type === "TRENDS");
    const customs = filtered.filter(m => m.type === "CUSTOM");
    updown.sort((a, b) => a.c.sym.localeCompare(b.c.sym));
    customs.sort((a, b) => a.ea - b.ea);
    return [...updown, ...battles, ...customs];
  }, [mks, pos]);

  // MemeMarket display list (separate from arena ranked)
  const memeMarkets = useMemo(() => {
    const all = mks.filter(m => m.type === "MEMEMARKET");
    const open = all.filter(m => m.st === "OPEN").sort((a, b) => a.ea - b.ea);
    const resolved = all.filter(m => m.st === "RES" && pos[m.id] && !pos[m.id].claimed);
    return [...resolved, ...open];
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
      zoom: isMobile ? undefined : "150%"
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Londrina+Solid:wght@400;900&family=Jersey+25&family=Mulish:wght@400;700&display=swap" rel="stylesheet"/>
      <style>{`@keyframes slideDown { from { opacity:0; transform:translateX(-50%) translateY(-20px); } to { opacity:1; transform:translateX(-50%) translateY(0); } } @keyframes timerPulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } } @keyframes priceFlash { 0% { opacity:1; transform:scale(1.2); } 30% { opacity:1; transform:scale(1); } 100% { opacity:1; transform:scale(1); } } @keyframes chestShake { 0%,100% { transform:translateX(0) rotateZ(0deg); } 4% { transform:translateX(-6px) rotateZ(-8deg); } 8% { transform:translateX(6px) rotateZ(6deg); } 12% { transform:translateX(-4px) rotateZ(-6deg); } 16% { transform:translateX(4px) rotateZ(4deg); } 20% { transform:translateX(-2px) rotateZ(-3deg); } 24% { transform:translateX(0) rotateZ(0deg); } } @keyframes spin { to { transform:rotate(360deg); } } @keyframes rewardPop { from { opacity:0; transform:scale(0.5); } to { opacity:1; transform:scale(1); } } @keyframes claimPop { 0% { transform:scale(0.6); opacity:0; } 50% { transform:scale(1.15); } 100% { transform:scale(1); opacity:1; } } @keyframes claimGlow { 0% { box-shadow:0 0 12px rgba(34,197,94,0.8), inset 0 1px 0 rgba(255,255,255,0.3); } 50% { box-shadow:0 0 24px rgba(34,197,94,0.5), inset 0 1px 0 rgba(255,255,255,0.2); } 100% { box-shadow:0 0 0px transparent; } } @keyframes chestSelectedPulse { 0%,100% { transform:scale(1.08); filter:drop-shadow(0 0 12px rgba(247,147,26,0.5)); } 50% { transform:scale(1.14); filter:drop-shadow(0 0 20px rgba(247,147,26,0.7)); } } .tip{position:relative;} .tip:hover::after{content:attr(data-tip);position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:6px;padding:5px 10px;border-radius:8px;background:#1a1f2a;color:#e0e0e0;font-size:13px;font-family:'Jersey 25',sans-serif;white-space:nowrap;z-index:999;pointer-events:none;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 12px rgba(0,0,0,0.4);}`}</style>

      {notification && (
        <div style={{
          position:"fixed", top:20, left:"50%", transform:"translateX(-50%)",
          zIndex:1000, padding:"16px 24px", borderRadius:16,
          background: notification.won ? "linear-gradient(135deg, #22c55e, #16a34a)" : "linear-gradient(135deg, #ef4444, #dc2626)",
          boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
          display:"flex", alignItems:"center", gap:12,
          animation:"slideDown 0.3s ease-out"
        }}>

          <span style={{ fontSize:"1.5em" }}>{notification.isBattle ? "⚔️" : notification.result === "YES" ? "📈" : "📉"}</span>
          <div>
            <div style={{ fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em" }}>
              {notification.isBattle
                ? `${notification.isTrends ? "" : "$"}${notification.winnerSym} WON the battle!`
                : notification.isMemeMarket
                ? `${notification.coin} ${notification.result === "YES" ? "TRENDED UP!" : "TRENDED DOWN"}`
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
          <button onClick={() => setShowHowTo(true)} style={{
            width:28, height:28, borderRadius:"50%", border:"1px solid #ffffff20",
            background:"#0c1018", color:"#94a3b8", cursor:"pointer",
            fontFamily:"'Jersey 25',sans-serif", fontSize:".85em",
            display:"flex", alignItems:"center", justifyContent:"center",
            flexShrink:0
          }}>?</button>
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
          }}>{activeTab === "arena" ? "Meme Arena" : "MemeMarket"}{!isProd && <span style={{
            fontSize:".45em", background:"#ff4444", color:"#fff", padding:"2px 8px",
            borderRadius:4, marginLeft:10, verticalAlign:"middle", letterSpacing:1
          }}>DEV</span>}</div>
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize: isMobile ? ".75em" : ".9em",
            color:"#ffffff60"
          }}>
            {activeTab === "arena" ? "Predict targets. Vote with conviction on your favorite memes." : "Create prediction markets on meme virality via Google Trends."}
          </div>
          {/* Tab bar — MemeMarket only visible to supahmarbler */}
          {memeUser?.username === "supahmarbler" && <div style={{ display:"flex", gap:8, marginTop:10 }}>
            {[{id:"arena",label:"Meme Arena"},{id:"mememarket",label:"MemeMarket"}].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                fontFamily:"'Londrina Solid',sans-serif", fontSize: isMobile ? ".85em" : ".95em",
                padding:"6px 16px", borderRadius:10, cursor:"pointer", border:"none",
                background: activeTab === tab.id ? "linear-gradient(135deg,#71BAFF,#4a90d9)" : "#ffffff10",
                color: activeTab === tab.id ? "#fff" : "#ffffff60",
                transition:"all .15s ease"
              }}>{tab.label}</button>
            ))}
          </div>}
        </div>

        {activeTab === "arena" && <div style={{
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
              (m.type === "BATTLE" || m.type === "TRENDS")
                ? <div key={m.id} style={{ gridColumn: isMobile ? undefined : "span 2" }}>
                    <BattleCard m={m} bal={bal} streak={streak}
                      pos={pos[m.id]||null}
                      players={marketPlayers[m.id]||[]}
                      onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                      isMobile={isMobile}
                      memeUser={memeUser}
                      onLoginRequired={() => setShowDeposit(true)}
                      trendSnaps={trendSnapsRef.current}/>
                  </div>
                : m.type === "CUSTOM"
                ? <CustomPredictionCard key={m.id} m={m} bal={bal}
                    pos={pos[m.id]||null}
                    players={marketPlayers[m.id]||[]}
                    onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                    isMobile={isMobile}
                    memeUser={memeUser}
                    onLoginRequired={() => setShowDeposit(true)}/>
                : <Card key={m.id} m={m} bal={bal} streak={streak}
                    pos={pos[m.id]||null}
                    players={marketPlayers[m.id]||[]}
                    onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                    isMobile={isMobile}
                    memeUser={memeUser}
                    onLoginRequired={() => setShowDeposit(true)}/>
            )}
            {[...pmMarkets]
              .filter(pm => !(pm.status === "RESOLVED" && (!pm.user_position || pm.user_position.claimed)))
              .sort((a, b) => new Date(a.ending_date || a.expires_at || 0) - new Date(b.ending_date || b.expires_at || 0)).map(pm => (
              <PredictionCard key={"pm-" + pm.market_id} pm={pm} memescore={memescore} authToken={authToken}
                memeUser={memeUser} onLoginRequired={() => setShowDeposit(true)}
                setMemescore={setMemescore} setPmMarkets={setPmMarkets}
                isMobile={isMobile} />
            ))}
          </div>

          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            position: "static"
          }}>
            <TreasureChestCard
              chestState={memeUser && chestQuest ? chestState : "cooldown"}
              chestCooldown={memeUser && chestQuest ? chestCooldown : 0}
              chestReward={chestReward}
              chestQuest={chestQuest}
              onClaim={memeUser ? handleChestClaim : () => setShowDeposit(true)}
              isMobile={isMobile}/>

            {/* Sidebar inventory + claim card */}
            {holdings && holdings.length > 0 && (() => {
              const dbTierMap = { GOLD:"gold", SILVER:"purple", BRONZE:"green" };
              const tierColors = { gold:"#ff7900", purple:"#e900d7", green:"#69b69b" };
              const tierColors2 = { gold:"#ffcb15", purple:"#fe6aff", green:"#d4ffed" };
              const tierOrder = { gold:0, purple:1, green:2 };
              const inv = holdings.map(h => ({
                sym: h.coin_symbol,
                ticker: h.coin_ticker || h.coin_name || h.coin_symbol,
                tier: dbTierMap[h.tier] || "green",
                img: h.coin_image,
              })).sort((a, b) => (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3));
              const canScan = !scanning && (!lastCensusAt || Date.now() - new Date(lastCensusAt).getTime() >= CENSUS_COOLDOWN_MS);
              const msLeft = lastCensusAt ? Math.max(0, CENSUS_COOLDOWN_MS - (Date.now() - new Date(lastCensusAt).getTime())) : 0;
              const onCooldown = !canScan && !scanning && lastCensusAt;
              const d = Math.floor(msLeft / (24*60*60*1000));
              const h = Math.floor((msLeft % (24*60*60*1000)) / (60*60*1000));
              const m = Math.floor((msLeft % (60*60*1000)) / (60*1000));
              void claimTick;
              const pct = onCooldown ? Math.min(100, Math.max(0, ((Date.now() - new Date(lastCensusAt).getTime()) / CENSUS_COOLDOWN_MS) * 100)) : 100;
              const doScan = async () => {
                setScanning(true); setScanError(null);
                try {
                  await runHoldingsScan(userId.current, memeUser.id, authToken);
                  setLastCensusAt(new Date().toISOString());
                  await loadInventory(userId.current);
                  const { data: freshUser } = await supabase.from("labs_users").select("diamond_hands").eq("id", userId.current).single();
                  const freshDh = freshUser?.diamond_hands || 0;
                  setDiamondHands(freshDh);
                  const { data: freshHoldings } = await supabase.from("labs_user_inventory").select("tier").eq("user_id", userId.current);
                  const reward = calcHoldingsReward(freshHoldings, freshDh);
                  if (reward > 0) {
                    const { error: rewardErr } = await supabase.rpc('labs_claim_holdings_reward', { p_user_id: userId.current, p_reward: reward });
                    if (rewardErr) throw new Error("Reward failed: " + rewardErr.message);
                    setBal(b => b + reward);
                    setClaimReward(reward);
                    setTimeout(() => setClaimReward(0), 1800);
                  }
                } catch (e) { setScanError(e.message); }
                setScanning(false);
              };
              return (
                <div style={{
                  background:"linear-gradient(360deg,#212936,#4e596c)",
                  boxShadow:"0 4px 44px #ffffff12,0 4px 12px #000000b8",
                  borderRadius:"16px 16px 25px 25px", padding:"5px 6px 10px"
                }}>
                  <div style={{
                    background:"#191f29",
                    borderRadius:14, padding:"14px 18px",
                    display:"flex", flexDirection:"column",
                    position:"relative", overflow:"hidden"
                  }}>
                    {/* Dark overlay */}
                    <div style={{
                      position:"absolute", inset:0,
                      background:"linear-gradient(180deg, rgba(15,20,30,0.88) 0%, rgba(15,20,30,0.78) 60%, rgba(0,0,0,0.55) 100%)",
                      pointerEvents:"none"
                    }}/>
                    <div style={{ position:"relative", zIndex:1 }}>
                      {/* Header */}
                      <div style={{
                        fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
                        textTransform:"uppercase", marginBottom:14,
                        textShadow:"0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
                        lineHeight:1.2, display:"flex", alignItems:"center", gap:10
                      }}>
                        <span><span style={gld}>Memecoin</span> Inventory</span>
                        {diamondHands > 0 && (
                          <span style={{
                            position:"relative", overflow:"hidden",
                            fontFamily:"'Jersey 25',sans-serif", fontSize:".85em",
                            background:"linear-gradient(135deg, rgba(185,242,255,0.12) 0%, rgba(100,180,220,0.08) 50%, rgba(185,242,255,0.12) 100%)",
                            color:"#e0f7ff", padding:"3px 12px", borderRadius:8,
                            fontWeight:700, letterSpacing:".06em",
                            border:"1px solid rgba(185,242,255,0.25)",
                            textShadow:"0 0 8px rgba(185,242,255,0.5)",
                            boxShadow:"0 0 12px rgba(185,242,255,0.15), 0 0 30px rgba(185,242,255,0.08), inset 0 1px 0 rgba(255,255,255,0.1)",
                            animation:"diamondPulse 3s ease-in-out infinite"
                          }}>
                            <span style={{ position:"relative", zIndex:1 }}>{"\u{1F48E}"} {diamondHands}X</span>
                            <span style={{
                              position:"absolute", top:0, left:"-100%", width:"100%", height:"100%",
                              background:"linear-gradient(90deg, transparent 0%, rgba(185,242,255,0.15) 50%, transparent 100%)",
                              borderRadius:8, animation:"diamondShimmer 4s ease-in-out infinite"
                            }}/>
                          </span>
                        )}
                      </div>
                      {/* Coin grid — max 3 rows, coins shrink to fit */}
                      <div style={{
                        display:"grid",
                        gridTemplateColumns:`repeat(${Math.max(4, Math.ceil(inv.length / 3))}, 1fr)`,
                        gap:6
                      }}>
                        {inv.map((c, i) => {
                          const tc = tierColors[c.tier];
                          const tc2 = tierColors2[c.tier];
                          return (
                            <div key={i} style={{
                              background:"linear-gradient(180deg, #1a1a24 0%, #12121a 100%)",
                              border:"1.5px solid " + tc + "55", borderRadius:8,
                              overflow:"hidden", display:"flex", flexDirection:"column",
                              boxShadow:"0 0 8px " + tc + "20, 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)"
                            }}>
                              <div style={{
                                width:"100%", aspectRatio:"1", position:"relative",
                                background:"linear-gradient(180deg, " + tc + "0d, transparent)",
                                display:"flex", alignItems:"center", justifyContent:"center",
                                overflow:"hidden"
                              }}>
                                {c.img ? <img src={c.img} alt={c.sym}
                                  style={{ width:"100%", height:"100%", objectFit:"cover" }}
                                  onError={e => { e.target.style.display="none"; }}
                                /> : <div style={{
                                  fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.3em",
                                  color:tc, opacity:.5
                                }}>{c.sym[0]}</div>}
                              </div>
                              <div style={{
                                background:"linear-gradient(180deg, " + tc + "bb, " + tc2 + "88)",
                                padding:"3px 5px",
                                display:"flex", alignItems:"center", justifyContent:"space-between",
                                marginTop:"auto"
                              }}>
                                <div style={{
                                  fontFamily:"'Londrina Solid',sans-serif", fontSize:".55em",
                                  color:"#fff", textShadow:"0 1px 3px rgba(0,0,0,.6)"
                                }}>${c.ticker}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Claim / timer bar */}
                      {memeUser && (
                        <div style={{
                          marginTop:14, display:"flex", alignItems:"stretch",
                          gap:0, width:"100%", height:32, borderRadius:8, overflow:"hidden"
                        }}>
                          <div style={{
                            flex:1, position:"relative",
                            background:"rgba(0,0,0,0.45)",
                            boxShadow:"inset 0 2px 4px rgba(0,0,0,0.4)"
                          }}>
                            <div style={{
                              position:"absolute", top:0, left:0, height:"100%",
                              width: pct + "%",
                              background:"linear-gradient(90deg, #71BAFF, #5a9fdf)",
                              boxShadow:"0 0 8px rgba(113,186,255,0.3)",
                              transition: pct < 100 ? "width 0.3s ease-out" : "none",
                              overflow:"hidden"
                            }}/>
                          </div>
                          <div onClick={canScan && !claimReward ? doScan : undefined} style={{
                            fontFamily:"'Jersey 25',sans-serif",
                            fontSize: claimReward > 0 ? ".95em" : ".75em",
                            whiteSpace:"nowrap",
                            color: (claimReward > 0 || canScan) ? "#fff" : "#ffffffaa",
                            background: claimReward > 0
                              ? "linear-gradient(180deg, #22c55e 0%, #16a34a 100%)"
                              : canScan
                                ? "linear-gradient(180deg, #ffcb15 0%, #f7931a 100%)"
                                : "linear-gradient(180deg, #f7931a99 0%, #cc750e99 100%)",
                            padding:"0 24px",
                            cursor: canScan && !claimReward ? "pointer" : "default",
                            fontWeight:700, letterSpacing:".06em", textTransform:"uppercase",
                            display:"flex", alignItems:"center", justifyContent:"center",
                            width:"33%", flexShrink:0,
                            boxShadow: claimReward > 0 ? "0 0 16px rgba(34,197,94,0.6)" : canScan ? "inset 0 1px 0 rgba(255,255,255,0.25)" : "none",
                            textShadow: "0 1px 4px rgba(0,0,0,0.4)",
                            animation: claimReward > 0 ? "claimPop .35s ease-out, claimGlow 1.8s ease-out" : "none",
                            transition:"background .3s, color .3s, font-size .3s"
                          }}
                          onMouseEnter={canScan && !claimReward ? e => { e.currentTarget.style.filter="brightness(1.1)"; } : undefined}
                          onMouseLeave={canScan && !claimReward ? e => { e.currentTarget.style.filter=""; } : undefined}
                          >
                            {scanning ? "SCANNING..." : claimReward > 0 ? `+${claimReward.toLocaleString()}` : canScan ? (() => { const r = calcHoldingsReward(holdings, diamondHands); return r > 0 ? `CLAIM ${r.toLocaleString()}` : "CLAIM"; })() : `${d}d ${h}h ${m}m`}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {retweetQuest && retweetState !== "loading" && !(retweetState === "completed" && retweetReward === 0) && (
              <RetweetQuestCard
                retweetState={memeUser ? retweetState : "completed"}
                retweetCooldown={retweetCooldown}
                retweetReward={retweetReward}
                retweetQuest={retweetQuest}
                onRetweet={memeUser ? handleRetweet : () => setShowDeposit(true)}
                isMobile={isMobile}/>
            )}

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
                <span style={{ flex:1, ...(ranked.filter(m => m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM").length > 0 && ranked.filter(m => m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM").every(m => yP(m.qY,m.qN,m.b) < 25) ? { color:"#f65e5e" } : {}) }}>{ranked.filter(m => m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM").length > 0 && ranked.filter(m => m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM").every(m => yP(m.qY,m.qN,m.b) < 25) ? "REKT BOARD" : "CONVICTION BOARD"}</span>
                <div style={{ display:"flex", fontFamily:"'Jersey 25',sans-serif", fontSize:".6em", color:"#ffffff30", textTransform:"uppercase" }}>
                  <span style={{ width:50, textAlign:"right", marginRight:8 }}>streak</span>
                  <span style={{ width:70, textAlign:"right" }}>pool</span>
                </div>
              </div>
              {[...ranked.filter(m => m.type !== "BATTLE" && m.type !== "TRENDS" && m.type !== "CUSTOM")].sort((a,b) => yP(b.qY,b.qN,b.b) - yP(a.qY,a.qN,a.b)).map((m,i) => {
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
                      color: ranked.filter(r => r.type !== "BATTLE" && r.type !== "TRENDS" && r.type !== "CUSTOM").length > 0 && ranked.filter(r => r.type !== "BATTLE" && r.type !== "TRENDS" && r.type !== "CUSTOM").every(r => yP(r.qY,r.qN,r.b) < 25) ? "#f65e5e" : "#ffffff50"
                    }}>{yP(m.qY,m.qN,m.b)}% on UP</div>
                  </div>
                  {coinForm.length > 0 && (
                    <div style={{ display:"flex", gap:2, alignItems:"center", justifyContent:"flex-end", width:50, flexShrink:0 }}>
                      {coinForm.map((h,j) => (
                        <div key={j} style={{
                          width:10, height:10, borderRadius:"50%",
                          background: h.result === "YES" ? "#22c55e" : "#ef4444",
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:6, fontWeight:700, color:"#fff"
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
                {hist.slice(-5).reverse().map((h,i) => {
                  const isBuy = h.type === "BUY";
                  const isSell = h.type === "SELL";
                  const isClaim = h.type === "CLAIM";
                  const won = isClaim && h.pnl != null && h.pnl >= 0;
                  const color = isBuy ? "#71BAFF" : isSell ? (h.pnl >= 0 ? "#b6ffac" : "#f65e5e") : won ? "#b6ffac" : "#f65e5e";
                  const label = isBuy ? "BUY -" + h.amount
                    : isSell ? (h.pnl >= 0 ? "SELL +" + h.amount : "SELL " + h.amount)
                    : won ? "+" + h.amount : "-" + (h.amount - (h.pnl || 0));
                  return (
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
                        fontFamily:"'Jersey 25',sans-serif", color
                      }}>{label}</span>
                    </div>
                  );
                })}
              </div>
            )}

          </div>
        </div>}

        {activeTab === "mememarket" && <div>
          {/* Create button */}
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => {
              if (!memeUser) { setShowDeposit(true); return; }
              setShowCreateMemeMarket(true);
            }} style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize: isMobile ? "1em" : "1.1em",
              padding:"10px 24px", borderRadius:12, border:"none",
              background:"linear-gradient(135deg,#71BAFF,#4a90d9)",
              color:"#fff", cursor:"pointer",
              boxShadow:"0 4px 16px rgba(113,186,255,0.3)"
            }}>+ CREATE MARKET</button>
          </div>

          {/* Market grid */}
          {memeMarkets.length === 0 ? (
            <div style={{
              textAlign:"center", padding:"48px 16px",
              fontFamily:"'Jersey 25',sans-serif", fontSize:"1.1em", color:"#ffffff40"
            }}>
              No markets yet — be the first to create one!
            </div>
          ) : (
            <div style={{
              display:"grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(17em, 1fr))",
              gap: isMobile ? 12 : 16
            }}>
              {memeMarkets.map(m => (
                <MemeMarketCard key={m.id} m={m} bal={bal}
                  pos={pos[m.id]||null}
                  players={marketPlayers[m.id]||[]}
                  onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                  isMobile={isMobile}
                  memeUser={memeUser}
                  onLoginRequired={() => setShowDeposit(true)}
                  trendSnaps={trendSnapsRef.current}/>
              ))}
            </div>
          )}

          {/* Your created markets (only show resolved ones not in main grid) */}
          {userId.current && (() => {
            const mainIds = new Set(memeMarkets.map(m => m.id));
            const myMarkets = mks.filter(m => m.type === "MEMEMARKET" && m.createdBy === userId.current && !mainIds.has(m.id));
            if (myMarkets.length === 0) return null;
            return (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em", marginBottom:10, color:"#ffffff80" }}>Your Markets</div>
                <div style={{
                  display:"grid",
                  gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(17em, 1fr))",
                  gap: isMobile ? 12 : 16
                }}>
                  {myMarkets.map(m => (
                    <MemeMarketCard key={"my-"+m.id} m={m} bal={bal}
                      pos={pos[m.id]||null}
                      players={marketPlayers[m.id]||[]}
                      onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                      isMobile={isMobile}
                      memeUser={memeUser}
                      onLoginRequired={() => setShowDeposit(true)}
                      trendSnaps={trendSnapsRef.current}/>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>}
      </div>

      <MemeMarketCreateModal
        show={showCreateMemeMarket}
        onClose={() => setShowCreateMemeMarket(false)}
        bal={bal}
        memeUser={memeUser ? { id: userId.current, ...memeUser } : null}
        onLoginRequired={() => setShowDeposit(true)}
        onCreated={(result) => {
          setBal(result.new_balance);
          setActiveTab("mememarket");
          // Trigger market refresh by updating lastUpdate
          setLastUpdate(new Date());
        }}
      />

      {showProfile && (() => {
        const dbTierMap = { GOLD:"gold", SILVER:"purple", BRONZE:"green" };
        const tierColors = { gold:"#ff7900", purple:"#e900d7", green:"#69b69b" };
        const tierColors2 = { gold:"#ffcb15", purple:"#fe6aff", green:"#d4ffed" };
        const tierOrder = { gold:0, purple:1, green:2 };
        const inv = (holdings || []).map(h => ({
          sym: h.coin_symbol,
          ticker: h.coin_ticker || h.coin_name || h.coin_symbol,
          tier: dbTierMap[h.tier] || "green",
          img: h.coin_image,
        })).sort((a, b) => (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3));
        return (<>
          <div onClick={() => setShowProfile(false)} style={{
            position:"fixed", inset:0, zIndex:50,
            background:"radial-gradient(ellipse at 50% 30%, rgba(20,15,40,0.88) 0%, rgba(5,5,10,0.96) 100%)",
            backdropFilter:"blur(12px)",
            animation:"overlayFadeIn 0.25s ease-out"
          }}/>
          <div style={{
            position:"fixed", top:"50%", left:"50%", transform:"translate(-50%,-50%)",
            width:"min(680px, 92vw)", maxHeight:"85vh", overflowY:"auto",
            background:"linear-gradient(180deg, #10141e 0%, #0c1018 40%, #111827 100%)",
            border:"1px solid rgba(113,186,255,0.12)",
            borderRadius:20, zIndex:51, padding:0,
            boxShadow:"0 0 60px rgba(0,0,0,0.7), 0 0 120px rgba(113,186,255,0.06), inset 0 1px 0 rgba(255,255,255,0.04)",
            animation:"panelSlideIn 0.3s cubic-bezier(0.34,1.56,0.64,1)"
          }}>
            {/* Header */}
            <div style={{
              padding:"20px 24px", display:"flex", justifyContent:"space-between",
              alignItems:"center",
              borderBottom:"1px solid rgba(255,255,255,0.06)",
              background:"linear-gradient(180deg, rgba(113,186,255,0.04) 0%, transparent 100%)"
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <div style={{
                  width:44, height:44, borderRadius:22, overflow:"hidden",
                  background:"linear-gradient(135deg,#71BAFF,#4023C3)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:18, fontWeight:700, flexShrink:0,
                  boxShadow:"0 2px 8px rgba(0,0,0,0.4)",
                  border:"none"
                }}>
                  {memeUser?.image
                    ? <img src={memeUser.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                    : <span>{(memeUser?.username || "G")[0].toUpperCase()}</span>
                  }
                </div>
                <div>
                  <div style={{
                    fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.15em",
                    textShadow:"0 0 20px rgba(255,255,255,0.1)"
                  }}>{memeUser?.username || "Guest"}</div>
                  <div style={{
                    fontFamily:"'Jersey 25',sans-serif", fontSize:".78em", color:"#ffffff50"
                  }}>
                    <span style={gld}>{bal.toLocaleString()} MEMESCORE</span>
                  </div>
                </div>
              </div>
              <span onClick={() => setShowProfile(false)} style={{
                cursor:"pointer", color:"#ffffff30", fontSize:"1.2em", padding:"6px 10px",
                lineHeight:1, borderRadius:8, border:"1px solid rgba(255,255,255,0.06)",
                background:"rgba(255,255,255,0.03)", transition:"all .15s"
              }}
              onMouseEnter={e => { e.currentTarget.style.background="rgba(255,255,255,0.08)"; e.currentTarget.style.color="#ffffff80"; }}
              onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,0.03)"; e.currentTarget.style.color="#ffffff30"; }}
              >✕</span>
            </div>
            <div style={{ padding:"20px 24px" }}>
              {/* Combined inventory + claim card */}
              <div style={{
                background:"linear-gradient(360deg,#212936,#4e596c)",
                boxShadow:"0 4px 44px #ffffff12,0 4px 12px #000000b8",
                borderRadius:20, padding:0, overflow:"hidden"
              }}>
                <div style={{
                  backgroundImage:"url(/experiments/memecoin-arena/inventory-bg.png)",
                  backgroundSize:"110%", backgroundPosition:"center center",
                  padding:"14px 18px",
                  display:"flex", flexDirection:"column",
                  position:"relative"
                }}>
                  {/* Dark overlay */}
                  <div style={{
                    position:"absolute", inset:0, borderRadius:14,
                    background:"linear-gradient(180deg, rgba(15,20,30,0.88) 0%, rgba(15,20,30,0.78) 60%, rgba(0,0,0,0.55) 100%)",
                    pointerEvents:"none"
                  }}/>

                  {/* Content */}
                  <div style={{ position:"relative", zIndex:1 }}>
                    {/* Header */}
                    <div style={{
                      fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
                      textTransform:"uppercase", marginBottom:14,
                      textShadow:"0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
                      lineHeight:1.2, display:"flex", alignItems:"center", gap:10
                    }}>
                      <span><span style={gld}>Memecoin</span> Inventory</span>
                      {diamondHands > 0 && (
                        <span style={{
                          position:"relative", overflow:"hidden",
                          fontFamily:"'Jersey 25',sans-serif", fontSize:".85em",
                          background:"linear-gradient(135deg, rgba(185,242,255,0.12) 0%, rgba(100,180,220,0.08) 50%, rgba(185,242,255,0.12) 100%)",
                          color:"#e0f7ff", padding:"3px 12px", borderRadius:8,
                          fontWeight:700, letterSpacing:".06em",
                          border:"1px solid rgba(185,242,255,0.25)",
                          textShadow:"0 0 8px rgba(185,242,255,0.5)",
                          boxShadow:"0 0 12px rgba(185,242,255,0.15), 0 0 30px rgba(185,242,255,0.08), inset 0 1px 0 rgba(255,255,255,0.1)",
                          animation:"diamondPulse 3s ease-in-out infinite"
                        }}>
                          <span style={{ position:"relative", zIndex:1 }}>{"\u{1F48E}"} {diamondHands}X</span>
                          <span style={{
                            position:"absolute", top:0, left:"-100%", width:"100%", height:"100%",
                            background:"linear-gradient(90deg, transparent 0%, rgba(185,242,255,0.15) 50%, transparent 100%)",
                            borderRadius:8, animation:"diamondShimmer 4s ease-in-out infinite"
                          }}/>
                        </span>
                      )}
                    </div>

                    {scanError && <div style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".75em", color:"#f65e5e",
                      marginBottom:10, textAlign:"center"
                    }}>Scan failed: {scanError}</div>}

                    {holdings === null ? (
                      <div style={{ color:"#ffffff30", fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", textAlign:"center", padding:"20px 0" }}>Loading...</div>
                    ) : inv.length === 0 ? (
                      <div style={{ color:"#ffffff30", fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", textAlign:"center", padding:"20px 0" }}>
                        {scanning ? "Scanning..." : memeUser ? "Hit Claim to check your holdings" : "Log in to see holdings"}
                      </div>
                    ) : (
                    <div style={{
                      display:"grid",
                      gridTemplateColumns:"repeat(auto-fill, minmax(60px, 1fr))",
                      gap:8
                    }}>
                      {inv.map((h, i) => {
                        const tc = tierColors[h.tier];
                        const tc2 = tierColors2[h.tier];
                        return (
                          <div key={i} style={{
                            background:"linear-gradient(180deg, #1a1a24 0%, #12121a 100%)",
                            border:"1.5px solid " + tc + "55",
                            borderRadius:8,
                            overflow:"hidden",
                            display:"flex", flexDirection:"column",
                            boxShadow:"0 0 8px " + tc + "20, 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
                            cursor:"pointer", transition:"transform .2s, box-shadow .2s, border-color .2s"
                          }}
                          onMouseEnter={e => { e.currentTarget.style.transform="translateY(-3px) scale(1.04)"; e.currentTarget.style.boxShadow="0 0 16px "+tc+"40, 0 4px 12px rgba(0,0,0,0.5)"; e.currentTarget.style.borderColor=tc+"88"; }}
                          onMouseLeave={e => { e.currentTarget.style.transform=""; e.currentTarget.style.boxShadow="0 0 8px "+tc+"20, 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor=tc+"55"; }}
                          >
                            <div style={{
                              width:"100%", aspectRatio:"1", position:"relative",
                              background:"linear-gradient(180deg, " + tc + "0d, transparent)",
                              display:"flex", alignItems:"center", justifyContent:"center",
                              overflow:"hidden"
                            }}>
                              {h.img ? <img src={h.img} alt={h.sym}
                                style={{ width:"100%", height:"100%", objectFit:"cover" }}
                                onError={e => { e.target.style.display="none"; }}
                              /> : <div style={{
                                fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.3em",
                                color:tc, opacity:.5
                              }}>{h.sym[0]}</div>}
                            </div>
                            <div style={{
                              background:"linear-gradient(180deg, " + tc + "bb, " + tc2 + "88)",
                              padding:"3px 5px",
                              display:"flex", alignItems:"center", justifyContent:"space-between",
                              marginTop:"auto"
                            }}>
                              <div style={{
                                fontFamily:"'Londrina Solid',sans-serif", fontSize:".55em",
                                color:"#fff", textShadow:"0 1px 3px rgba(0,0,0,.6)"
                              }}>${h.ticker}</div>
                              <img src="https://meme.com/assets/images/farm/simple-diamond.svg" alt="" style={{
                                width:9, height:7, filter:"drop-shadow(0 0 2px rgba(255,255,255,0.3))"
                              }}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    )}

                    {/* Claim / timer section */}
                    {memeUser && (() => {
                      const canScan = !scanning && (!lastCensusAt || Date.now() - new Date(lastCensusAt).getTime() >= CENSUS_COOLDOWN_MS);
                      const msLeft = lastCensusAt ? Math.max(0, CENSUS_COOLDOWN_MS - (Date.now() - new Date(lastCensusAt).getTime())) : 0;
                      const onCooldown = !canScan && !scanning && lastCensusAt;
                      const d = Math.floor(msLeft / (24*60*60*1000));
                      const h = Math.floor((msLeft % (24*60*60*1000)) / (60*60*1000));
                      const m = Math.floor((msLeft % (60*60*1000)) / (60*1000));
                      const s = Math.floor((msLeft % (60*1000)) / 1000);
                      void claimTick;
                      const pct = onCooldown ? Math.min(100, Math.max(0, ((Date.now() - new Date(lastCensusAt).getTime()) / CENSUS_COOLDOWN_MS) * 100)) : 100;
                      const doScan = async () => {
                        setScanning(true); setScanError(null);
                        try {
                          await runHoldingsScan(userId.current, memeUser.id, authToken);
                          setLastCensusAt(new Date().toISOString());
                          await loadInventory(userId.current);
                          const { data: freshUser } = await supabase.from("labs_users").select("diamond_hands").eq("id", userId.current).single();
                          const freshDh = freshUser?.diamond_hands || 0;
                          setDiamondHands(freshDh);
                          const { data: freshHoldings } = await supabase.from("labs_user_inventory").select("tier").eq("user_id", userId.current);
                          const reward = calcHoldingsReward(freshHoldings, freshDh);
                          if (reward > 0) {
                            const { error: rewardErr } = await supabase.rpc('labs_claim_holdings_reward', {
                              p_user_id: userId.current,
                              p_reward: reward
                            });
                            if (rewardErr) throw new Error("Reward failed: " + rewardErr.message);
                            setBal(b => b + reward);
                            setClaimReward(reward);
                            setTimeout(() => setClaimReward(0), 1800);
                          }
                        } catch (e) { setScanError(e.message); }
                        setScanning(false);
                      };
                      return (
                        <div style={{
                          marginTop:14, display:"flex", alignItems:"stretch",
                          gap:0, width:"100%", height:32, borderRadius:8, overflow:"hidden"
                        }}>
                          {/* Progress bar */}
                          <div style={{
                            flex:1, position:"relative",
                            background:"rgba(0,0,0,0.45)",
                            boxShadow:"inset 0 2px 4px rgba(0,0,0,0.4)"
                          }}>
                            <div style={{
                              position:"absolute", top:0, left:0, height:"100%",
                              width: pct + "%",
                              background:"linear-gradient(90deg, #71BAFF, #5a9fdf)",
                              boxShadow:"0 0 8px rgba(113,186,255,0.3)",
                              transition: pct < 100 ? "width 0.3s ease-out" : "none",
                              overflow:"hidden"
                            }}/>
                          </div>
                          {/* Claim / timer button */}
                          <div onClick={canScan && !claimReward ? doScan : undefined} style={{
                            fontFamily:"'Jersey 25',sans-serif",
                            fontSize: claimReward > 0 ? "1.2em" : "1em",
                            color: (claimReward > 0 || canScan) ? "#fff" : "#ffffffaa",
                            background: claimReward > 0
                              ? "linear-gradient(180deg, #22c55e 0%, #16a34a 100%)"
                              : canScan
                                ? "linear-gradient(180deg, #ffcb15 0%, #f7931a 100%)"
                                : "linear-gradient(180deg, #f7931a99 0%, #cc750e99 100%)",
                            padding:"0 24px",
                            cursor: canScan && !claimReward ? "pointer" : "default",
                            fontWeight:700, letterSpacing:".06em", textTransform:"uppercase",
                            display:"flex", alignItems:"center", justifyContent:"center",
                            width:"33%", flexShrink:0,
                            boxShadow: claimReward > 0 ? "0 0 16px rgba(34,197,94,0.6)" : canScan ? "inset 0 1px 0 rgba(255,255,255,0.25)" : "none",
                            textShadow: "0 1px 4px rgba(0,0,0,0.4)",
                            animation: claimReward > 0 ? "claimPop .35s ease-out, claimGlow 1.8s ease-out" : "none",
                            transition:"background .3s, color .3s, font-size .3s"
                          }}
                          onMouseEnter={canScan && !claimReward ? e => { e.currentTarget.style.filter="brightness(1.1)"; } : undefined}
                          onMouseLeave={canScan && !claimReward ? e => { e.currentTarget.style.filter=""; } : undefined}
                          >
                            {scanning ? "SCANNING..." : claimReward > 0 ? `+${claimReward.toLocaleString()}` : canScan ? (() => { const r = calcHoldingsReward(holdings, diamondHands); return r > 0 ? `CLAIM ${r.toLocaleString()}` : "CLAIM"; })() : `${d}d ${h}h ${m}m`}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>);
      })()}

      <HowToPlayModal isOpen={showHowTo} onClose={() => setShowHowTo(false)} isMobile={isMobile} />

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

      {flash && (
        <div onClick={() => setFlash(null)} style={{
          position:"fixed", bottom:32, left:"50%", transform:"translateX(-50%)",
          background: flash.type === "error" ? "#dc2626" : "#16a34a",
          color:"#fff", padding:"12px 24px", borderRadius:12,
          fontFamily:"'Jersey 25',sans-serif", fontSize:"1.1em",
          boxShadow:"0 4px 20px rgba(0,0,0,0.5)", zIndex:999, cursor:"pointer",
          animation:"fadeIn .2s ease"
        }}>
          {flash.msg}
        </div>
      )}

    </div>
  );
}
