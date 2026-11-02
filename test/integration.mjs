// Integration tests: the real server (in this process and as a child process) against a stand-in for the ask site.
// Run: npm test  (or: node test/integration.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockSite, GOOD_KEY } from './mock-site.mjs';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';

const SERVER = fileURLToPath(new URL('../ask-code-server.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let root, site, app, base;
const MAX = 2;

const config = (over = {}) => ({ key: GOOD_KEY, site: site.url, root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: MAX, logLevel: 'error', ...over });
const startApp = async (over) => {
  const a = createApp(config(over));
  return { app: a, base: `http://127.0.0.1:${await a.listen()}` };
};

/** Parses an SSE body into [{event, data}]. */
const parseSSE = (text) =>
  text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : {} };
    });

const post = async (path, body = {}, url = base) => {
  const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const type = res.headers.get('content-type');
  const text = await res.text();
  return { status: res.status, type, json: type.includes('json') ? JSON.parse(text) : null, events: type.includes('event-stream') ? parseSSE(text) : null };
};
const get = async (path, url = base) => {
  const res = await fetch(url + path);
  return { status: res.status, json: await res.json() };
};
const answerOf = (events) => events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
const done = (events) => events.find((e) => e.event === 'done')?.data;

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-int-'));
  writeFileSync(join(root, 'ASK.md'), 'The magic word is PINEAPPLE.');
  writeFileSync(join(root, '.env'), 'TOKEN=super-secret');
  site = await startMockSite();
  ({ app, base } = await startApp());
});

after(async () => {
  await app.shutdown(500);
  await site.close();
  rmSync(root, { recursive: true, force: true });
});

test('GET /health', async () => {
  const { status, json } = await get('/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.keyPresent, true);
  assert.equal(json.maxParallel, MAX);
  assert.equal(json.running, 0);
  assert.equal(json.root, root);
  assert.ok(!JSON.stringify(json).includes(GOOD_KEY), 'the key is not in /health');
});

test('GET /me: the account as the site sends it; 401 for a bad key; 502 when the site is down', async () => {
  const ok = await get('/me');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.code, true);

  const bad = await startApp({ key: 'sk-ask-invalid' });
  const r401 = await get('/me', bad.base);
  assert.equal(r401.status, 401);
  assert.ok(r401.json.error);
  await bad.app.shutdown(200);

  const dead = await startApp({ site: 'http://127.0.0.1:1' });
  const r502 = await get('/me', dead.base);
  assert.equal(r502.status, 502);
  assert.ok(r502.json.error);
  await dead.app.shutdown(200);
});

test('unknown route is 404, wrong method is 405, both as JSON', async () => {
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/execute')).status, 405);
});

test('POST /ask puts ASK.md in the context and streams delta, usage, done', async () => {
  site.setScenario(async ({ body, emit }) => {
    assert.equal(body.commands, false);
    assert.deepEqual(body.history, []);
    emit('delta', { text: body.notes?.includes('PINEAPPLE') ? 'ASK.md says PINEAPPLE' : 'no notes' });
  });
  const r = await post('/ask', { prompt: 'what is in ASK.md?' });
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/event-stream/);
  assert.equal(answerOf(r.events), 'ASK.md says PINEAPPLE');
  assert.deepEqual(r.events.map((e) => e.event), ['delta', 'usage', 'done']);

  site.setScenario(async ({ body, emit }) => emit('delta', { text: body.notes ? 'has notes' : 'no notes' }));
  const bare = await post('/ask', { prompt: 'q', useContext: false });
  assert.equal(answerOf(bare.events), 'no notes');
});

test('POST /ask validates the body', async () => {
  assert.equal((await post('/ask', {})).status, 400);
  assert.equal((await post('/ask', { prompt: 'x', useContext: 'yes' })).status, 400);
});

test('POST /ask: an error from the site is an error event', async () => {
  const r = await post('/ask', { prompt: '__quota__' });
  assert.equal(r.events.at(-1).event, 'error');
  assert.ok(r.events.at(-1).data.message);
});

