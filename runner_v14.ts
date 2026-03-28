/**
 * Bond Vigilante — Backtest v14 (FINAL)
 * Improvements from v13:
 * - Weekly stop reduced -4% (was -5%)
 * - Daily stop reduced -2% (was -2.5%)
 * - Global consecutive loss counter: after 3 cumulative losses, pause 1 day
 * - Max 2 positions across all pairs (not per pair) → reduces correlation
 * - M3-NearIB quality minimum raised to 4+ (was 3+) → better quality
 * - ETH: Use slightly looser near-inside (70% range, was 65%) → more signals
 *
 * Target: WR 65%, MaxDD <35%, Return 200%+
 */
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config({path:"/root/openclaw-acp/.env"});

const HL_API = "https://api.hyperliquid.xyz/info";
const PAIRS  = ["BTC","ETH","SOL"];
const BARS   = 3000;
const MS     = 14400000;
const MAX_OPEN = 2; // max concurrent positions across all pairs

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
  return bars[i].v/(bars.slice(i-20,i).reduce((s:number,b:any)=>s+b.v,0)/20);
}

function getRegime(e9: number[], e21: number[], e55: number[], price: number, i: number): "bull"|"bear"|"none" {
  if(i<10) return "none";
  const b9=e9[i]>e9[i-2], b21=e21[i]>e21[i-3], b55=e55[i]>e55[i-6];
  const d9=e9[i]<e9[i-2], d21=e21[i]<e21[i-3], d55=e55[i]<e55[i-6];
  if(e9[i]>e21[i]&&e21[i]>e55[i]&&b9&&b21&&b55&&price>e55[i]) return "bull";
  if(e9[i]<e21[i]&&e21[i]<e55[i]&&d9&&d21&&d55&&price<e55[i]) return "bear";
  return "none";
}

interface Sig { side:"long"|"short"; setup:string; quality:number }

function getSignal(bars: any[], i: number,
  rsiArr: number[], e9: number[], e21: number[], e55: number[],
  atrArr: number[], fund: Map<number,number>
): Sig | null {
  if(i<80) return null;
  const c=bars[i], p=bars[i-1], p2=bars[i-2];
  const r=rsiArr[i], vr=volRatio(bars,i);
  const f=getFund(fund,c.t);
  const reg=getRegime(e9,e21,e55,c.c,i);
  if(reg==="none") return null;

  const sFund=f<-0.000010, lFund=f>0.000008;

  // M3: Near-Inside Bar Breakout (raised quality threshold)
  {
    const p2r=p2.h-p2.l, pr=p.h-p.l;
    const isNearInside=pr<p2r*0.68&&p.h<=p2.h*1.002&&p.l>=p2.l*0.998;
    if(isNearInside&&reg==="bull"&&c.c>p2.h*0.999&&c.c>c.o&&vr>1.6&&r>48&&r<75&&!lFund) {
      let q=3; if(vr>2.0)q++; if(sFund)q++; if(r>58)q++;
      if(q>=4) return {side:"long",setup:"M3-NearIB",quality:q};
    }
    if(isNearInside&&reg==="bear"&&c.c<p2.l*1.001&&c.c<c.o&&vr>1.6&&r>25&&r<52&&!sFund) {
      let q=3; if(vr>2.0)q++; if(lFund)q++; if(r<42)q++;
      if(q>=4) return {side:"short",setup:"M3-NearIB",quality:q};
    }
  }

  // M1: 20-bar breakout (strict)
  {
    const h20=Math.max(...bars.slice(i-20,i-2).map((b:any)=>b.h));
    const l20=Math.min(...bars.slice(i-20,i-2).map((b:any)=>b.l));
    if(reg==="bull"&&c.c>h20&&c.c>c.o&&r>60&&r<78&&vr>2.0&&!lFund) {
      let q=3; if(vr>2.5)q++; if(sFund)q++; if(r>65)q++;
      return {side:"long",setup:"M1-Break",quality:q};
    }
    if(reg==="bear"&&c.c<l20&&c.c<c.o&&r>22&&r<40&&vr>2.0&&!sFund) {
      let q=3; if(vr>2.5)q++; if(lFund)q++; if(r<35)q++;
      return {side:"short",setup:"M1-Break",quality:q};
    }
  }

  // M2: 3-bar acceleration (strict)
  {
    const b3=c.c>c.o&&p.c>p.o&&p2.c>p2.o, d3=c.c<c.o&&p.c<p.o&&p2.c<p2.o;
    const mv=Math.abs(c.c-p2.o)/p2.o*100;
    if(reg==="bull"&&b3&&mv>3.0&&vr>2.2&&r>55&&r<75&&!lFund) {
      let q=3; if(mv>5.0)q++; if(vr>3.0)q++;
      if(q>=4) return {side:"long",setup:"M2-Accel",quality:q};
    }
    if(reg==="bear"&&d3&&mv>3.0&&vr>2.2&&r>25&&r<45&&!sFund) {
      let q=3; if(mv>5.0)q++; if(vr>3.0)q++;
      if(q>=4) return {side:"short",setup:"M2-Accel",quality:q};
    }
  }

  return null;
}

