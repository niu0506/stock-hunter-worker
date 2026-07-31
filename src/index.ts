import type { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';

const HOLIDAYS = new Set<string>([
  '20250101',
  '20250128','20250129','20250130','20250131',
  '20250201','20250202','20250203','20250204',
  '20250404','20250405','20250406',
  '20250501','20250502','20250503','20250504','20250505',
  '20250531','20250601','20250602',
  '20251001','20251002','20251003','20251004','20251005','20251006','20251007','20251008',
  '20260101','20260102','20260103',
  '20260214','20260215','20260216','20260217','20260218','20260219','20260220',
  '20260404','20260405','20260406',
  '20260501','20260502','20260503','20260504','20260505',
  '20260619','20260620','20260621',
  '20260927','20260928','20260929',
  '20261001','20261002','20261003','20261004','20261005','20261006','20261007',
]);

const MAKEUP_WORKDAYS = new Set<string>([
  '20250126','20250208','20250427','20250510','20250928','20251011',
  '20260110','20260221','20260222','20260509','20261010','20261011',
]);

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  STOCK_HUNTER: KVNamespace;
}

interface StockData {
  code: string;
  name: string;
  price: number;
  changePct: number;
  turnoverRate: number;
  peRatio: number;
  pbRatio: number;
  marketCap: number;
}

interface ScreeningResult {
  date: string;
  updatedAt: string;
  stocks: StockData[];
}

function isTradingDay(): boolean {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const day = d.getDay();
  if (MAKEUP_WORKDAYS.has(dateStr)) return true;
  if (HOLIDAYS.has(dateStr)) return false;
  return day >= 1 && day <= 5;
}

function matches(s: StockData): boolean {
  if (isNaN(s.marketCap) || s.marketCap < 50) return false;
  if (isNaN(s.peRatio) || s.peRatio < 0 || s.peRatio > 40) return false;
  if (isNaN(s.turnoverRate) || s.turnoverRate < 3) return false;
  if (isNaN(s.changePct) || s.changePct < 9.5) return false;
  if (isNaN(s.pbRatio) || s.pbRatio > 3) return false;
  return true;
}

async function fetchStocksFromSina(): Promise<StockData[]> {
  const results: StockData[] = [];
  const seen = new Set<string>();
  const baseUrl =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
    'Market_Center.getHQNodeData?sort=code&asc=1&node=hs_a&_s_r_a=page';

  for (let page = 1; page <= 45; page++) {
    const resp = await fetch(`${baseUrl}&page=${page}&num=100`, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) throw new Error(`Sina API error: ${resp.status}`);
    const data: any[] = await resp.json();
    if (!Array.isArray(data) || data.length === 0) break;

    for (const item of data) {
      const code: string = item.code;
      const name: string = item.name;
      const trade = parseFloat(item.trade);
      if (!code || !name || isNaN(trade)) continue;
      if (!/^(00[0123]|30[0123]|60[0123])/.test(code)) continue;
      if (seen.has(code)) continue;
      seen.add(code);

      results.push({
        code, name, price: trade,
        changePct: parseFloat(item.changepercent) || 0,
        turnoverRate: parseFloat(item.turnoverratio) || 0,
        peRatio: parseFloat(item.per) || 0,
        pbRatio: parseFloat(item.pb) || 0,
        marketCap: (parseFloat(item.mktcap) || 0) / 10000,
      });
    }
    if (data.length < 100) break;
  }
  return results;
}

async function fetchStocksFromEastmoney(): Promise<StockData[]> {
  const results: StockData[] = [];
  const seen = new Set<string>();
  const baseUrl =
    'https://push2.eastmoney.com/api/qt/clist/get?po=1&np=1&fltt=2&invt=2&fid=f3' +
    '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f8,f9,f23,f20';

  for (let page = 1; page <= 60; page++) {
    const resp = await fetch(`${baseUrl}&pn=${page}&pz=100`, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) throw new Error(`Eastmoney API error: ${resp.status}`);
    const json: any = await resp.json();
    const diff: any[] = json && json.data && json.data.diff;
    if (!Array.isArray(diff) || diff.length === 0) break;

    for (const item of diff) {
      const code: string = item.f12;
      const name: string = item.f14;
      if (!code || !name) continue;
      if (!/^(00[0123]|30[0123]|60[0123])/.test(code)) continue;
      if (seen.has(code)) continue;
      seen.add(code);

      results.push({
        code, name,
        price: parseFloat(item.f2) || 0,
        changePct: parseFloat(item.f3) || 0,
        turnoverRate: parseFloat(item.f8) || 0,
        peRatio: parseFloat(item.f9) || 0,
        pbRatio: parseFloat(item.f23) || 0,
        marketCap: (parseFloat(item.f20) || 0) / 100000000,
      });
    }
    if (diff.length < 100) break;
  }
  return results;
}

