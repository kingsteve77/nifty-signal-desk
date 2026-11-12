const capital=document.querySelector('#capital'), riskPct=document.querySelector('#riskPct'), riskAmount=document.querySelector('#riskAmount');
function calcRisk(){const c=Math.max(0,Number(capital.value)||0),p=Math.min(1,Math.max(0,Number(riskPct.value)||0));riskAmount.textContent='₹'+(c*p/100).toLocaleString('en-IN',{maximumFractionDigits:2});}
capital.addEventListener('input',calcRisk);riskPct.addEventListener('input',calcRisk);calcRisk();
function updateClock(){const now=new Date();document.querySelector('#clock').textContent=now.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'} )+' IST';const mins=now.getHours()*60+now.getMinutes();const weekday=now.getDay()>0&&now.getDay()<6;document.querySelector('#marketSession').textContent=weekday&&mins>=555&&mins<930?'Session window':'Outside regular session';}
updateClock();setInterval(updateClock,1000);
fetch('/api/health').then(r=>r.json()).then(d=>{const live=d.provider?.mode==='live'&&d.provider?.connected;document.querySelector('#statusText').textContent=live?'LIVE FEED CONNECTED':'DEMO · NO LIVE FEED';}).catch(()=>{document.querySelector('#statusText').textContent='BACKEND OFFLINE';});
