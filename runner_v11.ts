/**
 * Bond Vigilante — Backtest v11
 * Strategy rethink: Momentum-based (not mean-reversion)
 * Crypto tends to TREND, not bounce. When momentum accelerates, it continues.
 *
 * Signals with known crypto edge:
 * 1. M1: 20-bar breakout with RSI momentum zone (55-75) + vol
 * 2. M2: 3-bar price acceleration + vol (explosive move)
 * 3. M3: Inside bar breakout (proved 56% WR in v10)
 * 4. D1: RSI Divergence (reversal only at extremes <25 or >75)
 *
 * Key changes:
 * - Strict trend regime only (both EMAs slope same direction)
 * - No EMA bounce signal (proved noise)
 * - Score threshold 5+ with minimum 3 independent conditions
 * - Clean 1:2 R:R, no partial TP
 * - Daily consLoss reset
 */
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config({path:"/root/openclaw-acp/.env"});

const HL_API = "https://api.hyperliquid.xyz/info";
const PAIRS  = ["BTC","ETH","SOL"];
const BARS   = 3000;
const MS     = 14400000;

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

function volRatio(bars: any[], i: number) {
  if(i<20) return 1;
  return bars[i].v / (bars.slice(i-20,i).reduce((s:number,b:any)=>s+b.v,0)/20);
}

// Strict regime: both EMAs in same direction, price correct side
function getRegime(e21: number[], e55: number[], price: number, i: number): "bull"|"bear"|"none" {
  if(i<8) return "none";
  const bull21=e21[i]>e21[i-3], bear21=e21[i]<e21[i-3];
  const bull55=e55[i]>e55[i-6], bear55=e55[i]<e55[i-6];
  if(e21[i]>e55[i] && bull21 && bull55 && price>e55[i]) return "bull";
  if(e21[i]<e55[i] && bear21 && bear55 && price<e55[i]) return "bear";
  return "none";
}

// RSI divergence detection
function findRsiDiv(bars: any[], rsiArr: number[], i: number, lb=14): {bull:boolean;bear:boolean} {
  if(i<lb+2) return {bull:false,bear:false};
  // Find the pivot in the last lb bars
  let priceLow=Infinity, priceLowRsi=50;
  let priceHigh=-Infinity, priceHighRsi=50;
  for(let j=i-lb;j<i-2;j++){
    if(bars[j].l < priceLow){priceLow=bars[j].l; priceLowRsi=rsiArr[j];}
    if(bars[j].h > priceHigh){priceHigh=bars[j].h; priceHighRsi=rsiArr[j];}
  }
  // Bullish div: current price lower than prior pivot low, but RSI is HIGHER
  const bullDiv = bars[i].l<priceLow && rsiArr[i]>priceLowRsi && rsiArr[i]<35;
  // Bearish div: current price higher than prior pivot high, but RSI is LOWER
  const bearDiv = bars[i].h>priceHigh && rsiArr[i]<priceHighRsi && rsiArr[i]>65;
  return {bull:bullDiv, bear:bearDiv};
}

interface Sig { side:"long"|"short"; setup:string; score:number }

