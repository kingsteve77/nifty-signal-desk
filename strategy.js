// Transparent rule engine. Not a predictive guarantee.
// Candle shape: { time, open, high, low, close, volume }
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (const price of values.slice(period)) value = price * k + value * (1-k);
  return value;
}
function rsi(values, period=14) {
  if (values.length <= period) return null;
  let gains=0, losses=0;
  for(let i=values.length-period;i<values.length;i++){
    const d=values[i]-values[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  if(losses===0) return 100;
  const rs=(gains/period)/(losses/period);
  return 100-(100/(1+rs));
}
function vwap(candles) {
  let pv=0, vol=0;
  for(const c of candles){ const typical=(c.high+c.low+c.close)/3; pv+=typical*c.volume; vol+=c.volume; }
  return vol ? pv/vol : null;
}
export function evaluateSignal(symbol, candles) {
  if (!Array.isArray(candles) || candles.length < 30) {
    return { symbol, action:"NO TRADE", reason:"Need at least 30 complete 5-minute candles.", setupScore:null };
  }
  const c = candles.slice(-60);
  const closes = c.map(x=>Number(x.close));
  if(c.some(x=>![x.open,x.high,x.low,x.close,x.volume].every(v=>Number.isFinite(Number(v))) || Number(x.volume)<0)){
    return { symbol, action:"NO TRADE", reason:"Invalid candle data.", setupScore:null };
  }
  const e9=ema(closes,9), e20=ema(closes,20), r=rsi(closes,14), vw=vwap(c);
  const last=c.at(-1), prev=c.at(-2);
  const avgVol=c.slice(-21,-1).reduce((s,x)=>s+Number(x.volume),0)/20;
  const relVol=avgVol ? Number(last.volume)/avgVol : 0;
  const bullish = last.close > vw && e9 > e20 && r >= 52 && last.close > prev.high && relVol >= 1.15;
  const bearish = last.close < vw && e9 < e20 && r <= 48 && last.close < prev.low && relVol >= 1.15;
  const score = (last.close>vw || last.close<vw ? 1:0) + (e9!==null && e20!==null && e9!==e20 ? 1:0) +
    (r!==null && (r>=52 || r<=48) ? 1:0) + (relVol>=1.15 ? 1:0) +
    (last.close>prev.high || last.close<prev.low ? 1:0);
  if(!bullish && !bearish){
    return { symbol, action:"NO TRADE", reason:"Trend, momentum, breakout and volume are not aligned.", setupScore:score*20,
      indicators:{vwap:vw,ema9:e9,ema20:e20,rsi:r,relativeVolume:relVol} };
  }
  const action=bullish?"BUY CE":"BUY PE";
  const entry=Number(last.close);
  const stop=bullish?Math.min(Number(last.low),Number(prev.low)):Math.max(Number(last.high),Number(prev.high));
  const risk=Math.abs(entry-stop);
  if(!risk || !Number.isFinite(risk)) return {symbol,action:"NO TRADE",reason:"Could not calculate a valid stop.",setupScore:score*20};
  return {
    symbol, action, setupScore:score*20, entryReference:entry, underlyingInvalidation:stop,
    underlyingTarget:bullish?entry+1.5*risk:entry-1.5*risk,
    holdingWindow:"5–15 minutes; reassess at every completed 5-minute candle",
    reason:"Rule confluence detected. Confirm the option premium, spread, liquidity and risk before any paper entry.",
    indicators:{vwap:vw,ema9:e9,ema20:e20,rsi:r,relativeVolume:relVol}
  };
}
