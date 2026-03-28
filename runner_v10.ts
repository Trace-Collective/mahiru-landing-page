/**
 * Bond Vigilante — Backtest v10
 * Clean rebuild:
 * - NO partial TP (cleaner WR math)
 * - SL = 1.0x ATR, TP = 2.0x ATR (simpler 1:2 R:R)
 * - Random baseline WR ≈ 33% (need 50%+ for edge)
 * - strictBull/strictBear only (no mod regimes)
 * - Debug mode shows raw signal quality without risk filters
 */
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config({path:"/root/openclaw-acp/.env"});

const HL_API = "https://api.hyperliquid.xyz/info";
const PAIRS  = ["BTC","ETH","SOL"];
const BARS   = 3000;
const MS     = 14400000;

// ─── Data fetch ───────────────────────────────────────────
async function fetchBars(pair: string) {
  const end=Date.now(), start=end-MS*BARS;
  const r = await axios.post(HL_API,{type:"candleSnapshot",req:{coin:pair,interval:"4h",startTime:start,endTime:end}});
  return (r.data??[]).map((c:any)=>({t:+c.t,o:+c.o,h:+c.h,l:+c.l,c:+c.c,v:+c.v}));
}

async function fetchFunding(pair: string) {
  const r = await axios.post(HL_API,{type:"fundingHistory",coin:pair,startTime:Date.now()-MS*BARS});
  const m = new Map<number,number>();
  for(const f of r.data??[]) m.set(Math.floor(+f.time/28800000)*28800000, parseFloat(f.fundingRate??"0"));
  return m;
}

function getFund(m: Map<number,number>, t: number) {
  const b=Math.floor(t/28800000)*28800000; return m.get(b) ?? m.get(b-28800000) ?? 0;
}

// ─── Indicators ───────────────────────────────────────────
function calcEma(bars: any[], p: number) {
  const k=2/(p+1); let e=bars[0].c; const out=[e];
  for(let i=1;i<bars.length;i++) { e=bars[i].c*k+e*(1-k); out.push(e); }
  return out;
}

function calcRsi(bars: any[], p=14) {
  const out=new Array(p).fill(50); let g=0,l=0;
  for(let i=1;i<=p;i++){const d=bars[i].c-bars[i-1].c; d>0?g+=d:l+=Math.abs(d);}
  let ag=g/p, al=l/p;
  out[p]=100-100/(1+ag/Math.max(al,1e-9));
  for(let i=p+1;i<bars.length;i++){
    const d=bars[i].c-bars[i-1].c;
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
    out[i]=100-100/(1+ag/Math.max(al,1e-9));
  }
  return out;
}

function calcAtr(bars: any[], p=14) {
  const tr=bars.map((b:any,i:number)=>!i?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)));
  const out:number[]=[];
  for(let i=0;i<tr.length;i++){
    if(i<p){out.push(tr.slice(0,i+1).reduce((a:number,b:number)=>a+b,0)/(i+1));continue;}
    out.push((out[i-1]*(p-1)+tr[i])/p);
  }
  return out;
}

function volMult(bars: any[], i: number) {
  if(i<20) return 1;
  return bars[i].v / (bars.slice(i-20,i).reduce((s:number,b:any)=>s+b.v,0)/20);
}

// ─── Regime ───────────────────────────────────────────────
// Strict: BOTH EMAs slope same direction, price on correct side
function regime(e21: number[], e55: number[], price: number, i: number): "bull"|"bear"|"none" {
  const bull21 = e21[i]>e21[i-3];
  const bull55 = e55[i]>e55[i-5];
  const bear21 = e21[i]<e21[i-3];
  const bear55 = e55[i]<e55[i-5];
  if(e21[i]>e55[i] && bull21 && bull55 && price>e55[i]) return "bull";
  if(e21[i]<e55[i] && bear21 && bear55 && price<e55[i]) return "bear";
  return "none";
}

// ─── Patterns ─────────────────────────────────────────────
function isBullPin(b: any) {
  const range=b.h-b.l; if(range<0.001) return false;
  const body=Math.abs(b.c-b.o);
  const loWick=Math.min(b.c,b.o)-b.l;
  const hiWick=b.h-Math.max(b.c,b.o);
  return body>range*0.04 && loWick>body*1.8 && loWick>range*0.35 && hiWick<body*2.5;
}

function isBearPin(b: any) {
  const range=b.h-b.l; if(range<0.001) return false;
  const body=Math.abs(b.c-b.o);
  const hiWick=b.h-Math.max(b.c,b.o);
  const loWick=Math.min(b.c,b.o)-b.l;
  return body>range*0.04 && hiWick>body*1.8 && hiWick>range*0.35 && loWick<body*2.5;
}

// ─── Signal engine ────────────────────────────────────────
interface Sig { side:"long"|"short"; setup:string; score:number }

