const ema = (values, period) => {
  const k = 2 / (period + 1);
  let out = values[0];
  for (const value of values.slice(1)) out = value * k + out * (1 - k);
  return out;
};
function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (!losses) return 100;
  return 100 - 100 / (1 + gains / losses);
}
export function analyzeCandles(symbol, candles) {
  if (!Array.isArray(candles) || candles.length < 25) return { symbol, action: "NO TRADE", reason: "Need 25 completed five-minute candles." };
  const c = candles.slice(-25), closes = c.map(x => Number(x.close));
  if (closes.some(x => !Number.isFinite(x) || x <= 0)) return { symbol, action: "NO TRADE", reason: "Invalid candle values." };
  const last = c.at(-1), price = closes.at(-1), fast = ema(closes.slice(-20), 9), slow = ema(closes.slice(-20), 20), momentum = rsi(closes);
  const priorHigh = Math.max(...c.slice(0, -1).map(x => Number(x.high)));
  const priorLow = Math.min(...c.slice(0, -1).map(x => Number(x.low)));
  const up = price > fast && fast > slow && momentum >= 52 && momentum <= 72 && price > priorHigh;
  const down = price < fast && fast < slow && momentum >= 28 && momentum <= 48 && price < priorLow;
  if (!up && !down) return { symbol, action: "NO TRADE", reason: "EMA trend, RSI and breakout are not aligned.", underlying: price, rsi: Number(momentum.toFixed(1)), evaluatedAt: new Date().toISOString() };
  const range = Math.max(1, Number(last.high) - Number(last.low));
  return { symbol, action: up ? "BUY CE BIAS" : "BUY PE BIAS", underlying: price, invalidation: up ? Number(last.low) : Number(last.high), target: up ? price + range * 1.5 : price - range * 1.5, rsi: Number(momentum.toFixed(1)), holdingWindow: "Reassess after each completed five-minute candle.", note: "Underlying direction only; option contract, premium, lot risk and liquidity are not checked." };
}
export function analyzeScalpCandles(symbol, candles) {
  if (!Array.isArray(candles) || candles.length < 16)
    return { symbol, action: "NO TRADE", reason: "Scalping setup needs at least 16 completed one-minute candles." };
  const c = candles.slice(-16);
  const closes = c.map(x => Number(x.close));
  if (closes.some(x => !Number.isFinite(x) || x <= 0))
    return { symbol, action: "NO TRADE", reason: "Invalid one-minute candle data." };
  const price = closes.at(-1);
  const fast = ema(closes.slice(-9), 5);
  const slow = ema(closes.slice(-9), 9);
  const momentum = rsi(closes, 7);
  const recent = c.slice(-6, -1);
  const breakoutHigh = Math.max(...recent.map(x => Number(x.high)));
  const breakoutLow = Math.min(...recent.map(x => Number(x.low)));
  const candle = c.at(-1);
  const bullish = price > fast && fast > slow && momentum >= 54 && momentum <= 75 && price > breakoutHigh && candle.close > candle.open;
  const bearish = price < fast && fast < slow && momentum <= 46 && momentum >= 25 && price < breakoutLow && candle.close < candle.open;
  if (!bullish && !bearish) return {
    symbol, action: "NO TRADE", reason: "One-minute EMA, RSI and 5-candle breakout are not aligned.",
    underlying: price, rsi: Number(momentum.toFixed(1)), timeframe: "1m"
  };
  const side = bullish ? "CE" : "PE";
  const range = Math.max(Number(candle.high) - Number(candle.low), price * 0.00035);
  return {
    symbol, action: "BUY " + side + " BIAS", side, underlying: price,
    invalidation: bullish ? Number(candle.low) : Number(candle.high),
    rsi: Number(momentum.toFixed(1)), timeframe: "1m",
    holdingWindow: "Scalp plan: review within 5–10 minutes; exit sooner if invalidated.",
    underlyingTarget: bullish ? price + range * 1.5 : price - range * 1.5,
    completedAt: new Date(candle.time + 60000).toISOString(),
    reason: "One-minute EMA 5/9, RSI 7 and five-candle breakout aligned."
  };
}
