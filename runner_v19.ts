/**
 * Bond Vigilante — Backtest v19
 * v16 (LB 80.9) foundation + targeted improvements:
 * 1. BARS=5000 → ~833 days history (more trades, better validation)
 * 2. B-20Bar: Add "pre-breakout tightening" filter — last 5 bars' range
 *    must be contracting (avg range last 5 bars < avg range bars 6-15)
 *    This makes B-20Bar a genuine squeeze → breakout, not just any 20-bar break
 * 3. Q-Squeeze: Tighten volume threshold to 2.0 (was 1.8) — only take strong
 *    volume confirmations on the squeeze break
 * 4. N-NearIB: Same (proven anchor, 68% WR)
 * 5. Leverage: Same (BTC/ETH 3×, SOL 2.5×) — don't touch what works
 *
 * Expected: ~220-250 trades (vs 168 in v16), Return ~350-400% → LB ~120+
 */
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config({path:"/root/openclaw-acp/.env"});

const HL_API = "https://api.hyperliquid.xyz/info";
const PAIRS  = ["BTC","ETH","SOL"];
const BARS   = 5000;
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

  // ── SQUEEZE BREAKOUT (tighter volume) ──────────────
  {
    const atr3=bars.slice(i-3,i).reduce((s:number,b:any)=>s+(b.h-b.l),0)/3;
    const squeezed = atr3 < atrArr[i]*0.72;
    if(squeezed) {
      const sqHigh=Math.max(...bars.slice(i-4,i).map((b:any)=>b.h));
      const sqLow =Math.min(...bars.slice(i-4,i).map((b:any)=>b.l));
      if(reg==="bull"&&c.c>sqHigh&&c.c>c.o&&vr>2.0&&r>52&&r<78&&!lFund) {  // vol bumped 1.8→2.0
        return {side:"long",setup:"Q-Squeeze"};
      }
      if(reg==="bear"&&c.c<sqLow&&c.c<c.o&&vr>2.0&&r>22&&r<48&&!sFund) {
        return {side:"short",setup:"Q-Squeeze"};
      }
    }
  }

  // ── NEAR-INSIDE BAR BREAKOUT (unchanged) ─────────────────────────
  {
    const p2r=p2.h-p2.l,pr=p.h-p.l;
    const nearIB=pr<p2r*0.68&&p.h<=p2.h*1.001&&p.l>=p2.l*0.999;
    if(nearIB) {
      if(reg==="bull"&&c.c>p2.h*0.999&&c.c>c.o&&vr>1.7&&r>48&&r<75&&!lFund) {
        return {side:"long",setup:"N-NearIB"};
      }
      if(reg==="bear"&&c.c<p2.l*1.001&&c.c<c.o&&vr>1.7&&r>25&&r<52&&!sFund) {
        return {side:"short",setup:"N-NearIB"};
      }
    }
  }

  // ── 20-BAR BREAKOUT with pre-breakout tightening ─────────────────
  // New filter: last 5 bars' avg range must be < bars 6-20 avg range
  // (volatility was contracting before the breakout → genuine squeeze→break)
  {
    const h20=Math.max(...bars.slice(i-20,i-2).map((b:any)=>b.h));
    const l20=Math.min(...bars.slice(i-20,i-2).map((b:any)=>b.l));
    const recent5Rng = bars.slice(i-5,i).reduce((s:number,b:any)=>s+(b.h-b.l),0)/5;
    const prior15Rng = bars.slice(i-20,i-5).reduce((s:number,b:any)=>s+(b.h-b.l),0)/15;
    const contracting = recent5Rng < prior15Rng * 0.85; // range contracted 15%+ before break
    if(contracting) {
      if(reg==="bull"&&c.c>h20&&c.c>c.o&&r>58&&r<78&&vr>1.9&&!lFund) {
        return {side:"long",setup:"B-20Bar"};
      }
      if(reg==="bear"&&c.c<l20&&c.c<c.o&&r>22&&r<42&&vr>1.9&&!sFund) {
        return {side:"short",setup:"B-20Bar"};
      }
    }
  }

  return null;
}

interface Trade{pnlPct:number;won:boolean;setup:string;side:string;date:string;pair:string;}

