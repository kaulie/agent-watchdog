import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerDashboard } from '../src/dashboard.js';
import { buildContract } from '../src/contract.js';
import { MonitorEngine } from '../src/engine.js';
import { PauseController } from '../src/pause.js';
import { tmpConfig, tmpStore } from './helpers.js';

test('history isolates services, uses [from,to), counts raw results and empty buckets', async () => {
  const config = tmpConfig(), store = tmpStore(config), app = Fastify();
  try {
    for (const serviceId of ['a', 'b']) store.upsertService(buildContract({serviceId, probeTarget:'http://localhost/health'}, config));
    for (const [service, time, ok] of [['a',1000,true],['a',1500,false],['a',2000,true],['b',1200,true]] as const) {
      store.recordProbe(service, {ok, checkedAt:new Date(time).toISOString(), latencyMs:12, status:ok?200:503, error:ok?undefined:'unavailable'});
    }
    registerDashboard(app, store);
    const data = (await app.inject('/api/services/a/health-history?from=1000&to=2000')).json();
    assert.equal(data.total, 2); assert.equal(data.successful, 1); assert.equal(data.availability, 50);
    assert.equal(data.buckets.length, 24); assert.equal(data.buckets[1].availability, null);
    assert.deepEqual(data.events.map((e: {ok:boolean}) => e.ok), [false,true]);
    assert.equal(data.events[0].error, 'unavailable'); assert.equal(data.events[0].status,503);
    assert.equal(data.events[0].latencyMs,12);
    assert.equal(data.hasOlder, false);
    assert.equal((await app.inject('/api/services/b/health-history?from=1000&to=2000')).json().availability,100);
    assert.equal((await app.inject('/api/services/a/health-history?from=3000&to=4000')).json().hasOlder, true);
    assert.equal((await app.inject('/api/services/a/health-history?from=3000&to=4000')).json().availability,null);
    for (const query of ['from=no','from=1&to=1','from=0&to=99999999999','before=-1','from=1.1&to=3']) {
      assert.equal((await app.inject('/api/services/a/health-history?'+query)).statusCode,400);
    }
    assert.equal((await app.inject('/api/services/missing/health-history')).statusCode,404);
    const page = await app.inject('/dashboard'); assert.equal(page.statusCode,200);
    assert.match(page.headers['content-type']!, /text\/html/);
    assert.match(page.body,/逐次 health check/); assert.match(page.body,/textContent=value/);
    assert.match(page.body,/探测记录来自本机 SQLite/); assert.match(page.body,/不会现场探活/);
    assert.match(page.body,/启停记录/);
    assert.match(page.body,/hasOlder/);
    assert.match(page.body,/stepWin/);
    assert.match(page.body,/id="more" hidden disabled/);
  } finally {await app.close();store.close();}
});

test('remediation history isolates services, uses [from,to) and pages', async () => {
  const config = tmpConfig(), store = tmpStore(config), app = Fastify();
  try {
    store.upsertService(buildContract({serviceId:'a', probeTarget:'http://localhost/health'}, config));
    store.upsertService(buildContract({serviceId:'b', probeTarget:'http://localhost/health'}, config));
    store.addRemediation({serviceId:'a', action:'start', command:'bash start.sh', ok:true, exitCode:0,
      durationMs:10, trigger:'threshold', output:'', createdAt:new Date(1500).toISOString()});
    store.addRemediation({serviceId:'a', action:'start', command:'bash start.sh', ok:false, exitCode:1,
      durationMs:21, trigger:'manual', output:'busy', createdAt:new Date(1800).toISOString()});
    store.addRemediation({serviceId:'a', action:'restart', command:'bash restart.sh', ok:true, exitCode:0,
      durationMs:22, trigger:'manual', output:'', createdAt:new Date(2500).toISOString()});
    store.addRemediation({serviceId:'b', action:'stop', command:'bash stop.sh', ok:true, exitCode:0,
      durationMs:5, trigger:'manual', output:'', createdAt:new Date(1600).toISOString()});
    registerDashboard(app, store);
    const data = (await app.inject('/api/services/a/remediation-history?from=1000&to=2000')).json();
    assert.equal(data.total, 2);
    assert.equal(data.hasOlder, false);
    assert.equal((await app.inject('/api/services/a/remediation-history?from=2000&to=3000')).json().hasOlder, true);
    assert.deepEqual(data.events.map((e: {action:string}) => e.action), ['start','start']);
    assert.equal(data.events[0].ok, false);
    assert.equal(data.events[0].output, 'busy');
    assert.equal(data.events[1].trigger, 'threshold');
    assert.equal((await app.inject('/api/services/b/remediation-history?from=1000&to=2000')).json().total, 1);
    assert.equal((await app.inject('/api/services/a/remediation-history?from=2000&to=3000')).json().events[0].action, 'restart');
    assert.equal((await app.inject('/api/services/missing/remediation-history')).statusCode, 404);
    assert.equal((await app.inject('/api/services/a/remediation-history?from=1&to=1')).statusCode, 400);
    for (let i=0;i<101;i++) store.addRemediation({serviceId:'a', action:'start', command:'x', ok:true, exitCode:0,
      durationMs:1, trigger:'threshold', output:'', createdAt:new Date(1100).toISOString()});
    const first=(await app.inject('/api/services/a/remediation-history?from=1000&to=2000')).json();
    assert.equal(first.events.length,100); assert.ok(first.nextCursor);
    const second=(await app.inject('/api/services/a/remediation-history?from=1000&to=2000&before='+first.nextCursor)).json();
    assert.equal(first.total, second.total); assert.ok(second.events.length>=1);
  } finally {await app.close();store.close();}
});

