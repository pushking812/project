// Live check against the real ask site (read-only; never calls /bug).
// Needs ASK_KEY (and ASK_SITE if not the default). Without a key every test is skipped.
// Run (cmd):  set ASK_KEY=...  &  node --test --test-timeout=240000 --test-reporter=tap test/live.mjs > live.log
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { loadConfig } from '../lib/config.mjs';
import { resetSessions } from '../lib/sessions.mjs';
import { setLogLevel } from '../lib/log.mjs';

const KEY = process.env.ASK_KEY;
const skip = KEY ? false : 'ASK_KEY is not set';
const SITE = (process.env.ASK_SITE || 'https://ask.oryxml.com').replace(/\/+$/, '');

let root, home, app, base, sessionId;

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(text);
  return { status: res.status, json, text };
};
const parseSSE = (text) =>
  text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') }));
const note = (...a) => console.log('# ' + a.join(' '));

before(async () => {
  if (skip) return;
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-live-'));
  home = mkdtempSync(join(tmpdir(), 'ask-live-home-'));
  writeFileSync(join(root, 'hello.txt'), 'the secret word is pelican\n');
  app = createApp({ key: KEY, site: SITE, root, home, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error' });
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  if (!app) return;
  await app.shutdown(500);
  resetSessions();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('1. /doctor: ask is reachable with this key', { skip }, async () => {
  const r = await call('GET', '/doctor');
  assert.equal(r.status, 200);
  const checks = r.json.checks ?? r.json;
  note('doctor:', JSON.stringify(checks).slice(0, 600));
  const ask = Array.isArray(checks) ? checks.find((c) => c.name === 'ask') : checks.ask;
  assert.ok(ask, 'no "ask" check in /doctor');
  assert.equal(ask.ok, true, 'ask check failed: ' + JSON.stringify(ask));
});

test('2. /status, /models, /context have the expected shape', { skip }, async () => {
  const s = await call('GET', '/status');
  note('status:', s.text.slice(0, 500));
  assert.equal(s.status, 200);
  assert.equal(s.json.ok, true);
  const m = await call('GET', '/models');
  note('models:', m.text.slice(0, 500));
  assert.equal(m.status, 200);
  assert.ok(Array.isArray(m.json.models), 'models is not an array');
  assert.ok(m.json.models.length > 0, 'no models');
  const c = await call('GET', '/context');
  note('context:', c.text.slice(0, 300));
  assert.equal(c.status, 200);
  assert.equal(typeof c.json.contextLeft, 'number');
});

test('3. /ask streams an answer', { skip }, async () => {
  const r = await call('POST', '/ask', { prompt: 'Reply with the single word: ok' });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const ev = parseSSE(r.text);
  note('ask events:', ev.map((e) => e.event).join(','));
  assert.ok(ev.some((e) => e.event === 'done'), 'no done event: ' + r.text.slice(0, 300));
  assert.ok(!ev.some((e) => e.event === 'error'), 'error event: ' + JSON.stringify(ev.find((e) => e.event === 'error')));
});

test('4. /execute reads a file with a tool and keeps a session', { skip }, async () => {
  const created = await call('POST', '/sessions', { title: 'live test' });
  assert.equal(created.status, 200, created.text.slice(0, 300));
  sessionId = created.json.session_id;
  const r = await call('POST', '/execute', { prompt: 'Read hello.txt and tell me the secret word.', session_id: sessionId });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const ev = parseSSE(r.text);
  note('execute events:', ev.map((e) => e.event).join(','));
  assert.ok(!ev.some((e) => e.event === 'error'), 'error event: ' + JSON.stringify(ev.find((e) => e.event === 'error')));
  const done = ev.find((e) => e.event === 'done');
  assert.ok(done, 'no done event');
  const all = ev.map((e) => JSON.stringify(e.data)).join(' ').toLowerCase();
  assert.ok(all.includes('pelican'), 'the answer does not mention the file content');
  note('session_id:', sessionId);
});

test('5. a second /execute with session_id remembers the first', { skip }, async () => {
  assert.ok(sessionId, 'no session_id from test 4');
  const r = await call('POST', '/execute', { prompt: 'What was the secret word? Answer with the word only.', session_id: sessionId });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const ev = parseSSE(r.text);
  assert.ok(!ev.some((e) => e.event === 'error'), 'error event');
  assert.ok(ev.map((e) => JSON.stringify(e.data)).join(' ').toLowerCase().includes('pelican'));
});

test('6. /compact replaces the history of the session', { skip }, async () => {
  assert.ok(sessionId, 'no session_id');
  const r = await call('POST', '/compact', { session_id: sessionId });
  note('compact:', r.status, r.text.slice(0, 300));
  // 400 too_short is a valid answer for a very short session; anything else must be a clean stream.
  if (r.status === 400) return assert.equal(r.json.error?.code ?? r.json.code, 'too_short');
  assert.equal(r.status, 200);
  const ev = parseSSE(r.text);
  assert.ok(ev.some((e) => e.event === 'done'), 'no done event');
  assert.ok(!ev.some((e) => e.event === 'error'));
});

test('7. /model picks a listed model and /ask still works', { skip }, async () => {
  const m = await call('GET', '/models');
  const first = m.json.models[0];
  const name = typeof first === 'string' ? first : first.id ?? first.name;
  const bad = await call('POST', '/model', { name: 'no-such-model-xyz' });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/model', { name });
  note('model:', name, ok.status);
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  const r = await call('POST', '/ask', { prompt: 'Reply with the single word: ok' });
  assert.equal(r.status, 200);
  assert.ok(parseSSE(r.text).some((e) => e.event === 'done'));
});
