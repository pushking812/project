// The "browser" field of POST /execute and /start (stage 2G): the task gets its own window. Fake site, fake browser.
// Run: node --test test/execute-browser.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { startMockSite, GOOD_KEY } from './mock-site.mjs';

class FakeBrowser {
  static made = [];
  constructor(opts) {
    this.headless = opts.headless;
    this.calls = [];
    this.closed = false;
    this.url = 'about:blank';
    FakeBrowser.made.push(this);
  }
  async start() {}
  async captchaSigns() {
    return { frames: [], marks: 0, mark: '', solved: false, inputs: 3, text: 'Hello', words: 20 };
  }
  async front() {}
  async here() {
    return { url: this.url, title: 'Fake page' };
  }
  async act(args) {
    this.calls.push(args);
    if (args.action === 'open') this.url = args.url;
    return { ok: true, output: `Now at: ${this.url}\nTitle: Fake page` };
  }
  async close() {
    this.closed = true;
  }
}

let site, app, base, root;

before(async () => {
  setLogLevel('error');
  site = await startMockSite();
  root = mkdtempSync(join(tmpdir(), 'ask-exb-'));
  app = createApp({ key: GOOD_KEY, site: site.url, root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 3, logLevel: 'error' });
  app.makeBrowser = (config, opts) => new FakeBrowser(opts);
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(500);
  await site.close();
  rmSync(root, { recursive: true, force: true });
});

const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};

/** Runs a task whose model calls `browser` once with `input`; returns what the tool answered and the body sent to /v1/code. */
async function runBrowserTask(body, input) {
  let answer;
  site.setScenario(async ({ callTool }) => {
    answer = await callTool('browser', input);
  });
  FakeBrowser.made.length = 0;
  const before = site.requests.length;
  const res = await post('/execute', { prompt: 'look at a page', ...body });
  const sent = site.requests.slice(before).find((r) => r.path === '/v1/code')?.body;
  return { res, answer, sent, made: [...FakeBrowser.made] };
}

test('browser:true: the site is told, the tool opens a page, the window is closed with the task', async () => {
  const r = await runBrowserTask({ browser: true }, { action: 'open', url: 'https://example.com' });
  assert.equal(r.res.status, 200);
  assert.equal(r.sent.browser, true);
  assert.equal(r.answer.ok, true);
  assert.match(r.answer.output, /Now at: https:\/\/example\.com/);
  assert.equal(r.made.length, 1);
  assert.equal(r.made[0].headless, true, 'headless by default');
  assert.equal(r.made[0].closed, true);
  assert.match(r.res.text, /event: done/);
});

test('no browser field: the site is not told and the tool answers that the browser is off', async () => {
  const r = await runBrowserTask({}, { action: 'open', url: 'https://example.com' });
  assert.equal(r.sent.browser, undefined);
  assert.equal(r.answer.ok, false);
  assert.match(r.answer.output, /browser is off/i);
  assert.equal(r.made.length, 0);
});

test('mode edits: a site outside allowedSites is refused, one inside it opens', async () => {
  const refused = await runBrowserTask({ browser: true, mode: 'edits' }, { action: 'open', url: 'https://example.com' });
  assert.equal(refused.answer.ok, false);
  assert.match(refused.answer.output, /didn’t allow/);
  assert.equal(refused.made[0].calls.length, 0);

  const allowed = await runBrowserTask({ browser: true, mode: 'edits', allowedSites: ['Example.com'] }, { action: 'open', url: 'https://example.com' });
  assert.equal(allowed.answer.ok, true);
  assert.equal(allowed.made[0].calls[0].action, 'open');
});

test('plan mode: the tool may look but not click', async () => {
  const r = await runBrowserTask({ browser: true, mode: 'plan' }, { action: 'click', selector: 'text=Buy' });
  assert.equal(r.answer.ok, false);
  assert.match(r.answer.output, /Plan mode/);
  assert.equal(r.made[0].calls.length, 0);
});

test('handoff in a headless window: refused at once, the person cannot see it', async () => {
  const r = await runBrowserTask({ browser: true }, { action: 'handoff', text: 'solve the captcha' });
  assert.equal(r.answer.ok, false);
  assert.match(r.answer.output, /headless/);
  assert.equal(r.made[0].calls.length, 0);
});

test('/start takes the same fields; wrong types are 400', async () => {
  site.setScenario(async ({ callTool }) => {
    await callTool('browser', { action: 'open', url: 'https://example.com' });
  });
  const started = await post('/start', { prompt: 'x', browser: true });
  assert.equal(started.status, 200);
  assert.ok(JSON.parse(started.text).taskId);

  const bad1 = await post('/execute', { prompt: 'x', browser: 'yes' });
  assert.equal(bad1.status, 400);
  const bad2 = await post('/execute', { prompt: 'x', browser: true, allowedSites: 'example.com' });
  assert.equal(bad2.status, 400);
});
