const { useState, useEffect, useCallback } = React;

const lC = (a,b,B) => { const x=a/B,y=b/B,m=Math.max(x,y); return B*(m+Math.log(Math.exp(x-m)+Math.exp(y-m))); };
const yP = (a,b,B) => { if(!B)return 50; const m=Math.max(a/B,b/B),eA=Math.exp(a/B-m),eB=Math.exp(b/B-m); return Math.min(100,Math.max(0,Math.round(eA/(eA+eB)*100))); };
const sF = (a,b,B,c,s) => { const A=s==="YES"?Math.exp(a/B):Math.exp(b/B),X=s==="YES"?Math.exp(b/B):Math.exp(a/B),p=(Math.exp(c/B)*(A+X)-X)/A; return p>0?B*Math.log(p):0; };
const rF = (a,b,B,sh,s) => { if(sh<=0)return 0; return Math.max(0,Math.round(lC(a,b,B)-(s==="YES"?lC(Math.max(0,a-sh),b,B):lC(a,Math.max(0,b-sh),B)))); };

const COINS = [
  { sym:"JOE", mcap:7.1e6, color:"#f7931a", mul:1.05, img:"https://cdn.meme.com/images/meme_assets/2025-07-16/1752687196279dnFN.png" },
  { sym:"STNK", mcap:6.5e6, color:"#84CC16", mul:1.05, img:"https://cdn.meme.com/images/meme_assets/2025-10-24/17613344323935piQ.png" },
  { sym:"DOGE", mcap:16.4e9, color:"#c2a633", mul:1.05, img:"https://cdn.meme.com/images/meme_assets/2024-04-10/1712777399153FJCg.png" },
  { sym:"PENGU", mcap:422e6, color:"#38BDF8", mul:1.05, img:"https://cdn.meme.com/images-4/meme_assets/2024-12-17/1734446159208EJOa.png" },
  { sym:"PEPE", mcap:1.73e9, color:"#4ADE80", mul:1.05, img:"https://cdn.meme.com/images/meme_assets/2024-04-10/1712779740059DXOD.png" },
];

