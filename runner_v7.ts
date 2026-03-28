/**
 * Bond Vigilante — Backtest v7
 * Key fixes from v6:
 * - Funding rate thresholds corrected (raw decimal, not *100)
 * - Looser but higher-quality sweep conditions
 * - Partial TP at 1R → breakeven SL (improves WR)
 * - Tighter TP (2.2x ATR) for more closed winners
 * - Primary: EMA21+EMA55 trend regime (v3 foundation)
 * - Secondary: Setup B only when funding strongly directional
 */
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config({ path: "/root/openclaw-acp/.env" });

const HL_API = "https://api.hyperliquid.xyz/info";
const PAIRS  = ["BTC", "ETH", "SOL"];
const BARS   = 500; // ~83 days of 4h candles

async function fetchHistory(pair: string): Promise<any[]> {
  const ms=14400000, end=Date.now(), start=end-ms*BARS;
  const res = await axios.post(HL_API, {
    type:"candleSnapshot",
    req:{coin:pair,interval:"4h",startTime:start,endTime:end}
  });
  return (res.data??[]).map((c:any)=>({
    t:+c.t,o:+c.o,h:+c.h,l:+c.l,c:+c.c,v:+c.v
  }));
}

async function fetchFunding(pair: string): Promise<Map<number,number>> {
  const res = await axios.post(HL_API, {
    type:"fundingHistory", coin:pair,
    startTime:Date.now()-14400000*BARS
  });
  const map = new Map<number,number>();
  // Key: 8h bucket (Hyperliquid pays every 8h)
  for(const f of (res.data??[])) {
    const bucket = Math.floor(+f.time / 28800000) * 28800000;
    map.set(bucket, parseFloat(f.fundingRate??"0")); // raw decimal
  }
  return map;
}

function getFunding(funding: Map<number,number>, t: number): number {
  // Find closest 8h bucket for this candle
  const bucket = Math.floor(t / 28800000) * 28800000;
  return funding.get(bucket) ?? funding.get(bucket - 28800000) ?? 0;
}

function ema(bars: any[], p: number): number[] {
  const k=2/(p+1), out=[bars[0].c];
  for(let i=1;i<bars.length;i++) out.push(bars[i].c*k+out[i-1]*(1-k));
  return out;
}

function rsi(bars: any[], p=14): number[] {
  const out=new Array(p).fill(50);
  let gS=0,lS=0;
  for(let i=1;i<=p;i++){
    const d=bars[i].c-bars[i-1].c;
    if(d>0)gS+=d; else lS+=Math.abs(d);
  }
  let ag=gS/p, al=lS/p;
  out[p]=100-100/(1+ag/Math.max(al,1e-9));
  for(let i=p+1;i<bars.length;i++){
    const d=bars[i].c-bars[i-1].c;
    ag=(ag*(p-1)+(d>0?d:0))/p;
    al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
    out[i]=100-100/(1+ag/Math.max(al,1e-9));
  }
  return out;
}

function atr(bars: any[], p=14): number[] {
  const trs=bars.map((b:any,i:number)=>
    !i?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c))
  );
  const out: number[]=[];
  for(let i=0;i<trs.length;i++){
    if(i<p){ out.push(trs.slice(0,i+1).reduce((a:number,b:number)=>a+b,0)/(i+1)); continue; }
    out.push((out[i-1]*(p-1)+trs[i])/p);
  }
  return out;
}

function volSpike(bars: any[], i: number, mult=1.5): boolean {
  if(i<20) return false;
  const avg=bars.slice(i-20,i).reduce((s:number,b:any)=>s+b.v,0)/20;
  return bars[i].v > avg*mult;
}

function swingLow(bars: any[], i: number, lookback=6): number {
  return Math.min(...bars.slice(Math.max(0,i-lookback),i).map((b:any)=>b.l));
}

function swingHigh(bars: any[], i: number, lookback=6): number {
  return Math.max(...bars.slice(Math.max(0,i-lookback),i).map((b:any)=>b.h));
}

// ── Signal engine v7 ─────────────────────────────────────
interface Signal { side:"long"|"short"; setup:string; score:number }

