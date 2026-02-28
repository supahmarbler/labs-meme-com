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
      image: data.profile_image_url
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
      expires_at: new Date(m.ea).toISOString(),
      price_updated_at: new Date().toISOString()
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
const syncUserToDb = async (userId, totalVolume, wins, losses, streak, bestStreak) => {
  if (!supabase) return;
  try {
    await supabase.from("labs_users").update({
      total_volume: totalVolume,
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

// Deduplicate: one OPEN market per coin, keep highest round. Keep all RES with positions.
const dedup = (mks) => {
  const openByCoin = {};
  const result = [];
  // First pass: find highest-round OPEN market per coin
  mks.forEach(m => {
    if (m.st === "OPEN") {
      if (!openByCoin[m.c.sym] || m.rn > openByCoin[m.c.sym].rn) openByCoin[m.c.sym] = m;
    }
  });
  // Second pass: keep RES markets + one OPEN per coin
  const seen = new Set();
  mks.forEach(m => {
    if (m.st === "OPEN") {
      if (openByCoin[m.c.sym]?.id === m.id && !seen.has(m.id)) { seen.add(m.id); result.push(m); }
    } else {
      if (!seen.has(m.id)) { seen.add(m.id); result.push(m); }
    }
  });
  return result;
};

const dbMarketToLocal = (db, coinData) => {
  const mcap = Number(db.current_mc) || 0;
  const b = Number(db.b) || getB(mcap);
  // DB stores user trades; we add base liquidity (equal to B) for LMSR math
  return {
    id: db.id,
    c: {
      sym: db.coin_symbol,
      name: db.coin_name,
      img: coinData?.img || db.coin_image,
      color: coinData?.color || db.coin_color,
      mcap: mcap
    },
    rn: parseInt(db.id.split("-")[1]) || 1,
    mc: mcap,
    startMc: Number(db.start_mc) || 0,
    qY: (Number(db.q_yes) || 0) + b,
    qN: (Number(db.q_no) || 0) + b,
    b: b,
    st: db.status || "OPEN",
    res: db.result,
    vol: Number(db.volume) || 0,
    ppl: Number(db.players) || 0,
    ea: new Date(db.expires_at).getTime()
  };
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

// Fallback coin data when APIs are rate limited
const FALLBACK_COINS = [
  { sym: "JOE", name: "Joe Coin", mcap: 7000000, color: "#f7931a", img: "https://cdn.meme.com/images/meme_assets/2025-07-16/1752687196279dnFN.png" },
  { sym: "STNK", name: "Stonks", mcap: 6000000, color: "#3d7a1c", img: "https://cdn.meme.com/images/meme_assets/2025-10-24/17613344323935piQ.png" },
  { sym: "PEPE", name: "Pepe", mcap: 1700000000, color: "#4ADE80", img: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779740059DXOD.png" },
  { sym: "MOG", name: "Mog Coin", mcap: 66000000, color: "#1e3a5f", img: "https://cdn.meme.com/images/meme_assets/2024-04-15/1713170597024m28Z.png" }
];

async function fetchCoins() {
  try {
    // Get metadata from meme.com
    const res = await fetch(`${API_BASE}/farm/coins_leaderboard?page=1&page_size=100`);
    const data = await res.json();
    const coins = data.items.filter(c => COIN_SYMBOLS.includes(c.symbol.toLowerCase())).map(c => ({
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
    const data = await res.json();

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
    console.error("CoinGecko fetch failed, trying meme.com:", err);
    // Fallback to meme.com API
    try {
      const res = await fetch(`${API_BASE}/farm/coins_leaderboard?page=1&page_size=100`);
      const data = await res.json();
      const priceMap = {};
      data.items.forEach(c => {
        priceMap[c.symbol.toLowerCase()] = {
          price: c.price_now,
          mcap: c.market_capitalization
        };
      });
      return priceMap;
    } catch (e) {
      console.error("Fallback also failed:", e);
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

const fM = v => v>=1e12?"$"+(v/1e12).toFixed(2)+"T":v>=1e9?"$"+(v/1e9).toFixed(2)+"B":v>=1e6?"$"+(v/1e6).toFixed(1)+"M":"$"+(v/1e3).toFixed(0)+"K";
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
    b:b,
    st:"OPEN", res:null, ea:nextRoundExpiry(), vol:0, ppl:0
  };
};

const CoinImg = ({ src, color, size, sym }) => {
  const s = size||40;
  const [imgErr, setImgErr] = React.useState(false);
  return (
    <div style={{
      width:s, height:s, borderRadius:12, position:"relative",
      border:"1px solid "+(color||"#fff")+"66",
      background:"linear-gradient(135deg, "+(color||"#fff")+"44, "+(color||"#fff")+"11)",
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

const convBonus = (m) => {
  const roundDuration = 86400*1000; // 24h baseline for bonus calc
  const elapsed = (Date.now() - (m.ea - roundDuration)) / roundDuration;
  if (elapsed < 0.25) return { mul:1.5, label:"EARLY BIRD 1.5x", color:"#f7931a" };
  if (elapsed < 0.5) return { mul:1.2, label:"CONVICTION 1.2x", color:"#71BAFF" };
  return { mul:1, label:null, color:null };
};

const streakMul = (s) => s >= 10 ? 3 : s >= 5 ? 2 : s >= 3 ? 1.5 : 1;
const streakLabel = (s) => s >= 10 ? "ON FIRE 3x" : s >= 5 ? "HOT STREAK 2x" : s >= 3 ? "STREAK 1.5x" : null;

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
  const rf = pos ? sellShares(m.qY, m.qN, m.b, pos.sh, pos.side) : 0;
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
            <CoinImg src={m.c.img} color={m.c.color} size={40} sym={m.c.sym}/>
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
            }}>PRICE TO BEAT</div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.05em",
              color:"#94a3b8"
            }}>{fM(m.startMc)}</div>
          </div>
          <div style={{ width:1, height:36, background:"#ffffff20", flexShrink:0 }}/>
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
                ADD MORE
              </button>
              <button style={{ ...bx, background:"#71baff8a" }}
                onClick={() => onSell(m.id)}>
                SELL
              </button>
            </div>
          )}

          {step==="res" && (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {pos && !pos.claimed && (
                <button
                  style={{ ...bx, background: m.res===pos.side ? "#71baff" : "#f65e5e30" }}
                  onClick={() => onClaim(m.id)}>
                  {m.res===pos.side
                    ? "CLAIM "+Math.round(pos.sh).toLocaleString()
                    : "YOU LOST. CLOSE."}
                </button>
              )}
              {pos && pos.claimed && (
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", textAlign:"center", padding:8
                }}>CLAIMED</div>
              )}
            </div>
          )}
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

function App() {
  const [mks, setMks] = useState([]);
  const [pos, setPos] = useState({});
  const [bal, setBal] = useState(0);
  const [hist, setHist] = useState([]);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
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
  const [leaderboard, setLeaderboard] = useState([]);
  const [marketHistory, setMarketHistory] = useState([]);

  // Refresh leaderboard and market history from database
  const refreshLeaderboard = useCallback(async () => {
    const leaders = await loadLeaderboardFromDb();
    if (leaders) setLeaderboard(leaders);
    const players = await loadMarketPlayersFromDb();
    setMarketPlayers(players);
    const history = await loadMarketHistoryFromDb();
    if (history) setMarketHistory(history);
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

      const coinMap = {};
      coins.forEach(c => { coinMap[c.sym] = c; });

      // Try loading from Supabase first
      const dbPositions = await loadPositionsFromDb(userId.current);
      // Load all markets (including resolved) so we can show claim UI for unclaimed positions
      const dbMarkets = await loadMarketsFromDb(true);
      const dbUser = await loadUserFromDb(userId.current);
      const players = await loadMarketPlayersFromDb();
      setMarketPlayers(players);

      if (dbMarkets && dbMarkets.length > 0) {
        // Show OPEN markets + resolved markets with unclaimed positions
        const posMarketIds = dbPositions ? new Set(Object.keys(dbPositions)) : new Set();
        const relevantMarkets = dbMarkets.filter(db =>
          db.status === "OPEN" || (db.status === "RES" && posMarketIds.has(db.id))
        );
        const localMks = relevantMarkets.map(db => dbMarketToLocal(db, coinMap[db.coin_symbol]));
        // Create markets for any coins missing an OPEN market
        const openSyms = new Set(dbMarkets.filter(db => db.status === "OPEN").map(db => db.coin_symbol));
        coins.forEach(c => {
          if (!openSyms.has(c.sym)) {
            const highest = dbMarkets.filter(db => db.coin_symbol === c.sym)
              .reduce((max, db) => { const rn = parseInt(db.id.split("-")[1]) || 0; return rn > max ? rn : max; }, 0);
            const newM = mk(c, highest + 1);
            localMks.push(newM);
            syncMarketToDb(newM);
          }
        });
        setMks(dedup(localMks));

        // Load user data from database — Supabase is source of truth for arena balance
        if (dbUser) {
          setBal(dbUser.labs_balance ?? 0);
          setStreak(dbUser.current_streak ?? 0);
          setBestStreak(dbUser.best_streak ?? 0);
          setWins(dbUser.wins ?? 0);
          setLosses(dbUser.losses ?? 0);
          setMyProfit(dbUser.total_profit ?? 0);
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

        // History still from localStorage for now
        if (saved) {
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

  // Calculate total volume and wins/losses
  const totalVolume = useMemo(() => {
    return Object.values(pos).reduce((s, p) => s + p.inv, 0) + hist.reduce((s, h) => s + h.inv, 0);
  }, [pos, hist]);

  // wins and losses are now state loaded from DB, not computed from hist

  // Save state whenever it changes (only after DB values are loaded)
  useEffect(() => {
    if (loading || !dbLoaded.current || mks.length === 0) return;
    saveState({ mks, pos, bal, hist, streak, bestStreak, savedAt: Date.now() });

    // Sync user stats to database (balance managed by RPCs only)
    syncUserToDb(userId.current, totalVolume, wins, losses, streak, bestStreak);
  }, [mks, pos, bal, hist, streak, bestStreak, loading, totalVolume, wins, losses]);

  // Price feed from CoinGecko (every 15s), synced to DB
  useEffect(() => {
    if (mks.length === 0) return;

    const updatePrices = async () => {
      const coins = mks.filter(m => m.st === "OPEN").map(m => m.c);
      if (coins.length === 0) return;
      const prices = await fetchPrices(coins);
      // Write to DB only — refreshMarkets (every 15s) syncs DB→local for all clients
      if (supabase) {
        const now = new Date().toISOString();
        for (const m of mks) {
          if (m.st !== "OPEN") continue;
          const data = prices[m.c.sym.toLowerCase()];
          if (data && data.mcap) {
            await supabase.from("labs_markets").update({
              current_mc: data.mcap,
              price_updated_at: now
            }).eq("id", m.id);
          }
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
      const dbMarkets = await loadMarketsFromDb(true);
      if (!dbMarkets || dbMarkets.length === 0) return;
      const dbMap = {};
      dbMarkets.forEach(db => { dbMap[db.id] = db; });

      setMks(prev => {
        const localIds = new Set(prev.map(m => m.id));
        let updated = prev.map(m => {
          const db = dbMap[m.id];
          if (!db) return m;
          const b = m.b;
          // If DB says resolved but local says open, sync resolution
          if (db.status === "RES" && m.st === "OPEN") {
            return { ...m, st: "RES", res: db.result,
              mc: Number(db.current_mc) || m.mc,
              qY: (Number(db.q_yes) || 0) + b,
              qN: (Number(db.q_no) || 0) + b,
              vol: Number(db.volume) || m.vol,
              ppl: Number(db.players) || m.ppl
            };
          }
          if (m.st !== "OPEN") return m;
          return {
            ...m,
            mc: Number(db.current_mc) || m.mc,
            startMc: Number(db.start_mc) || m.startMc,
            ea: db.expires_at ? new Date(db.expires_at).getTime() : m.ea,
            qY: (Number(db.q_yes) || 0) + b,
            qN: (Number(db.q_no) || 0) + b,
            vol: Number(db.volume) || m.vol,
            ppl: Number(db.players) || m.ppl
          };
        });
        // Add any new markets from DB that we don't have locally (OPEN, or resolved with position)
        dbMarkets.filter(db => !localIds.has(db.id) && (db.status === "OPEN" || (db.status === "RES" && pos[db.id] && !pos[db.id].claimed))).forEach(db => {
          const coinData = prev.find(m => m.c.sym === db.coin_symbol)?.c;
          if (coinData) updated.push(dbMarketToLocal(db, coinData));
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
        const openBySymbol = new Set(p.filter(m => m.st === "OPEN").map(m => m.c.sym));
        const resolved = p.filter(m => m.st === "RES");
        const newMarkets = [];
        resolved.forEach(m => {
          // Skip if user has unclaimed position
          if (pos[m.id] && !pos[m.id].claimed) return;
          // Skip if there's already an OPEN market for this coin
          if (openBySymbol.has(m.c.sym)) return;
          const newM = mk({ ...m.c, mcap: m.mc }, m.rn + 1);
          newMarkets.push(newM);
          openBySymbol.add(m.c.sym);
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
          setNotification({
            id: m.id,
            coin: m.c.sym,
            result: m.res,
            won,
            reward
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

    // Optimistic update for UI responsiveness
    const shares = buyShares(m.qY, m.qN, m.b, amt, side);
    const isNewPlayer = !pos[mid];
    const updatedMarket = {
      ...m,
      qY: side==="YES" ? m.qY + shares : m.qY,
      qN: side==="NO" ? m.qN + shares : m.qN,
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
          // Update with server values (RPC already deducted balance)
          setMks(p => p.map(mk => {
            if (mk.id !== mid) return mk;
            return { ...mk, qY: mk.b + data.new_q_yes, qN: mk.b + data.new_q_no };
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
    const rf = sellShares(m.qY, m.qN, m.b, pp.sh, pp.side);
    const pnl = rf - pp.inv;

    // Optimistic update for UI responsiveness
    const updatedMarket = {
      ...m,
      qY: pp.side==="YES" ? Math.max(0, m.qY - pp.sh) : m.qY,
      qN: pp.side==="NO" ? Math.max(0, m.qN - pp.sh) : m.qN,
      vol: m.vol + rf,
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
          // Update with server values (RPC already credited balance)
          setMks(p => p.map(mk => {
            if (mk.id !== mid) return mk;
            return { ...mk, qY: mk.b + data.new_q_yes, qN: mk.b + data.new_q_no };
          }));
          if (data.new_balance != null) setBal(data.new_balance);
          else setBal(b => b + rf);
          setTimeout(refreshLeaderboard, 500);
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback: credit locally and sync
    setBal(b => b + rf);
    syncMarketToDb(updatedMarket);
    syncPositionToDb(userId.current, mid, null);
    recordTradeInDb(userId.current, mid, m.c.sym, pp.side, pp.sh, rf, 'SELL', null, pnl);
    // Credit balance and profit in DB atomically
    if (supabase) {
      await supabase.rpc('labs_adjust_balance', { p_user_id: userId.current, p_delta: rf });
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
    const won = m.res===pp.side;
    const rw = won ? Math.round(pp.sh) : 0;
    const pnl = rw - pp.inv;

    setBal(b => b+rw);
    setPos(p => ({ ...p, [mid]:{ ...p[mid], claimed:true }}));
    setHist(h => [...h, { sym:m.c.sym, rn:m.rn, side:pp.side, result:m.res, rw, inv:pp.inv }]);

    // Update wins/losses and streak
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

    // Remove position from DB after claiming
    syncPositionToDb(userId.current, mid, null);
    recordTradeInDb(userId.current, mid, m.c.sym, pp.side, pp.sh, rw, 'CLAIM', m.res, pnl);

    // Credit claim reward to DB atomically
    if (supabase && rw > 0) {
      await supabase.rpc('labs_adjust_balance', { p_user_id: userId.current, p_delta: rw });
    }
    // Track profit (pnl = reward - invested)
    if (supabase) {
      await supabase.rpc('labs_adjust_profit', { p_user_id: userId.current, p_delta: pnl });
      setTimeout(refreshLeaderboard, 500);
    }
  }, [pos, mks, memeUser, refreshLeaderboard]);

  // Build display list: resolved with unclaimed position takes priority over OPEN for same coin
  const ranked = useMemo(() => {
    const resByCoin = {};
    mks.forEach(m => {
      if (m.st === "RES" && pos[m.id] && !pos[m.id].claimed) resByCoin[m.c.sym] = m;
    });
    // Filter: show resolved (unclaimed) instead of OPEN for same coin
    const filtered = mks.filter(m => {
      if (m.st === "OPEN" && resByCoin[m.c.sym]) return false; // hide OPEN, show RES instead
      if (m.st === "RES" && (!pos[m.id] || pos[m.id].claimed)) return false; // hide claimed/no-position RES
      return true;
    });
    const allRekt = filtered.length > 0 && filtered.every(m => yP(m.qY, m.qN, m.b) < 25);
    return filtered.sort((a,b) => allRekt
      ? yP(a.qY, a.qN, a.b) - yP(b.qY, b.qN, b.b)
      : yP(b.qY, b.qN, b.b) - yP(a.qY, a.qN, a.b));
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
          <style>{`@keyframes slideDown { from { opacity:0; transform:translateX(-50%) translateY(-20px); } to { opacity:1; transform:translateX(-50%) translateY(0); } } @keyframes timerPulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } } @keyframes priceFlash { 0% { opacity:1; transform:scale(1.2); } 30% { opacity:1; transform:scale(1); } 100% { opacity:1; transform:scale(1); } }`}</style>
          <span style={{ fontSize:"1.5em" }}>{notification.result === "YES" ? "📈" : "📉"}</span>
          <div>
            <div style={{ fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em" }}>
              ${notification.coin} {notification.result === "YES" ? "WENT UP!" : "WENT DOWN"}
            </div>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".9em", opacity:.9 }}>
              {notification.won ? `You won! Claim ${notification.reward.toLocaleString()}` : "Better luck next time"}
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
          <div onClick={() => setShowProfile(true)} style={{
            display:"flex", alignItems:"center", gap: isMobile ? 6 : 10, cursor:"pointer"
          }}>
            <div style={{
              width: isMobile ? 32 : 36, height: isMobile ? 32 : 36, borderRadius: "50%", overflow:"hidden",
              background:"linear-gradient(135deg,#71BAFF,#4023C3)",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize: isMobile ? 12 : 14, fontWeight:700, flexShrink:0
            }}>
              {memeUser?.image
                ? <img src={memeUser.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                : <span>{(memeUser?.username || "G")[0].toUpperCase()}</span>
              }
            </div>
            {!isMobile && <span style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em"
            }}>{memeUser?.username || "Guest"}</span>}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:"72em", margin:"0 auto", padding: isMobile ? "12px 12px 24px" : "20px 2.5% 48px" }}>
        <div style={{ marginBottom: isMobile ? 8 : 16 }}>
          <div style={{
            fontFamily:"'Londrina Solid',sans-serif", fontSize: isMobile ? "1.3em" : "1.6em",
            textTransform:"uppercase", textShadow:"0 2px 4px rgba(0,0,0,.5)"
          }}>Memecoin Arena{!isProd && <span style={{
            fontSize:".45em", background:"#ff4444", color:"#fff", padding:"2px 8px",
            borderRadius:4, marginLeft:10, verticalAlign:"middle", letterSpacing:1
          }}>DEV</span>}</div>
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize: isMobile ? ".75em" : ".9em",
            color:"#ffffff60"
          }}>
            {isMobile ? "24h prediction rounds" : "Predict targets. Vote with conviction on your favorite memes. "}
            {!isMobile && <span style={{ ...gld }}>24h rounds.</span>}
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
              <Card key={m.id} m={m} bal={bal} streak={streak}
                pos={pos[m.id]||null}
                players={marketPlayers[m.id]||[]}
                onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                isMobile={isMobile}
                memeUser={memeUser}
                onLoginRequired={() => setShowDeposit(true)}/>
            )}
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
                <span style={{ flex:1, ...(ranked.length > 0 && ranked.every(m => yP(m.qY,m.qN,m.b) < 25) ? { color:"#f65e5e" } : {}) }}>{ranked.length > 0 && ranked.every(m => yP(m.qY,m.qN,m.b) < 25) ? "REKT BOARD" : "CONVICTION BOARD"}</span>
                <div style={{ display:"flex", fontFamily:"'Jersey 25',sans-serif", fontSize:".6em", color:"#ffffff30", textTransform:"uppercase" }}>
                  <span style={{ width:80, textAlign:"center" }}>streak</span>
                  <span style={{ width:50, textAlign:"right" }}>pool</span>
                </div>
              </div>
              {ranked.map((m,i) => {
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
                      color: ranked.length > 0 && ranked.every(r => yP(r.qY,r.qN,r.b) < 25) ? "#f65e5e" : "#ffffff50"
                    }}>{yP(m.qY,m.qN,m.b)}% on UP</div>
                  </div>
                  {coinForm.length > 0 && (
                    <div style={{ display:"flex", gap:3, alignItems:"center", justifyContent:"center", width:80, marginRight:-13 }}>
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
                    ...gld, fontFamily:"'Jersey 25',sans-serif", textAlign:"right", minWidth:50
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
                    name: u.username || anonName(u.id),
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
        const holdings = [
          { sym:"PEPE", tier:"gold", img:"https://cdn.meme.com/images/meme_assets/2024-04-10/1712779740059DXOD.png", color:"#4ADE80" },
          { sym:"DOGE", tier:"silver", img:"https://cdn.meme.com/images/meme_assets/2024-04-09/1712630400000DOGE.png", color:"#C2A633" },
          { sym:"JOE", tier:"silver", img:"https://cdn.meme.com/images/meme_assets/2025-07-16/1752687196279dnFN.png", color:"#f7931a" },
          { sym:"PENGU", tier:"bronze", img:"https://cdn.meme.com/images/meme_assets/2024-12-17/1734393600000PNGU.png", color:"#71BAFF" },
        ];
        const tierColors = { gold:"#f7931a", silver:"#94a3b8", bronze:"#b45309" };
        const tierLabels = { gold:"GOLD", silver:"SILVER", bronze:"BRONZE" };
        return (
          <div onClick={() => setShowProfile(false)} style={{
            position:"fixed", inset:0, background:"rgba(0,0,0,0.85)",
            backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)",
            display:"flex", alignItems:"center", justifyContent:"center", zIndex:100
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              background:"linear-gradient(180deg,#1a2332,#0c1018)",
              borderRadius:20, padding: isMobile ? "20px 16px 24px" : "28px 32px 32px",
              width: isMobile ? "92%" : "auto", maxWidth:680, minWidth: isMobile ? "auto" : 420,
              border:"1px solid #ffffff15", position:"relative"
            }}>
              {/* Close button */}
              <button onClick={() => setShowProfile(false)} style={{
                position:"absolute", top:14, right:16, background:"none", border:"none",
                color:"#ffffff60", fontSize:"1.3em", cursor:"pointer", padding:4,
                fontFamily:"'Jersey 25',sans-serif"
              }}>X</button>

              {/* Header */}
              <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:20 }}>
                <div style={{
                  width:52, height:52, borderRadius:"50%", overflow:"hidden",
                  background:"linear-gradient(135deg,#71BAFF,#4023C3)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:20, fontWeight:700, flexShrink:0
                }}>
                  {memeUser?.image
                    ? <img src={memeUser.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                    : <span>{(memeUser?.username || "G")[0].toUpperCase()}</span>
                  }
                </div>
                <div>
                  <div style={{
                    fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.4em"
                  }}>{memeUser?.username || "Guest"}</div>
                  <div style={{ display:"flex", gap:16, marginTop:2 }}>
                    <span style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".85em", color:"#ffffff60"
                    }}>MEMESCORE: <span style={gld}>{memescore.toLocaleString()}</span></span>
                    <span style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".85em", color:"#ffffff60"
                    }}>STREAK: <span style={{ color:"#f7931a" }}>{streak}</span></span>
                  </div>
                </div>
              </div>

              {/* Divider */}
              <div style={{ height:1, background:"#ffffff10", margin:"0 0 20px" }}/>

              {/* Inventory label */}
              <div style={{
                fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
                color:"#ffffff40", letterSpacing:2, marginBottom:14
              }}>MEME INVENTORY</div>

              {/* Card grid */}
              <div style={{
                display:"grid",
                gridTemplateColumns:"repeat(auto-fill, minmax(88px, 1fr))",
                gap:10
              }}>
                {holdings.map(h => (
                  <div key={h.sym} style={{
                    background:"linear-gradient(180deg,#1e2a3a,#141c28)",
                    border:`2px solid ${tierColors[h.tier]}`,
                    borderRadius:12, overflow:"hidden", cursor:"default",
                    transition:"transform 0.2s ease, box-shadow 0.2s ease"
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.boxShadow=`0 6px 20px ${tierColors[h.tier]}44`; }}
                  onMouseLeave={e => { e.currentTarget.style.transform="translateY(0)"; e.currentTarget.style.boxShadow="none"; }}
                  >
                    {/* Coin image + tier badge */}
                    <div style={{ position:"relative", aspectRatio:"1", overflow:"hidden" }}>
                      <img src={h.img} alt={h.sym} style={{
                        width:"100%", height:"100%", objectFit:"cover", display:"block"
                      }}/>
                      <span style={{
                        position:"absolute", top:4, right:4, fontSize:".5em",
                        fontFamily:"'Jersey 25',sans-serif",
                        background:tierColors[h.tier]+"cc", color:"#fff",
                        padding:"1px 5px", borderRadius:3, letterSpacing:1
                      }}>{tierLabels[h.tier]}</span>
                    </div>
                    {/* Footer */}
                    <div style={{
                      background:tierColors[h.tier]+"18",
                      borderTop:`1px solid ${tierColors[h.tier]}33`,
                      padding:"4px 8px", display:"flex", alignItems:"center",
                      justifyContent:"space-between"
                    }}>
                      <span style={{
                        fontFamily:"'Londrina Solid',sans-serif", fontSize:".75em",
                        color:tierColors[h.tier]
                      }}>${h.sym}</span>
                      <span style={{ fontSize:".6em" }}>💎</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
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

    </div>
  );
}
