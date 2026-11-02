// Integration tests of stage 2B-sessions (2В): /sessions and session_id in /execute and /start, against a stand-in site.
// Run: npm test  (or: node --test test/sessions.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSite, GOOD_KEY } from './mock-site.mjs';
import { createApp } from '../ask-code-server.mjs';
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
