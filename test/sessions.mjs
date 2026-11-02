// Integration tests of stage 2B-sessions (2В): /sessions and session_id in /execute and /start, against a stand-in site.
// Run: npm test  (or: node --test test/sessions.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSite, GOOD_KEY } from './mock-site.mjs';
import { createApp } from '../ask-code-server.mjs';
import { historyFile, saveHistory } from '../build/ask-code-core.mjs';
import { resetSessions } from '../lib/sessions.mjs';
import { setLogLevel } from '../lib/log.mjs';

let root, home, site, app, base;

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, json: type.includes('json') ? JSON.parse(text) : null, text };
};
const post = (path, body = {}) => call('POST', path, body);
const get = (path) => call('GET', path);

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-ses-'));
  home = mkdtempSync(join(tmpdir(), 'ask-home-'));
  mkdirSync(join(root, 'sub'));
  site = await startMockSite();
  app = createApp({ key: GOOD_KEY, site: site.url, root, home, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 3, logLevel: 'error' });
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(500);
  await site.close();
  resetSessions();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('POST /sessions makes a session; GET /sessions lists it as the current one', async () => {
  assert.deepEqual((await get('/sessions')).json, { ok: true, sessions: [] });

  const a = await post('/sessions', { title: '  Add   tests ' });
  assert.equal(a.status, 200);
  assert.equal(a.json.ok, true);
  assert.match(a.json.session_id, /^[A-Za-z0-9_-]+$/);

  const list = await get('/sessions');
  assert.equal(list.status, 200);
  assert.equal(list.json.sessions.length, 1);
  const [s] = list.json.sessions;
  assert.equal(s.id, a.json.session_id);
  assert.equal(s.title, 'Add tests');
  assert.equal(s.requests, 0);
  assert.equal(s.current, true);
  assert.ok(!Number.isNaN(Date.parse(s.savedAt)));

  const b = await post('/sessions');
  assert.notEqual(b.json.session_id, a.json.session_id);
  const two = (await get('/sessions')).json.sessions;
  assert.equal(two.length, 2);
  assert.deepEqual(two.filter((x) => x.current).map((x) => x.id), [b.json.session_id]);
});

test('/sessions: bad title and folders outside the project are refused', async () => {
  assert.equal((await post('/sessions', { title: 5 })).status, 400);
  assert.equal((await post('/sessions', { folder: '..' })).status, 403);
  assert.equal((await get('/sessions?folder=..')).status, 400);
  assert.equal((await get('/sessions?folder=nope')).status, 404);
  assert.equal((await get('/sessions?folder=sub')).json.sessions.length, 0);
});

// ─── session_id in /execute and /start ───────────────────────────────────────────────────────────

const parseSSE = (text) =>
  text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') }));
const execute = async (body) => {
  const r = await post('/execute', body);
  return { status: r.status, json: r.json, events: r.text.startsWith('event') || r.text.startsWith(':') ? parseSSE(r.text) : null };
};
const codeBodies = () => site.requests.filter((r) => r.path === '/v1/code').map((r) => r.body);
const waitDone = async (taskId) => {
  for (let i = 0; i < 100; i++) {
    const s = (await get(`/status/${taskId}`)).json;
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('task did not finish');
};

test('/execute without session_id stays stateless: empty history, no session event', async () => {
  const r = await execute({ prompt: 'plain question' });
  assert.equal(r.status, 200);
  assert.ok(!r.events.some((e) => e.event === 'session'));
  assert.deepEqual(codeBodies().at(-1).history, []);
  assert.equal((await get('/sessions')).json.sessions.some((s) => s.title === 'plain question'), false);
});

test('/execute with session_id: history is sent and grows, session event, /status has session_id', async () => {
  const { json: made } = await post('/sessions', { title: 'My task' });
  const id = made.session_id;

  const first = await execute({ prompt: 'first request', session_id: id });
  assert.equal(first.status, 200);
  const ev = first.events.find((e) => e.event === 'session');
  assert.deepEqual(ev.data, { session_id: id, requests: 1, title: 'My task' });
  assert.ok(first.events.findIndex((e) => e.event === 'session') < first.events.findIndex((e) => e.event === 'done'));
  assert.deepEqual(codeBodies().at(-1).history, []);

  const second = await execute({ prompt: 'second request', session_id: id });
  assert.equal(second.events.find((e) => e.event === 'session').data.requests, 2);
  const sent = codeBodies().at(-1).history;
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { role: 'user', text: 'first request' });
  assert.equal(sent[1].role, 'assistant');
  assert.match(sent[1].text, /^ok/);

  const saved = (await get(`/sessions/${id}`)).json;
  assert.equal(saved.history.length, 4);
  assert.deepEqual(saved.inputs, ['first request', 'second request']);
  assert.equal(saved.title, 'My task');
  assert.equal((await get('/sessions')).json.sessions.find((s) => s.id === id).requests, 2);
});

test('/start with session_id: /status has session_id, the request joins the session; an unknown valid id starts a new one', async () => {
  const started = await post('/start', { prompt: 'in the background', session_id: 'bg-1' });
  assert.equal(started.status, 200);
  const s = await waitDone(started.json.taskId);
  assert.equal(s.status, 'done');
  assert.equal(s.session_id, 'bg-1');
  const saved = (await get('/sessions/bg-1')).json;
  assert.equal(saved.history.length, 2);
  assert.equal(saved.title, 'in the background');

  const plain = await post('/start', { prompt: 'no session' });
  assert.equal('session_id' in (await waitDone(plain.json.taskId)), false);
});

