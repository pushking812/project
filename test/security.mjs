// Stage 2 safety checks together (SPEC §11, criteria 37–40) and a walk over every endpoint of stage 2.
// Run: npm test  (or: node --test test/security.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSite, GOOD_KEY } from './mock-site.mjs';
import { createApp } from '../ask-code-server.mjs';
import { historyFile, saveHistory } from '../build/ask-code-core.mjs';
import { resetSessions } from '../lib/sessions.mjs';
import { setLogLevel } from '../lib/log.mjs';

let root, home, site, apps = [], file;

const open = async (mode) => {
  const app = createApp({ key: GOOD_KEY, site: site.url, root, home, host: '127.0.0.1', port: 0, mode, maxParallel: 3, logLevel: 'error' });
  const port = await app.listen();
  apps.push(app);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  return { app, call, post: (p, b = {}) => call('POST', p, b), get: (p) => call('GET', p), del: (p) => call('DELETE', p) };
};

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-sec-'));
  home = mkdtempSync(join(tmpdir(), 'ask-sechome-'));
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  writeFileSync(join(root, '.env'), 'TOKEN=hunter2\n');
  site = await startMockSite();
  file = historyFile(site.url, root, home);
  await saveHistory(file, [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], 'Old', ['hi']);
});

after(async () => {
  for (const a of apps) await a.shutdown(500);
  await site.close();
  resetSessions();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('criterion 38: the server listens on 127.0.0.1 only', async () => {
  const s = await open('all');
  const addr = s.app.server.address();
  assert.equal(addr.address, '127.0.0.1');
});

test('criterion 39: mode=plan blocks every write operation and leaves the folder as it was', async () => {
  const s = await open('plan');
  const refused = [
    ['/write', { path: 'new.txt', content: 'x' }],
    ['/edit', { path: 'a.txt', old_text: 'alpha', new_text: 'beta' }],
    ['/command', { command: 'echo hi' }],
    ['/remember', { note: 'x' }],
    ['/memory', { topic: 'p.md', content: 'x' }],
    ['/sessions/old-one/export', { filename: 'out.md' }],
    ['/watches', { spec: 'node check.mjs every 5m' }],
    ['/browser', { action: 'handoff' }],
  ];
  for (const [path, body] of refused) {
    const r = await s.post(path, body);
    assert.equal(r.status, 403, `${path} gave ${r.status}: ${r.text}`);
  }
  assert.equal((await s.del('/memory')).status, 403);
  assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(existsSync(join(root, 'out.md')), false);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha\n');
  // looking stays allowed
  assert.equal((await s.post('/read', { path: 'a.txt' })).status, 200);
  assert.equal((await s.get('/notes')).status, 200);
});

test('criterion 40: a command that touches a secret is refused in every mode', async () => {
  const s = await open('all');
  for (const command of ['cat .env', 'type .env', 'node -e "require(\'fs\').readFileSync(\'.env\')"']) {
    const r = await s.post('/command', { command });
    assert.equal(r.status, 403, `${command} gave ${r.status}`);
  }
  assert.equal((await s.post('/read', { path: '.env' })).status, 403);
  assert.equal((await s.post('/write', { path: '.env', content: 'x' })).status, 403);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN=hunter2\n');
});

test('criterion 37: ASK_KEY is in no answer of stage 2 and not in a child process', async () => {
  const s = await open('all');
  const answers = [
    await s.get('/health'),
    await s.get('/me'),
    await s.get('/status'),
    await s.get('/context'),
    await s.get('/models'),
    await s.get('/doctor'),
    await s.get('/sessions'),
    await s.get('/memory'),
    await s.get('/watches'),
    await s.get('/apps'),
    await s.post('/bug', { text: 'something broke' }),
    await s.post('/command', { command: 'node -e "console.log(Object.keys(process.env).join())"' }),
    await s.post('/read', { path: 'nope.txt' }),
  ];
  for (const r of answers) assert.ok(!r.text.includes(GOOD_KEY), `the key is in: ${r.text.slice(0, 120)}`);
  const env = answers.at(-2).json.output;
  assert.ok(!/ASK_KEY/.test(env), 'ASK_KEY is not in the environment of a command');
});

test('stage 1 still answers after stage 2 (regression)', async () => {
  const s = await open('all');
  assert.equal((await s.get('/health')).status, 200);
  assert.equal((await s.get('/status/none')).status, 404);
  assert.equal((await s.post('/stop/none')).status, 404);
  assert.equal((await s.post('/ask', {})).status, 400);
  assert.equal((await s.post('/execute', {})).status, 400);
  assert.equal((await s.call('GET', '/nowhere')).status, 404);
});
