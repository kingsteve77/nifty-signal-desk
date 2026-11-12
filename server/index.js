import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCandles } from "./strategy.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "../public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: process.env.APP_MODE || "demo", provider: "not-connected" });
});

app.get("/api/signal/:symbol", (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  if (!["NIFTY", "BANKNIFTY"].includes(symbol)) return res.status(400).json({ error: "Unsupported symbol" });
  res.json({ symbol, action: "NO TRADE", reason: "No verified live market feed is connected.", mode: "demo", evaluatedAt: new Date().toISOString() });
});

app.post("/api/analyze", (req, res) => {
  const { symbol, candles, source, lastTickAt } = req.body || {};
  if (!["NIFTY", "BANKNIFTY"].includes(String(symbol).toUpperCase())) return res.status(400).json({ error: "Unsupported symbol" });
  if (source !== "angelone" || !Array.isArray(candles) || !lastTickAt) return res.status(400).json({ error: "Verified Angel One candle data is required." });
  const ageMs = Date.now() - new Date(lastTickAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 90_000) return res.status(409).json({ error: "Market data is stale. NO TRADE." });
  res.json(analyzeCandles(String(symbol).toUpperCase(), candles));
});

app.listen(port, () => console.log(`NIFTY Signal Desk listening on ${port}`));
