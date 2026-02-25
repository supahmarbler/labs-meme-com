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

// Supabase client
const SUPABASE_URL = "https://csvegolcvwuwssoefxdh.supabase.co";
const SUPABASE_KEY = "sb_publishable_Qf1O75YbEeBE2qwg4ThmwA_Uxpw9BG4";
const supabase = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);

// meme.com API base
const MEME_API = "https://api.meme.com/api/v1";

// Check if meme.com auth token is valid
const getMemeAuth = () => {
  try {
    const token = localStorage.getItem("auth_token");
    const timestamp = localStorage.getItem("auth_timestamp");
    if (!token || !timestamp) return null;

    // Check if token is expired (with 60s buffer)
    const expiresAt = parseInt(timestamp) * 1000;
    if (Date.now() > expiresAt - 60000) return null;

    return {
      token,
      walletAddress: localStorage.getItem("auth_wallet_address"),
      walletType: localStorage.getItem("auth_wallet_type")
    };
  } catch (e) {
    console.log("Auth check failed:", e);
    return null;
  }
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
      id: data.userId,
      username: data.username,
      image: data.profileImageUrl
    };
  } catch (e) {
    console.log("Failed to fetch meme user:", e);
    return null;
  }
};

// Fetch memescore from meme.com API
const fetchMemescore = async (authToken, userId) => {
  try {
    const res = await fetch(`${MEME_API}/farm/user_balance?meme_user_id=${userId}`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return Math.floor(data.memescore || 0);
  } catch (e) {
    console.log("Failed to fetch memescore:", e);
    return 0;
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

// Supabase market sync with retry
const syncMarketToDb = async (m, retries = 2) => {
  if (!supabase) return false;
  try {
    // Store user trades only (subtract base liquidity which equals B)
    const payload = {
      q_yes: Math.max(0, m.qY - m.b),
      q_no: Math.max(0, m.qN - m.b),
      current_mc: m.mc,
      status: m.st,
      result: m.res,
      volume: m.vol,
      players: m.ppl
    };
    const { error } = await supabase
      .from("labs_markets")
      .update(payload)
      .eq("id", m.id);
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

const loadMarketsFromDb = async () => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("labs_markets")
      .select("*")
      .eq("status", "OPEN");
    if (error) throw error;
    return data;
  } catch (e) {
    console.error("Load markets failed:", e);
    return null;
  }
};

// Ensure user exists in database
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
        labs_balance: 10000,
        total_volume: 0,
        wins: 0,
        losses: 0,
        current_streak: 0,
        best_streak: 0
      });
    }
  } catch (e) {
    // User might already exist, that's fine
    console.log("User check:", e.message);
  }
};

