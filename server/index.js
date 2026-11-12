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
function connectFyersFeed(token) {
  if (dataSocket) { try { dataSocket.close(); } catch {} }
  market.connected = false;
  market.status = "Connecting to FYERS market-data socket";
  dataSocket = FyersDataSocket.getInstance(appId() + ":" + token, "");
  dataSocket.on("connect", () => {
    market.connected = true;
    market.status = "Connected; waiting for NIFTY index ticks";
    dataSocket.subscribe(["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"]);
  });
  dataSocket.on("message", onTick);
  dataSocket.on("error", error => {
    market.connected = false;
    market.status = "FYERS socket error; reconnect required";
    console.error("FYERS socket error:", error?.message || String(error));
  });
  dataSocket.on("close", () => {
    market.connected = false;
    market.status = "FYERS socket closed; reconnect required";
  });
  dataSocket.connect();
  dataSocket.autoreconnect();
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
        state.signal || { symbol: key, action: "NO TRADE", reason: "Waiting for completed five-minute candles." } };
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
    const data = await response.json();
    if (!response.ok || data.s !== "ok" || !data.access_token) {
      console.error("FYERS token exchange failed:", data.code || response.status, data.message || "No message");
      return res.status(502).send("FYERS authentication failed. Check Render logs and reconnect.");
    }
    fyersAccessToken = data.access_token;
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