async function runAll() {
  const D:Record<string,any>={};
  for(const pair of PAIRS){
    const [bars,fund]=await Promise.all([fetchBars(pair),fetchFunding(pair)]);
    D[pair]={bars,fund,rsi:calcRsi(bars),e9:calcEma(bars,9),e21:calcEma(bars,21),e55:calcEma(bars,55),atr:calcAtr(bars)};
  }
  const trades:Trade[]=[];
  const pos=new Map<string,{entry:number;side:"long"|"short";sl:number;tp:number;setup:string;barsHeld:number}>();
  let dStr="",wStr="",wPnl=0,pauseUntil=0,gCons=0;
  const dPnl:Record<string,number>={BTC:0,ETH:0,SOL:0};
  const dCons:Record<string,number>={BTC:0,ETH:0,SOL:0};
  const lev:Record<string,number>={BTC:3,ETH:3,SOL:2.5};
  const minLen=Math.min(...PAIRS.map(p=>D[p].bars.length));

  for(let i=80;i<minLen;i++){
    const today=new Date(D.BTC.bars[i].t).toISOString().slice(0,10);
    const week=today.slice(0,8)+Math.floor(+D.BTC.bars[i].t/604800000);
    if(today!==dStr){dStr=today;PAIRS.forEach(p=>{dPnl[p]=0;dCons[p]=0;});}
    if(week!==wStr){wStr=week;wPnl=0;}
    if(pauseUntil>0&&i>=pauseUntil)pauseUntil=0;

    for(const [pair,p2] of pos){
      const bar=D[pair].bars[i];
      p2.barsHeld++;
      let exit:number|null=null;
      if(p2.side==="long"){if(bar.l<=p2.sl)exit=p2.sl;else if(bar.h>=p2.tp)exit=p2.tp;}
      else{if(bar.h>=p2.sl)exit=p2.sl;else if(bar.l<=p2.tp)exit=p2.tp;}
      if(!exit&&p2.barsHeld>=14){exit=bar.c;}
      if(exit!==null){
        const raw=(p2.side==="long"?(exit-p2.entry)/p2.entry:(p2.entry-exit)/p2.entry);
        const pnl=raw*lev[pair]*100;
        dPnl[pair]+=pnl;wPnl+=pnl;
        if(pnl<0){dCons[pair]++;gCons++;}else{gCons=0;}
        trades.push({pnlPct:pnl,won:pnl>0,setup:p2.setup,side:p2.side,date:today,pair});
        pos.delete(pair);
      }
    }

    if(pauseUntil>0)continue;
    if(wPnl<-3.5){pauseUntil=i+7;continue;}
    if(gCons>=3){pauseUntil=i+6;gCons=0;continue;}

    for(const pair of PAIRS){
      if(pos.has(pair)||dPnl[pair]<-2||dCons[pair]>=2||pos.size>=2)continue;
      const d=D[pair];
      const sig=getSignal(d.bars,i,d.rsi,d.e9,d.e21,d.e55,d.atr,d.fund);
      if(!sig)continue;
      const atrV=d.atr[i],entry=d.bars[i].c;
      const sl=sig.side==="long"?entry-atrV:entry+atrV;
      const tp=sig.side==="long"?entry+atrV*2:entry-atrV*2;
      pos.set(pair,{entry,side:sig.side,sl,tp,setup:sig.setup,barsHeld:0});
    }
  }
  return trades;
}

function metrics(trades: Trade[]) {
  if(!trades.length)return{n:0,wr:"—",ret:"—",pf:"—",sortino:"—",dd:"—",setups:"—",lb:"—"};
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
  const lb=0.4*sort+0.35*ret+0.25*pf;
  return {
    n:trades.length,wr:(wr*100).toFixed(0)+"%",ret:ret.toFixed(1)+"%",pf:pf.toFixed(2),
    sortino:sort.toFixed(2),dd:(maxDD*100).toFixed(2)+"%",
    setups:Object.entries(sc).map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`).join(" | "),
    lb:lb.toFixed(1)
  };
}

async function main() {
  console.log("\n📊 Bond Vigilante v19 — 5000 bars + B-20Bar pre-squeeze filter\n");
  const allTrades=await runAll();
  const pp:Record<string,Trade[]>={BTC:[],ETH:[],SOL:[]};
  allTrades.forEach(t=>pp[t.pair].push(t));

  console.log("Pair    N     WR%    Return%   PF      Sortino  MaxDD   Setups");
  console.log("─".repeat(120));
  for(const pair of PAIRS){
    const m=metrics(pp[pair]);
    console.log(pair.padEnd(8)+String(m.n).padEnd(6)+String(m.wr).padEnd(7)+String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+String(m.dd).padEnd(8)+m.setups);
  }
  console.log("─".repeat(120));
  const m=metrics(allTrades);
  console.log("TOTAL".padEnd(8)+String(m.n).padEnd(6)+String(m.wr).padEnd(7)+String(m.ret).padEnd(10)+String(m.pf).padEnd(8)+String(m.sortino).padEnd(9)+String(m.dd).padEnd(8)+m.setups);
  console.log(`\n  🏆 LB Score ≈ ${m.lb}  |  WR ${m.wr}  PF ${m.pf}  Sortino ${m.sortino}  Return ${m.ret}`);
  console.log(`  Formula: 0.4×${m.sortino} + 0.35×${m.ret} + 0.25×${m.pf} = ${m.lb}\n`);
}
main().catch(console.error);
