/**
 * Bond Vigilante — Backtest v9
 * High-quality price action:
 * - Pin bar (hammer/shooting star) in trend
 * - Significant 20-bar liquidity sweep + strong recovery
 * - Inside bar breakout in strong trend
 * - Engulf in trend
 * Daily consLoss reset, score threshold 5+
 * 3000 bars (~500 days of 4h data)
 */
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config({path:"/root/openclaw-acp/.env"});

const HL_API = "https://api.hyperliquid.xyz/info";
const PAIRS = ["BTC","ETH","SOL"];
const BARS = 3000;
const MS = 14400000;

async function fetchBars(pair: string) {
  const end=Date.now(), start=end-MS*BARS;
  const r = await axios.post(HL_API,{type:"candleSnapshot",req:{coin:pair,interval:"4h",startTime:start,endTime:end}});
  return (r.data??[]).map((c:any)=>({t:+c.t,o:+c.o,h:+c.h,l:+c.l,c:+c.c,v:+c.v}));
}

async function fetchFunding(pair: string) {
  const r = await axios.post(HL_API,{type:"fundingHistory",coin:pair,startTime:Date.now()-MS*BARS});
  const m = new Map<number,number>();
  for(const f of r.data??[]) {
    const b = Math.floor(+f.time/28800000)*28800000;
    m.set(b, parseFloat(f.fundingRate??"0"));
  }
  return m;
}

function getFund(m: Map<number,number>, t: number) {
  const b = Math.floor(t/28800000)*28800000;
  return m.get(b) ?? m.get(b-28800000) ?? 0;
}

function calcEma(bars: any[], p: number) {
  const k=2/(p+1); let e=bars[0].c; const out=[e];
  for(let i=1;i<bars.length;i++) { e=bars[i].c*k+e*(1-k); out.push(e); }
  return out;
}

function calcRsi(bars: any[], p=14) {
  const out=new Array(p).fill(50);
  let g=0, l=0;
  for(let i=1;i<=p;i++) {
    const d=bars[i].c-bars[i-1].c;
    if(d>0) g+=d; else l+=Math.abs(d);
  }
  let ag=g/p, al=l/p;
  out[p]=100-100/(1+ag/Math.max(al,1e-9));
  for(let i=p+1;i<bars.length;i++) {
    const d=bars[i].c-bars[i-1].c;
    ag=(ag*(p-1)+(d>0?d:0))/p;
    al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
    out[i]=100-100/(1+ag/Math.max(al,1e-9));
  }
  return out;
}

function calcAtr(bars: any[], p=14) {
  const tr=bars.map((b:any,i:number)=>
    !i ? b.h-b.l : Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c))
  );
  const out:number[]=[];
  for(let i=0;i<tr.length;i++) {
    if(i<p) { out.push(tr.slice(0,i+1).reduce((a:number,b:number)=>a+b,0)/(i+1)); continue; }
    out.push((out[i-1]*(p-1)+tr[i])/p);
  }
  return out;
}

function hasVolSpike(bars: any[], i: number, mult=1.5) {
  if(i<20) return false;
  const avg = bars.slice(i-20,i).reduce((s:number,b:any)=>s+b.v,0)/20;
  return bars[i].v > avg*mult;
}

// Bull pin bar (hammer): body in top 40%, lower wick > 2x body
function isBullPin(b: any) {
  const range=b.h-b.l; if(range<0.0001) return false;
  const body=Math.abs(b.c-b.o);
  const loWick=Math.min(b.c,b.o)-b.l;
  const hiWick=b.h-Math.max(b.c,b.o);
  return body>range*0.05 && loWick>body*2 && loWick>range*0.38 && hiWick<body*2;
}

// Bear pin bar (shooting star): body in bottom 40%, upper wick > 2x body
function isBearPin(b: any) {
  const range=b.h-b.l; if(range<0.0001) return false;
  const body=Math.abs(b.c-b.o);
  const hiWick=b.h-Math.max(b.c,b.o);
  const loWick=Math.min(b.c,b.o)-b.l;
  return body>range*0.05 && hiWick>body*2 && hiWick>range*0.38 && loWick<body*2;
}

