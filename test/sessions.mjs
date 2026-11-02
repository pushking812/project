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
