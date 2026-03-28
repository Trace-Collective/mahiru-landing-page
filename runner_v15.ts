/**
 * Bond Vigilante — Backtest v15 LEADERBOARD-OPTIMIZED
 * Target: WR 65%+, PF 2.5+, Sortino 0.5+, MaxDD <30%
 *
 * DegenerateClaw Scoring = 0.4×Sortino + 0.35×Return% + 0.25×PF
 * WR does NOT directly affect leaderboard score.
 * High PF + High Sortino + High Return = winning formula.
 *
 * Strategy:
 * - SIGNAL TIER A: M3-NearIB (65% WR) → clean 1:3 R:R (TP=3×ATR, SL=1×ATR)
 *   → High PF: (0.65×3)/(0.35×1) = 5.57 theoretical!
 * - SIGNAL TIER B: M1-Break (58% WR) → tiered 0.6/2.5 exit for WR boost
 * - POSITION SIZE: 100% for Tier A, 75% for Tier B (reduced)
 * - RISK MGMT: daily -2%, global 3-loss pause, weekly -3.5% stop
 * - MAX OPEN: 1 position per pair (no correlation blowup)
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

interface Sig { side:"long"|"short"; setup:string; tier:"A"|"B"; quality:number }

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

  // ━━━ TIER A: Near-Inside Bar Breakout ━━━━━━━━━━━━━━━━━━
  // Best signal: 65-70% WR. Use FULL 1:3 R:R for max PF.
  {
    const p2r=p2.h-p2.l, pr=p.h-p.l;
    const nearInside = pr < p2r*0.68 && p.h<=p2.h*1.001 && p.l>=p2.l*0.999;
    if(nearInside) {
      if(reg==="bull" && c.c>p2.h*0.999 && c.c>c.o && vr>1.7 && r>48&&r<75&&!lFund) {
        let q=3; if(vr>2.2)q++; if(sFund)q++; if(r>58)q++; if(c.c>e21[i])q++;
        if(q>=4) return {side:"long",setup:"A-NearIB",tier:"A",quality:q};
      }
      if(reg==="bear" && c.c<p2.l*1.001 && c.c<c.o && vr>1.7 && r>25&&r<52&&!sFund) {
        let q=3; if(vr>2.2)q++; if(lFund)q++; if(r<42)q++; if(c.c<e21[i])q++;
        if(q>=4) return {side:"short",setup:"A-NearIB",tier:"A",quality:q};
      }
    }
  }

  // ━━━ TIER B: 20-Bar Breakout ━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Decent signal: 58-60% WR. Use tiered exit for WR boost.
  {
    const h20=Math.max(...bars.slice(i-20,i-2).map((b:any)=>b.h));
    const l20=Math.min(...bars.slice(i-20,i-2).map((b:any)=>b.l));
    if(reg==="bull"&&c.c>h20&&c.c>c.o&&r>60&&r<78&&vr>2.0&&!lFund) {
      let q=3; if(vr>2.5)q++; if(sFund)q++; if(r>65)q++;
      return {side:"long",setup:"B-Break",tier:"B",quality:q};
    }
    if(reg==="bear"&&c.c<l20&&c.c<c.o&&r>22&&r<40&&vr>2.0&&!sFund) {
      let q=3; if(vr>2.5)q++; if(lFund)q++; if(r<35)q++;
      return {side:"short",setup:"B-Break",tier:"B",quality:q};
    }
  }

  // ━━━ TIER A: 3-bar acceleration (bonus signal) ━━━━━━━━━
  {
    const b3=c.c>c.o&&p.c>p.o&&p2.c>p2.o, d3=c.c<c.o&&p.c<p.o&&p2.c<p2.o;
    const mv=Math.abs(c.c-p2.o)/p2.o*100;
    if(reg==="bull"&&b3&&mv>4.0&&vr>2.5&&r>58&&r<75&&!lFund) {
      return {side:"long",setup:"A-Accel",tier:"A",quality:5};
    }
    if(reg==="bear"&&d3&&mv>4.0&&vr>2.5&&r>25&&r<42&&!sFund) {
      return {side:"short",setup:"A-Accel",tier:"A",quality:5};
    }
  }

  return null;
}

interface Trade {
  pnlPct:number; won:boolean; setup:string; tier:string; side:string; date:string; pair:string;
}

interface Pos {
  pair:string; entry:number; side:"long"|"short"; sl:number; tp1:number; tp2:number;
  tier:"A"|"B"; setup:string; partial:boolean; barsHeld:number;
  sizeMult:number; // 1.0 for A, 0.75 for B
}

async function runAll() {
  const allBars:Record<string,any[]>={}, allFund:Record<string,Map<number,number>>={};
  const allRsi:Record<string,number[]>={}, allE9:Record<string,number[]>={};
  const allE21:Record<string,number[]>={}, allE55:Record<string,number[]>={};
  const allAtr:Record<string,number[]>={};

  for(const pair of PAIRS) {
    const [bars,fund]=await Promise.all([fetchBars(pair),fetchFunding(pair)]);
    allBars[pair]=bars; allFund[pair]=fund;
    allRsi[pair]=calcRsi(bars);
    allE9[pair]=calcEma(bars,9); allE21[pair]=calcEma(bars,21); allE55[pair]=calcEma(bars,55);
    allAtr[pair]=calcAtr(bars);
  }

  const trades:Trade[]=[];
  const positions=new Map<string,Pos>();
  const pairDailyPnl:Record<string,number>={BTC:0,ETH:0,SOL:0};
  const pairConsDay:Record<string,number>={BTC:0,ETH:0,SOL:0};
  let dayStr="", weekStr="", weeklyPnl=0, globalCons=0, pauseUntil=0;
  const baseLev:Record<string,number>={BTC:3,ETH:3,SOL:2.5};
  const minLen=Math.min(...PAIRS.map(p=>allBars[p].length));

  for(let i=80; i<minLen; i++) {
    const bar0=allBars["BTC"][i];
    const today=new Date(bar0.t).toISOString().slice(0,10);
    const week=today.slice(0,8)+Math.floor(+bar0.t/604800000);
    if(today!==dayStr){dayStr=today;PAIRS.forEach(p=>{pairDailyPnl[p]=0;pairConsDay[p]=0;});}
    if(week!==weekStr){weekStr=week;weeklyPnl=0;}
    if(pauseUntil>0&&i>=pauseUntil) pauseUntil=0;

    // ─ Process open positions ─
    for(const [pair,pos] of positions) {
      const bar=allBars[pair][i];
      pos.barsHeld++;
      const {entry,side,sizeMult} = pos;
      const lev=baseLev[pair]*sizeMult;

      let exit:number|null=null, isWin=false, pnlPct=0;

      if(pos.tier==="A") {
        // TIER A: Clean 1:3 exit — no partial
        if(side==="long"){if(bar.l<=pos.sl){exit=pos.sl;}else if(bar.h>=pos.tp2){exit=pos.tp2;isWin=true;}}
        else{if(bar.h>=pos.sl){exit=pos.sl;}else if(bar.l<=pos.tp2){exit=pos.tp2;isWin=true;}}
        // Time exit at 15 bars
        if(!exit&&pos.barsHeld>=15){exit=bar.c;isWin=(side==="long"?bar.c>entry:bar.c<entry);}
        if(exit!==null){
          const raw=(side==="long"?(exit-entry)/entry:(entry-exit)/entry);
          pnlPct=raw*lev*100;
          isWin=pnlPct>0;
        }
      } else {
        // TIER B: Tiered exit 0.6/2.5 for WR boost
        if(!pos.partial){
          const tp1chk=side==="long"?bar.h>=pos.tp1:bar.l<=pos.tp1;
          if(side==="long"&&bar.l<=pos.sl){exit=pos.sl;isWin=false;}
          else if(side==="short"&&bar.h>=pos.sl){exit=pos.sl;isWin=false;}
          else if(tp1chk){
            pos.partial=true; pos.sl=entry;
            const tp2chk=side==="long"?bar.h>=pos.tp2:bar.l<=pos.tp2;
            if(tp2chk){exit=pos.tp2;isWin=true;}
          }
        } else {
          if(side==="long"){if(bar.l<=pos.sl){exit=pos.sl;}else if(bar.h>=pos.tp2){exit=pos.tp2;isWin=true;}}
          else{if(bar.h>=pos.sl){exit=pos.sl;}else if(bar.l<=pos.tp2){exit=pos.tp2;isWin=true;}}
        }
        if(!exit&&pos.barsHeld>=12){exit=bar.c;}
        if(exit!==null&&!pnlPct){
          if(pos.partial){
            const g1=(side==="long"?(pos.tp1-entry)/entry:(entry-pos.tp1)/entry);
            const g2=(side==="long"?(exit-entry)/entry:(entry-exit)/entry);
            pnlPct=(g1*0.5+g2*0.5)*lev*100;
          } else {
            pnlPct=(side==="long"?(exit-entry)/entry:(entry-exit)/entry)*lev*100;
          }
          isWin=pnlPct>0;
        }
      }

      if(exit!==null){
        pairDailyPnl[pair]+=pnlPct; weeklyPnl+=pnlPct;
        if(pnlPct<0){pairConsDay[pair]++;globalCons++;}else{globalCons=0;}
        trades.push({pnlPct,won:isWin,setup:pos.setup,tier:pos.tier,side,date:today,pair});
        positions.delete(pair);
      }
    }

    // ─ Risk controls ─
    if(pauseUntil>0){continue;}
    if(weeklyPnl<-3.5){pauseUntil=i+7;continue;}
    if(globalCons>=3){pauseUntil=i+7;globalCons=0;continue;}

    // ─ New entries ─
    for(const pair of PAIRS){
      if(positions.has(pair)) continue;
      if(pairDailyPnl[pair]<-2||pairConsDay[pair]>=2) continue;

      const sig=getSignal(allBars[pair],i,allRsi[pair],allE9[pair],allE21[pair],allE55[pair],allAtr[pair],allFund[pair]);
      if(!sig) continue;

      const atrV=allAtr[pair][i], entry=allBars[pair][i].c;
      const sizeMult=sig.tier==="A"?1.0:0.75;
      const sl=sig.side==="long"?entry-atrV:entry+atrV;

      let tp1:number, tp2:number;
      if(sig.tier==="A"){
        // Clean 1:3 — tp1 not used (set same as tp2 for simplicity)
        tp1=sig.side==="long"?entry+atrV*3:entry-atrV*3;
        tp2=tp1;
      } else {
        tp1=sig.side==="long"?entry+atrV*0.6:entry-atrV*0.6;
        tp2=sig.side==="long"?entry+atrV*2.5:entry-atrV*2.5;
      }

      positions.set(pair,{pair,entry,side:sig.side,sl,tp1,tp2,tier:sig.tier,setup:sig.setup,partial:false,barsHeld:0,sizeMult});
    }
  }
  return trades;
}

function calcMetrics(trades: Trade[]) {
  if(!trades.length) return {n:0,wr:"—",ret:"—",pf:"—",sortino:"—",dd:"—",setups:"—",lbScore:"—"};
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

  const sortVal=(mean/dDev);
  const lbScore=0.4*sortVal+0.35*ret+0.25*pf;
  return {
    n:trades.length,
    wr:((wins.length/trades.length)*100).toFixed(0)+"%",
    ret:ret.toFixed(1)+"%",
    pf:pf.toFixed(2),
    sortino:sortVal.toFixed(2),
    dd:(maxDD*100).toFixed(2)+"%",
    setups:Object.entries(sc).map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`).join(" | "),
    lbScore:lbScore.toFixed(1)
  };
}

async function main() {
  console.log("\n📊 Bond Vigilante v15 — LEADERBOARD OPTIMIZED\n");
  console.log("Tier A (NearIB/Accel) → clean 1:3 R:R → Max PF");
  console.log("Tier B (20-bar Break) → tiered exit → WR boost\n");

  const allTrades = await runAll();
  const m = calcMetrics(allTrades);

  const perPair:Record<string,Trade[]>={BTC:[],ETH:[],SOL:[]};
  allTrades.forEach(t=>perPair[t.pair].push(t));

  console.log("Pair    N     WR%    Return%   PF      Sortino  MaxDD   Setups");
  console.log("─".repeat(100));
  for(const pair of PAIRS){
    const pm=calcMetrics(perPair[pair]);
    console.log(pair.padEnd(8)+String(pm.n).padEnd(6)+String(pm.wr).padEnd(7)+String(pm.ret).padEnd(10)+String(pm.pf).padEnd(8)+String(pm.sortino).padEnd(9)+String(pm.dd).padEnd(8)+pm.setups);
  }
  console.log("─".repeat(100));
  console.log("TOTAL".padEnd(8)+String(m.n).padEnd(6)+String(m.wr).padEnd(7)+String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+String(m.dd).padEnd(8)+m.setups);

  console.log(`\n════════════════════════════════════════`);
  console.log(`  🏆 LB Score = 0.4×${m.sortino} + 0.35×${m.ret} + 0.25×${m.pf}`);
  console.log(`  🏆 LB Score ≈ ${m.lbScore}`);
  console.log(`  WR ${m.wr}  PF ${m.pf}  Sortino ${m.sortino}  MaxDD ${m.dd}`);
  console.log(`  Compare: 80% WR alt → LB Score ≈ 15-20 (4x WORSE)`);
  console.log(`════════════════════════════════════════\n`);
}
main().catch(console.error);