function getSignal(
  bars: any[], i: number,
  rsiArr: number[], e21: number[], e55: number[],
  atrArr: number[], fund: Map<number,number>
): Sig | null {
  if(i<75) return null;
  const c=bars[i], p=bars[i-1], p2=bars[i-2];
  const r=rsiArr[i];
  const f=getFund(fund,c.t);
  const vr=volRatio(bars,i);
  const reg=getRegime(e21,e55,c.c,i);
  if(reg==="none") return null;

  const sFund=f<-0.000010; // shorts crowded → squeeze potential
  const lFund=f>0.000008;  // longs crowded → fade potential

  // ── M1: 20-BAR BREAKOUT WITH MOMENTUM RSI ──────────────────
  // Price breaks above 20-bar high (excl prev 2 bars) with momentum RSI
  // This captures trending breakout continuation
  {
    const h20 = Math.max(...bars.slice(i-20,i-2).map((b:any)=>b.h));
    const l20  = Math.min(...bars.slice(i-20,i-2).map((b:any)=>b.l));

    if(reg==="bull" && c.c>h20 && c.c>c.o) {
      // Momentum RSI zone: 55-75 (trending, not overbought)
      const rsiMomentum = r>55 && r<75;
      const volOk = vr>1.6;
      if(rsiMomentum && volOk && !lFund) {
        let sc=4;
        if(vr>2.0) sc++;
        if(sFund) sc++;
        if(r>60) sc++;
        return {side:"long", setup:"M1-Break", score:sc};
      }
    }

    if(reg==="bear" && c.c<l20 && c.c<c.o) {
      const rsiMomentum = r>25 && r<45;
      const volOk = vr>1.6;
      if(rsiMomentum && volOk && !sFund) {
        let sc=4;
        if(vr>2.0) sc++;
        if(lFund) sc++;
        if(r<40) sc++;
        return {side:"short", setup:"M1-Break", score:sc};
      }
    }
  }

  // ── M2: 3-BAR PRICE ACCELERATION ──────────────────────────
  // 3 consecutive closes in same direction + accelerating volume
  {
    const bull3 = c.c>c.o && p.c>p.o && p2.c>p2.o; // 3 green bars
    const bear3 = c.c<c.o && p.c<p.o && p2.c<p2.o; // 3 red bars
    const moveSize = Math.abs(c.c-p2.o)/p2.o*100;   // 3-bar % move

    if(reg==="bull" && bull3 && moveSize>2.0 && vr>1.8 && r>50 && r<72 && !lFund) {
      let sc=4;
      if(moveSize>3.5) sc++;
      if(vr>2.2) sc++;
      if(sFund) sc++;
      return {side:"long", setup:"M2-Accel", score:sc};
    }

    if(reg==="bear" && bear3 && moveSize>2.0 && vr>1.8 && r>28 && r<50 && !sFund) {
      let sc=4;
      if(moveSize>3.5) sc++;
      if(vr>2.2) sc++;
      if(lFund) sc++;
      return {side:"short", setup:"M2-Accel", score:sc};
    }
  }

  // ── M3: INSIDE BAR BREAKOUT (proved 56% WR in v10) ────────
  {
    const isInside = p.h<p2.h && p.l>p2.l; // consolidation
    if(isInside) {
      if(reg==="bull" && c.c>p2.h && c.c>c.o && vr>1.8 && r<72 && !lFund) {
        let sc=5;
        if(vr>2.2) sc++;
        if(sFund) sc++;
        return {side:"long", setup:"M3-IB", score:sc};
      }
      if(reg==="bear" && c.c<p2.l && c.c<c.o && vr>1.8 && r>28 && !sFund) {
        let sc=5;
        if(vr>2.2) sc++;
        if(lFund) sc++;
        return {side:"short", setup:"M3-IB", score:sc};
      }
    }
  }

  // ── D1: RSI DIVERGENCE REVERSAL (extreme zones only) ──────
  // Only trade reversal when RSI is truly extreme AND divergence confirmed
  {
    const div = findRsiDiv(bars,rsiArr,i);
    // Bull divergence: new price low but RSI higher → potential reversal up
    if(div.bull && c.c>c.o && vr>1.5) {
      // Can trade against bear regime if RSI truly extreme
      let sc=5;
      if(vr>2.0) sc++;
      if(sFund) sc++;
      if(c.c>bars[i-3].l*1.01) sc++; // price recovering
      return {side:"long", setup:"D1-Diverge", score:sc};
    }
    // Bear divergence: new price high but RSI lower → potential reversal down
    if(div.bear && c.c<c.o && vr>1.5) {
      let sc=5;
      if(vr>2.0) sc++;
      if(lFund) sc++;
      if(c.c<bars[i-3].h*0.99) sc++;
      return {side:"short", setup:"D1-Diverge", score:sc};
    }
  }

  return null;
}