function getSignal(
  bars: any[], i: number,
  rsiA: number[], e21: number[], e55: number[],
  atrA: number[], funding: Map<number,number>
): Signal | null {
  if(i < 60) return null;
  const cur=bars[i], prev=bars[i-1], prev2=bars[i-2];
  const f = getFunding(funding, cur.t); // raw decimal
  const r = rsiA[i];
  const vol = volSpike(bars,i);

  // Funding signal direction (corrected thresholds for raw decimal)
  // Typical 8h rate: -0.00003 to +0.00002
  const shortsCrowded = f < -0.000010; // persistently negative → longs favored
  const longsCrowded  = f > 0.000008;  // elevated positive → shorts favored
  const fundingNeutral= !shortsCrowded && !longsCrowded;

  // ════ SETUP A: EMA TREND CONTINUATION ════════════════════
  // Bull regime: EMA21 > EMA55, price above both
  // Entry: sweep of recent swing low then reclaim (bullish reversal candle)
  {
    const bullRegime = e21[i] > e55[i] && cur.c > e55[i];
    const bearRegime = e21[i] < e55[i] && cur.c < e55[i];
    const sl5 = swingLow(bars,i,5);
    const sh5 = swingHigh(bars,i,5);

    if(bullRegime) {
      // Swept low + closed back above it + bullish candle
      const swept = prev.l < sl5 && cur.c > sl5;
      const bullCandle = cur.c > cur.o && cur.c > prev.c;
      const notOverbought = r < 68;
      const fundingOK = !longsCrowded; // don't buy when longs too crowded

      if(swept && bullCandle && fundingOK) {
        let score = 3;
        if(vol) score++;
        if(notOverbought) score++;
        if(shortsCrowded) score++; // extra: shorts being squeezed
        if(cur.c > e21[i]) score++; // reclaimed EMA21
        if(score >= 4) return { side:"long", setup:"A-Bull", score };
      }
    }

    if(bearRegime) {
      // Swept high + closed back below it + bearish candle
      const swept = prev.h > sh5 && cur.c < sh5;
      const bearCandle = cur.c < cur.o && cur.c < prev.c;
      const notOversold = r > 32;
      const fundingOK = !shortsCrowded;

      if(swept && bearCandle && fundingOK) {
        let score = 3;
        if(vol) score++;
        if(notOversold) score++;
        if(longsCrowded) score++;
        if(cur.c < e21[i]) score++;
        if(score >= 4) return { side:"short", setup:"A-Bear", score };
      }
    }
  }

  // ════ SETUP B: COUNTER-TREND REVERSAL ════════════════════
  // When price is extended + sweep + strong reversal candle + funding extreme
  {
    // Check if recent move was extended (5% drop in 6 bars or 5% rise)
    const recentLow  = Math.min(...bars.slice(i-6,i).map((b:any)=>b.l));
    const recentHigh = Math.max(...bars.slice(i-6,i).map((b:any)=>b.h));
    const dropExtended  = (bars[i-6].c - recentLow) / bars[i-6].c > 0.04;
    const riseExtended  = (recentHigh - bars[i-6].c) / bars[i-6].c > 0.04;

    // Relief long: extended dump + shorts crowded + sweep + reversal
    if(dropExtended && shortsCrowded) {
      const swLow = swingLow(bars,i,8);
      const swept = prev.l < swLow;
      const reversal = cur.c > prev.o && cur.c > prev.c * 1.005; // strong recovery candle
      const rsiOS = r < 40;

      if(swept && reversal && rsiOS) {
        let score = 4;
        if(vol) score++;
        if(cur.c > e21[i] * 0.995) score++; // near EMA recovery
        return { side:"long", setup:"B-Relief", score };
      }
    }

    // Dead-cat short: extended bounce + longs crowded + sweep high + rejection
    if(riseExtended && longsCrowded) {
      const swHigh = swingHigh(bars,i,8);
      const swept = prev.h > swHigh;
      const rejection = cur.c < prev.o && cur.c < prev.c * 0.995;
      const rsiOB = r > 60;

      if(swept && rejection && rsiOB) {
        let score = 4;
        if(vol) score++;
        if(cur.c < e21[i] * 1.005) score++;
        return { side:"short", setup:"B-DeadCat", score };
      }
    }
  }

  // ════ SETUP C: ENGULF / STRONG REVERSAL BAR ════════════════
  // No-sweep version: just needs engulf + extreme RSI + volume + EMA alignment
  {
    const bullEngulf = cur.c > prev.h && cur.o < prev.l; // full bull engulf
    const bearEngulf = cur.c < prev.l && cur.o > prev.h; // full bear engulf

    if(bullEngulf && r < 35 && vol && e21[i] > e55[i]*0.98) {
      const f_ok = !longsCrowded;
      if(f_ok) return { side:"long", setup:"C-BullEngulf", score: 5 };
    }
    if(bearEngulf && r > 65 && vol && e21[i] < e55[i]*1.02) {
      const f_ok = !shortsCrowded;
      if(f_ok) return { side:"short", setup:"C-BearEngulf", score: 5 };
    }
  }

  return null;
}