async function fetchStocks(): Promise<StockData[]> {
  const sources = [fetchStocksFromSina, fetchStocksFromEastmoney];
  let lastError: unknown = null;
  for (const source of sources) {
    try {
      const data = await source();
      if (data.length > 0) return data;
    } catch (e) {
      lastError = e;
      console.log(`数据源 ${source.name} 获取失败:`, e);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有数据源均未获取到数据');
}

function formatStockMessage(stocks: StockData[]): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  if (stocks.length === 0) {
    return `*优选A股股票 (${dateStr})*\n没有符合条件的股票`;
  }

  const lines = stocks.map(
    (s) =>
      `\`${s.code}\` - ${s.name}\n` +
      `最新价: ${s.price.toFixed(2)}\n` +
      `涨跌幅: ${s.changePct.toFixed(2)}%\n` +
      `换手率: ${s.turnoverRate.toFixed(2)}%\n` +
      `总市值: ${s.marketCap.toFixed(2)}亿元\n` +
      `动态市盈率: ${s.peRatio.toFixed(2)}\n` +
      `市净率: ${s.pbRatio.toFixed(2)}\n` +
      `-------------\n`,
  );

  return `*优选A股股票 (${dateStr})*\n共 ${stocks.length} 只股票\n\n${lines.join('')}`;
}

async function sendTelegram(env: Env, stocks: StockData[]): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: formatStockMessage(stocks),
      parse_mode: 'Markdown',
    }),
  });
  if (!resp.ok) {
    throw new Error(`Telegram API error: ${resp.status} ${await resp.text()}`);
  }
}

async function saveToKV(env: Env, stocks: StockData[]): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const result: ScreeningResult = {
    date: dateStr,
    updatedAt: now.toISOString(),
    stocks,
  };

  await env.STOCK_HUNTER.put('latest', JSON.stringify(result));
  await env.STOCK_HUNTER.put(`history:${dateStr}`, JSON.stringify(result));

  const indexRaw = await env.STOCK_HUNTER.get('history:index');
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(dateStr)) {
    index.unshift(dateStr);
    if (index.length > 365) index.length = 365;
    await env.STOCK_HUNTER.put('history:index', JSON.stringify(index));
  }
}

async function handleScreening(env: Env): Promise<string> {
  console.log('开始获取A股数据');

  const allData = await fetchStocks();
  console.log(`获取到 ${allData.length} 条股票数据`);

  if (allData.length === 0) return '未获取到股票数据';

  const selected = allData.filter(matches);
  selected.sort((a: StockData, b: StockData) => b.changePct - a.changePct);

  console.log(`筛选出 ${selected.length} 只符合条件的股票`);

  await Promise.all([
    sendTelegram(env, selected),
    saveToKV(env, selected),
  ]);

  return `完成: ${selected.length} 只股票`;
}

