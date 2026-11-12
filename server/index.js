import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { analyzeCandles } from "./strategy.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
const pendingStates = new Map();
let fyersAccessToken = null;
let fyersConnectedAt = null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "../public")));

const appId = () => process.env.FYERS_APP_ID?.trim();
const appSecret = () => process.env.FYERS_SECRET_ID?.trim();
const redirectUri = () => process.env.FYERS_REDIRECT_URI?.trim();

app.get("/api/health", (_req, res) => {
  const connected = Boolean(fyersAccessToken);
  res.json({
    ok: true,
    mode: connected ? "fyers-authenticated" : "demo",
    provider: connected ? "fyers" : "not-connected",
    authenticatedAt: fyersConnectedAt
  });
});

// Start the individual-app OAuth flow. The redirect URI must exactly match
// the URI registered in the FYERS API dashboard.
app.get("/api/fyers/login", (_req, res) => {
  if (!appId() || !appSecret() || !redirectUri()) {
    return res.status(503).send("FYERS server credentials are not configured. Add FYERS_APP_ID, FYERS_SECRET_ID and FYERS_REDIRECT_URI in Render environment variables.");
  }
  const state = randomBytes(24).toString("hex");
  pendingStates.set(state, Date.now());
  for (const [key, createdAt] of pendingStates) {
    if (Date.now() - createdAt > 10 * 60 * 1000) pendingStates.delete(key);
  }
  const login = new URL("https://api-t1.fyers.in/api/v3/generate-authcode");
  login.searchParams.set("client_id", appId());
  login.searchParams.set("redirect_uri", redirectUri());
  login.searchParams.set("response_type", "code");
  login.searchParams.set("state", state);
  res.redirect(login.toString());
});

// FYERS sends auth_code and state to this server-side callback.
app.get("/api/fyers/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const authCode = String(req.query.auth_code || "");
  const state = String(req.query.state || "");
  const createdAt = pendingStates.get(state);
  pendingStates.delete(state);
  if (!authCode || !createdAt || Date.now() - createdAt > 10 * 60 * 1000) {
    return res.status(400).send("FYERS login could not be verified. Return to the dashboard and try Connect FYERS again.");
  }
  if (!appId() || !appSecret() || !redirectUri()) {
    return res.status(503).send("FYERS server credentials are not configured.");
  }
  try {
    const appIdHash = createHash("sha256").update(appId() + ":" + appSecret()).digest("hex");
    const response = await fetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "NIFTY-Signal-Desk/1.0" },
      body: JSON.stringify({ grant_type: "authorization_code", appIdHash, code: authCode })
    });
    const data = await response.json();
    if (!response.ok || data.s !== "ok" || !data.access_token) {
      console.error("FYERS token exchange failed:", data.code || response.status, data.message || "No message");
      return res.status(502).send("FYERS authentication failed. Check the Render logs and try connecting again.");
    }
    fyersAccessToken = data.access_token;
    fyersConnectedAt = new Date().toISOString();
    return res.status(200).send("FYERS authentication successful. You can return to NIFTY Signal Desk. This confirms login only; live market data is not connected yet.");
  } catch (error) {
    console.error("FYERS callback error:", error.message);
    return res.status(502).send("Could not complete FYERS authentication. Try again.");
  }
});

app.get("/api/signal/:symbol", (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  if (!["NIFTY", "BANKNIFTY"].includes(symbol)) return res.status(400).json({ error: "Unsupported symbol" });
  res.json({ symbol, action: "NO TRADE", reason: "Live candle processing is not connected yet.", mode: fyersAccessToken ? "fyers-authenticated" : "demo", evaluatedAt: new Date().toISOString() });
});

app.post("/api/analyze", (req, res) => {
  const { symbol, candles, source, lastTickAt } = req.body || {};
  if (!["NIFTY", "BANKNIFTY"].includes(String(symbol).toUpperCase())) return res.status(400).json({ error: "Unsupported symbol" });
  if (source !== "fyers" || !Array.isArray(candles) || !lastTickAt) return res.status(400).json({ error: "Verified FYERS candle data is required." });
  const ageMs = Date.now() - new Date(lastTickAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 90_000) return res.status(409).json({ error: "Market data is stale. NO TRADE." });
  res.json(analyzeCandles(String(symbol).toUpperCase(), candles));
});

app.listen(port, () => console.log(`NIFTY Signal Desk listening on ${port}`));