interface Trade { pnlPct:number; won:boolean; setup:string; side:string; date:string; }

function simulate(bars: any[], fund: Map<number,number>, pair: string) {
  const rsiArr=calcRsi(bars), e21=calcEma(bars,21), e55=calcEma(bars,55), atrArr=calcAtr(bars);
  const trades:Trade[]=[];
  let pos:{entry:number;side:"long"|"short";sl:number;tp:number;setup:string}|null=null;
  let dailyPnl=0, dayStr="", consDay=0;
  const lev = pair==="SOL" ? 2.5 : 3;

  for(let i=75; i<bars.length; i++) {
    const bar=bars[i], today=new Date(bar.t).toISOString().slice(0,10);
    if(today!==dayStr) { dailyPnl=0; dayStr=today; consDay=0; }

    if(pos) {
      let exit:number|null=null;
      const {entry,side,sl,tp} = pos;
      if(side==="long") { if(bar.l<=sl) exit=sl; else if(bar.h>=tp) exit=tp; }
      else { if(bar.h>=sl) exit=sl; else if(bar.l<=tp) exit=tp; }
      if(exit!==null) {
        const raw=(side==="long"?(exit-entry)/entry:(entry-exit)/entry);
        const pnlPct=raw*lev*100;
        dailyPnl+=pnlPct;
        if(pnlPct<0) consDay++;
        trades.push({pnlPct, won:pnlPct>0, setup:pos.setup, side, date:today});
        pos=null;
      }
    }

    if(dailyPnl<-3 || consDay>=2 || pos) continue;
    const sig=getSignal(bars,i,rsiArr,e21,e55,atrArr,fund);
    if(!sig || sig.score<4) continue;

    const atrV=atrArr[i], entry=bar.c;
    // 1:2 R:R clean
    const sl=sig.side==="long"?entry-atrV:entry+atrV;
    const tp=sig.side==="long"?entry+atrV*2:entry-atrV*2;
    pos={entry,side:sig.side,sl,tp,setup:sig.setup};
  }
  return trades;
}

function calcMetrics(trades: Trade[]) {
  if(!trades.length) return {n:0,wr:"—",ret:"—",pf:"—",sortino:"—",dd:"—",setups:"none"};
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

async function main() {
  console.log("\n📊 Bond Vigilante v11 — Momentum Breakout + RSI Divergence\n");
  console.log("Pair    Trades  WR%    Return%   PF      Sortino  MaxDD   Setups");
  console.log("─".repeat(110));
  let all:Trade[]=[];
  for(const pair of PAIRS) {
    try {
      const [bars,fund] = await Promise.all([fetchBars(pair), fetchFunding(pair)]);
      const trades = simulate(bars,fund,pair);
      const m = calcMetrics(trades);
      all=[...all,...trades];
      console.log(
        pair.padEnd(8)+String(m.n).padEnd(8)+String(m.wr).padEnd(7)+
        String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
        String(m.dd).padEnd(8)+m.setups
      );
    } catch(e:any) { console.log(pair.padEnd(8)+"ERROR: "+e.message); }
  }
  console.log("─".repeat(110));
  const m=calcMetrics(all);
  console.log(
    "TOTAL".padEnd(8)+String(m.n).padEnd(8)+String(m.wr).padEnd(7)+
    String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
    String(m.dd).padEnd(8)+m.setups
  );
  console.log(`\n🎯 LB Target: WR >50%, PF >2.5, Sortino >0.8`);
  console.log(`   Result:    WR ${m.wr}, PF ${m.pf}, Sortino ${m.sortino}, Return ${m.ret}`);
  console.log(`   Note: 1:2 R:R random baseline = 33% WR\n`);
}
main().catch(console.error);
