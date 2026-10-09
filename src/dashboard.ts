import type { FastifyInstance } from "fastify";
import type { Store } from "./db.js";

export function registerDashboard(app: FastifyInstance, store: Store): void {
  app.get('/dashboard', async (_req, reply) => reply.type('text/html').send(page));
  app.get<{Params: {id: string}; Querystring: {from?: string; to?: string; before?: string}}>(
    '/api/services/:id/health-history', async (req, reply) => {
      const service = store.getService(req.params.id);
      if (!service) return reply.code(404).send({error: 'service not found'});
      const to = req.query.to === undefined ? Date.now() : Number(req.query.to);
      const from = req.query.from === undefined ? to - 86400000 : Number(req.query.from);
      const before = req.query.before === undefined ? undefined : Number(req.query.before);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to ||
          to - from > 30 * 86400000 || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) {
        return reply.code(400).send({error: 'Use epoch milliseconds, from < to, maximum 30 days, and a positive integer cursor'});
      }
      reply.header('Cache-Control', 'no-store');
      return {...store.probeHistory(req.params.id, from, to, before),
        enabled: service.enabled, staleAfterMs: Math.max(service.intervalSec * 2000, service.probeTimeoutMs * 2)};
    });
}

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watchdog · 服务健康</title><style>
body{font:15px system-ui,sans-serif;background:#f3f6fa;color:#172b46;margin:0}main{max-width:1100px;margin:40px auto;padding:0 24px}
h1{margin-bottom:8px}h2{font-size:19px}p{color:#53657b;line-height:1.6}section{background:white;border:1px solid #dce4ed;border-radius:12px;padding:24px;margin:20px 0}
.controls{display:flex;flex-wrap:wrap;gap:16px;align-items:end}label{display:grid;gap:6px}select,button{font:inherit;padding:10px;border:1px solid #b3c2d4;border-radius:6px;background:white;color:#172b46}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}#metric{font-size:34px;font-weight:700}#chart{display:flex;height:170px;gap:4px;align-items:end;border-bottom:1px solid #b3c2d4;margin-top:20px}
.bucket{flex:1;height:100%;display:flex;align-items:end;background:#f0f3f7;position:relative}.bar{width:100%;background:#227665;min-height:2px}.empty{background:repeating-linear-gradient(45deg,#e6ebf1,#e6ebf1 4px,#f8fafc 4px,#f8fafc 8px)}
.axis{display:flex;justify-content:space-between;font-size:12px;color:#53657b;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}td,th{padding:12px 8px;border-bottom:1px solid #e3e9f0}td:last-child{overflow-wrap:anywhere;max-width:400px}.bad{color:#b32c36}.good{color:#227665}#message{min-height:24px}
</style></head><body><main><h1>Watchdog</h1><p>按服务查看实际 health check 结果</p>
<div class="controls"><label>服务<select id="service" aria-label="服务"></select></label>
<label>时间范围<select id="range"><option value="1">最近 1 小时</option><option value="24" selected>最近 24 小时</option><option value="168">最近 7 天</option><option value="720">最近 30 天</option></select></label><button id="refresh">刷新</button></div>
<p id="message" role="status" aria-live="polite"></p>
<p id="latest"></p>
<section><h2>可用性 SLA · 探测样本</h2><div id="metric">—</div><p id="counts"></p>
<p>成功探测数 ÷ 总探测数；不是按时长加权的 SLA。包括手动探测，不使用状态机的滞回结果。无样本不代表健康。</p>
<div id="chart" role="img" aria-label="可用率图表"></div><div class="axis"><span id="start"></span><span>每柱 0–100% · 斜线为无数据</span><span id="end"></span></div></section>
<section><h2>逐次 health check</h2><p>时间为浏览器本地时区，范围包含起点、不含终点。历史保留 30 天，上线前数据不回填。记录按写入顺序倒序。</p>
<div class="table"><table><thead><tr><th>探测时间</th><th>结果</th><th>耗时</th><th>HTTP 状态</th><th>错误</th></tr></thead><tbody id="events"></tbody></table></div><p id="empty"></p><button id="more" disabled>加载更早记录</button></section>
</main><script>
const el=id=>document.getElementById(id); let generation=0, windowRange, cursor=null;
const date=n=>new Date(n).toLocaleString(); const pct=n=>n===null?'无数据':n.toFixed(2)+'%';
async function json(url){const r=await fetch(url);if(!r.ok)throw new Error('请求失败 ('+r.status+')');return r.json();}
function clear(){el('latest').textContent='';el('metric').textContent='—';el('counts').textContent='';el('chart').replaceChildren();el('events').replaceChildren();el('empty').textContent='';el('start').textContent='';el('end').textContent='';el('more').disabled=true;cursor=null;}
function render(data,append){
 if(!append){el('metric').textContent=pct(data.availability);el('counts').textContent=data.successful+' 次成功 / '+data.total+' 次探测';
 const last=data.latest;const stale=last&&Date.now()-last.checkedAt>data.staleAfterMs;
 el('latest').textContent='最新探测（独立于时间筛选）：'+(!last?'无数据':date(last.checkedAt)+' · '+(last.ok?'成功':'失败'))+(!data.enabled?' · 服务已禁用':stale?' · 数据已过期，当前健康未知':'');
 el('start').textContent=date(data.from);el('end').textContent=date(data.to);
 for(const b of data.buckets){const col=document.createElement('div');col.className='bucket'+(b.total?'':' empty');col.title=date(b.from)+' – '+date(b.to)+': '+pct(b.availability)+' ('+b.successful+'/'+b.total+')';
 if(b.total){const bar=document.createElement('div');bar.className='bar';bar.style.height=b.availability+'%';col.append(bar);}el('chart').append(col);}
 el('chart').setAttribute('aria-label','可用率 '+pct(data.availability)+'，24 个等宽时间区间；悬停查看详情');}
 for(const e of data.events){const tr=document.createElement('tr');for(const value of [date(e.checkedAt),e.ok?'健康':'失败',e.latencyMs+' ms',e.status??'—',e.error??'—']){const td=document.createElement('td');td.textContent=value;tr.append(td);}tr.children[1].className=e.ok?'good':'bad';el('events').append(tr);}
 el('empty').textContent=data.total?'':'此时间范围无探测数据';cursor=data.nextCursor;el('more').disabled=cursor===null;
}
async function load(append=false){
 const token=append?generation:++generation;
 if(!append){clear();windowRange={to:Date.now()};windowRange.from=windowRange.to-Number(el('range').value)*3600000;}
 if(!el('service').value){el('message').textContent='暂无服务';return;}
 el('message').textContent='正在读取…';el('more').disabled=true;
 const q=new URLSearchParams({from:windowRange.from,to:windowRange.to});if(append&&cursor)q.set('before',cursor);
 try{const data=await json('/api/services/'+encodeURIComponent(el('service').value)+'/health-history?'+q);
 if(token!==generation)return;render(data,append);el('message').textContent='数据截至 '+date(windowRange.to)+' · 点击刷新获取最新探测';}
 catch(e){if(token===generation){el('message').textContent=e.message;el('more').disabled=cursor===null;}}
}
el('service').onchange=()=>load();el('range').onchange=()=>load();el('refresh').onclick=()=>load();el('more').onclick=()=>load(true);
json('/api/services').then(data=>{for(const s of data.services){const option=document.createElement('option');option.value=s.contract.serviceId;option.textContent=s.contract.name+' ('+s.contract.serviceId+')'+(s.contract.enabled?'':' · 已禁用');el('service').append(option);}load();}).catch(e=>{el('message').textContent=e.message;});
</script></body></html>`;