// ── Simulate ──────────────────────────────────────────────
interface Trade {
  pnlPct:number; won:boolean; score:number; setup:string;
  entry:number; exit:number; side:string; date:string;
}

function simulate(bars: any[], funding: Map<number,number>, pair: string) {
  const rsiA=rsi(bars), e21=ema(bars,21), e55=ema(bars,55), atrA=atr(bars);
  const trades: Trade[]=[];
  let pos: {
    entry:number; side:"long"|"short"; sl:number; tp:number;
    score:number; setup:string; partialDone:boolean; atrEntry:number;
  }|null=null;
  let dailyPnl=0, dayStr="", consLoss=0, totalSeen=0;

  // Per-pair leverage
  const lev = pair==="BTC"?3 : pair==="ETH"?3 : 2.5;

  for(let i=60;i<bars.length;i++){
    const bar=bars[i], today=new Date(bar.t).toISOString().slice(0,10);
    if(today!==dayStr){ dailyPnl=0; dayStr=today; }

    if(pos){
      const{entry,side,sl,tp,atrEntry}=pos;

      // Partial TP at 1.0R → move SL to entry (breakeven)
      if(!pos.partialDone){
        const tp1r = side==="long" ? entry+atrEntry : entry-atrEntry;
        if((side==="long"&&bar.h>=tp1r)||(side==="short"&&bar.l<=tp1r)){
          pos.partialDone=true;
          pos.sl = entry; // breakeven stop
        }
      }

      // Check SL/TP hit
      let exit: number|null=null;
      let hitSL=false;
      if(side==="long"){
        if(bar.l<=pos.sl){exit=pos.sl;hitSL=true;}
        else if(bar.h>=tp){exit=tp;}
      } else {
        if(bar.h>=pos.sl){exit=pos.sl;hitSL=true;}
        else if(bar.l<=tp){exit=tp;}
      }

      if(exit!==null){
        const raw=(side==="long"?(exit-entry)/entry:(entry-exit)/entry);
        const pnlPct=raw*lev*100;
        dailyPnl+=pnlPct;
        if(pnlPct<=0) consLoss++; else consLoss=0;
        trades.push({
          pnlPct, won:pnlPct>0, score:pos.score,
          setup:pos.setup, entry, exit:exit, side, date:today
        });
        pos=null;
      }
    }

    // Risk controls: daily stop -1.5%, max 2 consecutive losses
    if(dailyPnl<-1.5||consLoss>=2||pos) continue;

    const sig=getSignal(bars,i,rsiA,e21,e55,atrA,funding);
    if(!sig) continue;
    totalSeen++;
    if(sig.score<4) continue;

    const atrV=atrA[i], entry=bar.c;
    // Setup-specific R:R
    let slMult=1.2, tpMult=2.2;
    if(sig.setup.startsWith("B")){ slMult=1.0; tpMult=2.5; } // tighter SL, wider TP for reversals
    if(sig.setup.startsWith("C")){ slMult=0.8; tpMult=2.0; } // engulf: very tight SL

    const sl = sig.side==="long" ? entry-atrV*slMult : entry+atrV*slMult;
    const tp = sig.side==="long" ? entry+atrV*tpMult : entry-atrV*tpMult;
    pos={entry,side:sig.side,sl,tp,score:sig.score,setup:sig.setup,partialDone:false,atrEntry:atrV};
  }

  return {trades,totalSeen};
}