// Sync user stats to database
const syncUserToDb = async (userId, bal, totalVolume, wins, losses, streak, bestStreak) => {
  if (!supabase) return;
  try {
    await supabase.from("labs_users").upsert({
      id: userId,
      labs_balance: bal,
      total_volume: totalVolume,
      wins: wins,
      losses: losses,
      current_streak: streak,
      best_streak: bestStreak,
      updated_at: new Date().toISOString()
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
      .select("id, username, profile_image, total_volume, wins, losses, current_streak, created_at")
      .gt("total_volume", 0)
      .order("total_volume", { ascending: false })
      .limit(10);
    if (error) throw error;
    return data;
  } catch (e) {
    console.error("Leaderboard load failed:", e);
    return null;
  }
};

// Load recent market results (last 10 resolved)
const loadMarketHistoryFromDb = async () => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("labs_markets")
      .select("id, coin_symbol, coin_image, coin_color, start_mc, current_mc, result, expires_at, volume")
      .eq("status", "RES")
      .order("expires_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return data;
  } catch (e) {
    console.error("History load failed:", e);
    return null;
  }
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
const COIN_SYMBOLS = ["joe", "stnk", "pengu", "pepe", "mog", "dog"];
const COIN_COLORS = { joe:"#f7931a", stnk:"#84CC16", pengu:"#38BDF8", pepe:"#4ADE80", mog:"#9333EA", dog:"#c2a633" };

// CoinGecko for fast price updates
const COINGECKO_IDS = {
  joe: "joe-coin",
  stnk: "stonks-4",
  pengu: "pudgy-penguins",
  pepe: "pepe",
  mog: "mog-coin",
  dog: "the-doge-nft"
};

// Fallback coin data when APIs are rate limited
const FALLBACK_COINS = [
  { sym: "JOE", name: "Joe Coin", mcap: 7000000, color: "#f7931a", img: "https://cdn.meme.com/images/meme_assets/2025-07-16/1752687196279dnFN.png" },
  { sym: "STNK", name: "Stonks", mcap: 6000000, color: "#84CC16", img: "https://cdn.meme.com/images/meme_assets/2025-10-24/17613344323935piQ.png" },
  { sym: "PENGU", name: "Pudgy Penguins", mcap: 450000000, color: "#38BDF8", img: "https://cdn.meme.com/images-4/meme_assets/2024-12-17/1734446159208EJOa.png" },
  { sym: "PEPE", name: "Pepe", mcap: 1700000000, color: "#4ADE80", img: "https://cdn.meme.com/images/meme_assets/2024-04-10/1712779740059DXOD.png" },
  { sym: "MOG", name: "Mog Coin", mcap: 66000000, color: "#9333EA", img: "https://cdn.meme.com/images/meme_assets/2024-04-15/1713170597024m28Z.png" },
  { sym: "DOG", name: "Own The Doge", mcap: 6700000, color: "#c2a633", img: "https://cdn.meme.com/images/meme_assets/2024-04-11/1712816760809SN3H.png" }
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
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc`
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
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc`
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
  let lo = 0, hi = cost * 2;
  for (let i = 0; i < 40; i++) {
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
const DUR = 86400;
const gld = { background:"linear-gradient(193deg,#f7931a -49%,#fab248 -14%,#fff1a6 58%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" };

// B controls market depth - higher B = more liquidity, less price impact
// Base liquidity should be proportional to B for LMSR to work correctly
const getB = (mcap) => mcap > 1e9 ? 50000 : mcap > 100e6 ? 30000 : 20000;

const mk = (c, r) => {
  const b = getB(c.mcap);
  return {
    id:c.sym+"-"+(r||1), c, rn:r||1, mc:c.mcap, startMc:c.mcap,
    qY:b, qN:b, // Start with equal shares = 50/50 odds
    b:b,
    st:"OPEN", res:null, ea:Date.now()+DUR*1000, vol:0, ppl:0
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
  const elapsed = (Date.now() - (m.ea - DUR*1000)) / (DUR*1000);
  if (elapsed < 0.25) return { mul:1.5, label:"EARLY BIRD 1.5x", color:"#f7931a" };
  if (elapsed < 0.5) return { mul:1.2, label:"CONVICTION 1.2x", color:"#71BAFF" };
  return { mul:1, label:null, color:null };
};

const streakMul = (s) => s >= 10 ? 3 : s >= 5 ? 2 : s >= 3 ? 1.5 : 1;
const streakLabel = (s) => s >= 10 ? "ON FIRE 3x" : s >= 5 ? "HOT STREAK 2x" : s >= 3 ? "STREAK 1.5x" : null;

// Deposit/Withdraw modal component
const DepositModal = ({ isOpen, onClose, onDeposit, memeUser, memescore, labsBalance, authToken, isMobile }) => {
  const [mode, setMode] = useState("deposit"); // "deposit" or "withdraw"
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const maxAmount = mode === "deposit" ? memescore : labsBalance;
  const minAmount = 100;

  const handleSubmit = async () => {
    const amt = parseInt(amount) || 0;
    if (amt <= 0) return;
    if (amt < minAmount) {
      setError(`Minimum ${mode} is ${minAmount}`);
      return;
    }
    if (amt > maxAmount) {
      setError(mode === "deposit" ? "Insufficient memescore" : "Insufficient Labs balance");
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

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || data.detail || `${mode} failed`);
      }

      onDeposit(amt, data.new_labs_balance, data.new_memescore);
      setAmount("");
      onClose();
    } catch (e) {
      console.error(`${mode} error:`, e);
      setError(e.message || `${mode} failed. Please try again.`);
    } finally {
      setLoading(false);
    }
  };

  // Not logged in - show login prompt
  if (!memeUser) {
    return (
      <div style={{
        position:"fixed", inset:0, background:"rgba(0,0,0,0.8)",
        display:"flex", alignItems: isMobile ? "flex-end" : "center", justifyContent:"center", zIndex:100
      }} onClick={onClose}>
        <div style={{
          background:"linear-gradient(180deg,#1a2332,#0c1018)",
          borderRadius: isMobile ? "20px 20px 0 0" : 20,
          padding: isMobile ? "24px 16px 32px" : 32,
          width: isMobile ? "100%" : "auto",
          minWidth: isMobile ? "auto" : 340,
          maxWidth: isMobile ? "100%" : 400,
          border:"1px solid #ffffff15",
          textAlign:"center"
        }} onClick={e => e.stopPropagation()}>
          <div style={{
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.4em",
            marginBottom:20
          }}>Login Required</div>

          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize:".9em",
            color:"#94a3b8", marginBottom:24, lineHeight:1.5
          }}>
            Connect your meme.com account to deposit memescore and start playing.
          </div>

          <a
            href="https://meme.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display:"block", width:"100%", height:48, borderRadius:12, border:"none",
              background:"linear-gradient(90deg,#71BAFF,#4023C3)",
              color:"#fff", cursor:"pointer", textDecoration:"none",
              fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.1em",
              lineHeight:"48px"
            }}
          >
            Login on meme.com
          </a>

          <button onClick={onClose} style={{
            marginTop:12, width:"100%", height:40, borderRadius:10, border:"none",
            background:"transparent", color:"#ffffff60", cursor:"pointer",
            fontFamily:"'Jersey 25',sans-serif", fontSize:".85em"
          }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,0.8)",
      display:"flex", alignItems: isMobile ? "flex-end" : "center", justifyContent:"center", zIndex:100
    }} onClick={onClose}>
      <div style={{
        background:"linear-gradient(180deg,#1a2332,#0c1018)",
        borderRadius: isMobile ? "20px 20px 0 0" : 20,
        padding: isMobile ? "20px 16px 32px" : 24,
        width: isMobile ? "100%" : "auto",
        minWidth: isMobile ? "auto" : 360,
        maxWidth: isMobile ? "100%" : 420,
        border:"1px solid #ffffff15"
      }} onClick={e => e.stopPropagation()}>
        {/* Mode tabs */}
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          <button onClick={() => { setMode("deposit"); setError(null); setAmount(""); }} style={{
            flex:1, padding:"10px 0", borderRadius:10,
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1em",
            background: mode === "deposit" ? "linear-gradient(90deg,#71BAFF,#4023C3)" : "#ffffff10",
            border: mode === "deposit" ? "none" : "1px solid #ffffff15",
            color:"#fff", cursor:"pointer"
          }}>Deposit</button>
          <button onClick={() => { setMode("withdraw"); setError(null); setAmount(""); }} style={{
            flex:1, padding:"10px 0", borderRadius:10,
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1em",
            background: mode === "withdraw" ? "linear-gradient(90deg,#f7931a,#c2410c)" : "#ffffff10",
            border: mode === "withdraw" ? "none" : "1px solid #ffffff15",
            color:"#fff", cursor:"pointer"
          }}>Withdraw</button>
        </div>

        {/* Balance display */}
        <div style={{
          display:"flex", justifyContent:"space-between", marginBottom:16,
          padding:"12px 14px", background:"#0c1018", borderRadius:10
        }}>
          <div style={{ textAlign:"center", flex:1 }}>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#ffffff50", marginBottom:4 }}>MEMESCORE</div>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", color:"#f7931a" }}>{memescore.toLocaleString()}</div>
          </div>
          <div style={{ width:1, background:"#ffffff15" }} />
          <div style={{ textAlign:"center", flex:1 }}>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".7em", color:"#ffffff50", marginBottom:4 }}>LABS BALANCE</div>
            <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", color:"#71BAFF" }}>{labsBalance.toLocaleString()}</div>
          </div>
        </div>

        {error && (
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize:".8em",
            color:"#ef4444", textAlign:"center", marginBottom:12,
            padding:10, background:"#ef444415", borderRadius:8
          }}>
            {error}
          </div>
        )}

        <input
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="Amount..."
          value={amount}
          onChange={e => { setAmount(e.target.value); setError(null); }}
          style={{
            width:"100%", height:48, border:"1px solid #4c5159", borderRadius:12,
            textAlign:"center", color:"#fff", background:"#0c1018",
            fontFamily:"'Jersey 25',sans-serif", fontSize:"1.2em", outline:"none",
            marginBottom:12
          }}
        />

        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          {[1000, 5000, 10000].map(amt => (
            <button key={amt} onClick={() => { setAmount(String(Math.min(amt, maxAmount))); setError(null); }} style={{
              flex:1, padding:"8px 0", borderRadius:8,
              fontFamily:"'Jersey 25',sans-serif", fontSize:".75em",
              background:"#00000042", border:"1px solid #ffffff15",
              color: amt <= maxAmount ? "#ffffff80" : "#ffffff30", cursor:"pointer"
            }}>{(amt/1000)}K</button>
          ))}
          <button onClick={() => { setAmount(String(maxAmount)); setError(null); }} style={{
            flex:1, padding:"8px 0", borderRadius:8,
            fontFamily:"'Jersey 25',sans-serif", fontSize:".75em",
            background: mode === "deposit" ? "#f7931a20" : "#71BAFF20",
            border: mode === "deposit" ? "1px solid #f7931a40" : "1px solid #71BAFF40",
            color: mode === "deposit" ? "#f7931a" : "#71BAFF", cursor:"pointer"
          }}>MAX</button>
        </div>

        <div style={{ display:"flex", gap:10 }}>
          <button onClick={onClose} style={{
            flex:1, height:44, borderRadius:12, border:"none",
            background:"#ffffff15", color:"#fff", cursor:"pointer",
            fontFamily:"'Jersey 25',sans-serif", fontSize:"1em"
          }}>Cancel</button>
          <button onClick={handleSubmit} disabled={loading || !amount} style={{
            flex:2, height:44, borderRadius:12, border:"none",
            background: loading ? "#4c5159" : mode === "deposit"
              ? "linear-gradient(90deg,#71BAFF,#4023C3)"
              : "linear-gradient(90deg,#f7931a,#c2410c)",
            color:"#fff", cursor: loading ? "wait" : "pointer",
            fontFamily:"'Jersey 25',sans-serif", fontSize:"1em"
          }}>{loading ? "Processing..." : mode === "deposit" ? "Deposit" : "Withdraw"}</button>
        </div>
      </div>
    </div>
  );
};