function renderFrontend(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StockHunter - A股筛选</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7fa;color:#333}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:20px 32px;display:flex;align-items:center;gap:16px}
.header h1{font-size:22px;font-weight:600}
.header .sub{font-size:13px;color:#8899b4}
.header .trigger-btn{margin-left:auto;background:#4a7cff;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.header .trigger-btn:hover{background:#3a66d6}
.header .trigger-btn:disabled{background:#8899b4;cursor:not-allowed}
.container{display:flex;gap:0;max-width:1400px;margin:0 auto;min-height:calc(100vh-80px)}
.sidebar{width:260px;min-width:260px;background:#fff;border-right:1px solid #e8ecf1;padding:20px 0;overflow-y:auto}
.sidebar h3{font-size:13px;font-weight:600;color:#8899b4;text-transform:uppercase;padding:0 20px;margin-bottom:12px;letter-spacing:.5px}
.history-item{padding:10px 20px;cursor:pointer;border-left:3px solid transparent;transition:all .15s;display:flex;justify-content:space-between;align-items:center}
.history-item:hover{background:#f0f4ff;border-left-color:#4a7cff}
.history-item.active{background:#eef3ff;border-left-color:#4a7cff;font-weight:600}
.history-item .count{background:#e8ecf1;border-radius:10px;padding:2px 8px;font-size:11px;color:#666}
.history-item.active .count{background:#4a7cff;color:#fff}
.main{flex:1;padding:24px 32px;overflow-y:auto}
.main h2{font-size:18px;margin-bottom:20px;color:#1a1a2e}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.stat-card .label{font-size:12px;color:#8899b4;margin-bottom:4px}
.stat-card .value{font-size:22px;font-weight:700;color:#1a1a2e}
.stat-card .value.green{color:#00c853}
.stat-card .value.red{color:#ff1744}
.chart-container{background:#fff;border-radius:10px;padding:20px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.chart-container h3{font-size:14px;color:#8899b4;margin-bottom:12px}
.table-container{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06);overflow:hidden}
.table-container h3{font-size:14px;padding:16px 20px;border-bottom:1px solid #e8ecf1;color:#1a1a2e}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f8f9fc;padding:10px 16px;text-align:left;font-weight:600;color:#666;border-bottom:1px solid #e8ecf1;white-space:nowrap}
td{padding:10px 16px;border-bottom:1px solid #f0f2f5;white-space:nowrap}
tr:hover td{background:#f8f9fc}
.code{font-family:'SF Mono',monospace;color:#4a7cff;font-weight:600}
.up{color:#ff1744}
.down{color:#00c853}
.empty-state{text-align:center;padding:60px 20px;color:#8899b4}
.empty-state .big{font-size:48px;margin-bottom:12px}
.empty-state p{font-size:15px}
.loading{text-align:center;padding:60px;color:#8899b4}
.loading .spinner{display:inline-block;width:32px;height:32px;border:3px solid #e8ecf1;border-top-color:#4a7cff;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:12px}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:768px){.container{flex-direction:column}.sidebar{width:100%;min-width:auto;border-right:none;border-bottom:1px solid #e8ecf1;padding:12px 0}.sidebar h3{padding:0 16px}.history-item{padding:8px 16px}.main{padding:16px}.stats{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="header">
  <h1>📈 StockHunter</h1>
  <span class="sub">A股优选股票筛选</span>
  <button class="trigger-btn" id="triggerBtn">🔄 手动触发</button>
</div>
<div class="container">
  <div class="sidebar" id="sidebar">
    <h3>📋 历史记录</h3>
    <div id="historyList"></div>
  </div>
  <div class="main" id="mainContent">
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>
  </div>
</div>
<script>
const API_BASE = '';
async function fetchJSON(path){const r=await fetch(API_BASE+path);if(!r.ok)throw new Error(await r.text());return r.json()}

let currentDate = null;

function renderTable(stocks){
  if(stocks.length===0) return '<div class="empty-state"><div class="big">📭</div><p>没有符合条件的股票</p></div>';
  let html = '<table><thead><tr><th>代码</th><th>名称</th><th>最新价</th><th>涨跌幅</th><th>换手率</th><th>市盈率</th><th>市净率</th></tr></thead><tbody>';
  for(const s of stocks){
    const cls = s.changePct>=0?'up':'down';
    html += \`<tr><td class="code">\${s.code}</td><td>\${s.name}</td><td>\${s.price.toFixed(2)}</td><td class="\${cls}">\${s.changePct>=0?'+':''}\${s.changePct.toFixed(2)}%</td><td>\${s.turnoverRate.toFixed(2)}%</td><td>\${s.peRatio.toFixed(2)}</td><td>\${s.pbRatio.toFixed(2)}</td></tr>\`;
  }
  html += '</tbody></table>';
  return html;
}

function renderMain(result){
  const {date, updatedAt, stocks} = result;
  currentDate = date;
  const timeStr = new Date(updatedAt).toLocaleString('zh-CN');
  return \`
    <h2>\${date.slice(0,4)}-\${date.slice(4,6)}-\${date.slice(6,8)} 筛选结果</h2>
    <div style="font-size:12px;color:#8899b4;margin-bottom:16px">更新时间: \${timeStr}</div>
    
    <div class="chart-container"><h3>📊 历史筛选数量趋势</h3><div style="height:240px"><canvas id="stockChart"></canvas></div></div>
    <div class="table-container"><h3>详细列表 (\${stocks.length} 只)</h3>\${renderTable(stocks)}</div>
  \`;
}

function renderHistory(dates){
  const list = document.getElementById('historyList');
  list.innerHTML = dates.map(d=>{
    const isActive = d.date === currentDate;
    return \`<div class="history-item\${isActive?' active':''}" onclick="loadDate('\${d.date}')"><span>\${d.date.slice(0,4)}-\${d.date.slice(4,6)}-\${d.date.slice(6,8)}</span><span class="count">\${d.count}</span></div>\`;
  }).join('');
}

let chartInstance = null;
let historyData = [];

function initChart(){
  if(chartInstance){chartInstance.destroy();chartInstance=null}
  const canvas=document.getElementById('stockChart');
  if(!canvas||historyData.length<2)return;
  const labels=historyData.map(h=>h.date.slice(0,4)+'-'+h.date.slice(4,6)+'-'+h.date.slice(6,8)).reverse();
  const counts=historyData.map(h=>h.count).reverse();
  chartInstance=new Chart(canvas,{
    type:'bar',
    data:{labels,datasets:[{label:'筛选股票数量',data:counts,backgroundColor:'rgba(74,124,255,0.6)',borderColor:'#4a7cff',borderWidth:1,borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{stepSize:1,precision:0}},x:{grid:{display:false},ticks:{maxRotation:45}}}}
  });
}

async function loadDate(date){
  const main = document.getElementById('mainContent');
  main.innerHTML = '<div class="loading"><div class="spinner"></div><p>加载中...</p></div>';
  try {
    const result = await fetchJSON(\`/api/history/\${date}\`);
    main.innerHTML = renderMain(result);
    const history = await fetchJSON('/api/history');
    historyData = history||[];
    renderHistory(history);
    initChart();
  } catch(e){
    main.innerHTML = \`<div class="empty-state"><div class="big">⚠️</div><p>加载失败: \${e.message}</p></div>\`;
  }
}

async function init(){
  const main = document.getElementById('mainContent');
  try {
    const [latest, history] = await Promise.all([
      fetchJSON('/api/latest'),
      fetchJSON('/api/history')
    ]);
    historyData = history||[];
    if(latest && latest.stocks){
      main.innerHTML = renderMain(latest);
    } else {
      main.innerHTML = \`<div class="empty-state"><div class="big">📭</div><p>暂无筛选结果</p></div>\`;
    }
    renderHistory(history||[]);
    initChart();
  } catch(e){
    main.innerHTML = \`<div class="empty-state"><div class="big">⚠️</div><p>加载失败: \${e.message}</p></div>\`;
  }
}

async function triggerScreening(){
  const btn = document.getElementById('triggerBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 筛选中...';
  try {
    const r = await fetch('/trigger', {method:'POST'});
    const res = await r.json();
    if(!r.ok) throw new Error(res.error || '触发失败');
    alert('✅ ' + res.message);
    await init();
  } catch(e){
    alert('❌ 触发失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 手动触发';
  }
}
document.getElementById('triggerBtn').addEventListener('click', triggerScreening);
init();
</script>
</body>
</html>`;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (!isTradingDay()) {
      console.log('今天不是交易日，跳过');
      return;
    }
    try {
      const result = await handleScreening(env);
      console.log(result);
    } catch (e) {
      console.error('执行失败:', e);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/trigger') {
      try {
        const result = await handleScreening(env);
        return new Response(JSON.stringify({ success: true, message: result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (path === '/api/latest') {
      const data = await env.STOCK_HUNTER.get('latest');
      return new Response(data || 'null', {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
    }

    if (path === '/api/history') {
      const raw = await env.STOCK_HUNTER.get('history:index');
      const dates: string[] = raw ? JSON.parse(raw) : [];
      const items = await Promise.all(
        dates.map(async (d) => {
          const raw = await env.STOCK_HUNTER.get(`history:${d}`);
          if (!raw) return null;
          const result: ScreeningResult = JSON.parse(raw);
          return { date: d, count: result.stocks.length };
        }),
      );
      return new Response(JSON.stringify(items.filter(Boolean)), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
    }

    const historyMatch = path.match(/^\/api\/history\/(\d{8})$/);
    if (historyMatch) {
      const data = await env.STOCK_HUNTER.get(`history:${historyMatch[1]}`);
      if (!data) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(data, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
    }

    return new Response(renderFrontend(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