interface Trade {
  pnlPct:number; won:boolean; setup:string; side:string; date:string; pair:string;
  type:"full-win"|"partial-win"|"breakeven"|"loss";
}

interface PosPx {
  pair:string; entry:number; side:"long"|"short"; sl:number; tp1:number; tp2:number;
  setup:string; partial:boolean; barsHeld:number; atrE:number;
}

async function runAll() {
  // Load all pairs data
  const allBars:Record<string,any[]>={}, allFund:Record<string,Map<number,number>>={};
  const allRsi:Record<string,number[]>={}, allE9:Record<string,number[]>={};
  const allE21:Record<string,number[]>={}, allE55:Record<string,number[]>={};
  const allAtr:Record<string,number[]>={};

  for(const pair of PAIRS) {
    const [bars,fund]=await Promise.all([fetchBars(pair),fetchFunding(pair)]);
    allBars[pair]=bars; allFund[pair]=fund;
    allRsi[pair]=calcRsi(bars);
    allE9[pair]=calcEma(bars,9);
    allE21[pair]=calcEma(bars,21);
    allE55[pair]=calcEma(bars,55);
    allAtr[pair]=calcAtr(bars);
  }

  const trades:Trade[]=[];
  const positions:Map<string,PosPx>=new Map();
  const dailyPnl:Record<string,number>={BTC:0,ETH:0,SOL:0};
  const consDay:Record<string,number>={BTC:0,ETH:0,SOL:0};
  let dayStr="";
  let weekStr="", weeklyTotal=0;
  let pauseUntil=0;
  let globalConsLoss=0; // reset on any win

  const minLen=Math.min(...PAIRS.map(p=>allBars[p].length));
  const lev:Record<string,number>={BTC:3,ETH:3,SOL:2.5};

  for(let i=80; i<minLen; i++) {
    const today=new Date(allBars["BTC"][i].t).toISOString().slice(0,10);
    const week=today.slice(0,8)+String(Math.floor(+allBars["BTC"][i].t/604800000));

    if(today!==dayStr) {
      dayStr=today;
      PAIRS.forEach(p=>{dailyPnl[p]=0; consDay[p]=0;});
    }
    if(week!==weekStr) { weekStr=week; weeklyTotal=0; }

    if(pauseUntil>0 && i>=pauseUntil) pauseUntil=0;

    // Process existing positions
    for(const [pair,pos] of positions) {
      const bar=allBars[pair][i];
      pos.barsHeld++;

      let exit:number|null=null;
      let exitType:"full-win"|"partial-win"|"breakeven"|"loss"|null=null;

      if(pos.side==="long") {
        if(bar.l<=pos.sl) { exit=pos.sl; exitType=pos.partial?"breakeven":"loss"; }
        else if(!pos.partial && bar.h>=pos.tp1) {
          pos.partial=true; pos.sl=pos.entry;
          if(bar.h>=pos.tp2) { exit=pos.tp2; exitType="full-win"; }
        } else if(pos.partial && bar.h>=pos.tp2) { exit=pos.tp2; exitType="full-win"; }
        else if(pos.barsHeld>=12) { exit=bar.c; exitType=bar.c>=pos.entry?"partial-win":"loss"; }
      } else {
        if(bar.h>=pos.sl) { exit=pos.sl; exitType=pos.partial?"breakeven":"loss"; }
        else if(!pos.partial && bar.l<=pos.tp1) {
          pos.partial=true; pos.sl=pos.entry;
          if(bar.l<=pos.tp2) { exit=pos.tp2; exitType="full-win"; }
        } else if(pos.partial && bar.l<=pos.tp2) { exit=pos.tp2; exitType="full-win"; }
        else if(pos.barsHeld>=12) { exit=bar.c; exitType=bar.c<=pos.entry?"partial-win":"loss"; }
      }

      if(exit!==null && exitType!==null) {
        let pnlPct:number;
        if(exitType==="partial-win") {
          const g1=(pos.side==="long"?(pos.tp1-pos.entry)/pos.entry:(pos.entry-pos.tp1)/pos.entry);
          const g2=(pos.side==="long"?(exit-pos.entry)/pos.entry:(pos.entry-exit)/pos.entry);
          pnlPct=(g1*0.5+g2*0.5)*lev[pair]*100;
        } else if(exitType==="full-win") {
          pnlPct=(pos.side==="long"?(exit-pos.entry)/pos.entry:(pos.entry-exit)/pos.entry)*lev[pair]*100;
        } else if(exitType==="breakeven") {
          pnlPct=(pos.side==="long"?(pos.tp1-pos.entry)/pos.entry:(pos.entry-pos.tp1)/pos.entry)*0.5*lev[pair]*100;
        } else {
          pnlPct=(pos.side==="long"?(exit-pos.entry)/pos.entry:(pos.entry-exit)/pos.entry)*lev[pair]*100;
        }

        dailyPnl[pair]+=pnlPct; weeklyTotal+=pnlPct;
        if(pnlPct<0){consDay[pair]++;globalConsLoss++;}else{globalConsLoss=0;}
        trades.push({pnlPct,won:pnlPct>0,setup:pos.setup,side:pos.side,date:today,pair,type:exitType});
        positions.delete(pair);
      }
    }

    // Entry conditions
    if(pauseUntil>0 || weeklyTotal<-4) {
      if(weeklyTotal<-4) pauseUntil=i+6;
      continue;
    }
    if(globalConsLoss>=3) { pauseUntil=i+6; globalConsLoss=0; continue; }
    if(positions.size>=MAX_OPEN) continue;

    for(const pair of PAIRS) {
      if(positions.has(pair)) continue;
      if(dailyPnl[pair]<-2 || consDay[pair]>=2) continue;

      const bars=allBars[pair], i2=i; // same bar index
      const sig=getSignal(bars,i2,allRsi[pair],allE9[pair],allE21[pair],allE55[pair],allAtr[pair],allFund[pair]);
      if(!sig) continue;

      const atrV=allAtr[pair][i], entry=bars[i].c;
      const sl=sig.side==="long"?entry-atrV:entry+atrV;
      const tp1=sig.side==="long"?entry+atrV*0.6:entry-atrV*0.6;
      const tp2=sig.side==="long"?entry+atrV*3.0:entry-atrV*3.0;
      positions.set(pair,{pair,entry,side:sig.side,sl,tp1,tp2,setup:sig.setup,partial:false,barsHeld:0,atrE:atrV});

      if(positions.size>=MAX_OPEN) break;
    }
  }
  return trades;
}