const Card = ({ m, bal, pos, onBuy, onSell, onClaim, streak, isMobile }) => {
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
        <div style={{ display:"flex", alignItems:"center", marginBottom:12, gap:11 }}>
          <CoinImg src={m.c.img} color={m.c.color} size={40} sym={m.c.sym}/>
          <div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:".875em",
              textTransform:"uppercase",
              textShadow:"0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
              lineHeight:1.2
            }}>${m.c.sym} Up or Down</div>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
              color:"#ffffff35", marginTop:2
            }}>24h prediction</div>
          </div>
        </div>

        <div style={{
          display:"flex", alignItems:"flex-start", gap:12, marginBottom:10,
          flexWrap:"wrap"
        }}>
          <div style={{ whiteSpace:"nowrap" }}>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".5em",
              color:"#ffffff40", marginBottom:2
            }}>PRICE TO BEAT</div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:".9em",
              color:"#94a3b8"
            }}>{fM(m.startMc)}</div>
          </div>
          <div style={{ width:1, height:32, background:"#ffffff20", flexShrink:0 }}/>
          <div style={{ whiteSpace:"nowrap" }}>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".5em",
              color:"#ffffff40", marginBottom:2
            }}>CURRENT PRICE</div>
            <div style={{
              display:"flex", alignItems:"center", gap:4,
              fontFamily:"'Londrina Solid',sans-serif", fontSize:".9em"
            }}>
              <span style={{...gld}}>{fM(m.mc)}</span>
              <span style={{
                fontFamily:"'Jersey 25',sans-serif", fontSize:".7em",
                color: isUp ? "#4ade80" : pctChange < 0 ? "#f65e5e" : "#ffffff40"
              }}>
                {isUp ? "▲" : pctChange < 0 ? "▼" : ""} {Math.abs(pctChange).toFixed(1)}%
              </span>
            </div>
          </div>
          {pos && !pos.claimed && (
            <>
              <div style={{ width:1, height:32, background:"#ffffff20", flexShrink:0 }}/>
              <div style={{ whiteSpace:"nowrap" }}>
                <div style={{
                  fontFamily:"'Jersey 25',sans-serif", fontSize:".5em",
                  color:"#ffffff40", marginBottom:2
                }}>YOUR BET</div>
                <div style={{
                  display:"flex", alignItems:"center", gap:4,
                  fontFamily:"'Londrina Solid',sans-serif", fontSize:".9em"
                }}>
                  <span style={{ color: pos.side==="YES" ? "#71baff" : "#a78bfa" }}>
                    {rf.toLocaleString()} {pos.side==="YES" ? "UP" : "DN"}
                  </span>
                  <span style={{
                    fontFamily:"'Jersey 25',sans-serif", fontSize:".7em",
                    color: pnl>=0 ? "#4ade80" : "#f65e5e"
                  }}>
                    {pnl>=0 ? "▲" : "▼"} {pnl>=0 ? "+" : ""}{pnl.toLocaleString()}
                  </span>
                </div>
              </div>
            </>
          )}
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
                onClick={() => { setSide("YES"); setStep("amt"); }}>
                UP
              </button>
              <button style={{ ...bx, background:"#234bc29e", border:"2px solid #c8dbff52" }}
                onClick={() => { setSide("NO"); setStep("amt"); }}>
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
                  style={{ ...bx, background: m.res===pos.side ? "#71baff" : "#00000042" }}
                  onClick={() => onClaim(m.id)}>
                  {m.res===pos.side
                    ? "CLAIM "+Math.round(pos.sh).toLocaleString()
                    : "CLAIM (0)"}
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
        padding:"0 16px", justifyContent:"space-between"
      }}>
        <span style={{
          fontFamily:"'Jersey 25',sans-serif", fontSize:".9em",
          ...gld,
          textShadow:"0 0 10px rgba(250,178,72,0.4), 0 0 20px rgba(250,178,72,0.2)"
        }}>{fT(sec)}</span>
        <div style={{ display:"flex", alignItems:"center", fontSize:".75em" }}>
          <span style={{ fontFamily:"'Jersey 25',sans-serif" }}>
            <span style={gld}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</span>
          </span>
          <span style={{ margin:"0 8px", color:"#72727266" }}>|</span>
          <span style={{ fontFamily:"'Jersey 25',sans-serif" }}>{m.ppl} players</span>
        </div>
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
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [, tick] = useState(0);
  const [memeUser, setMemeUser] = useState(null);
  const [memescore, setMemescore] = useState(0);
  const [authToken, setAuthToken] = useState(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [marketHistory, setMarketHistory] = useState([]);

  // Refresh leaderboard from database
  const refreshLeaderboard = useCallback(async () => {
    const leaders = await loadLeaderboardFromDb();
    if (leaders) setLeaderboard(leaders);
  }, []);
  const [notification, setNotification] = useState(null);
  const initialized = useRef(false);
  const seenResolutions = useRef(new Set());
  const userId = useRef(null);
  const isMobile = useIsMobile();

  // Check for meme.com auth on mount
  useEffect(() => {
    const checkAuth = async () => {
      const auth = getMemeAuth();
      if (!auth) {
        setMemeUser(null);
        setAuthToken(null);
        userId.current = getUserId(null);
        return;
      }

      setAuthToken(auth.token);

      // Fetch user profile
      const user = await fetchMemeUser(auth.token);
      if (user) {
        setMemeUser(user);
        userId.current = getUserId(user.id);

        // Fetch labs balance (includes memescore)
        const balances = await fetchLabsBalance(auth.token);
        setBal(balances.labsBalance);
        setMemescore(balances.memescore);
      }
    };

    checkAuth();
  }, []);

  // Load state on mount - try Supabase first, fallback to localStorage
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const saved = loadState();

    const init = async () => {
      // Ensure user exists in database
      await ensureUserInDb(userId.current, memeUser);

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
      const dbMarkets = await loadMarketsFromDb();
      const dbUser = await loadUserFromDb(userId.current);
      const dbPositions = await loadPositionsFromDb(userId.current);

      if (dbMarkets && dbMarkets.length > 0) {
        // Use shared markets from DB
        const localMks = dbMarkets.map(db => dbMarketToLocal(db, coinMap[db.coin_symbol]));
        setMks(localMks);

        // Load user data from database if available
        if (dbUser) {
          setBal(dbUser.labs_balance ?? 10000);
          setStreak(dbUser.current_streak ?? 0);
          setBestStreak(dbUser.best_streak ?? 0);
        } else if (saved) {
          setBal(saved.bal ?? 10000);
          setStreak(saved.streak || 0);
        }

        // Load positions from database if available
        if (dbPositions && Object.keys(dbPositions).length > 0) {
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
        setBal(saved.bal ?? 10000);
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
      setLoading(false);
    };

    init();
  }, []);

  // Calculate total volume and wins/losses
  const totalVolume = useMemo(() => {
    return Object.values(pos).reduce((s, p) => s + p.inv, 0) + hist.reduce((s, h) => s + h.inv, 0);
  }, [pos, hist]);

  const wins = useMemo(() => hist.filter(h => h.result === h.side).length, [hist]);
  const losses = useMemo(() => hist.filter(h => h.result !== h.side).length, [hist]);

  // Save state whenever it changes
  useEffect(() => {
    if (loading || mks.length === 0) return;
    saveState({ mks, pos, bal, hist, streak, bestStreak, savedAt: Date.now() });

    // Sync user stats to database
    syncUserToDb(userId.current, bal, totalVolume, wins, losses, streak, bestStreak);
  }, [mks, pos, bal, hist, streak, bestStreak, loading, totalVolume, wins, losses]);

  // Real price feed from meme.com API (every 30 seconds)
  useEffect(() => {
    if (mks.length === 0) return;

    const updatePrices = async () => {
      const prices = await fetchPrices(mks.map(m => m.c));
      setMks(p => p.map(m => {
        if (m.st !== "OPEN") return m;
        const data = prices[m.c.sym.toLowerCase()];
        if (data) {
          return { ...m, mc: data.mcap };
        }
        return m;
      }));
      setLastUpdate(new Date());
    };

    updatePrices();
    const i = setInterval(updatePrices, 60000); // 60s to avoid CoinGecko rate limits
    return () => clearInterval(i);
  }, [mks.length]);

  // Periodic leaderboard refresh (every 30 seconds)
  useEffect(() => {
    if (loading) return;
    const i = setInterval(refreshLeaderboard, 30000);
    return () => clearInterval(i);
  }, [loading, refreshLeaderboard]);

  // resolve: UP/DOWN model - resolves at expiry only
  useEffect(() => {
    const i = setInterval(() => {
      const n = Date.now();
      setMks(p => p.map(m => {
        if (m.st!=="OPEN") return m;
        if (n >= m.ea) {
          const resolved = { ...m, st:"RES", res: m.mc > m.startMc ? "YES" : "NO" };
          // Sync resolution to database
          syncMarketToDb(resolved);
          return resolved;
        }
        return m;
      }));
      tick(t => t+1);
    }, 1000);
    return () => clearInterval(i);
  }, []);

  // auto-renew markets after resolution
  useEffect(() => {
    const i = setInterval(() => {
      const newMarkets = [];
      setMks(p => {
        const ids = [];
        const u = p.map(m => {
          if (m.st!=="RES") return m;
          if (!m._r) {
            return { ...m, _r:Date.now() };
          }
          if (Date.now()-m._r < 10000) return m;
          ids.push(m.id);
          const newM = mk({ ...m.c, mcap:m.mc }, m.rn+1);
          newMarkets.push(newM);
          return newM;
        });
        if (ids.length) setPos(pp => {
          const n = { ...pp };
          ids.forEach(id => delete n[id]);
          return n;
        });
        return u;
      });
      // Sync new markets to database
      newMarkets.forEach(m => syncMarketToDb(m));
    }, 2000);
    return () => clearInterval(i);
  }, []);

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
    setBal(b => b - amt);

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
          // Update with server values
          setMks(p => p.map(mk => {
            if (mk.id !== mid) return mk;
            return { ...mk, qY: mk.b + data.new_q_yes, qN: mk.b + data.new_q_no };
          }));
          setBal(data.new_balance);
          // Refresh leaderboard after successful trade
          setTimeout(refreshLeaderboard, 500);
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback to client-side sync
    syncMarketToDb(updatedMarket);
    syncPositionToDb(userId.current, mid, newPosition);
    recordTradeInDb(userId.current, mid, m.c.sym, side, shares, amt, 'BUY');
    // Refresh leaderboard after fallback sync
    setTimeout(refreshLeaderboard, 500);
  }, [mks, pos, refreshLeaderboard]);

  const onSell = useCallback(async (mid) => {
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
    setBal(b => b + rf);

    // Try atomic database function first, fall back to sync
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('labs_sell', {
          p_user_id: userId.current,
          p_market_id: mid
        });
        if (!error && data?.success) {
          // Update with server values
          setMks(p => p.map(mk => {
            if (mk.id !== mid) return mk;
            return { ...mk, qY: mk.b + data.new_q_yes, qN: mk.b + data.new_q_no };
          }));
          // Refresh leaderboard after successful trade
          setTimeout(refreshLeaderboard, 500);
          return;
        }
      } catch (e) {
        console.log("RPC not available, using sync fallback");
      }
    }
    // Fallback to client-side sync
    syncMarketToDb(updatedMarket);
    syncPositionToDb(userId.current, mid, null);
    recordTradeInDb(userId.current, mid, m.c.sym, pp.side, pp.sh, rf, 'SELL', null, pnl);
    // Refresh leaderboard after fallback sync
    setTimeout(refreshLeaderboard, 500);
  }, [pos, mks, refreshLeaderboard]);

  const onClaim = useCallback((mid) => {
    const pp = pos[mid];
    const m = mks.find(x => x.id===mid);
    if (!pp || !m || m.st!=="RES") return;
    const won = m.res===pp.side;
    const rw = won ? Math.round(pp.sh) : 0;
    const pnl = rw - pp.inv;

    setBal(b => b+rw);
    setPos(p => ({ ...p, [mid]:{ ...p[mid], claimed:true }}));
    setHist(h => [...h, { sym:m.c.sym, rn:m.rn, side:pp.side, result:m.res, rw, inv:pp.inv }]);

    // Update streak
    if (won) {
      setStreak(s => {
        const newStreak = s + 1;
        setBestStreak(bs => Math.max(bs, newStreak));
        return newStreak;
      });
    } else {
      setStreak(0);
    }

    // Sync to Supabase
    const claimedPosition = { ...pp, claimed: true };
    syncPositionToDb(userId.current, mid, claimedPosition);
    recordTradeInDb(userId.current, mid, m.c.sym, pp.side, pp.sh, rw, 'CLAIM', m.res, pnl);
  }, [pos, mks]);

  const ranked = [...mks].sort((a,b) => {
    const myA = pos[a.id] ? pos[a.id].inv : 0;
    const myB = pos[b.id] ? pos[b.id].inv : 0;
    if (myA !== myB) return myB - myA;
    return marketPool(b.qY, b.qN, b.b) - marketPool(a.qY, a.qN, a.b);
  });

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
          <style>{`@keyframes slideDown { from { opacity:0; transform:translateX(-50%) translateY(-20px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`}</style>
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
              fontFamily:"'Jersey 25',sans-serif", fontSize:".8em", color:"#ffffff60"
            }}>LABS:</span>}
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

      <div style={{ maxWidth:"72em", margin:"0 auto", padding: isMobile ? "12px 12px 24px" : "20px 2.5% 48px" }}>
        <div style={{ marginBottom: isMobile ? 8 : 16 }}>
          <div style={{
            fontFamily:"'Londrina Solid',sans-serif", fontSize: isMobile ? "1.3em" : "1.6em",
            textTransform:"uppercase", textShadow:"0 2px 4px rgba(0,0,0,.5)"
          }}>Memecoin Arena</div>
          <div style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize: isMobile ? ".75em" : ".9em",
            color:"#ffffff60"
          }}>
            {isMobile ? "24h prediction rounds" : "Predict targets. Vote with conviction on your favorite memes. "}
            {!isMobile && <span style={{ color:"#f7931a" }}>24h rounds</span>}
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
                onBuy={onBuy} onSell={onSell} onClaim={onClaim}
                isMobile={isMobile}/>
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
                borderBottom:"1px solid #ffffff0d"
              }}>CONVICTION BOARD</div>
              {ranked.map((m,i) => (
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
                    }}>${m.c.sym}</div>
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".65em",
                      color:"#ffffff50"
                    }}>{yP(m.qY,m.qN,m.b)}% say UP</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{
                      ...gld, fontFamily:"'Jersey 25',sans-serif"
                    }}>{marketPool(m.qY, m.qN, m.b).toLocaleString()}</div>
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif",
                      fontSize:".6em", color:"#ffffff40"
                    }}>memescore</div>
                  </div>
                </div>
              ))}
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
              }}>TOP TRADERS</div>
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
                  vol: totalVolume,
                  w: wins,
                  l: losses,
                  img: null,
                  isCurrentUser: true
                };
                const leaders = leaderboard
                  .filter(u => u.id !== userId.current)
                  .map(u => ({
                    id: u.id,
                    name: u.username || anonName(u.id),
                    vol: u.total_volume || 0,
                    w: u.wins || 0,
                    l: u.losses || 0,
                    img: u.profile_image,
                    isCurrentUser: false
                  }));
                return [...leaders, currentUser].sort((a,b) => b.vol - a.vol).slice(0,5);
              })().map((p,i) => (
                <div key={p.id || i} style={{
                  display:"flex", alignItems:"center", gap:10,
                  padding:"10px 16px", background:"#191f29",
                  borderBottom:"1px solid #ffffff08"
                }}>
                  <span style={{
                    fontFamily:"'Jersey 25',sans-serif", minWidth:28,
                    color:["#f7931a","#94a3b8","#b45309"][i] || "#ffffff40"
                  }}>#{i+1}</span>
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
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                      color:"#ffffff50"
                    }}>{p.w}W {p.l}L</div>
                  </div>
                  <div style={{
                    ...gld, fontFamily:"'Jersey 25',sans-serif", fontSize:".9em"
                  }}>{p.vol.toLocaleString()}</div>
                </div>
              ))}
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

            {marketHistory.length > 0 && (
              <div style={{
                background:"linear-gradient(360deg,#212936,#4e596c)",
                borderRadius:25, overflow:"hidden"
              }}>
                <div style={{
                  padding:"12px 16px",
                  fontFamily:"'Londrina Solid',sans-serif",
                  textTransform:"uppercase", background:"#191f29",
                  borderBottom:"1px solid #ffffff0d"
                }}>RECENT RESULTS</div>
                {marketHistory.map((m,i) => (
                  <div key={m.id} style={{
                    display:"flex", alignItems:"center", gap:10,
                    padding:"10px 16px", background:"#191f29",
                    borderBottom:"1px solid #ffffff08"
                  }}>
                    <CoinImg src={m.coin_image} color={m.coin_color} size={24} sym={m.coin_symbol}/>
                    <div style={{ flex:1 }}>
                      <div style={{
                        fontFamily:"'Jersey 25',sans-serif", fontSize:".85em"
                      }}>${m.coin_symbol}</div>
                      <div style={{
                        fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
                        color:"#ffffff40"
                      }}>{fM(m.start_mc)} → {fM(m.current_mc)}</div>
                    </div>
                    <span style={{
                      fontFamily:"'Jersey 25',sans-serif",
                      color: m.result==="YES" ? "#b6ffac" : "#f65e5e"
                    }}>{m.result==="YES" ? "UP ↑" : "DOWN ↓"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <DepositModal
        isOpen={showDeposit}
        onClose={() => setShowDeposit(false)}
        onDeposit={(amt, newLabsBal, newMemescore) => {
          setBal(newLabsBal);
          setMemescore(newMemescore);
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