function isBullEngulf(cur: any, prev: any) {
  return cur.c>prev.h && cur.o<=prev.c && cur.c>cur.o;
}
function isBearEngulf(cur: any, prev: any) {
  return cur.c<prev.l && cur.o>=prev.c && cur.c<cur.o;
}

// Significant swing: 20-bar lookback, exclude last 2 bars
function swing20Low(bars: any[], i: number) {
  return Math.min(...bars.slice(Math.max(0,i-20),i-1).map((b:any)=>b.l));
}
function swing20High(bars: any[], i: number) {
  return Math.max(...bars.slice(Math.max(0,i-20),i-1).map((b:any)=>b.h));
}

interface Sig { side:"long"|"short"; setup:string; score:number }

function getSignal(
  bars: any[], i: number,
  rsiArr: number[], e21: number[], e55: number[],
  atrArr: number[], fund: Map<number,number>
): Sig | null {
  if(i<72) return null;
  const c=bars[i], p=bars[i-1], p2=bars[i-2];
  const f=getFund(fund,c.t);
  const r=rsiArr[i];

  const sFund = f < -0.000010;
  const lFund = f >  0.000008;

  // Strict regime: both EMAs trending in same direction
  const emaSlope21up = e21[i]>e21[i-4];
  const emaSlope55up = e55[i]>e55[i-6];
  const emaSlope21dn = e21[i]<e21[i-4];
  const emaSlope55dn = e55[i]<e55[i-6];
  const strongBull = e21[i]>e55[i] && emaSlope21up && emaSlope55up && c.c>e55[i];
  const strongBear = e21[i]<e55[i] && emaSlope21dn && emaSlope55dn && c.c<e55[i];
  const modBull = e21[i]>e55[i] && c.c>e21[i]*0.97;
  const modBear = e21[i]<e55[i] && c.c<e21[i]*1.03;

  const hasVol = hasVolSpike(bars, i, 1.5);
  const hasVolHigh = hasVolSpike(bars, i, 2.0);

  // ══ P1: BULL PIN BAR + CONFIRMATION ══
  if(modBull && isBullPin(p) && c.c > p.h) {
    const rsiOk = r > 35 && r < 68;
    if(rsiOk && !lFund) {
      let sc=4;
      if(hasVol) sc++;
      if(strongBull) sc++;
      if(sFund) sc++;
      if(r < 55) sc++;
      if(sc>=5) return {side:"long", setup:"P1-BullPin", score:sc};
    }
  }

  // ══ P2: BEAR PIN BAR + CONFIRMATION ══
  if(modBear && isBearPin(p) && c.c < p.l) {
    const rsiOk = r > 32 && r < 65;
    if(rsiOk && !sFund) {
      let sc=4;
      if(hasVol) sc++;
      if(strongBear) sc++;
      if(lFund) sc++;
      if(r > 45) sc++;
      if(sc>=5) return {side:"short", setup:"P2-BearPin", score:sc};
    }
  }

  // ══ P3: ENGULF IN TREND ══
  if(modBull && isBullEngulf(c,p) && r<52 && !lFund) {
    let sc=4;
    if(hasVol) sc++;
    if(strongBull) sc++;
    if(sFund) sc++;
    if(sc>=5) return {side:"long", setup:"P3-BullEngulf", score:sc};
  }
  if(modBear && isBearEngulf(c,p) && r>48 && !sFund) {
    let sc=4;
    if(hasVol) sc++;
    if(strongBear) sc++;
    if(lFund) sc++;
    if(sc>=5) return {side:"short", setup:"P3-BearEngulf", score:sc};
  }

  // ══ S4: 20-BAR LIQUIDITY SWEEP ══
  if(modBull) {
    const swL = swing20Low(bars,i);
    const swept = p.l < swL;
    const recovery = c.c > swL && c.c > c.o && c.c > p.c;
    if(swept && recovery && r<58 && !lFund) {
      let sc=5;
      if(hasVol) sc++;
      if(sFund) sc++;
      if(strongBull) sc++;
      return {side:"long", setup:"S4-Sweep", score:sc};
    }
  }
  if(modBear) {
    const swH = swing20High(bars,i);
    const swept = p.h > swH;
    const recovery = c.c < swH && c.c < c.o && c.c < p.c;
    if(swept && recovery && r>42 && !sFund) {
      let sc=5;
      if(hasVol) sc++;
      if(lFund) sc++;
      if(strongBear) sc++;
      return {side:"short", setup:"S4-Sweep", score:sc};
    }
  }

  // ══ S5: INSIDE BAR BREAKOUT ══
  if(strongBull) {
    const isInside = p.h < p2.h && p.l > p2.l;
    const brk = c.c > p2.h && c.c > c.o;
    if(isInside && brk && r<65 && hasVol && !lFund) {
      return {side:"long", setup:"S5-IB", score:5};
    }
  }
  if(strongBear) {
    const isInside = p.h < p2.h && p.l > p2.l;
    const brk = c.c < p2.l && c.c < c.o;
    if(isInside && brk && r>35 && hasVol && !sFund) {
      return {side:"short", setup:"S5-IB", score:5};
    }
  }

  return null;
}