const fM = v => v>=1e12?"$"+(v/1e12).toFixed(2)+"T":v>=1e9?"$"+(v/1e9).toFixed(2)+"B":v>=1e6?"$"+(v/1e6).toFixed(1)+"M":"$"+(v/1e3).toFixed(0)+"K";
const fT = s => s<=0?"RESOLVING...":String(Math.floor(s/3600)).padStart(2,"0")+":"+String(Math.floor((s%3600)/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
const DUR = 172800;
const gld = { background:"linear-gradient(193deg,#f7931a -49%,#fab248 -14%,#fff1a6 58%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" };

const MUL_MIN = 1.02, MUL_MAX = 1.15;

const mk = (c, r, mul) => {
  const m = mul || c.mul;
  return {
    id:c.sym+"-"+(r||1), c:{...c, mul:m}, rn:r||1, tgt:c.mcap*m, mc:c.mcap,
    qY:0, qN:0, b:c.sym==="DOGE"?1000:c.sym==="PEPE"?800:500,
    st:"OPEN", res:null, ea:Date.now()+DUR*1000, vol:0, ppl:0
  };
};

const CoinImg = ({ src, color, size, sym }) => {
  const s = size||40;
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
      <img src={src} alt="" crossOrigin="anonymous" referrerPolicy="no-referrer"
        style={{
          position:"absolute", inset:0,
          width:"100%", height:"100%", objectFit:"cover", borderRadius:11
        }}
        onError={e => { e.target.style.display="none"; }}/>
      <span style={{ position:"relative", zIndex:0 }}>{(sym||"?")[0]}</span>
    </div>
  );
};

// Conviction: early bets get bonus shares (first 25% of round = 1.5x, first 50% = 1.2x)
const convBonus = (m) => {
  const elapsed = (Date.now() - (m.ea - DUR*1000)) / (DUR*1000);
  if (elapsed < 0.25) return { mul:1.5, label:"EARLY BIRD 1.5x", color:"#f7931a" };
  if (elapsed < 0.5) return { mul:1.2, label:"CONVICTION 1.2x", color:"#71BAFF" };
  return { mul:1, label:null, color:null };
};

// Streak multiplier: 3 wins = 1.5x, 5 = 2x, 10 = 3x
const streakMul = (s) => s >= 10 ? 3 : s >= 5 ? 2 : s >= 3 ? 1.5 : 1;
const streakLabel = (s) => s >= 10 ? "ON FIRE 3x" : s >= 5 ? "HOT STREAK 2x" : s >= 3 ? "STREAK 1.5x" : null;

const Card = ({ m, bal, pos, onBuy, onSell, onClaim, streak }) => {
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
    if (m.st==="RES") setStep("res");
    else if (pos && step==="sel") setStep("pos");
  }, [m.st, pos]);

  const yp = yP(m.qY, m.qN, m.b);
  const np = 100-yp;
  const prog = m.tgt > m.c.mcap ? Math.min(100, Math.max(0, (m.mc - m.c.mcap) / (m.tgt - m.c.mcap) * 100)) : 0;
  const rf = pos ? rF(m.qY, m.qN, m.b, pos.sh, pos.side) : 0;
  const pnl = pos ? rf - pos.inv : 0;
  const conv = convBonus(m);
  const sm = streakMul(streak);

  const doBuy = () => {
    const a = parseInt(amt)||0;
    if (a<=0 || a>bal) return;
    onBuy(m.id, side, a, conv.mul);
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
              fontFamily:"'Jersey 25',sans-serif", fontSize:".7em",
              color:"#ffffff50", textTransform:"uppercase", letterSpacing:".1em"
            }}>${m.c.sym}</div>
            <div style={{
              fontFamily:"'Londrina Solid',sans-serif", fontSize:".875em",
              textTransform:"uppercase",
              textShadow:"0 2px 2px rgba(0,0,0,.25),0 6px 6px rgba(0,0,0,.25)",
              lineHeight:1.2
            }}>WILL ${m.c.sym} HIT {fM(m.tgt)}?</div>
            <div style={{
              fontFamily:"'Jersey 25',sans-serif", fontSize:".6em",
              color:"#ffffff35", marginTop:2
            }}>+{((m.c.mul-1)*100).toFixed(1)}% target · touch to win</div>
          </div>
        </div>

        <div style={{
          display:"flex", justifyContent:"space-between",
          fontFamily:"'Jersey 25',sans-serif", fontSize:".65em",
          color:"#ffffff40", marginBottom:4
        }}>
          <span>NOW: {fM(m.mc)}</span>
          <span>TARGET: {fM(m.tgt)}</span>
        </div>
        <div style={{
          height:4, background:"#0c1018", borderRadius:999,
          overflow:"hidden", marginBottom:10
        }}>
          <div style={{
            height:"100%", borderRadius:999, transition:"width 1s",
            width:prog+"%",
            background: prog>=100
              ? "linear-gradient(90deg,#b6ffac,#53ac52)"
              : "linear-gradient(90deg,#71BAFF,"+m.c.color+")"
          }}/>
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
                YES
              </button>
              <button style={{ ...bx, background:"#234bc29e", border:"2px solid #c8dbff52" }}
                onClick={() => { setSide("NO"); setStep("amt"); }}>
                NO
              </button>
            </div>
          )}

          {step==="amt" && (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <div style={{
                display:"flex", justifyContent:"space-between", alignItems:"center",
                fontFamily:"'Jersey 25',sans-serif", fontSize:".75em"
              }}>
                <div style={{ display:"flex", gap:4 }}>
                  {conv.label && <span style={{
                    background:conv.color+"22", color:conv.color,
                    padding:"2px 8px", borderRadius:8, border:"1px solid "+conv.color+"44"
                  }}>{conv.label}</span>}
                  {sm > 1 && <span style={{
                    background:"#f65e5e22", color:"#f65e5e",
                    padding:"2px 8px", borderRadius:8, border:"1px solid #f65e5e44"
                  }}>{streakLabel(streak)}</span>}
                </div>
                <span style={gld}>BAL: {bal.toLocaleString()}</span>
              </div>
              <input type="number" placeholder="Amount..."
                value={amt} onChange={e => setAmt(e.target.value)} autoFocus
                style={{
                  height:42, border:"1px solid #4c5159", borderRadius:15,
                  textAlign:"center", color:"#fff", background:"transparent",
                  fontFamily:"'Jersey 25',sans-serif", fontSize:"1em", outline:"none"
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
                  BET {side} {amt ? "("+parseInt(amt).toLocaleString()+")" : ""}
                </button>
              </div>
            </div>
          )}

          {step==="pos" && pos && m.st==="OPEN" && (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <div style={{ fontFamily:"'Jersey 25',sans-serif", fontSize:".85em" }}>
                YOUR BET:{" "}
                <span style={{
                  fontFamily:"'Londrina Solid',sans-serif",
                  color: pos.side==="YES" ? "#71baff" : "#4023c3"
                }}>{pos.side}</span>
                {" "} {Math.round(pos.sh)} SHARES{" "}
                <span style={{ color: pnl>=0 ? "#b6ffac" : "#f65e5e" }}>
                  {pnl>=0 ? "+" : ""}{pnl.toLocaleString()}
                </span>
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button style={{ ...bx, background:"#71baff" }}
                  onClick={() => { setSide(pos.side); setStep("amt"); }}>
                  ADD MORE
                </button>
                <button style={{ ...bx, background:"#71baff8a" }}
                  onClick={() => onSell(m.id)}>
                  SELL ({rf.toLocaleString()})
                </button>
              </div>
            </div>
          )}

          {step==="res" && (
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <div style={{
                fontFamily:"'Jersey 25',sans-serif", padding:"12px 16px",
                background:"#242a35", borderRadius:8, textAlign:"center"
              }}>
                {m.res==="YES" ? "TARGET HIT!" : "SURVIVED 48H — NO WINS"}
              </div>
              {pos && !pos.claimed && (
                <div>
                  {m.res===pos.side && sm > 1 && (
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif", fontSize:".7em",
                      textAlign:"center", color:"#f65e5e", marginBottom:4
                    }}>STREAK BONUS {sm}x APPLIED!</div>
                  )}
                  <button
                    style={{ ...bx, background: m.res===pos.side ? "#71baff" : "#00000042" }}
                    onClick={() => onClaim(m.id)}>
                    {m.res===pos.side
                      ? "CLAIM "+Math.round(pos.sh * sm).toLocaleString() + (sm > 1 ? " ("+sm+"x)" : "")
                      : "CLAIM (0)"}
                  </button>
                </div>
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
          fontFamily:"'Jersey 25',sans-serif", fontSize:".9em", color:"#ffffff80"
        }}>{fT(sec)}</span>
        <div style={{ display:"flex", alignItems:"center", fontSize:".75em" }}>
          <span style={{ fontFamily:"'Jersey 25',sans-serif" }}>
            <span style={gld}>{m.vol.toLocaleString()}</span>
          </span>
          <span style={{ margin:"0 8px", color:"#72727266" }}>|</span>
          <span style={{ fontFamily:"'Jersey 25',sans-serif" }}>{m.ppl} players</span>
        </div>
      </div>
    </div>
  );
};

