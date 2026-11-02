// Integration tests of stage 2D (/watches, /apps). A fake browser stands in for Chrome.
// Run: node --test test/watches.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';

const KEY = 'sk-ask-test-key-watches';
let root, app, base;

/** Only what a watch asks of the browser: the text of a page. */
class FakeBrowser {
  constructor() {
    this.pages = [];
    this.closed = false;
  }
  async start() {}
  async here() {
    return { url: 'about:blank', title: '' };
  }
  async captchaSigns() {
    return { frames: [], marks: 0, mark: '', solved: false, inputs: 1, text: 'x', words: 20 };
  }
  async act() {
    return { ok: true, output: 'Opened.' };
  }
  async pageText(url) {
    this.pages.push(url);
    return { title: 'Slots', text: 'No free slots today', signs: await this.captchaSigns() };
  }
  async close() {
    this.closed = true;
  }
}

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const get = (path) => call('GET', path);
const post = (path, body = {}) => call('POST', path, body);
const del = (path) => call('DELETE', path);

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-w-'));
  // A command watch prints a number; an app prints its address and keeps running.
  writeFileSync(join(root, 'check.mjs'), "console.log('count 1');");
  writeFileSync(join(root, 'serve.mjs'), "console.log('Local: http://localhost:5999/'); setInterval(() => {}, 1000);");
  app = createApp({ key: KEY, site: 'http://127.0.0.1:1', root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error' });
  app.makeBrowser = () => new FakeBrowser();
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await del('/apps').catch(() => {});
  await app.shutdown(500);
  await new Promise((r) => setTimeout(r, 300));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('GET /watches: empty at first', async () => {
  const r = await get('/watches');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, watches: [] });
});

test('POST /watches: validation, and a page needs the browser (browser_off)', async () => {
  assert.equal((await post('/watches', {})).status, 400);
  assert.equal((await post('/watches', { spec: '   ' })).status, 400);
  assert.equal((await post('/watches', { spec: 'https://example.com', mode: 'dance' })).status, 400);
  const off = await post('/watches', { spec: 'https://example.com every 5m' });
  assert.equal(off.status, 400);
  assert.equal(off.json.code, 'browser_off');
  assert.deepEqual((await get('/watches')).json.watches, [], 'nothing was started');
});

test('a page watch: id, first look, list, and stop with DELETE', async () => {
  assert.equal((await post('/browser', { action: 'open', url: 'https://example.com/' })).status, 200);
  const made = await post('/watches', { spec: 'https://example.com/slots every 10m for "free slot"' });
  assert.equal(made.status, 200);
  assert.equal(made.json.ok, true);
  assert.equal(made.json.id, 1);
  assert.equal(made.json.everyMs, 600_000);
  assert.equal(made.json.wanted, 'free slot');
  assert.equal(made.json.checks, 1, 'the first look is done before the answer');

  const list = (await get('/watches')).json.watches;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: 1, target: 'https://example.com/slots', url: 'https://example.com/slots', everyMs: 600_000, checks: 1, alerts: 0, wanted: 'free slot', error: null });

  assert.equal((await del('/watches/1')).status, 200);
  assert.equal((await del('/watches/1')).status, 404);
  assert.deepEqual((await get('/watches')).json.watches, []);
});

test('the pace is at least 2 minutes, and DELETE /watches stops them all', async () => {
  const a = await post('/watches', { spec: 'https://example.com/a every 10s' });
  assert.equal(a.json.everyMs, 120_000);
  await post('/watches', { spec: 'https://example.com/b' });
  assert.equal((await get('/watches')).json.watches.length, 2);
  const all = await del('/watches');
  assert.equal(all.status, 200);
  assert.equal(all.json.output, 'All watches stopped.');
  assert.deepEqual((await get('/watches')).json.watches, []);
});

test('POST /watches: addresses and sites are checked like /browser', async () => {
  // parseWatch takes only http(s), localhost and domain-like text for an address; anything else is a command.
  const bare = await post('/watches', { spec: 'example.com/x' });
  assert.equal(bare.status, 200);
  assert.equal((await get('/watches')).json.watches[0].url, 'https://example.com/x');
  await del('/watches');
  const other = await post('/watches', { spec: 'https://example.com/x', mode: 'edits' });
  assert.equal(other.status, 403);
  assert.equal(other.json.code, 'site_not_allowed');
  const allowed = await post('/watches', { spec: 'https://example.com/x', mode: 'edits', allowedSites: ['example.com'] });
  assert.equal(allowed.status, 200);
  await del('/watches');
});

test('a command watch runs the command; plan mode refuses it', async () => {
  const plan = await post('/watches', { spec: 'node check.mjs every 5m', mode: 'plan' });
  assert.equal(plan.status, 403);
  assert.equal(plan.json.code, 'plan_mode');
  const made = await post('/watches', { spec: 'node check.mjs every 5m' });
  assert.equal(made.status, 200);
  assert.equal(made.json.checks, 1);
  assert.equal(made.json.error, null);
  const [w] = (await get('/watches')).json.watches;
  assert.equal(w.url, null);
  await del('/watches');
});

test('apps: GET /apps lists what /command started, DELETE stops it', async () => {
  assert.deepEqual((await get('/apps')).json, { ok: true, apps: [] });
  const started = await post('/command', { command: 'node serve.mjs &' });
  assert.equal(started.status, 200);
  assert.equal(started.json.app, 1);

  const list = (await get('/apps')).json.apps;
  assert.equal(list.length, 1);
  assert.equal(list[0].n, 1);
  assert.match(list[0].command, /serve\.mjs/);
  assert.match(list[0].url, /^http:\/\/localhost:5999\/?$/);
  assert.equal(list[0].running, true);

  assert.equal((await del('/apps/1')).status, 200);
  assert.equal((await del('/apps/1')).status, 404);
  assert.deepEqual((await get('/apps')).json.apps, []);
});

test('apps: numbers go on counting, and DELETE /apps stops everything', async () => {
  const one = await post('/command', { command: 'node serve.mjs &' });
  const two = await post('/command', { command: 'node serve.mjs &' });
  assert.equal(two.json.app, one.json.app + 1, 'never the same number twice');
  assert.equal((await get('/apps')).json.apps.length, 2);
  const all = await del('/apps');
  assert.equal(all.status, 200);
  assert.equal(all.json.output, 'Stopped everything.');
  assert.deepEqual((await get('/apps')).json.apps, []);
  assert.equal((await del('/apps/99')).status, 404);
});
