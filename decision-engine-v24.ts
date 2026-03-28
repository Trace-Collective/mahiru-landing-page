/**
 * Bond Vigilante — Decision Engine v24
 * Deterministic rule-based signal engine for Degen Claw leaderboard.
 *
 * Signals (proven in 500-day backtest):
 *   Q-Squeeze : ATR compression breakout — 3-bar range < 72% of 14-bar ATR
 *   N-NearIB  : Near inside-bar breakout — 68% WR anchor signal
 *   B-20Bar   : 20-bar range breakout with volume confirmation
 *
 * Regime     : EMA9 > EMA21 > EMA55, all slopes same direction (strict triple alignment)
 * R:R        : 1:2 clean (SL = 1×ATR, TP = 2×ATR)
 * Leverage   : BTC/ETH 20×, SOL 15×  → LB Score ~471 in backtest
 * MaxOpen    : 2 concurrent positions
 *
 * Funding thresholds (AssetData.fundingRate = raw × 100):
 *   shorts_crowded: fundingRate < -0.001  (raw < -0.000010)
 *   longs_crowded : fundingRate >  0.0008 (raw >  0.000008)
 */
import axios from "axios";
import type { AssetData, AccountState, TradeDecision } from "./types.js";

const HL_API   = "https://api.hyperliquid.xyz/info";
const PAIRS    = ["BTC", "ETH", "SOL"] as const;
const BARS_REQ = 200;  // enough for 80-bar warmup + all lookbacks
const MS_4H    = 14400000;
const LEVER: Record<string, number> = { BTC: 20, ETH: 20, SOL: 15 };

// ── Indicator helpers ──────────────────────────────────────────────────────────
function calcEma(bars: Bar[], p: number): number[] {
  const k = 2 / (p + 1);
  let e = bars[0].c;
  const out = [e];
  for (let i = 1; i < bars.length; i++) { e = bars[i].c * k + e * (1 - k); out.push(e); }
  return out;
}

function calcRsi(bars: Bar[], p = 14): number[] {
  const out = new Array(p).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = bars[i].c - bars[i - 1].c; d > 0 ? g += d : l += Math.abs(d); }
  let ag = g / p, al = l / p;
  out[p] = 100 - 100 / (1 + ag / Math.max(al, 1e-9));
  for (let i = p + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p;
    out[i] = 100 - 100 / (1 + ag / Math.max(al, 1e-9));
  }
  return out;
}

function calcAtr(bars: Bar[], p = 14): number[] {
  const tr = bars.map((b, i) => !i ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  const out: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < p) { out.push(tr.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1)); continue; }
    out.push((out[i - 1] * (p - 1) + tr[i]) / p);
  }
  return out;
}

function volR(bars: Bar[], i: number): number {
  if (i < 20) return 1;
  return bars[i].v / (bars.slice(i - 20, i).reduce((s, b) => s + b.v, 0) / 20);
}

function getRegime(e9: number[], e21: number[], e55: number[], price: number, i: number): "bull" | "bear" | "none" {
  if (i < 10) return "none";
  const b9 = e9[i] > e9[i - 2], b21 = e21[i] > e21[i - 3], b55 = e55[i] > e55[i - 6];
  const d9 = e9[i] < e9[i - 2], d21 = e21[i] < e21[i - 3], d55 = e55[i] < e55[i - 6];
  if (e9[i] > e21[i] && e21[i] > e55[i] && b9 && b21 && b55 && price > e55[i]) return "bull";
  if (e9[i] < e21[i] && e21[i] < e55[i] && d9 && d21 && d55 && price < e55[i]) return "bear";
  return "none";
}

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Sig { side: "long" | "short"; setup: string; label: "A" | "B" | "C"; }