interface Trade { pnlPct:number; won:boolean; score:number; setup:string; side:string; date:string; }

function simulate(bars: any[], fund: Map<number,number>, pair: string) {
  const rsiArr=calcRsi(bars), e21=calcEma(bars,21), e55=calcEma(bars,55), atrArr=calcAtr(bars);
  const trades:Trade[]=[];
  let pos: {
    entry:number; side:"long"|"short"; sl:number; tp:number;
    score:number; setup:string; partial:boolean; atrE:number;
  }|null=null;
  let dailyPnl=0, dayStr="", consDay=0, totalSeen=0;
  const lev = pair==="SOL" ? 2.5 : 3;

  for(let i=72; i<bars.length; i++) {
    const bar=bars[i], today=new Date(bar.t).toISOString().slice(0,10);
    if(today!==dayStr) { dailyPnl=0; dayStr=today; consDay=0; }

    if(pos) {
      const {entry, side, atrE} = pos;
      if(!pos.partial) {
        const tp1 = side==="long" ? entry+atrE : entry-atrE;
        if((side==="long"&&bar.h>=tp1)||(side==="short"&&bar.l<=tp1)) {
          pos.partial=true; pos.sl=entry;
        }
      }
      let exit:number|null=null;
      if(side==="long") { if(bar.l<=pos.sl) exit=pos.sl; else if(bar.h>=pos.tp) exit=pos.tp; }
      else { if(bar.h>=pos.sl) exit=pos.sl; else if(bar.l<=pos.tp) exit=pos.tp; }
      if(exit!==null) {
        const raw=(side==="long"?(exit-entry)/entry:(entry-exit)/entry);
        const pnlPct=raw*lev*100;
        dailyPnl+=pnlPct;
        if(pnlPct<=0) consDay++;
        trades.push({pnlPct, won:pnlPct>0, score:pos.score, setup:pos.setup, side, date:today});
        pos=null;
      }
    }

    if(dailyPnl<-3 || consDay>=2 || pos) continue;
    const sig = getSignal(bars,i,rsiArr,e21,e55,atrArr,fund);
    if(!sig || sig.score<5) continue;
    totalSeen++;

    const atrV=atrArr[i], entry=bar.c;
    let slM=1.1, tpM=2.2;
    if(sig.setup.startsWith("S4")) { slM=0.9; tpM=2.5; }
    if(sig.setup.startsWith("S5")) { slM=0.8; tpM=2.0; }

    const sl = sig.side==="long" ? entry-atrV*slM : entry+atrV*slM;
    const tp = sig.side==="long" ? entry+atrV*tpM : entry-atrV*tpM;
    pos = {entry, side:sig.side, sl, tp, score:sig.score, setup:sig.setup, partial:false, atrE:atrV};
  }
  return {trades, totalSeen};
}