test('POST /execute creates a file; done.steps says so', async () => {
  site.setScenario(async ({ callTool, emit }) => {
    const res = await callTool('write_file', { path: 'hello.txt', content: 'Hello' });
    emit('delta', { text: res.ok ? 'created' : 'failed' });
  });
  const r = await post('/execute', { prompt: 'create hello.txt with Hello' });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'Hello');
  assert.deepEqual(done(r.events).steps, ['wrote hello.txt']);
  assert.equal(done(r.events).answer, 'created');
  const tool = r.events.find((e) => e.event === 'tool');
  assert.deepEqual(tool.data, { name: 'write_file', ok: true, callId: '1' });
  assert.equal(r.events[0].event, 'status');
});

test('POST /execute: .env is refused and the model sees the refusal', async () => {
  site.setScenario(async ({ callTool, emit }) => emit('delta', { text: JSON.stringify(await callTool('read_file', { path: '.env' })) }));
  const r = await post('/execute', { prompt: 'read .env' });
  const seen = JSON.parse(answerOf(r.events));
  assert.equal(seen.ok, false);
  assert.ok(!seen.output.includes('super-secret'));
  assert.equal(r.events.find((e) => e.event === 'tool').data.ok, false);
});

test('POST /execute: a path outside the folder is refused', async () => {
  site.setScenario(async ({ callTool, emit }) => emit('delta', { text: JSON.stringify(await callTool('read_file', { path: '../../../etc/passwd' })) }));
  const r = await post('/execute', { prompt: 'read passwd' });
  const seen = JSON.parse(answerOf(r.events));
  assert.equal(seen.ok, false);
  assert.ok(!seen.output.includes('root:'));
});

test('run_command does not see ASK_KEY', async () => {
  process.env.ASK_KEY = GOOD_KEY; // as when the real server runs
  try {
    site.setScenario(async ({ callTool, emit }) => {
      const res = await callTool('run_command', { command: `node -e "console.log('unset=' + (process.env.ASK_KEY === undefined))"` });
      emit('delta', { text: JSON.stringify(res) });
    });
    const r = await post('/execute', { prompt: 'echo the key' });
    const seen = JSON.parse(answerOf(r.events));
    assert.ok(seen.output.includes('unset=true'), seen.output);
    assert.ok(!seen.output.includes('unset=false'), seen.output);
    assert.ok(!seen.output.includes(GOOD_KEY));
  } finally {
    delete process.env.ASK_KEY;
  }
});

test('POST /execute and /start validate mode and prompt', async () => {
  for (const path of ['/execute', '/start']) {
    assert.equal((await post(path, { prompt: 'x', mode: 'nope' })).status, 400);
    assert.equal((await post(path, { prompt: '  ' })).status, 400);
  }
});

const slow = async ({ sleep, closed, emit }) => {
  for (let i = 0; i < 200 && !closed(); i++) {
    emit('delta', { text: '.' });
    await sleep(25);
  }
};

test('/start twice, both run on their own; /stop ends one as stopped; the other goes on and finishes', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  site.setScenario(async (ctx) => {
    if (ctx.body.prompt === 'task A') {
      ctx.emit('delta', { text: 'A working' });
      await Promise.race([gate, ctx.sleep(5000)]);
      ctx.emit('delta', { text: ' A finished' });
    } else await slow(ctx);
  });
  const a = await post('/start', { prompt: 'task A' });
  const b = await post('/start', { prompt: 'task B' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.status, 'running');
  assert.notEqual(a.json.taskId, b.json.taskId);
  await sleep(150);
  assert.equal((await get(`/status/${a.json.taskId}`)).json.status, 'running');
  assert.equal((await get(`/status/${b.json.taskId}`)).json.status, 'running');
  assert.equal((await get('/health')).json.running, 2);

  const stop = await post(`/stop/${b.json.taskId}`);
  assert.equal(stop.status, 200);
  assert.equal(stop.json.status, 'stopping');
  await sleep(300);
  const sb = (await get(`/status/${b.json.taskId}`)).json;
  assert.equal(sb.status, 'stopped');
  assert.ok(sb.finishedAt);
  assert.equal((await get(`/status/${a.json.taskId}`)).json.status, 'running');

  release();
  await sleep(300);
  const sa = (await get(`/status/${a.json.taskId}`)).json;
  assert.equal(sa.status, 'done');
  assert.equal(sa.answer, 'A working A finished');
  assert.deepEqual(sa.usage, { input: 10, output: 5 });
  assert.equal(sa.error, null);
  assert.deepEqual(Object.keys(sa).sort(), ['answer', 'error', 'finishedAt', 'startedAt', 'status', 'steps', 'usage']);
  assert.equal((await get('/health')).json.running, 0);
});