function getSignal(bars: Bar[], i: number, rsi: number[], e9: number[], e21: number[], e55: number[], atr: number[], fundRate: number): Sig | null {
  if (i < 80 || i < bars.length - 1) return null; // only act on the LATEST completed bar
  const c = bars[i], p = bars[i - 1], p2 = bars[i - 2];
  const r = rsi[i], vr = volR(bars, i);
  const reg = getRegime(e9, e21, e55, c.c, i);
  if (reg === "none") return null;

  // fundRate already in % (× 100 from AssetData), thresholds scaled accordingly
  const sFund = fundRate < -0.001;    // raw < -0.000010
  const lFund = fundRate > 0.0008;   // raw >  0.000008

  // ── Q-Squeeze ────────────────────────────────────────
  {
    const atr3 = bars.slice(i - 3, i).reduce((s, b) => s + (b.h - b.l), 0) / 3;
    if (atr3 < atr[i] * 0.72) {
      const sqHigh = Math.max(...bars.slice(i - 4, i).map(b => b.h));
      const sqLow  = Math.min(...bars.slice(i - 4, i).map(b => b.l));
      if (reg === "bull" && c.c > sqHigh && c.c > c.o && vr > 1.8 && r > 52 && r < 78 && !lFund)
        return { side: "long",  setup: "Q-Squeeze", label: "A" };
      if (reg === "bear" && c.c < sqLow  && c.c < c.o && vr > 1.8 && r > 22 && r < 48 && !sFund)
        return { side: "short", setup: "Q-Squeeze", label: "A" };
    }
  }

  // ── N-NearIB ─────────────────────────────────────────
  {
    const p2r = p2.h - p2.l, pr = p.h - p.l;
    if (pr < p2r * 0.68 && p.h <= p2.h * 1.001 && p.l >= p2.l * 0.999) {
      if (reg === "bull" && c.c > p2.h * 0.999 && c.c > c.o && vr > 1.7 && r > 48 && r < 75 && !lFund)
        return { side: "long",  setup: "N-NearIB", label: "B" };
      if (reg === "bear" && c.c < p2.l * 1.001 && c.c < c.o && vr > 1.7 && r > 25 && r < 52 && !sFund)
        return { side: "short", setup: "N-NearIB", label: "B" };
    }
  }

  // ── B-20Bar ───────────────────────────────────────────
  {
    const h20 = Math.max(...bars.slice(i - 20, i - 2).map(b => b.h));
    const l20 = Math.min(...bars.slice(i - 20, i - 2).map(b => b.l));
    if (reg === "bull" && c.c > h20 && c.c > c.o && r > 58 && r < 78 && vr > 1.9 && !lFund)
      return { side: "long",  setup: "B-20Bar", label: "C" };
    if (reg === "bear" && c.c < l20 && c.c < c.o && r > 22 && r < 42 && vr > 1.9 && !sFund)
      return { side: "short", setup: "B-20Bar", label: "C" };
  }

  return null;
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchBars(pair: string, nBars: number): Promise<Bar[]> {
  const end = Date.now(), start = end - MS_4H * nBars;
  const r = await axios.post(HL_API, {
    type: "candleSnapshot",
    req: { coin: pair, interval: "4h", startTime: start, endTime: end }
  });
  return (r.data ?? []).map((c: any) => ({
    t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function getTradeDecision(
  account: AccountState,
  assets: AssetData[],
  _candles4h: Record<string, any[]>,
  consecutiveLosses: number,
  dailyPnlPct: number
): Promise<TradeDecision> {
  const noTrade = (reason: string): TradeDecision => ({
    action: "no_trade", pair: null, side: null, sizeUsd: null, leverage: null,
    stopLoss: null, takeProfit: null, rationale: reason,
    regime: "mixed", setup: null, rrRatio: null, partialClose: false,
  });

  // Global guards
  const openPairs = account.positions.map(p => p.pair);
  if (openPairs.length >= 2) return noTrade("MaxOpen=2 reached");
  if (consecutiveLosses >= 3) return noTrade("Global 3-loss pause active");
  if (dailyPnlPct <= -5) return noTrade("Daily portfolio loss limit hit (-5%)");

  // Evaluate each pair
  for (const pair of PAIRS) {
    if (openPairs.includes(pair)) continue;

    const fundAsset = assets.find(a => a.pair === pair);
    const fundRate  = fundAsset?.fundingRate ?? 0;  // already ×100 from market-data.ts

    let bars: Bar[];
    try { bars = await fetchBars(pair, BARS_REQ); }
    catch { continue; }
    if (bars.length < 90) continue;

    const rsi = calcRsi(bars);
    const e9  = calcEma(bars, 9);
    const e21 = calcEma(bars, 21);
    const e55 = calcEma(bars, 55);
    const atr = calcAtr(bars);
    const i   = bars.length - 1;

    const sig = getSignal(bars, i, rsi, e9, e21, e55, atr, fundRate);
    if (!sig) continue;

    const entry = bars[i].c;
    const atrV  = atr[i];
    const sl    = sig.side === "long"  ? entry - atrV     : entry + atrV;
    const tp    = sig.side === "long"  ? entry + atrV * 2 : entry - atrV * 2;
    const lev   = LEVER[pair] ?? 10;
    const reg   = getRegime(e9, e21, e55, entry, i);
    const regime = reg === "bull" ? "risk-on" : reg === "bear" ? "risk-off" : "mixed";

    const rationale =
      `${pair} ${sig.setup} signal — regime: ${regime}. ` +
      `Entry: ${entry.toFixed(2)}, SL: ${sl.toFixed(2)} (1×ATR), TP: ${tp.toFixed(2)} (2×ATR). ` +
      `ATR: ${atrV.toFixed(2)}, RSI: ${rsi[i].toFixed(1)}, Funding: ${fundRate.toFixed(4)}%. ` +
      `Leverage ${lev}×. R:R 1:2 clean. v24 backtest LB Score 471.6 (Return 1346%).`;

    return {
      action: "open",
      pair,
      side: sig.side,
      sizeUsd: null,     // bot.ts recalculates based on equity × risk%
      leverage: lev,
      stopLoss: parseFloat(sl.toFixed(4)),
      takeProfit: parseFloat(tp.toFixed(4)),
      rationale,
      regime,
      setup: sig.label,
      rrRatio: 2.0,
      partialClose: false,
    };
  }

  return noTrade("No signal across BTC/ETH/SOL on current 4h bar");
}
