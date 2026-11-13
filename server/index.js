import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { analyzeCandles } from "./strategy.js";

const require = createRequire(import.meta.url);
const { fyersDataSocket: FyersDataSocket } = require("fyers-api-v3");
const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
const pendingStates = new Map();
const market = {
  connected: false, status: "Not connected", lastTickAt: null,
  indices: {
    NIFTY: { symbol: "NSE:NIFTY50-INDEX", ltp: null, candles: [], signal: null, lastTickAt: null },
    BANKNIFTY: { symbol: "NSE:NIFTYBANK-INDEX", ltp: null, candles: [], signal: null, lastTickAt: null }
  }
};
let fyersAccessToken = null;
let dataSocket = null;
const recommendations = {
  NIFTY: { action: "NO TRADE", reason: "Waiting for a valid index setup and option-chain data." },
  BANKNIFTY: { action: "NO TRADE", reason: "Waiting for a valid index setup and option-chain data." }
};
const optionSnapshots = { NIFTY: null, BANKNIFTY: null };
const activeTrades = { NIFTY: null, BANKNIFTY: null };
const lastExitSignalAt = { NIFTY: null, BANKNIFTY: null };
let optionPollTimer = null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "../public")));
const appId = () => process.env.FYERS_APP_ID?.trim();
const appSecret = () => process.env.FYERS_SECRET_ID?.trim();
const redirectUri = () => process.env.FYERS_REDIRECT_URI?.trim();

function onTick(message) {
  let payload = message;
  if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return; } }
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const symbol = String(item.symbol || item.n || "");
    const price = Number(item.ltp ?? item.lp);
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = symbol.includes("NIFTYBANK") ? "BANKNIFTY" : symbol.includes("NIFTY50") ? "NIFTY" : null;
    if (!key) continue;
    const tickTime = Number(item.last_traded_time || item.tt || Date.now() / 1000);
    const timestamp = tickTime > 1e12 ? tickTime : tickTime * 1000;
    const candleTime = Math.floor(timestamp / 300000) * 300000;
    const state = market.indices[key];
    let candle = state.candles.at(-1);
    if (!candle || candle.time !== candleTime) {
      if (candle) {
        state.signal = analyzeCandles(key, state.candles);
        state.signal.completedAt = new Date(candle.time + 300000).toISOString();
      }
      candle = { time: candleTime, open: price, high: price, low: price, close: price };
      state.candles.push(candle);
      state.candles = state.candles.slice(-80);
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
    }
    state.ltp = price;
    state.lastTickAt = new Date(timestamp).toISOString();
    market.lastTickAt = state.lastTickAt;
  }
}
async function preloadFiveMinuteHistory(token) {
  const now = Date.now();
  const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const from = Math.floor(new Date(istDate + "T09:15:00+05:30").getTime() / 1000);
  const to = Math.floor((now - 300000) / 1000);
  if (to <= from) return;
  for (const [key, state] of Object.entries(market.indices)) {
    const url = new URL("https://api-t1.fyers.in/data/history");
    for (const [name, value] of Object.entries({ symbol: state.symbol, resolution: "5", date_format: "0", range_from: String(from), range_to: String(to) })) url.searchParams.set(name, value);
    try {
      const response = await fetch(url, { headers: { Authorization: appId() + ":" + token } });
      const data = await response.json();
      if (response.ok && data.s === "ok" && Array.isArray(data.candles)) {
        state.candles = data.candles.map(row => ({ time: Number(row[0]) * 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })).slice(-80);
        if (state.candles.length) {
          state.signal = analyzeCandles(key, state.candles);
          if (state.signal) state.signal.completedAt = new Date(state.candles.at(-1).time + 300000).toISOString();
        }
      } else {
        console.error("FYERS history preload failed for " + key + ":", data.message || response.status);
      }
    } catch (error) {
      console.error("FYERS history preload error for " + key + ":", error.message);
    }
  }
}