test('hasOlder stays true after the in-window page is exhausted', () => {
  const store = tmpStore(tmpConfig());
  try {
    store.recordProbe('a',{ok:true,checkedAt:new Date(100).toISOString(),latencyMs:1});
    for (let i=0;i<101;i++) store.recordProbe('a',{ok:true,checkedAt:new Date(1500).toISOString(),latencyMs:1});
    const first=store.probeHistory('a',1000,2000);
    assert.equal(first.events.length,100); assert.ok(first.nextCursor); assert.equal(first.hasOlder,true);
    const rest=store.probeHistory('a',1000,2000,first.nextCursor!);
    assert.equal(rest.nextCursor,null); assert.equal(rest.hasOlder,true); assert.equal(rest.total,101);
    assert.equal(store.probeHistory('a',0,2000).hasOlder,false);
  } finally {store.close();}
});

test('cursor pages every check once and does not change aggregate; time-based retention', () => {
  const store = tmpStore(tmpConfig());
  try {
    for (let i=0;i<205;i++) store.recordProbe('a',{ok:i%2===0,checkedAt:new Date(1000).toISOString(),latencyMs:1});
    const first=store.probeHistory('a',0,2000);
    const second=store.probeHistory('a',0,2000,first.nextCursor!);
    const third=store.probeHistory('a',0,2000,second.nextCursor!);
    assert.equal(first.events.length,100);assert.equal(second.events.length,100);assert.equal(third.events.length,5);
    assert.equal(third.nextCursor,null);assert.equal(second.total,205);
    assert.equal(new Set([...first.events,...second.events,...third.events].map(e=>e.id)).size,205);
    store.pruneProbes(30*86400000+1000);assert.equal(store.probeHistory('a',0,2000).total,205);
    store.pruneProbes(30*86400000+1001);assert.equal(store.probeHistory('a',0,2000).total,0);
  } finally {store.close();}
});

test('engine persists every raw probe with audit recording off, before hysteresis, across restart', async () => {
  const config = tmpConfig(); config.recordAllProbes=false;
  let store = tmpStore(config);
  const svc=store.upsertService(buildContract({serviceId:'a',probeTarget:'http://localhost/health',failureThreshold:3,remediation:'none'},config));
  const engine=new MonitorEngine(store,config,new PauseController(config),{
    probe:async()=>({ok:false,checkedAt:new Date(1000).toISOString(),latencyMs:10,error:'timeout'}),
  });
  try {
    await engine.probeNow('a');
    assert.notEqual(engine.getStatus(svc.serviceId)?.state,'down');
    assert.equal(store.listEvents({type:'probe'}).length,0);
    store.pruneEvents(0);
    assert.equal(store.probeHistory('a',0,2000).availability,0);
    store.close(); store=tmpStore(config);
    assert.equal(store.probeHistory('a',0,2000).events[0]?.error,'timeout');
  } finally {store.close();}
});