function calcMetrics(trades: Trade[], seen: number) {
  if(!trades.length) return {trades:0,seen,winRate:"0%",returnPct:"0%",pf:"—",sortino:"—",maxDD:"0%",avgScore:"—",setupBreakdown:"none"};
  const wins=trades.filter(t=>t.won);
  const gross=wins.reduce((s,t)=>s+t.pnlPct,0);
  const loss=Math.abs(trades.filter(t=>!t.won).reduce((s,t)=>s+t.pnlPct,0));
  const ret=trades.reduce((s,t)=>s+t.pnlPct,0);
  const pf=loss>0?(gross/loss):9.99;
  const mean=ret/trades.length;
  const neg=trades.filter(t=>t.pnlPct<0).map(t=>t.pnlPct-mean);
  const dDev=neg.length?Math.sqrt(neg.reduce((a,b)=>a+b*b,0)/neg.length):0.001;
  let eq=1, peak=1, maxDD=0;
  for(const t of trades) {
    eq*=(1+t.pnlPct/100);
    if(eq>peak) peak=eq;
    const dd=(peak-eq)/peak;
    if(dd>maxDD) maxDD=dd;
  }
  const sc:Record<string,{w:number;t:number}>={};
  for(const t of trades) {
    if(!sc[t.setup]) sc[t.setup]={w:0,t:0};
    sc[t.setup].t++;
    if(t.won) sc[t.setup].w++;
  }
  return {
    trades:trades.length, seen,
    winRate:((wins.length/trades.length)*100).toFixed(0)+"%",
    returnPct:ret.toFixed(1)+"%",
    pf:pf.toFixed(2),
    sortino:(mean/dDev).toFixed(2),
    maxDD:(maxDD*100).toFixed(2)+"%",
    avgScore:(trades.reduce((s,t)=>s+t.score,0)/trades.length).toFixed(1),
    setupBreakdown:Object.entries(sc).map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`).join(" | ")
  };
}

async function main() {
  console.log("\n📊 Bond Vigilante v9 — Pin Bar + 20-Bar Sweep + Inside Break\n");
  console.log("Pair    Trades  WR%    Return%   PF      Sortino  MaxDD   Setups");
  console.log("─".repeat(105));
  let all:Trade[]=[], totalSeen=0;
  for(const pair of PAIRS) {
    try {
      const [bars,fund] = await Promise.all([fetchBars(pair), fetchFunding(pair)]);
      const {trades, totalSeen:seen} = simulate(bars, fund, pair);
      const m = calcMetrics(trades, seen);
      all=[...all,...trades]; totalSeen+=seen;
      console.log(
        pair.padEnd(8)+String(m.trades).padEnd(8)+String(m.winRate).padEnd(7)+
        String(m.returnPct).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
        String(m.maxDD).padEnd(8)+m.setupBreakdown
      );
    } catch(e:any) { console.log(pair.padEnd(8)+"ERROR: "+e.message); }
  }
  console.log("─".repeat(105));
  const m=calcMetrics(all,totalSeen);
  console.log(
    "TOTAL".padEnd(8)+String(m.trades).padEnd(8)+String(m.winRate).padEnd(7)+
    String(m.returnPct).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
    String(m.maxDD).padEnd(8)+m.setupBreakdown
  );
  console.log(`\n🎯 LB Target: WR >55%, PF >2.5, Sortino >0.8, Return >40%`);
  console.log(`   Result:    WR ${m.winRate}, PF ${m.pf}, Sortino ${m.sortino}, Return ${m.returnPct}\n`);
}
main().catch(console.error);
