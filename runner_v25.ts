/**
 * Bond Vigilante — Backtest v25 COMPETITION MODE
 * Optimized for Degen Claw Weekly Season Format
 *
 * LEADERBOARD REALITY (from actual data):
 *   - Sortino = 10 (maxed/capped) for ALL top 10 bots — easy floor, not differentiator
 *   - Score differentiator = Return% × 35% + PF × 25% (relative to other bots)
 *   - Leader (#1 alura): 80% WR × 1:2 R:R → PF 8.32, Return +16.74% in 3 days, 5 trades
 *   - Current v24: PF 1.37 ← B-20Bar (42% WR) + Q-Squeeze (39% WR) drag PF down hard
 *
 * STRATEGY CHANGES:
 * 1. DROP B-20Bar & Q-Squeeze → they kill PF in weekly sample sizes
 * 2. KEEP N-NearIB but LOOSEN ratio 0.68→0.78 for more trade frequency
 * 3. ADD tiered exit: TP1 = 0.8×ATR (60% pos, SL→breakeven), TP2 = 2.5×ATR (40%)
 *    - Effect: most trades "won" (TP1 is closer → higher hit rate)
 *    - PF theoretical: (0.75 × 1.48×ATR) / (0.25 × 1×ATR) = 4.44
 * 4. ADD B-NearIB (body NearIB): body of prev bar < 60% of p2 body, wider range tolerance
 *    - Catches more NearIB-like setups → more trades per week
 * 5. Leverage: BTC/ETH 15×, SOL 12× (meaningful Return% without near-certain blowup)
 * 6. MaxOpen: 2 (allow 2 concurrent for more weekly Return%)
 *
 * TARGET: WR 72%+, PF 4.0+, weekly Return 8-20%, compete for top 3
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
  const b=Math.floor(t/28800000)*28800000; return m.get(b)??m.get(b-28800000)??0;
}
function calcEma(bars: any[], p: number) {
  const k=2/(p+1); let e=bars[0].c; const out=[e];
  for(let i=1;i<bars.length;i++){e=bars[i].c*k+e*(1-k);out.push(e);}
  return out;
}
function calcRsi(bars: any[], p=14) {
  const out=new Array(p).fill(50); let g=0,l=0;
  for(let i=1;i<=p;i++){const d=bars[i].c-bars[i-1].c;d>0?g+=d:l+=Math.abs(d);}
  let ag=g/p,al=l/p;
  out[p]=100-100/(1+ag/Math.max(al,1e-9));
  for(let i=p+1;i<bars.length;i++){
    const d=bars[i].c-bars[i-1].c;
    ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
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
function volR(bars: any[], i: number) {
  if(i<20) return 1;
  return bars[i].v/(bars.slice(i-20,i).reduce((s:number,b:any)=>s+b.v,0)/20);
}
function getRegime(e9: number[], e21: number[], e55: number[], price: number, i: number): "bull"|"bear"|"none" {
  if(i<10) return "none";
  const b9=e9[i]>e9[i-2],b21=e21[i]>e21[i-3],b55=e55[i]>e55[i-6];
  const d9=e9[i]<e9[i-2],d21=e21[i]<e21[i-3],d55=e55[i]<e55[i-6];
  if(e9[i]>e21[i]&&e21[i]>e55[i]&&b9&&b21&&b55&&price>e55[i]) return "bull";
  if(e9[i]<e21[i]&&e21[i]<e55[i]&&d9&&d21&&d55&&price<e55[i]) return "bear";
  return "none";
}

interface Sig{side:"long"|"short";setup:string}

function getSignal(bars: any[], i: number,
  rsiArr: number[], e9: number[], e21: number[], e55: number[],
  atrArr: number[], fund: Map<number,number>
): Sig|null {
  if(i<80) return null;
  const c=bars[i],p=bars[i-1],p2=bars[i-2];
  const r=rsiArr[i],vr=volR(bars,i),f=getFund(fund,c.t);
  const reg=getRegime(e9,e21,e55,c.c,i);
  if(reg==="none") return null;
  const sFund=f<-0.000010,lFund=f>0.000008;

  // ── N-NearIB (loosened ratio 0.68→0.78 for more frequency) ──────────────
  // Core edge: compression bar → momentum breakout. High WR anchor.
  {
    const p2r=p2.h-p2.l, pr=p.h-p.l;
    // Primary NearIB: full range compression
    const nearIB = pr<p2r*0.78 && p.h<=p2.h*1.002 && p.l>=p2.l*0.998;
    if(nearIB) {
      if(reg==="bull"&&c.c>p2.h*0.999&&c.c>c.o&&vr>1.6&&r>46&&r<76&&!lFund)
        return {side:"long",setup:"N-NearIB"};
      if(reg==="bear"&&c.c<p2.l*1.001&&c.c<c.o&&vr>1.6&&r>24&&r<54&&!sFund)
        return {side:"short",setup:"N-NearIB"};
    }
  }

  // ── B-NearIB (body inside bar variant — catches more setups) ────────────
  // Body of prev bar inside p2 range (wicks can exceed), body compression
  {
    const p2body=Math.abs(p2.c-p2.o), pbody=Math.abs(p.c-p.o);
    const bodyIB = pbody<p2body*0.65
      && Math.max(p.c,p.o)<=p2.h*1.003
      && Math.min(p.c,p.o)>=p2.l*0.997;
    if(bodyIB) {
      if(reg==="bull"&&c.c>p2.h*0.998&&c.c>c.o&&vr>1.8&&r>50&&r<74&&!lFund)
        return {side:"long",setup:"B-NearIB"};
      if(reg==="bear"&&c.c<p2.l*1.002&&c.c<c.o&&vr>1.8&&r>26&&r<50&&!sFund)
        return {side:"short",setup:"B-NearIB"};
    }
  }

  return null;
}

interface Trade{pnlPct:number;won:boolean;setup:string;side:string;date:string;pair:string;week:string;}

async function runAll() {
  const D:Record<string,any>={};
  for(const pair of PAIRS){
    const [bars,fund]=await Promise.all([fetchBars(pair),fetchFunding(pair)]);
    D[pair]={bars,fund,rsi:calcRsi(bars),e9:calcEma(bars,9),e21:calcEma(bars,21),e55:calcEma(bars,55),atr:calcAtr(bars)};
  }
  const trades:Trade[]=[];
  // Position now tracks tiered exit state
  const pos=new Map<string,{
    entry:number;side:"long"|"short";sl:number;tp1:number;tp2:number;
    setup:string;barsHeld:number;tp1Hit:boolean;partialPnl:number
  }>();
  let dStr="",wStr="",wPnl=0,pauseUntil=0,gCons=0;
  const dPnl:Record<string,number>={BTC:0,ETH:0,SOL:0};
  const dCons:Record<string,number>={BTC:0,ETH:0,SOL:0};
  const lev:Record<string,number>={BTC:15,ETH:15,SOL:12};
  const minLen=Math.min(...PAIRS.map(p=>D[p].bars.length));

  for(let i=80;i<minLen;i++){
    const today=new Date(D.BTC.bars[i].t).toISOString().slice(0,10);
    const weekNum=Math.floor(+D.BTC.bars[i].t/604800000);
    const week=today.slice(0,8)+weekNum;
    if(today!==dStr){dStr=today;PAIRS.forEach(p=>{dPnl[p]=0;dCons[p]=0;});}
    if(week!==wStr){wStr=week;wPnl=0;}
    if(pauseUntil>0&&i>=pauseUntil)pauseUntil=0;

    for(const [pair,p2] of pos){
      const bar=D[pair].bars[i];
      p2.barsHeld++;

      // ── Tiered exit logic ──────────────────────────────
      // Priority: SL check first, then TP checks
      const slHit = p2.side==="long"?bar.l<=p2.sl:bar.h>=p2.sl;

      if(!p2.tp1Hit) {
        // Phase 1: waiting for TP1 or SL
        if(slHit) {
          // Full loss
          const raw=(p2.side==="long"?(p2.sl-p2.entry)/p2.entry:(p2.entry-p2.sl)/p2.entry);
          const pnl=raw*lev[pair]*100;
          dPnl[pair]+=pnl;wPnl+=pnl;
          gCons++;dCons[pair]++;
          trades.push({pnlPct:pnl,won:false,setup:p2.setup,side:p2.side,date:today,pair,week});
          pos.delete(pair);
        } else if(p2.side==="long"?bar.h>=p2.tp1:bar.l<=p2.tp1) {
          // TP1 hit: lock 60% at TP1, move SL to breakeven for remaining 40%
          const raw1=(p2.side==="long"?(p2.tp1-p2.entry)/p2.entry:(p2.entry-p2.tp1)/p2.entry);
          p2.partialPnl = raw1*lev[pair]*100*0.6; // 60% of position at TP1
          p2.tp1Hit=true;
          p2.sl=p2.entry; // SL → breakeven for remaining 40%
        } else if(p2.barsHeld>=12) {
          // Time exit from phase 1 (12 bars = 48h)
          const raw=(p2.side==="long"?(bar.c-p2.entry)/p2.entry:(p2.entry-bar.c)/p2.entry);
          const pnl=raw*lev[pair]*100;
          dPnl[pair]+=pnl;wPnl+=pnl;
          if(pnl<0){gCons++;dCons[pair]++;}else{gCons=0;}
          trades.push({pnlPct:pnl,won:pnl>0,setup:p2.setup,side:p2.side,date:today,pair,week});
          pos.delete(pair);
        }
      } else {
        // Phase 2: TP1 already hit, SL at breakeven, waiting for TP2
        if(slHit) {
          // SL at breakeven → partial win (only 60% locked)
          const pnl=p2.partialPnl; // positive from TP1 partial
          dPnl[pair]+=pnl;wPnl+=pnl;
          gCons=0; // it's a win (positive PnL)
          trades.push({pnlPct:pnl,won:true,setup:p2.setup,side:p2.side,date:today,pair,week});
          pos.delete(pair);
        } else if(p2.side==="long"?bar.h>=p2.tp2:bar.l<=p2.tp2) {
          // Full TP2 hit
          const raw2=(p2.side==="long"?(p2.tp2-p2.entry)/p2.entry:(p2.entry-p2.tp2)/p2.entry);
          const pnl=p2.partialPnl + raw2*lev[pair]*100*0.4; // 60% locked + 40% at TP2
          dPnl[pair]+=pnl;wPnl+=pnl;
          gCons=0;
          trades.push({pnlPct:pnl,won:true,setup:p2.setup,side:p2.side,date:today,pair,week});
          pos.delete(pair);
        } else if(p2.barsHeld>=20) {
          // Time exit phase 2 (20 bars = 80h total)
          const raw=(p2.side==="long"?(bar.c-p2.entry)/p2.entry:(p2.entry-bar.c)/p2.entry);
          const pnl=p2.partialPnl + raw*lev[pair]*100*0.4;
          dPnl[pair]+=pnl;wPnl+=pnl;
          if(pnl<0){gCons++;dCons[pair]++;}else{gCons=0;}
          trades.push({pnlPct:pnl,won:pnl>0,setup:p2.setup,side:p2.side,date:today,pair,week});
          pos.delete(pair);
        }
      }
    }

    if(pauseUntil>0)continue;
    if(wPnl<-12.0){pauseUntil=i+7;continue;} // scaled for 15×
    if(gCons>=3){pauseUntil=i+6;gCons=0;continue;}

    for(const pair of PAIRS){
      if(pos.has(pair)||dPnl[pair]<-8||dCons[pair]>=2||pos.size>=2)continue;
      const d=D[pair];
      const sig=getSignal(d.bars,i,d.rsi,d.e9,d.e21,d.e55,d.atr,d.fund);
      if(!sig)continue;
      const atrV=d.atr[i],entry=d.bars[i].c;
      const sl  = sig.side==="long"?entry-atrV:entry+atrV;
      const tp1 = sig.side==="long"?entry+atrV*0.8:entry-atrV*0.8;   // partial exit
      const tp2 = sig.side==="long"?entry+atrV*2.5:entry-atrV*2.5;   // full exit
      pos.set(pair,{entry,side:sig.side,sl,tp1,tp2,setup:sig.setup,barsHeld:0,tp1Hit:false,partialPnl:0});
    }
  }
  return trades;
}

function metrics(trades: Trade[]) {
  if(!trades.length)return{n:0,wr:"—",ret:"—",pf:"—",sortino:"—",dd:"—",setups:"—",weeklyRet:"—",avgWeekTrades:"—"};
  const wins=trades.filter(t=>t.won);
  const gross=wins.reduce((s,t)=>s+t.pnlPct,0);
  const loss=Math.abs(trades.filter(t=>!t.won).reduce((s,t)=>s+t.pnlPct,0));
  const ret=trades.reduce((s,t)=>s+t.pnlPct,0);
  const pf=loss>0?gross/loss:9.99;
  const mean=ret/trades.length;
  const neg=trades.filter(t=>t.pnlPct<0).map(t=>t.pnlPct-mean);
  const dDev=neg.length?Math.sqrt(neg.reduce((a,b)=>a+b*b,0)/neg.length):0.001;
  let eq=1,peak=1,maxDD=0;
  for(const t of trades){eq*=(1+t.pnlPct/100);if(eq>peak)peak=eq;const dd=(peak-eq)/peak;if(dd>maxDD)maxDD=dd;}
  const sc:Record<string,{w:number;t:number}>={};
  for(const t of trades){if(!sc[t.setup])sc[t.setup]={w:0,t:0};sc[t.setup].t++;if(t.won)sc[t.setup].w++;}
  const wr=wins.length/trades.length;
  const sort=mean/dDev;

  // Weekly stats (key for competition)
  const byWeek:Record<string,number>={};
  const byWeekCount:Record<string,number>={};
  for(const t of trades){
    byWeek[t.week]=(byWeek[t.week]??0)+t.pnlPct;
    byWeekCount[t.week]=(byWeekCount[t.week]??0)+1;
  }
  const weeklyRets=Object.values(byWeek);
  const weeklyTrades=Object.values(byWeekCount);
  const avgWeeklyRet=weeklyRets.reduce((a,b)=>a+b,0)/weeklyRets.length;
  const avgWeeklyTrades=weeklyTrades.reduce((a,b)=>a+b,0)/weeklyTrades.length;
  const posWeeks=weeklyRets.filter(w=>w>0).length;

  return {
    n:trades.length,wr:(wr*100).toFixed(0)+"%",ret:ret.toFixed(1)+"%",pf:pf.toFixed(2),
    sortino:sort.toFixed(2),dd:(maxDD*100).toFixed(2)+"%",
    setups:Object.entries(sc).map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`).join(" | "),
    weeklyRet:avgWeeklyRet.toFixed(1)+"%",
    avgWeekTrades:avgWeeklyTrades.toFixed(1),
    posWeeks:`${posWeeks}/${weeklyRets.length}`
  };
}

async function main() {
  console.log("\n📊 Bond Vigilante v25 — COMPETITION MODE (Weekly Season)\n");
  console.log("Strategy: NearIB-only + tiered exit (TP1@0.8×ATR → SL@BE → TP2@2.5×ATR)");
  console.log("Target: WR 72%+, PF 4.0+, weekly Return 8-20%, trades 3-8/week\n");
  const allTrades=await runAll();
  const pp:Record<string,Trade[]>={BTC:[],ETH:[],SOL:[]};
  allTrades.forEach(t=>pp[t.pair].push(t));

  console.log("Pair    N     WR%    Return%   PF      Sortino  MaxDD   Avg/Wk  Setups");
  console.log("─".repeat(130));
  for(const pair of PAIRS){
    const m=metrics(pp[pair]);
    console.log(pair.padEnd(8)+String(m.n).padEnd(6)+String(m.wr).padEnd(7)+String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+String(m.dd).padEnd(8)+String(m.avgWeekTrades).padEnd(8)+m.setups);
  }
  console.log("─".repeat(130));
  const m=metrics(allTrades);
  console.log("TOTAL".padEnd(8)+String(m.n).padEnd(6)+String(m.wr).padEnd(7)+String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+String(m.dd).padEnd(8)+String(m.avgWeekTrades).padEnd(8)+m.setups);

  console.log(`\n  ═══════════ COMPETITION METRICS ═══════════`);
  console.log(`  🏆 WR: ${m.wr}  |  PF: ${m.pf}  |  Sortino: ${m.sortino}`);
  console.log(`  📅 Avg weekly Return: ${m.weeklyRet}  |  Avg trades/week: ${m.avgWeekTrades}`);
  console.log(`  📈 Profitable weeks: ${m.posWeeks}`);
  console.log(`  🎯 Leaderboard target: PF ${m.pf} → alura has 8.32, we target 4.0+`);
  console.log(`  Compare v24 (B-20Bar+QSqueeze): PF 1.37 → v25 NearIB-only target: 3.5+\n`);
}
main().catch(console.error);