function freshIndexSignal(key) {
  const state = market.indices[key];
  const stale = !state.lastTickAt || Date.now() - new Date(state.lastTickAt).getTime() > 90000;
  if (stale) return { action: "NO TRADE", reason: "Underlying index tick is stale." };
  if (!state.signal || !["BUY CE BIAS", "BUY PE BIAS"].includes(state.signal.action)) return { action: "NO TRADE", reason: state.signal?.reason || "No confirmed five-minute directional setup." };
  return state.signal;
}
async function fetchOptionChain(key, token) {
  const underlying = market.indices[key].symbol;
  const url = new URL("https://api-t1.fyers.in/data/options-chain-v3");
  url.searchParams.set("symbol", underlying);
  url.searchParams.set("strikecount", "8");
  url.searchParams.set("greeks", "1");
  const response = await fetch(url, { headers: { Authorization: appId() + ":" + token } });
  const json = await response.json();
  if (!response.ok || json.s !== "ok" || !json.data) throw new Error(json.message || "Option-chain request failed");
  return json.data;
}
function chooseContract(chain, side) {
  const legs = (chain.optionsChain || []).filter(x => x.option_type === side && x.symbol && Number(x.ltp) > 0 &&
    Number(x.bid) > 0 && Number(x.ask) >= Number(x.bid) && Number(x.volume) > 0 && Number(x.oi) > 0);
  const liquid = legs.filter(x => ((Number(x.ask) - Number(x.bid)) / Number(x.ltp)) <= 0.05);
  const deltaLegs = liquid.filter(x => Number.isFinite(Number(x.greeks?.delta)) &&
    Math.abs(Number(x.greeks.delta)) >= 0.40 && Math.abs(Number(x.greeks.delta)) <= 0.65);
  const pool = deltaLegs.length ? deltaLegs : liquid;
  pool.sort((a,b) => {
    const da = Number.isFinite(Number(a.greeks?.delta)) ? Math.abs(Math.abs(Number(a.greeks.delta)) - 0.50) : 1;
    const db = Number.isFinite(Number(b.greeks?.delta)) ? Math.abs(Math.abs(Number(b.greeks.delta)) - 0.50) : 1;
    return da - db || Number(b.volume) - Number(a.volume);
  });
  return pool[0] || null;
}
async function refreshOptionRecommendations() {
  if (!fyersAccessToken) return;
  for (const key of ["NIFTY", "BANKNIFTY"]) {
    try {
      const signal = freshIndexSignal(key);
      const active = activeTrades[key];
      if (active) {
        const chain = await fetchOptionChain(key, fyersAccessToken);
        const live = (chain.optionsChain || []).find(x => x.symbol === active.symbol);
        if (!live || !Number(live.ltp)) {
          recommendations[key] = { ...active, action: "NO TRADE", reason: "Selected option premium is unavailable; do not enter or add." };
          continue;
        }
        const premium = Number(live.ltp);
        const invalidated = !["BUY CE BIAS", "BUY PE BIAS"].includes(signal.action) ||
          (active.side === "CE" && signal.action !== "BUY CE BIAS") ||
          (active.side === "PE" && signal.action !== "BUY PE BIAS");
        if (premium <= active.stopLoss || premium >= active.target || invalidated) {
          const reason = premium <= active.stopLoss ? "Option premium reached the stop-loss level." :
            premium >= active.target ? "Option premium reached the target level." : "The five-minute underlying setup is no longer valid.";
          recommendations[key] = { ...active, action: "EXIT", premium, reason, updatedAt: new Date().toISOString() };
          lastExitSignalAt[key] = active.signalTime;
          activeTrades[key] = null;
        } else {
          recommendations[key] = { ...active, action: "HOLD", premium, reason: "Setup remains valid; monitor the stated stop-loss and target.", updatedAt: new Date().toISOString() };
        }
        continue;
      }
      if (!["BUY CE BIAS", "BUY PE BIAS"].includes(signal.action)) {
        recommendations[key] = { action: "NO TRADE", reason: signal.reason || "No confirmed directional setup." };
        continue;
      }
      if (lastExitSignalAt[key] && lastExitSignalAt[key] === signal.completedAt) {
        recommendations[key] = { action: "NO TRADE", reason: "A previous setup has exited. Waiting for a new completed five-minute signal." };
        continue;
      }
      const chain = await fetchOptionChain(key, fyersAccessToken);
      const expiry = (chain.expiryData || []).filter(x => Number(x.expiry) * 1000 > Date.now()).sort((a,b) => Number(a.expiry) - Number(b.expiry))[0];
      if (!expiry) throw new Error("No future expiry is listed by FYERS.");
      const side = signal.action === "BUY CE BIAS" ? "CE" : "PE";
      const contract = chooseContract(chain, side);
      if (!contract) {
        recommendations[key] = { action: "NO TRADE", reason: "No sufficiently liquid " + side + " contract with a usable bid/ask spread and premium was found." };
        continue;
      }
      const entry = Number(contract.ask);
      const trade = {
        action: "BUY " + side, side, symbol: contract.symbol, strike: Number(contract.strike_price),
        expiry: expiry.date, premium: Number(contract.ltp), entry: Number(entry.toFixed(2)),
        stopLoss: Number((entry * 0.80).toFixed(2)), target: Number((entry * 1.30).toFixed(2)),
        delta: Number.isFinite(Number(contract.greeks?.delta)) ? Number(contract.greeks.delta) : null,
        volume: Number(contract.volume), oi: Number(contract.oi),
        spreadPct: Number((((Number(contract.ask) - Number(contract.bid)) / Number(contract.ltp)) * 100).toFixed(2)),
        reason: "Five-minute index bias aligned; nearest listed expiry and a liquid contract selected from the live FYERS option chain.",
        signalTime: signal.completedAt || new Date().toISOString()
      };
      activeTrades[key] = trade;
      recommendations[key] = trade;
      optionSnapshots[key] = { checkedAt: new Date().toISOString(), expiry: expiry.date };
    } catch (error) {
      recommendations[key] = { action: "NO TRADE", reason: "Option-chain data unavailable: " + error.message };
      console.error("Option-chain refresh failed for " + key + ":", error.message);
    }
  }
}
function startOptionPolling() {
  if (optionPollTimer) clearInterval(optionPollTimer);
  refreshOptionRecommendations();
  optionPollTimer = setInterval(refreshOptionRecommendations, 20000);
}
function connectFyersFeed(token) {
  if (dataSocket) {
    try { dataSocket.close(); } catch {}
    dataSocket = null;
  }
  market.connected = false;
  market.status = "Connecting to FYERS market-data socket";
  try {
    dataSocket = FyersDataSocket.getInstance(appId() + ":" + token, "");
    dataSocket.on("connect", () => {
      market.connected = true;
      market.status = "Connected to FYERS; subscribing to index updates";
      try {
        dataSocket.subscribe(["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"], false);
        startOptionPolling();
      } catch (error) {
        market.connected = false;
        market.status = "FYERS connected but index subscription failed";
        console.error("FYERS subscribe error:", error?.message || String(error));
      }
    });
    dataSocket.on("message", message => {
      onTick(message);
    });
    dataSocket.on("error", error => {
      market.connected = false;
      market.status = "FYERS socket error: " + (error?.message || "check application logs");
      console.error("FYERS socket error:", error?.message || String(error));
    });
    dataSocket.on("close", event => {
      market.connected = false;
      market.status = "FYERS socket closed: " + (typeof event === "string" ? event : JSON.stringify(event || {}));
      console.error("FYERS socket closed:", event || "no close details");
    });
    dataSocket.autoreconnect();
    dataSocket.connect();
  } catch (error) {
    market.connected = false;
    market.status = "FYERS socket initialization failed";
    console.error("FYERS socket initialization error:", error?.stack || error?.message || String(error));
  }
}
app.get("/api/health", (_req, res) => res.json({
  ok: true, mode: market.connected ? "live" : fyersAccessToken ? "authenticated-no-feed" : "demo",
  provider: "fyers", marketConnected: market.connected, status: market.status,
  lastTickAt: market.lastTickAt, authenticated: Boolean(fyersAccessToken)
}));
app.get("/api/market", (_req, res) => {
  const indices = {};
  for (const [key, state] of Object.entries(market.indices)) {
    const stale = !state.lastTickAt || Date.now() - new Date(state.lastTickAt).getTime() > 90000;
    indices[key] = { symbol: state.symbol, ltp: state.ltp, lastTickAt: state.lastTickAt,
      completedCandles: Math.max(0, state.candles.length - (state.candles.length ? 1 : 0)),
      stale, signal: stale ? { symbol: key, action: "NO TRADE", reason: "No fresh market tick in the last 90 seconds." } :
        state.signal || { symbol: key, action: "NO TRADE", reason: "Waiting for completed five-minute candles." }, recommendation: stale ? { action: "NO TRADE", reason: "Underlying tick is stale." } : recommendations[key] };
  }
  res.json({ connected: market.connected, status: market.status, lastTickAt: market.lastTickAt, indices });
});
app.get("/api/fyers/login", (_req, res) => {
  if (!appId() || !appSecret() || !redirectUri()) return res.status(503).send("FYERS credentials are not configured in Render.");
  const state = randomBytes(24).toString("hex");
  pendingStates.set(state, Date.now());
  const login = new URL("https://api-t1.fyers.in/api/v3/generate-authcode");
  login.searchParams.set("client_id", appId());
  login.searchParams.set("redirect_uri", redirectUri());
  login.searchParams.set("response_type", "code");
  login.searchParams.set("state", state);
  res.redirect(login.toString());
});
app.get("/api/fyers/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const code = String(req.query.auth_code || "");
  const state = String(req.query.state || "");
  const created = pendingStates.get(state);
  pendingStates.delete(state);
  if (!code || !created || Date.now() - created > 600000) return res.status(400).send("FYERS login could not be verified. Return to dashboard and reconnect.");
  try {
    const appIdHash = createHash("sha256").update(appId() + ":" + appSecret()).digest("hex");
    const response = await fetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", appIdHash, code })
    });
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      const contentType = response.headers.get("content-type") || "unknown";
      console.error("FYERS token exchange returned non-JSON:", {
        httpStatus: response.status,
        contentType,
        bodyStart: responseText.slice(0, 300).replace(/[\\r\\n]+/g, " ")
      });
      return res.status(502).send("FYERS returned an unexpected response during token validation. Check Render logs for HTTP status and response type.");
    }
    if (!response.ok || data.s !== "ok" || !data.access_token) {
      console.error("FYERS token exchange failed:", data.code || response.status, data.message || "No message");
      return res.status(502).send("FYERS authentication failed. Check Render logs and reconnect.");
    }
    fyersAccessToken = data.access_token;
    await preloadFiveMinuteHistory(fyersAccessToken);
    connectFyersFeed(fyersAccessToken);
    res.send("FYERS login succeeded. The live market-data socket is starting. Return to NIFTY Signal Desk and check its feed status.");
  } catch (error) {
    console.error("FYERS callback error:", error.message);
    res.status(502).send("Could not complete FYERS authentication. Try again.");
  }
});
app.get("/api/signal/:symbol", (req, res) => {
  const key = String(req.params.symbol || "").toUpperCase();
  if (!market.indices[key]) return res.status(400).json({ error: "Unsupported symbol" });
  const state = market.indices[key];
  const stale = !state.lastTickAt || Date.now() - new Date(state.lastTickAt).getTime() > 90000;
  res.json(stale ? { symbol: key, action: "NO TRADE", reason: "Live data unavailable or stale." } : state.signal || { symbol: key, action: "NO TRADE", reason: "Waiting for completed five-minute candles." });
});
app.listen(port, () => console.log("NIFTY Signal Desk listening on " + port));
