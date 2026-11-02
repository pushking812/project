// Integration tests of stage 2E: /context, /status, /compact, /models, /model, /doctor, /bug, against a stand-in site.
// Run: npm test  (or: node --test test/diagnostics.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSite, GOOD_KEY } from './mock-site.mjs';
import { createApp } from '../ask-code-server.mjs';
import { historyFile, saveHistory, loadHistory, FOLDED_MARK } from '../build/ask-code-core.mjs';
import { resetSessions } from '../lib/sessions.mjs';
import { setLogLevel } from '../lib/log.mjs';

let root, home, site, app, base, file;

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, json: type.includes('json') ? JSON.parse(text) : null, text };
};
const post = (path, body = {}) => call('POST', path, body);
const get = (path) => call('GET', path);

const parseSSE = (text) =>
  text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') }));

const turns = (n) => Array.from({ length: n }, (_, i) => [{ role: 'user', text: `question ${i + 1}` }, { role: 'assistant', text: `answer ${i + 1} ${'lorem '.repeat(150)}` }]).flat();

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-diag-'));
  home = mkdtempSync(join(tmpdir(), 'ask-home-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'ASK.md'), '# Notes\n\nUse tabs.\n');
  site = await startMockSite();
  file = historyFile(site.url, root, home);
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

// ─── /context and /status ────────────────────────────────────────────────────────────────────────

test('GET /context: a folder without a task has an empty task and a full context', async () => {
  const r = await get('/context');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tokens.task, 0);
  assert.ok(r.json.tokens.notes > 0, 'ASK.md counts');
  assert.ok(r.json.tokens.env > 0);
  assert.equal(r.json.tokens.memory, 0);
  assert.equal(r.json.contextLeft, 100);
  assert.equal(r.json.requests, 0);
  assert.equal(r.json.session_id, null);
});

test('GET /context: the task of the current session is counted', async () => {
  await saveHistory(file, turns(5), 'Add tests', ['question 1']);
  const r = await get('/context');
  assert.equal(r.status, 200);
  assert.ok(r.json.tokens.task > 0);
  assert.equal(r.json.requests, 5);
  assert.ok(r.json.contextLeft < 100 && r.json.contextLeft > 70, `contextLeft ${r.json.contextLeft}`);
  assert.ok(r.json.session_id);

  const same = await get(`/context?session_id=${r.json.session_id}`);
  assert.equal(same.json.requests, 5);
});

test('GET /context: unknown session 404, bad id 400, folder outside 400', async () => {
  assert.equal((await get('/context?session_id=nope')).status, 404);
  assert.equal((await get('/context?session_id=a%2Fb')).status, 400);
  assert.equal((await get('/context?folder=..')).status, 400);
  assert.equal((await get('/context?folder=sub')).json.requests, 0);
});

test('GET /status: account, plan, model, folder, mode, task, memory, notes', async () => {
  const r = await get('/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.site, site.url);
  assert.equal(r.json.account, 'Tester');
  assert.equal(r.json.plan, 'plus');
  assert.equal(r.json.model, null);
  assert.equal(r.json.folder, root);
  assert.equal(r.json.mode, 'all');
  assert.deepEqual(r.json.task, { title: 'Add tests', requests: 5 });
  assert.deepEqual(r.json.memory, { chars: 0, topics: [] });
  assert.equal(r.json.notes.clipped, false);
  assert.ok(r.json.notes.sources.some((s) => s.where === 'ASK.md'));
});

test('GET /status: a wrong key at the site is 401', async () => {
  const other = createApp({ key: 'sk-ask-wrong', site: site.url, root, home, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 1, logLevel: 'error' });
  const port = await other.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 401);
  } finally {
    await other.shutdown(500);
  }
});

// STAGE-2E-TESTS-END