test('/start past MAX_PARALLEL is 429; a slot frees when a task ends; /execute takes a slot too', async () => {
  site.setScenario(slow);
  const started = [];
  for (let i = 0; i < MAX; i++) started.push((await post('/start', { prompt: `t${i}` })).json.taskId);
  const over = await post('/start', { prompt: 'one too many' });
  assert.equal(over.status, 429);
  assert.match(over.json.error, /max parallel tasks \(2\)/);
  assert.equal((await post('/execute', { prompt: 'sync too' })).status, 429);

  await post(`/stop/${started[0]}`);
  await sleep(300);
  const again = await post('/start', { prompt: 'fits now' });
  assert.equal(again.status, 200);
  for (const id of [...started.slice(1), again.json.taskId]) await post(`/stop/${id}`);
  await sleep(300);
});

test('/status and /stop of an unknown task are 404', async () => {
  const s = await get('/status/unknown');
  assert.equal(s.status, 404);
  assert.ok(s.json.error);
  assert.equal((await post('/stop/unknown')).status, 404);
});

test('a failing site ends a background task as error', async () => {
  const t = await post('/start', { prompt: '__quota__' });
  await sleep(300);
  const s = (await get(`/status/${t.json.taskId}`)).json;
  assert.equal(s.status, 'error');
  assert.ok(s.error);
});

test('a client that disconnects from /execute stops the task', async () => {
  site.setScenario(slow);
  const controller = new AbortController();
  const res = await fetch(`${base}/execute`, { method: 'POST', body: JSON.stringify({ prompt: 'drop me' }), signal: controller.signal });
  await res.body.getReader().read();
  assert.equal((await get('/health')).json.running, 1);
  controller.abort();
  await sleep(400);
  assert.equal((await get('/health')).json.running, 0);
});

test('shutdown aborts the running tasks', async () => {
  site.setScenario(slow);
  const own = await startApp();
  const t = await post('/start', { prompt: 'long' }, own.base);
  await sleep(100);
  const began = Date.now();
  await own.app.shutdown();
  assert.ok(Date.now() - began < 5000);
  assert.equal(own.app.registry.get(t.json.taskId).status, 'stopped');
});

test('as a process: listens on 127.0.0.1 only, keeps stdout clean, ASK_KEY stays out of the log, refuses to start without a key', async () => {
  const env = { ...process.env, ASK_KEY: GOOD_KEY, ASK_SITE: site.url, ASK_ROOT: root, ASK_PORT: '0', ASK_LOG_LEVEL: 'debug' };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  try {
    for (let i = 0; i < 100 && !/listening on/.test(err); i++) await sleep(50);
    const m = /listening on ([\d.]+):(\d+)/.exec(err);
    assert.ok(m, `no "listening" line: ${err}`);
    assert.equal(m[1], '127.0.0.1');
    const url = `http://127.0.0.1:${m[2]}`;
    assert.equal((await get('/health', url)).json.ok, true);
    assert.equal((await get('/me', url)).status, 200);
    site.setScenario(async ({ callTool, emit }) => {
      await callTool('write_file', { path: 'from-process.txt', content: 'x' });
      emit('delta', { text: 'ok' });
    });
    const r = await post('/execute', { prompt: 'write a file' }, url);
    assert.ok(done(r.events));
    assert.ok(existsSync(join(root, 'from-process.txt')));
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  }
  assert.equal(out, '', 'nothing on stdout');
  assert.ok(!err.includes(GOOD_KEY), 'ASK_KEY is not in the log');
  assert.ok(!err.includes('Hello') && !err.includes('super-secret'));

  const bare = spawn(process.execPath, [SERVER], { env: { ...process.env, ASK_KEY: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let bareErr = '';
  bare.stderr.on('data', (d) => (bareErr += d));
  const code = await new Promise((r) => bare.once('exit', r));
  assert.equal(code, 1);
  assert.match(bareErr, /ASK_KEY/);
});