function getSignal(
  bars: any[], i: number,
  rsiArr: number[], e21: number[], e55: number[],
  atrArr: number[], fund: Map<number,number>
): Sig | null {
  if(i<72) return null;
  const c=bars[i], p=bars[i-1], p2=bars[i-2];
  const r=rsiArr[i];
  const f=getFund(fund,c.t);
  const vm=volMult(bars,i);
  const reg=regime(e21,e55,c.c,i);
  if(reg==="none") return null;

  const sFund=f<-0.000010;
  const lFund=f>0.000008;

  const isBull = reg==="bull";
  const isBear = reg==="bear";

  // ── Signal 1: EMA21 Touch + Bounce ──
  // Price briefly touched EMA21 (prev bar's low within EMA), now recovering
  if(isBull) {
    const ema21val = e21[i-1];
    const touched = p.l <= ema21val*1.008 && p.l >= ema21val*0.985;
    const bounce = c.c > ema21val && c.c > c.o && c.c > p.c;
    if(touched && bounce && r>38 && r<65 && vm>1.3 && !lFund) {
      let sc=4; if(vm>1.8)sc++; if(sFund)sc++; if(r<52)sc++;
      return {side:"long",setup:"E1-EMABounce",score:sc};
    }
  }
  if(isBear) {
    const ema21val = e21[i-1];
    const touched = p.h >= ema21val*0.992 && p.h <= ema21val*1.015;
    const bounce = c.c < ema21val && c.c < c.o && c.c < p.c;
    if(touched && bounce && r>35 && r<62 && vm>1.3 && !sFund) {
      let sc=4; if(vm>1.8)sc++; if(lFund)sc++; if(r>48)sc++;
      return {side:"short",setup:"E1-EMABounce",score:sc};
    }
  }

  // ── Signal 2: Pin Bar Confirmation ──
  if(isBull && isBullPin(p)) {
    const confirm = c.c > p.h && c.c > c.o;
    if(confirm && r<65 && vm>1.4 && !lFund) {
      let sc=5; if(vm>2.0)sc++; if(sFund)sc++;
      return {side:"long",setup:"P2-PinBar",score:sc};
    }
  }
  if(isBear && isBearPin(p)) {
    const confirm = c.c < p.l && c.c < c.o;
    if(confirm && r>35 && vm>1.4 && !sFund) {
      let sc=5; if(vm>2.0)sc++; if(lFund)sc++;
      return {side:"short",setup:"P2-PinBar",score:sc};
    }
  }

  // ── Signal 3: 20-Bar Sweep ──
  {
    const sl20=Math.min(...bars.slice(Math.max(0,i-20),i-1).map((b:any)=>b.l));
    const sh20=Math.max(...bars.slice(Math.max(0,i-20),i-1).map((b:any)=>b.h));
    if(isBull && p.l<sl20) {
      const reclaim = c.c > sl20 && c.c > c.o && c.c > p.c;
      if(reclaim && r<60 && vm>1.3 && !lFund) {
        let sc=5; if(vm>1.8)sc++; if(sFund)sc++;
        return {side:"long",setup:"S3-Sweep",score:sc};
      }
    }
    if(isBear && p.h>sh20) {
      const reclaim = c.c < sh20 && c.c < c.o && c.c < p.c;
      if(reclaim && r>40 && vm>1.3 && !sFund) {
        let sc=5; if(vm>1.8)sc++; if(lFund)sc++;
        return {side:"short",setup:"S3-Sweep",score:sc};
      }
    }
  }

  // ── Signal 4: Inside Bar Breakout ──
  if(isBull) {
    const inside = p.h<p2.h && p.l>p2.l;
    const brk = c.c>p2.h && c.c>c.o;
    if(inside && brk && r<68 && vm>1.8 && !lFund) {
      return {side:"long",setup:"B4-IB",score:5};
    }
  }
  if(isBear) {
    const inside = p.h<p2.h && p.l>p2.l;
    const brk = c.c<p2.l && c.c<c.o;
    if(inside && brk && r>32 && vm>1.8 && !sFund) {
      return {side:"short",setup:"B4-IB",score:5};
    }
  }

  return null;
}

// ─── Simulate ─────────────────────────────────────────────
interface Trade { pnlPct:number; won:boolean; setup:string; side:string; date:string; }

function simulate(bars: any[], fund: Map<number,number>, pair: string, noRiskMgmt=false) {
  const rsiArr=calcRsi(bars), e21=calcEma(bars,21), e55=calcEma(bars,55), atrArr=calcAtr(bars);
  const trades:Trade[]=[];
  let pos:{entry:number;side:"long"|"short";sl:number;tp:number;setup:string}|null=null;
  let dailyPnl=0, dayStr="", consDay=0;
  const lev = pair==="SOL" ? 2.5 : 3;

  for(let i=72; i<bars.length; i++) {
    const bar=bars[i], today=new Date(bar.t).toISOString().slice(0,10);
    if(today!==dayStr) { dailyPnl=0; dayStr=today; consDay=0; }

    if(pos) {
      const {entry, side} = pos;
      let exit:number|null=null;
      // CLEAN exit: just SL and TP, no partial
      if(side==="long") {
        if(bar.l <= pos.sl) exit=pos.sl;
        else if(bar.h >= pos.tp) exit=pos.tp;
      } else {
        if(bar.h >= pos.sl) exit=pos.sl;
        else if(bar.l <= pos.tp) exit=pos.tp;
      }
      if(exit!==null) {
        const raw=(side==="long"?(exit-entry)/entry:(entry-exit)/entry);
        const pnlPct=raw*lev*100;
        dailyPnl+=pnlPct;
        if(pnlPct<0) consDay++;
        trades.push({pnlPct, won:pnlPct>0, setup:pos.setup, side, date:today});
        pos=null;
      }
    }

    // Risk management (skip in noRiskMgmt mode)
    if(!noRiskMgmt && (dailyPnl<-3 || consDay>=2 || pos)) continue;
    if(noRiskMgmt && pos) continue;

    const sig=getSignal(bars,i,rsiArr,e21,e55,atrArr,fund);
    if(!sig) continue;

    const atrV=atrArr[i], entry=bar.c;
    // Clean 1:2 R:R (no partial TP)
    const slM=1.0, tpM=2.0;
    const sl = sig.side==="long" ? entry-atrV*slM : entry+atrV*slM;
    const tp = sig.side==="long" ? entry+atrV*tpM : entry-atrV*tpM;
    pos={entry, side:sig.side, sl, tp, setup:sig.setup};
  }
  return trades;
}

