/**
 * dgmahiru Telegram Command Bot
 * Listens for commands and replies with live account/position data
 *
 * Commands:
 *   /status  (or /s)  — equity, free margin, daily PnL
 *   /pos     (or /p)  — open positions detail
 *   /regime  (or /r)  — current market regime BTC/ETH/SOL
 *   /help    (or /h)  — show all commands
 */
import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: "/root/openclaw-acp/.env" });

const TOKEN      = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID!;
const BASE       = `https://api.telegram.org/bot${TOKEN}`;
const HL_API     = "https://api.hyperliquid.xyz/info";
const HL_ADDR    = "0x33d15942cdfa18e40c0e8a03f64076c94a113b30";
const ACP_WALLET = process.env.ACP_WALLET ?? "0x598a08BbE033D93C9A7B20d27C9A838f59845d6c";
const DGCLAW_API = "https://dgclaw-trader.virtuals.io/users";

let lastUpdateId = 0;

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function send(text: string) {
  await axios.post(`${BASE}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "Markdown",
  }).catch(() => {});
}

async function getUpdates() {
  const r = await axios.get(`${BASE}/getUpdates`, {
    params: { offset: lastUpdateId + 1, timeout: 30, allowed_updates: ["message"] },
    timeout: 35000,
  }).catch(() => ({ data: { result: [] } }));
  return r.data.result ?? [];
}

// ── Hyperliquid data ──────────────────────────────────────────────────────────
async function fetchAccount() {
  const r = await axios.post(HL_API, { type: "clearinghouseState", user: HL_ADDR });
  const margin = r.data.marginSummary;
  const equity = parseFloat(margin?.accountValue ?? "0");
  const free   = parseFloat(margin?.withdrawable ?? "0");
  const positions = (r.data.assetPositions ?? [])
    .filter((p: any) => parseFloat(p.position?.szi ?? "0") !== 0)
    .map((p: any) => {
      const pos    = p.position;
      const szi    = parseFloat(pos.szi);
      const entry  = parseFloat(pos.entryPx ?? "0");
      const posVal = parseFloat(pos.positionValue ?? "0");
      const mark   = Math.abs(szi) > 0 ? posVal / Math.abs(szi) : entry;
      const upnl   = parseFloat(pos.unrealizedPnl ?? "0");
      const lev    = parseFloat(pos.leverage?.value ?? "1");
      const liqPx  = parseFloat(pos.liquidationPx ?? "0");
      return { pair: pos.coin, side: szi > 0 ? "LONG" : "SHORT", entry, mark, upnl, lev, liqPx, posVal };
    });
  return { equity, free, positions };
}

function calcEma(bars: any[], p: number) {
  const k = 2/(p+1); let e = bars[0].c; const out = [e];
  for (let i = 1; i < bars.length; i++) { e = bars[i].c*k + e*(1-k); out.push(e); }
  return out;
}

async function fetchRegime(pair: string) {
  const end = Date.now(), start = end - 14400000*120;
  const r = await axios.post(HL_API, { type:"candleSnapshot", req:{coin:pair,interval:"4h",startTime:start,endTime:end} });
  const bars = (r.data??[]).map((c:any)=>({c:+c.c,h:+c.h,l:+c.l}));
  if (bars.length < 60) return "unknown";
  const e9 = calcEma(bars,9), e21 = calcEma(bars,21), e55 = calcEma(bars,55);
  const i = bars.length - 1;
  const price = bars[i].c;
  const isBull = e9[i]>e21[i] && e21[i]>e55[i] && e9[i]>e9[i-2] && e21[i]>e21[i-3] && e55[i]>e55[i-6] && price>e55[i];
  const isBear = e9[i]<e21[i] && e21[i]<e55[i] && e9[i]<e9[i-2] && e21[i]<e21[i-3] && e55[i]<e55[i-6] && price<e55[i];
  return isBull ? "🟢 BULL" : isBear ? "🔴 BEAR" : "⚪ MIXED";
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleStatus() {
  const { equity, free, positions } = await fetchAccount();
  const stateFile = "/root/openclaw-acp/src/trading/bot-state.json";
  let dailyPnl = 0, consLoss = 0;
  try {
    const s = JSON.parse(require("fs").readFileSync(stateFile, "utf-8"));
    dailyPnl  = s.dailyPnlPct ?? 0;
    consLoss  = s.consecutiveLosses ?? 0;
  } catch {}

  await send(
`📊 *dgmahiru — Status*

💰 *Equity:* $${equity.toFixed(2)}
🔓 *Free margin:* $${free.toFixed(2)}
📈 *Daily PnL:* ${dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(3)}%
⚠️ *Consec. losses:* ${consLoss}
📂 *Open positions:* ${positions.length}

_Updated: ${new Date().toUTCString()}_`
  );
}

async function handlePositions() {
  const { equity, positions } = await fetchAccount();
  if (positions.length === 0) {
    await send("📭 *No open positions*\n\nBot is scanning for setups...");
    return;
  }
  let msg = `📂 *Open Positions — dgmahiru*\n\n`;
  for (const p of positions) {
    const pnlPct  = equity > 0 ? (p.upnl / equity * 100) : 0;
    const pnlSign = p.upnl >= 0 ? "✅" : "❌";
    msg += `${pnlSign} *${p.pair} ${p.side}* — ${p.lev}x\n`;
    msg += `  Entry: \`${p.entry.toFixed(2)}\`  Mark: \`${p.mark.toFixed(2)}\`\n`;
    msg += `  uPnL: ${p.upnl >= 0 ? "+" : ""}$${p.upnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n`;
    msg += `  Liq: \`${p.liqPx > 0 ? p.liqPx.toFixed(2) : "N/A"}\`\n\n`;
  }
  msg += `_Equity: $${equity.toFixed(2)}_`;
  await send(msg);
}

async function handleRegime() {
  await send("🔍 Checking regimes...");
  const pairs = ["BTC","ETH","SOL"];
  const results = await Promise.all(pairs.map(async p => {
    const reg = await fetchRegime(p);
    const r   = await axios.post(HL_API, { type:"metaAndAssetCtxs" });
    const meta = r.data[0].universe as any[];
    const idx  = meta.findIndex((m:any) => m.name === p);
    const price = idx >= 0 ? parseFloat(r.data[1][idx]?.markPx ?? "0") : 0;
    return `${reg} *${p}*  $${price.toLocaleString("en",{maximumFractionDigits:2})}`;
  }));
  await send(`📡 *Market Regime — dgmahiru*\n\n${results.join("\n")}\n\n_4H EMA9/21/55 triple alignment_`);
}

async function handleHelp() {
  await send(
`🤖 *dgmahiru Bot Commands*

/status  (or /s) — equity & daily PnL
/pos     (or /p) — open positions
/regime  (or /r) — BTC/ETH/SOL market regime
/help    (or /h) — show this menu`
  );
}

// ── Main polling loop ─────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] dgmahiru Telegram command bot started`);
  await send("🤖 *dgmahiru online* — command bot ready\nType /help to see commands");

  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        lastUpdateId = update.update_id;
        const text = update.message?.text?.trim().toLowerCase() ?? "";
        const chatId = String(update.message?.chat?.id);

        // Only respond to authorized chat
        if (chatId !== CHAT_ID) continue;

        if (text === "/status" || text === "/s")       await handleStatus();
        else if (text === "/pos" || text === "/p")     await handlePositions();
        else if (text === "/regime" || text === "/r")  await handleRegime();
        else if (text === "/help" || text === "/h")    await handleHelp();
        else if (text.startsWith("/"))                 await send("❓ Unknown command. Type /help");
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(console.error);