// ── Metrics ────────────────────────────────────────────────
function metrics(trades: Trade[], seen: number) {
  if(!trades.length) return {
    trades:0,seen,winRate:"0%",returnPct:"0%",pf:"—",sortino:"—",
    maxDD:"0%",avgScore:"—",setupBreakdown:"—"
  };

  const wins=trades.filter(t=>t.won);
  const gross=wins.reduce((s,t)=>s+t.pnlPct,0);
  const loss=Math.abs(trades.filter(t=>!t.won).reduce((s,t)=>s+t.pnlPct,0));
  const ret=trades.reduce((s,t)=>s+t.pnlPct,0);
  const pf=loss>0?gross/loss:Infinity;
  const mean=ret/trades.length;
  const negArr=trades.filter(t=>t.pnlPct<0).map(t=>t.pnlPct-mean);
  const downDev=negArr.length?Math.sqrt(negArr.reduce((a,b)=>a+b*b,0)/negArr.length):0.001;
  const sortino=mean/downDev;

  let eq=1,peak=1,maxDD=0;
  for(const t of trades){
    eq*=(1+t.pnlPct/100);
    if(eq>peak) peak=eq;
    const dd=(peak-eq)/peak;
    if(dd>maxDD) maxDD=dd;
  }

  const setupCount: Record<string,{w:number;t:number}> = {};
  for(const t of trades){
    if(!setupCount[t.setup]) setupCount[t.setup]={w:0,t:0};
    setupCount[t.setup].t++;
    if(t.won) setupCount[t.setup].w++;
  }

  return {
    trades:trades.length, seen,
    winRate:((wins.length/trades.length)*100).toFixed(0)+"%",
    returnPct:ret.toFixed(1)+"%",
    pf:pf===Infinity?"∞":pf.toFixed(2),
    sortino:sortino.toFixed(2),
    maxDD:(maxDD*100).toFixed(2)+"%",
    avgScore:(trades.reduce((s,t)=>s+t.score,0)/trades.length).toFixed(1),
    setupBreakdown:Object.entries(setupCount)
      .map(([k,v])=>`${k}:${v.w}/${v.t}(${((v.w/v.t)*100).toFixed(0)}%)`)
      .join(" | ")
  };
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log("\n📊 Bond Vigilante v7 — Fixed Thresholds + Multi-Setup\n");
  console.log("Pair    Trades  Seen  WR%    Return%   PF      Sortino  MaxDD   Score  Setups");
  console.log("─".repeat(100));

  let all: Trade[]=[], totalSeen=0;

  for(const pair of PAIRS){
    try{
      const[bars,funding]=await Promise.all([fetchHistory(pair),fetchFunding(pair)]);
      const{trades,totalSeen:seen}=simulate(bars,funding,pair);
      const m=metrics(trades,seen);
      all=[...all,...trades]; totalSeen+=seen;
      console.log(
        pair.padEnd(8)+
        String(m.trades).padEnd(8)+
        String(m.seen).padEnd(6)+
        String(m.winRate).padEnd(7)+
        String(m.returnPct).padEnd(10)+
        String(m.pf).padEnd(8)+
        String(m.sortino).padEnd(9)+
        String(m.maxDD).padEnd(8)+
        String(m.avgScore).padEnd(7)+
        m.setupBreakdown
      );
    }catch(e:any){ console.log(pair.padEnd(8)+"ERROR: "+e.message); }
  }

  console.log("─".repeat(100));
  const m=metrics(all,totalSeen);
  console.log(
    "TOTAL".padEnd(8)+
    String(m.trades).padEnd(8)+
    String(m.seen).padEnd(6)+
    String(m.winRate).padEnd(7)+
    String(m.returnPct).padEnd(10)+
    String(m.pf).padEnd(8)+
    String(m.sortino).padEnd(9)+
    String(m.maxDD).padEnd(8)+
    String(m.avgScore).padEnd(7)+
    m.setupBreakdown
  );
  console.log(`\n🎯 LB Target:  WR >55%, PF >2.5, Sortino >0.8, Return >30%`);
  console.log(`   Backtest:   WR ${m.winRate}, PF ${m.pf}, Sortino ${m.sortino}, Return ${m.returnPct}\n`);

  // Show sample trades for debugging
  if(all.length<10 || process.argv.includes("--debug")){
    console.log("\n📋 All trades:");
    for(const t of all){
      console.log(`  ${t.date} ${t.side.toUpperCase().padEnd(6)} ${t.setup.padEnd(15)} PnL:${t.pnlPct.toFixed(2)}% score:${t.score} ${t.won?"✅":"❌"}`);
    }
  }
}

main().catch(console.error);