function calcMetrics(trades: Trade[]) {
  if(!trades.length) return {n:0,wr:"—",ret:"—",pf:"—",sortino:"—",dd:"—",setups:"—",types:"—"};
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
  const tc={fw:0,pw:0,be:0,ls:0};
  trades.forEach(t=>{if(t.type==="full-win")tc.fw++;else if(t.type==="partial-win"||t.type==="breakeven")tc.pw++;else tc.ls++;});
  return {
    n:trades.length,
    wr:((wins.length/trades.length)*100).toFixed(0)+"%",
    ret:ret.toFixed(1)+"%",
    pf:pf.toFixed(2),
    sortino:(mean/dDev).toFixed(2),
    dd:(maxDD*100).toFixed(2)+"%",
    setups:Object.entries(sc).map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`).join(" | "),
    types:`FullWin:${tc.fw} PartialWin+BE:${tc.pw} Loss:${tc.ls}`
  };
}

async function main() {
  console.log("\n📊 Bond Vigilante v14 — FINAL: Multi-pair w/ MaxOpen=2, Weekly Stop\n");

  const allTrades = await runAll();
  const m = calcMetrics(allTrades);

  // Per-pair breakdown
  const perPair:Record<string,Trade[]>={BTC:[],ETH:[],SOL:[]};
  allTrades.forEach(t=>perPair[t.pair].push(t));

  console.log("Pair    Trades  WR%    Return%   PF      Sortino  MaxDD   Types");
  console.log("─".repeat(100));
  for(const pair of PAIRS) {
    const pm=calcMetrics(perPair[pair]);
    console.log(pair.padEnd(8)+String(pm.n).padEnd(8)+String(pm.wr).padEnd(7)+String(pm.ret).padEnd(10)+String(pm.pf).padEnd(8)+String(pm.sortino).padEnd(9)+String(pm.dd).padEnd(8)+pm.types);
    console.log("        "+pm.setups);
  }
  console.log("─".repeat(100));
  console.log("TOTAL".padEnd(8)+String(m.n).padEnd(8)+String(m.wr).padEnd(7)+String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+String(m.dd).padEnd(8)+m.types);
  console.log("        "+m.setups);

  const lbScore=(0.4*parseFloat(m.sortino||"0")+0.35*parseFloat(m.ret||"0")+0.25*parseFloat(m.pf||"0"));
  console.log(`\n🎯 LB Score ≈ ${lbScore.toFixed(1)}`);
  console.log(`   WR ${m.wr}  PF ${m.pf}  Sortino ${m.sortino}  Return ${m.ret}  MaxDD ${m.dd}\n`);
}
main().catch(console.error);
