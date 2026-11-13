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
function supertrend(candles, period = 7, multiplier = 2) {
  if (candles.length < period + 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(Number(cur.high) - Number(cur.low), Math.abs(Number(cur.high) - Number(prev.close)), Math.abs(Number(cur.low) - Number(prev.close))));
  }
  let atr = trs.slice(0, period).reduce((a,b)=>a+b,0) / period;
  let upper = 0, lower = 0, trend = 1;
  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i - 1]) / period;
    const mid = (Number(candles[i].high) + Number(candles[i].low)) / 2;
    const basicUpper = mid + multiplier * atr, basicLower = mid - multiplier * atr;
    upper = i === period ? basicUpper : (basicUpper < upper || Number(candles[i-1].close) > upper ? basicUpper : upper);
    lower = i === period ? basicLower : (basicLower > lower || Number(candles[i-1].close) < lower ? basicLower : lower);
    const close = Number(candles[i].close);
    if (trend === 1 && close < lower) trend = -1;
    else if (trend === -1 && close > upper) trend = 1;
  }
  return { trend, line: trend === 1 ? lower : upper };
}
export function analyzeScalpCandles(symbol, candles) {
  if (!Array.isArray(candles) || candles.length < 20)
    return { symbol, action: "NO TRADE", reason: "Need 20 completed one-minute candles for EMA, RSI and Supertrend." };
  const c = candles.slice(-30);
  const closes = c.map(x => Number(x.close));
  if (closes.some(x => !Number.isFinite(x) || x <= 0))
    return { symbol, action: "NO TRADE", reason: "Invalid one-minute candle data." };
  const price = closes.at(-1), fast = ema(closes.slice(-9), 5), slow = ema(closes.slice(-9), 9);
  const momentum = rsi(closes, 7), st = supertrend(c, 7, 2);
  if (!st) return { symbol, action: "NO TRADE", reason: "Waiting for Supertrend calculation." };
  const candle = c.at(-1), recent = c.slice(-6, -1);
  const breakoutHigh = Math.max(...recent.map(x => Number(x.high)));
  const breakoutLow = Math.min(...recent.map(x => Number(x.low)));
  const bullish = st.trend === 1 && price > fast && fast > slow && momentum >= 50 && momentum <= 75 && price > breakoutHigh && Number(candle.close) > Number(candle.open);
  const bearish = st.trend === -1 && price < fast && fast < slow && momentum <= 50 && momentum >= 25 && price < breakoutLow && Number(candle.close) < Number(candle.open);
  if (!bullish && !bearish) return {
    symbol, action: "NO TRADE", reason: "Waiting for Supertrend, EMA 5/9, RSI 7 and breakout to agree.",
    underlying: price, rsi: Number(momentum.toFixed(1)), supertrend: st.trend === 1 ? "UP" : "DOWN", timeframe: "1m"
  };
  const side = bullish ? "CE" : "PE";
  const range = Math.max(Number(candle.high) - Number(candle.low), price * 0.0003);
  return {
    symbol, action: "BUY " + side + " BIAS", side, underlying: price,
    invalidation: st.line, supertrend: st.trend === 1 ? "UP" : "DOWN",
    rsi: Number(momentum.toFixed(1)), timeframe: "1m",
    holdingWindow: "Scalp: 5–10 minutes; exit if Supertrend flips or premium stop is hit.",
    underlyingTarget: bullish ? price + range * 1.3 : price - range * 1.3,
    completedAt: new Date(candle.time + 60000).toISOString(),
    reason: "Supertrend (7,2), EMA 5/9, RSI 7 and five-candle breakout aligned."
  };
}