test('session_id: bad ids are 400; a second task in a busy session is 409 and the session frees up afterwards', async () => {
  assert.equal((await post('/start', { prompt: 'x', session_id: '../x' })).status, 400);
  assert.equal((await post('/start', { prompt: 'x', session_id: 7 })).status, 400);
  assert.equal((await post('/execute', { prompt: 'x', session_id: '' })).status, 400);

  site.setScenario(async ({ emit, sleep }) => {
    emit('delta', { text: 'slow' });
    await sleep(300);
  });
  try {
    const slow = await post('/start', { prompt: 'slow one', session_id: 'busy-1' });
    assert.equal(slow.status, 200);
    const clash = await post('/start', { prompt: 'clash', session_id: 'busy-1' });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.code, 'session_busy');
    assert.equal((await post('/execute', { prompt: 'clash', session_id: 'busy-1' })).status, 409);
    await waitDone(slow.json.taskId);
    const after = await post('/start', { prompt: 'now free', session_id: 'busy-1' });
    assert.equal(after.status, 200);
    await waitDone(after.json.taskId);
    assert.equal((await get('/sessions/busy-1')).json.history.length, 4);
  } finally {
    site.setScenario(async ({ emit }) => emit('delta', { text: 'ok' }));
  }
});

test('a stopped task keeps what it wrote in the session, marked (stopped)', async () => {
  site.setScenario(async ({ emit, sleep, closed }) => {
    emit('delta', { text: 'half an answ' });
    for (let i = 0; i < 100 && !closed(); i++) await sleep(20);
  });
  try {
    const t = await post('/start', { prompt: 'long one', session_id: 'stop-1' });
    await new Promise((r) => setTimeout(r, 150));
    await post(`/stop/${t.json.taskId}`);
    assert.equal((await waitDone(t.json.taskId)).status, 'stopped');
    await new Promise((r) => setTimeout(r, 100));
    const saved = (await get('/sessions/stop-1')).json;
    assert.match(saved.history[1].text, /half an answ\n\(stopped\)/);
  } finally {
    site.setScenario(async ({ emit }) => emit('delta', { text: 'ok' }));
  }
});

// ─── resume, read, export (sessions seeded on disk the way ask-code saves them) ──────────────────

const seed = async (id, title, turns) => {
  const own = historyFile(site.url, root, home);
  const file = id === 'own' ? own : join(own.replace(/\.json$/, ''), `${id}.json`);
  const history = turns.flatMap((t) => [{ role: 'user', text: t }, { role: 'assistant', text: `answer to ${t}` }]);
  await saveHistory(file, history, title, turns);
};

test('GET /sessions/:id: history, title, inputs; 404 and 400', async () => {
  await seed('old-one', 'Fix bug', ['fix the bug', 'and the test']);
  const r = await get('/sessions/old-one');
  assert.equal(r.status, 200);
  assert.equal(r.json.title, 'Fix bug');
  assert.equal(r.json.history.length, 4);
  assert.deepEqual(r.json.inputs, ['fix the bug', 'and the test']);
  assert.ok(r.json.savedAt);
  assert.equal((await get('/sessions/nope')).status, 404);
  assert.equal((await get('/sessions/a.b')).status, 400);
  const listed = (await get('/sessions')).json.sessions.find((s) => s.id === 'old-one');
  assert.equal(listed.requests, 2);
  assert.equal(listed.current, false);
});

test('POST /sessions/resume: switches the current session; 409 when it already is; 404; 400', async () => {
  const r = await post('/sessions/resume', { id: 'old-one' });
  assert.equal(r.status, 200);
  assert.equal(r.json.session_id, 'old-one');
  assert.equal(r.json.title, 'Fix bug');
  assert.equal(r.json.history.length, 4);
  assert.deepEqual((await get('/sessions')).json.sessions.filter((s) => s.current).map((s) => s.id), ['old-one']);
  assert.equal((await post('/sessions/resume', { id: 'old-one' })).status, 409);
  assert.equal((await post('/sessions/resume', { id: 'missing' })).status, 404);
  assert.equal((await post('/sessions/resume', {})).status, 400);
  assert.equal((await post('/sessions/resume', { id: '../x' })).status, 400);
  assert.equal((await post('/sessions/resume', { id: 'old-one', folder: '..' })).status, 403);
});

test('POST /sessions/:id/export: writes Markdown, never over a file; plan, secrets, outside and unknown are refused', async () => {
  const r = await post('/sessions/old-one/export', { filename: 'notes.md' });
  assert.equal(r.status, 200);
  assert.equal(r.json.path, 'notes.md');
  const md = readFileSync(join(root, 'notes.md'), 'utf8');
  assert.match(md, /^# Fix bug/);
  assert.match(md, /\*\*You:\*\* fix the bug/);
  assert.match(md, /\*\*Ask:\*\* answer to and the test/);

  const again = await post('/sessions/old-one/export', { filename: 'notes.md' });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'file_exists');

  const auto = await post('/sessions/old-one/export', {});
  assert.equal(auto.status, 200);
  assert.match(auto.json.path, /^ask-code-\d{4}-\d\d-\d\d-\d\d-\d\d\.md$/);

  assert.equal((await post('/sessions/old-one/export', { filename: 'x.md', mode: 'plan' })).status, 403);
  assert.equal((await post('/sessions/old-one/export', { filename: '.env' })).status, 403);
  assert.equal((await post('/sessions/old-one/export', { filename: '../../x.md' })).status, 403);
  assert.equal((await post('/sessions/nope/export', {})).status, 404);
  const empty = await post('/sessions');
  assert.equal((await post(`/sessions/${empty.json.session_id}/export`, {})).status, 400);
  assert.ok(!existsSync(join(root, '.env')));
});
