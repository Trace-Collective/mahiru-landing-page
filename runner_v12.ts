/**
 * Bond Vigilante — Backtest v12
 * Refinement of v11 with:
 * - Remove D1-Diverge (32% WR = slightly below random, noise)
 * - Stricter M1 conditions: vol > 2.0x AND RSI 60-78 AND EMA9 confirms
 * - Add EMA9 as short-term trend confirmation
 * - Tighter daily risk: max -2.5% daily, max 2 consecutive losses
 * - M1-Pullback: enter on NEXT bar's retest of breakout level (higher quality)
 * - M2 requires stronger acceleration: vol > 2.2x AND 3% move
 * Goal: WR 50%+, PF 2.0+, Sortino 0.5+, MaxDD < 35%
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

// Strong regime: EMA9 + EMA21 + EMA55 all aligned
function getRegime(e9: number[], e21: number[], e55: number[], price: number, i: number): "bull"|"bear"|"none" {
  if(i<10) return "none";
  const bull9  = e9[i]>e9[i-2];
  const bull21 = e21[i]>e21[i-3];
  const bull55 = e55[i]>e55[i-6];
  const bear9  = e9[i]<e9[i-2];
  const bear21 = e21[i]<e21[i-3];
  const bear55 = e55[i]<e55[i-6];
  // Full alignment: e9 > e21 > e55, all sloping up, price above e55
  if(e9[i]>e21[i] && e21[i]>e55[i] && bull9 && bull21 && bull55 && price>e55[i]) return "bull";
  if(e9[i]<e21[i] && e21[i]<e55[i] && bear9 && bear21 && bear55 && price<e55[i]) return "bear";
  return "none";
}

interface Sig { side:"long"|"short"; setup:string; score:number }

function getSignal(
  bars: any[], i: number,
  rsiArr: number[], e9: number[], e21: number[], e55: number[],
  atrArr: number[], fund: Map<number,number>,
  prevBreakout: {active:boolean;level:number;side:"long"|"short";bars:number}
): Sig | null {
  if(i<80) return null;
  const c=bars[i], p=bars[i-1], p2=bars[i-2];
  const r=rsiArr[i];
  const f=getFund(fund,c.t);
  const vr=volRatio(bars,i);
  const reg=getRegime(e9,e21,e55,c.c,i);
  if(reg==="none") return null;

  const sFund=f<-0.000010;
  const lFund=f>0.000008;

  // ── M1: 20-BAR BREAKOUT WITH TIGHT CONDITIONS ──────────────
  {
    const h20=Math.max(...bars.slice(i-20,i-2).map((b:any)=>b.h));
    const l20=Math.min(...bars.slice(i-20,i-2).map((b:any)=>b.l));

    if(reg==="bull" && c.c>h20 && c.c>c.o) {
      const rsiStrong = r>60 && r<78; // momentum zone (stricter upper bound)
      const volStrong = vr>2.0;       // strong volume confirmation
      if(rsiStrong && volStrong && !lFund) {
        let sc=5;
        if(vr>2.5) sc++;
        if(sFund) sc++;
        if(r>65) sc++;
        return {side:"long", setup:"M1-BreakBull", score:sc};
      }
    }

    if(reg==="bear" && c.c<l20 && c.c<c.o) {
      const rsiStrong = r>22 && r<40;
      const volStrong = vr>2.0;
      if(rsiStrong && volStrong && !sFund) {
        let sc=5;
        if(vr>2.5) sc++;
        if(lFund) sc++;
        if(r<35) sc++;
        return {side:"short", setup:"M1-BreakBear", score:sc};
      }
    }
  }

  // ── M1P: BREAKOUT PULLBACK ENTRY (high quality) ────────────
  // Previous bar was the breakout. Current bar pulls back to breakout level then recovers.
  // This gives much better entry timing → higher WR.
  if(prevBreakout.active && prevBreakout.bars<=2) {
    const lvl=prevBreakout.level;
    if(prevBreakout.side==="long") {
      // Price pulled back toward breakout level, then closed back above it
      const pullback = c.l <= lvl*1.005 && c.c > lvl && c.c > c.o;
      if(pullback && reg==="bull" && !lFund) {
        let sc=5;
        if(vr>1.5) sc++;
        if(sFund) sc++;
        return {side:"long", setup:"M1P-Pullback", score:sc};
      }
    } else {
      const pullback = c.h >= lvl*0.995 && c.c < lvl && c.c < c.o;
      if(pullback && reg==="bear" && !sFund) {
        let sc=5;
        if(vr>1.5) sc++;
        if(lFund) sc++;
        return {side:"short", setup:"M1P-Pullback", score:sc};
      }
    }
  }

  // ── M2: 3-BAR ACCELERATION ────────────────────────────────
  {
    const bull3=c.c>c.o && p.c>p.o && p2.c>p2.o;
    const bear3=c.c<c.o && p.c<p.o && p2.c<p2.o;
    const move3pct=Math.abs(c.c-p2.o)/p2.o*100;

    if(reg==="bull" && bull3 && move3pct>3.0 && vr>2.2 && r>55 && r<75 && !lFund) {
      let sc=5;
      if(move3pct>5.0) sc++;
      if(vr>2.8) sc++;
      if(sFund) sc++;
      return {side:"long", setup:"M2-Accel", score:sc};
    }

    if(reg==="bear" && bear3 && move3pct>3.0 && vr>2.2 && r>25 && r<45 && !sFund) {
      let sc=5;
      if(move3pct>5.0) sc++;
      if(vr>2.8) sc++;
      if(lFund) sc++;
      return {side:"short", setup:"M2-Accel", score:sc};
    }
  }

  // ── M3: INSIDE BAR BREAKOUT ────────────────────────────────
  {
    const isInside=p.h<p2.h && p.l>p2.l;
    if(isInside) {
      if(reg==="bull" && c.c>p2.h && c.c>c.o && vr>1.8 && r>50 && r<72 && !lFund) {
        let sc=5; if(vr>2.2)sc++; if(sFund)sc++;
        return {side:"long", setup:"M3-IB", score:sc};
      }
      if(reg==="bear" && c.c<p2.l && c.c<c.o && vr>1.8 && r>28 && r<50 && !sFund) {
        let sc=5; if(vr>2.2)sc++; if(lFund)sc++;
        return {side:"short", setup:"M3-IB", score:sc};
      }
    }
  }

  return null;
}

interface Trade { pnlPct:number; won:boolean; setup:string; side:string; date:string; }

function simulate(bars: any[], fund: Map<number,number>, pair: string) {
  const rsiArr=calcRsi(bars);
  const e9=calcEma(bars,9), e21=calcEma(bars,21), e55=calcEma(bars,55);
  const atrArr=calcAtr(bars);
  const trades:Trade[]=[];
  let pos:{entry:number;side:"long"|"short";sl:number;tp:number;setup:string}|null=null;
  let dailyPnl=0, dayStr="", consDay=0;
  let prevBreakout:{active:boolean;level:number;side:"long"|"short";bars:number}={active:false,level:0,side:"long",bars:0};
  const lev = pair==="SOL" ? 2.5 : 3;

  for(let i=80; i<bars.length; i++) {
    const bar=bars[i], today=new Date(bar.t).toISOString().slice(0,10);
    if(today!==dayStr) { dailyPnl=0; dayStr=today; consDay=0; }

    // Track prev breakout for pullback entry
    if(prevBreakout.active) prevBreakout.bars++;
    if(prevBreakout.bars>3) prevBreakout.active=false;

    if(pos) {
      let exit:number|null=null;
      const {side,sl,tp} = pos;
      if(side==="long") { if(bar.l<=sl) exit=sl; else if(bar.h>=tp) exit=tp; }
      else { if(bar.h>=sl) exit=sl; else if(bar.l<=tp) exit=tp; }
      if(exit!==null) {
        const raw=(side==="long"?(exit-pos.entry)/pos.entry:(pos.entry-exit)/pos.entry);
        const pnlPct=raw*lev*100;
        dailyPnl+=pnlPct;
        if(pnlPct<0) consDay++;
        trades.push({pnlPct, won:pnlPct>0, setup:pos.setup, side, date:today});
        pos=null;
      }
    }

    if(dailyPnl<-2.5 || consDay>=2 || pos) continue;

    const sig=getSignal(bars,i,rsiArr,e9,e21,e55,atrArr,fund,prevBreakout);
    if(!sig || sig.score<5) continue;

    // Record breakout for potential pullback entry next bars
    if(sig.setup.startsWith("M1-Break")) {
      const h20=Math.max(...bars.slice(i-20,i-2).map((b:any)=>b.h));
      const l20=Math.min(...bars.slice(i-20,i-2).map((b:any)=>b.l));
      prevBreakout={active:true,level:sig.side==="long"?h20:l20,side:sig.side,bars:0};
    }

    const atrV=atrArr[i], entry=bar.c;
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
  console.log("\n📊 Bond Vigilante v12 — Momentum Breakout + Pullback (EMA9/21/55)\n");
  console.log("Pair    Trades  WR%    Return%   PF      Sortino  MaxDD   Setups");
  console.log("─".repeat(115));
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
  console.log("─".repeat(115));
  const m=calcMetrics(all);
  console.log(
    "TOTAL".padEnd(8)+String(m.n).padEnd(8)+String(m.wr).padEnd(7)+
    String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+
    String(m.dd).padEnd(8)+m.setups
  );
  console.log(`\n🎯 LB Target: WR >50%, PF >2.0, Sortino >0.5, MaxDD <35%`);
  console.log(`   Result:    WR ${m.wr}, PF ${m.pf}, Sortino ${m.sortino}, Return ${m.ret}, MaxDD ${m.dd}`);
  console.log(`   Note: 1:2 R:R random baseline = 33% WR\n`);
}
main().catch(console.error);