function App() {
  const [mks, setMks] = useState(() => COINS.map(c => mk(c,1)));
  const [pos, setPos] = useState({});
  const [bal, setBal] = useState(10000);
  const [hist, setHist] = useState([]);
  const [hitLog, setHitLog] = useState({}); // {sym: [true,false,true,...]}
  const [streak, setStreak] = useState(0);
  const [, tick] = useState(0);

  // mcap drift (exaggerated for demo — production uses real prices)
  useEffect(() => {
    const i = setInterval(() => setMks(p => p.map(m =>
      m.st!=="OPEN" ? m : { ...m, mc: m.mc*(1+(Math.random()-.47)*.012) }
    )), 2000);
    return () => clearInterval(i);
  }, []);

  // resolve: touch model - YES instantly when target hit, NO at expiry
  useEffect(() => {
    const i = setInterval(() => {
      const n = Date.now();
      setMks(p => p.map(m => {
        if (m.st!=="OPEN") return m;
        if (m.mc >= m.tgt) return { ...m, st:"RES", res:"YES" };
        if (n >= m.ea) return { ...m, st:"RES", res:"NO" };
        return m;
      }));
      tick(t => t+1);
    }, 1000);
    return () => clearInterval(i);
  }, []);

  // auto-renew with dynamic difficulty
  useEffect(() => {
    const i = setInterval(() => setMks(p => {
      const ids = [];
      const u = p.map(m => {
        if (m.st!=="RES") return m;
        if (!m._r) {
          // Log the result for difficulty adjustment
          setHitLog(prev => {
            const log = prev[m.c.sym] || [];
            return { ...prev, [m.c.sym]: [...log.slice(-6), m.res==="YES"] };
          });
          return { ...m, _r:Date.now() };
        }
        if (Date.now()-m._r < 10000) return m;
        // Adjust multiplier based on recent hit rate
        const log = hitLog[m.c.sym] || [];
        const hits = log.filter(Boolean).length;
        const total = log.length;
        let newMul = m.c.mul;
        if (total >= 3) {
          const rate = hits / total;
          if (rate > 0.6) newMul = Math.min(MUL_MAX, newMul * 1.02);
          else if (rate < 0.4) newMul = Math.max(MUL_MIN, newMul * 0.98);
        }
        ids.push(m.id);
        return mk({ ...m.c, mcap:m.mc, mul:newMul }, m.rn+1, newMul);
      });
      if (ids.length) setPos(pp => {
        const n = { ...pp };
        ids.forEach(id => delete n[id]);
        return n;
      });
      return u;
    }), 2000);
    return () => clearInterval(i);
  }, [hitLog]);

  const onBuy = useCallback((mid, side, amt, convMul) => {
    const bonus = convMul || 1;
    setMks(p => p.map(m => {
      if (m.id!==mid || m.st!=="OPEN") return m;
      const sh = sF(m.qY, m.qN, m.b, amt, side) * bonus;
      return {
        ...m,
        qY: side==="YES" ? m.qY+sh : m.qY,
        qN: side==="NO" ? m.qN+sh : m.qN,
        vol: m.vol+amt,
        ppl: m.ppl + (pos[mid] ? 0 : 1)
      };
    }));
    setPos(p => {
      const m = mks.find(x => x.id===mid);
      const sh = sF(m.qY, m.qN, m.b, amt, side) * bonus;
      const e = p[mid];
      if (e && e.side===side) return { ...p, [mid]:{ ...e, sh:e.sh+sh, inv:e.inv+amt }};
      return { ...p, [mid]:{ side, sh, inv:amt, claimed:false }};
    });
    setBal(b => b-amt);
  }, [mks, pos]);

  const onSell = useCallback((mid) => {
    const pp = pos[mid];
    const m = mks.find(x => x.id===mid);
    if (!pp || !m) return;
    const rf = rF(m.qY, m.qN, m.b, pp.sh, pp.side);
    setMks(p => p.map(x => x.id!==mid ? x : {
      ...x,
      qY: pp.side==="YES" ? Math.max(0,x.qY-pp.sh) : x.qY,
      qN: pp.side==="NO" ? Math.max(0,x.qN-pp.sh) : x.qN,
      vol: Math.max(0, x.vol-pp.inv)
    }));
    setPos(p => { const n={...p}; delete n[mid]; return n; });
    setBal(b => b+rf);
  }, [pos, mks]);

  const onClaim = useCallback((mid) => {
    const pp = pos[mid];
    const m = mks.find(x => x.id===mid);
    if (!pp || !m || m.st!=="RES") return;
    const won = m.res===pp.side;
    const sm = streakMul(streak);
    const rw = won ? Math.round(pp.sh * sm) : 0;
    setBal(b => b+rw);
    setStreak(s => won ? s+1 : 0);
    setPos(p => ({ ...p, [mid]:{ ...p[mid], claimed:true }}));
    setHist(h => [...h, { sym:m.c.sym, rn:m.rn, side:pp.side, result:m.res, rw, inv:pp.inv }]);
  }, [pos, mks, streak]);

  const ranked = [...mks].sort((a,b) => b.vol-a.vol);

  return (
    <div style={{
      minHeight:"100vh", background:"#0c1018", color:"#fff",
      fontFamily:"'Mulish',sans-serif"
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Londrina+Solid:wght@400;900&family=Jersey+25&family=Mulish:wght@400;700&display=swap" rel="stylesheet"/>

      <div style={{
        padding:"12px 24px", borderBottom:"1px solid #ffffff0d",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        background:"#0f1620", position:"sticky", top:0, zIndex:10
      }}>
        <div>
          <span style={{
            fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.5em",
            textTransform:"uppercase"
          }}>MEME.COM</span>
          <span style={{
            fontFamily:"'Jersey 25',sans-serif", fontSize:".75em",
            color:"#71BAFF", marginLeft:8
          }}>Predictions V2</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {streak >= 3 && <div style={{
            display:"flex", alignItems:"center", gap:4,
            background:"#f65e5e22", padding:"6px 12px", borderRadius:16,
            border:"1px solid #f65e5e44", fontFamily:"'Jersey 25',sans-serif"
          }}>
            <span style={{ color:"#f65e5e" }}>{streakLabel(streak)}</span>
            <span style={{ fontSize:".7em", color:"#f65e5e88" }}>{streak}W</span>
          </div>}
          <div style={{
            display:"flex", alignItems:"center", gap:6,
            background:"linear-gradient(360deg,#212936,#3a4558)",
            padding:"6px 16px", borderRadius:16, border:"1px solid #ffffff1a",
            fontFamily:"'Jersey 25',sans-serif"
          }}>
            <span style={{ fontSize:".7em", color:"#ffffff80" }}>star</span>
            <span style={gld}>{bal.toLocaleString()}</span>
            <span style={{ fontSize:".7em", color:"#ffffff80" }}>memescore</span>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:"72em", margin:"0 auto", padding:"20px 2.5% 48px" }}>
        <div style={{
          fontFamily:"'Londrina Solid',sans-serif", fontSize:"1.6em",
          textTransform:"uppercase", textShadow:"0 2px 4px rgba(0,0,0,.5)"
        }}>Memecoin Arena</div>
        <div style={{
          fontFamily:"'Jersey 25',sans-serif", fontSize:".9em",
          color:"#ffffff60", marginBottom:16
        }}>
          Predict targets. Vote with conviction on your favorite memes.{" "}
          <span style={{ color:"#f7931a" }}>48h rounds.</span>
        </div>

        <div style={{
          display:"grid", gridTemplateColumns:"1fr 20em",
          gap:20, alignItems:"start"
        }}>
          <div style={{
            display:"grid",
            gridTemplateColumns:"repeat(auto-fill,minmax(17em,1fr))",
            gap:16
          }}>
            {mks.map(m =>
              <Card key={m.id} m={m} bal={bal} streak={streak}
                pos={pos[m.id]||null}
                onBuy={onBuy} onSell={onSell} onClaim={onClaim}/>
            )}
          </div>

          <div style={{
            display:"flex", flexDirection:"column", gap:16,
            position:"sticky", top:60
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
                    }}>{yP(m.qY,m.qN,m.b)}% bullish</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{
                      ...gld, fontFamily:"'Jersey 25',sans-serif"
                    }}>{m.vol.toLocaleString()}</div>
                    <div style={{
                      fontFamily:"'Jersey 25',sans-serif",
                      fontSize:".6em", color:"#ffffff40"
                    }}>memescore</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Player Leaderboard */}
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
              {[
                { name:"supahmarbler", vol:4820, w:7, l:2, img:"https://cdn-v2.meme.com/users/0/6/profile_image_1764242574.jpg" },
                { name:"darkblu3c", vol:3150, w:5, l:3, img:"https://cdn-v2.meme.com/users/0/167/profile_image_1764242580.jpg" },
                { name:"Tyrberg", vol:2700, w:4, l:2, img:"https://cdn-v2.meme.com/users/184/184706/profile_image_1764242596.jpg" },
                { name:"SpaceBlock_", vol:1890, w:3, l:4, img:"https://cdn-v2.meme.com/users/197/197417/profile_image_1765204111.jpg" },
                { name:"You", vol:Object.values(pos).reduce((s,p)=>s+p.inv,0) + hist.reduce((s,h)=>s+h.inv,0), w:hist.filter(h=>h.result===h.side).length, l:hist.filter(h=>h.result!==h.side).length, img:null },
              ].sort((a,b)=>b.vol-a.vol).map((p,i) => (
                <div key={i} style={{
                  display:"flex", alignItems:"center", gap:10,
                  padding:"10px 16px", background: p.name==="You" ? "#191f29" : "#191f29",
                  borderBottom:"1px solid #ffffff08"
                }}>
                  <span style={{
                    fontFamily:"'Jersey 25',sans-serif", minWidth:28,
                    color:["#f7931a","#94a3b8","#b45309"][i] || "#ffffff40"
                  }}>#{i+1}</span>
                  <div style={{
                    width:26, height:26, borderRadius:13, overflow:"hidden",
                    background: p.name==="You" ? "linear-gradient(135deg,#71BAFF,#4023C3)" : "#333",
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
                      color: p.name==="You" ? "#71BAFF" : "#fff"
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
                }}>HISTORY</div>
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
    </div>
  );
}