// ─── Metrics ──────────────────────────────────────────────
function calcMetrics(trades: Trade[]) {
  if(!trades.length) return {n:0,wr:"0%",ret:"0%",pf:"—",sortino:"—",dd:"0%",setups:"none"};
  const wins=trades.filter(t=>t.won);
  const gross=wins.reduce((s,t)=>s+t.pnlPct,0);
  const loss=Math.abs(trades.filter(t=>!t.won).reduce((s,t)=>s+t.pnlPct,0));
  const ret=trades.reduce((s,t)=>s+t.pnlPct,0);
  const pf=loss>0?(gross/loss):9.99;
  const mean=ret/trades.length;
  const neg=trades.filter(t=>t.pnlPct<0).map(t=>t.pnlPct-mean);
  const dDev=neg.length?Math.sqrt(neg.reduce((a,b)=>a+b*b,0)/neg.length):0.001;
  let eq=1,peak=1,maxDD=0;
  for(const t of trades){eq*=(1+t.pnlPct/100);if(eq>peak)peak=eq;const dd=(peak-eq)/peak;if(dd>maxDD)maxDD=dd;}
  const sc:Record<string,{w:number;t:number}>={};
  for(const t of trades){if(!sc[t.setup])sc[t.setup]={w:0,t:0};sc[t.setup].t++;if(t.won)sc[t.setup].w++;}
  return {
    n:trades.length,
    wr:((wins.length/trades.length)*100).toFixed(0)+"%",
    ret:ret.toFixed(1)+"%",
    pf:pf.toFixed(2),
    sortino:(mean/dDev).toFixed(2),
    dd:(maxDD*100).toFixed(2)+"%",
    setups:Object.entries(sc).map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`).join(" | ")
  };
}

// ─── Main ─────────────────────────────────────────────────
async function main() {
  const debug = process.argv.includes("--debug");
  console.log("\n📊 Bond Vigilante v10 — Clean 1:2 R:R, StrictRegime\n");
  console.log("Pair    Trades  WR%    Return%   PF      Sortino  MaxDD   Setups");
  console.log("─".repeat(105));

  let all:Trade[]=[], allRaw:Trade[]=[];

  for(const pair of PAIRS) {
    try {
      const [bars,fund] = await Promise.all([fetchBars(pair), fetchFunding(pair)]);
      const managed = simulate(bars,fund,pair,false);
      const raw      = simulate(bars,fund,pair,true);
      const m = calcMetrics(managed);
      const mr = calcMetrics(raw);
      all=[...all,...managed]; allRaw=[...allRaw,...raw];
      console.log(
        pair.padEnd(8)+String(m.n).padEnd(8)+String(m.wr).padEnd(7)+
        String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
        String(m.dd).padEnd(8)+m.setups
      );
      if(debug) console.log(`  [raw/${pair}] n=${mr.n} WR=${mr.wr} Ret=${mr.ret} PF=${mr.pf} | ${mr.setups}`);
    } catch(e:any) { console.log(pair.padEnd(8)+"ERROR: "+e.message); }
  }

  console.log("─".repeat(105));
  const m  = calcMetrics(all);
  const mr = calcMetrics(allRaw);
  console.log(
    "TOTAL".padEnd(8)+String(m.n).padEnd(8)+String(m.wr).padEnd(7)+
    String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
    String(m.dd).padEnd(8)+m.setups
  );
  if(debug||allRaw.length>0) {
    console.log(`\n  [RAW unfiltered] n=${mr.n} WR=${mr.wr} Ret=${mr.ret} PF=${mr.pf} | ${mr.setups}`);
  }
  console.log(`\n🎯 LB Target: WR >55%, PF >2.5, Sortino >0.8`);
  console.log(`   Result:    WR ${m.wr}, PF ${m.pf}, Sortino ${m.sortino}, Return ${m.ret}\n`);
  console.log(`   Note: 1:2 R:R random baseline = 33% WR. Edge above 33% = signal quality.\n`);
}
main().catch(console.error);
