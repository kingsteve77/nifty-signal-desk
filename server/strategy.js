const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
function ema(values, period) {
  const k = 2 / (period + 1); let out = values[0];
  for (const v of values.slice(1)) out = v * k + out * (1 - k);
  return out;
}
function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d;
  }
  if (!losses) return 100;
  return 100 - 100 / (1 + gains / losses);
}
export function analyzeCandles(symbol, candles) {
  if (!Array.isArray(candles) || candles.length < 25) return { symbol, action: "NO TRADE", reason: "At least 25 completed five-minute candles are required." };
  const c = candles.slice(-25);
  const closes = c.map(x => Number(x.close)), volumes = c.map(x => Number(x.volume));
  if ([...closes, ...volumes].some(x => !Number.isFinite(x)) || closes.some(x => x <= 0)) return { symbol, action: "NO TRADE", reason: "Invalid candle data." };
  const last = c.at(-1), price = closes.at(-1), vwap = Number(last.vwap);
  if (!Number.isFinite(vwap)) return { symbol, action: "NO TRADE", reason: "VWAP missing." };
  const fast = ema(closes.slice(-20), 9), slow = ema(closes.slice(-20), 20), momentum = rsi(closes);
  const volRatio = volumes.at(-1) / Math.max(1, avg(volumes.slice(0, -1)));
  const priorHigh = Math.max(...c.slice(0, -1).map(x => Number(x.high)));
  const priorLow = Math.min(...c.slice(0, -1).map(x => Number(x.low)));
  const bullish = price > vwap && fast > slow && momentum >= 52 && momentum <= 72 && volRatio >= 1.2 && price > priorHigh;
  const bearish = price < vwap && fast < slow && momentum <= 48 && momentum >= 28 && volRatio >= 1.2 && price < priorLow;
  if (!bullish && !bearish) return { symbol, action: "NO TRADE", reason: "Trend, momentum, volume and breakout conditions are not aligned.", evaluatedAt: new Date().toISOString() };
  const direction = bullish ? "BUY CE" : "BUY PE";
  const range = Math.max(1, Number(last.high) - Number(last.low));
  return { symbol, action: direction, underlying: price, invalidation: bullish ? Number(last.low) : Number(last.high), target: bullish ? price + range * 1.5 : price - range * 1.5, holdingWindow: "Review each completed 5-minute candle; exit on stop, target or invalidation.", score: 5, scoreMeaning: "Rule confluence score, not probability of profit.", note: "Underlying signal only; option contract, premium, spread and lot risk are not calculated." };
}
