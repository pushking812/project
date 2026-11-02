// Integration tests of stage 2G (POST /browser) with a fake browser: no Chrome needed.
// Run: npm test  (or: node --test test/browser.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';

const KEY = 'sk-ask-test-key-browser';
let root, app, base;

/** A browser that keeps a few pages in memory and records what it was asked. */
class FakeBrowser {
  static made = [];
  constructor(opts) {
    this.opts = opts;
    this.headless = opts.headless;
    this.calls = [];
    this.url = 'about:blank';
    this.closed = false;
    FakeBrowser.made.push(this);
  }
  async start() {
    if (FakeBrowser.startError) throw new Error(FakeBrowser.startError);
  }
  async here() {
    return { url: this.url, title: 'Fake page' };
  }
  view(said) {
    return { ok: true, output: `${said ? `${said}\n` : ''}Now at: ${this.url}\nTitle: Fake page`, images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] };
  }
  async act(args) {
    await this.start();
    this.calls.push(args);
    if (args.action === 'open') {
      this.url = args.url;
      return this.view(`Opened ${args.url}.`);
    }
    if (args.action === 'screenshot') return this.view('');
    if (args.action === 'read') return { ok: true, output: `Now at: ${this.url}\nTitle: Fake page\n\nHello page text\n\nLinks:\n(none)\n\nFields and buttons:\n(none)` };
    return { ok: false, output: `fake: no action ${args.action}` };
  }
  async close() {
    this.closed = true;
  }
}

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null, text };
};
const post = (path, body = {}) => call('POST', path, body);
const last = () => FakeBrowser.made.at(-1);

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-br-'));
  writeFileSync(join(root, 'page.html'), '<h1>hi</h1>');
  writeFileSync(join(root, '.env'), 'TOKEN=super-secret');
  app = createApp({ key: KEY, site: 'http://127.0.0.1:1', root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error' });
  app.makeBrowser = (config, opts) => new FakeBrowser(opts);
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(500);
  rmSync(root, { recursive: true, force: true });
});

test('POST /browser: lazy start, open → output and picture, read → text, close, and a new start', async () => {
  assert.equal(FakeBrowser.made.length, 0, 'nothing starts before the first step');
  const open = await post('/browser', { action: 'open', url: 'https://example.com' });
  assert.equal(open.status, 200);
  assert.equal(open.json.ok, true);
  assert.match(open.json.output, /Now at: https:\/\/example\.com\//);
  assert.equal(open.json.images[0].mediaType, 'image/jpeg');
  assert.equal(FakeBrowser.made.length, 1);
  assert.equal(last().headless, true, 'headless unless ASK_BROWSER_HEADLESS=0');

  const shot = await post('/browser', { action: 'screenshot' });
  assert.equal(shot.status, 200);
  assert.ok(shot.json.images.length);

  const read = await post('/browser', { action: 'read' });
  assert.match(read.json.output, /Hello page text/);
  assert.equal(FakeBrowser.made.length, 1, 'the same window for every step');

  const close = await post('/browser', { action: 'close' });
  assert.equal(close.status, 200);
  assert.equal(FakeBrowser.made[0].closed, true);
  assert.match((await post('/browser', { action: 'close' })).json.output, /not running/);

  await post('/browser', { action: 'open', url: 'example.org' });
  assert.equal(FakeBrowser.made.length, 2, 'open after close starts a new window');
});

test('POST /browser: validation (400) and refused addresses (403)', async () => {
  assert.equal((await post('/browser', {})).status, 400);
  const bad = await post('/browser', { action: 'dance' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'bad_action');
  assert.equal((await post('/browser', { action: 'open' })).status, 400);
  assert.equal((await post('/browser', { action: 'open', url: 'https://example.com', mode: 'wild' })).status, 400);

  const js = await post('/browser', { action: 'open', url: 'javascript:alert(1)' });
  assert.equal(js.status, 403);
  assert.equal(js.json.code, 'refused_url');
  const outside = await post('/browser', { action: 'open', url: 'file:///etc/passwd' });
  assert.equal(outside.status, 403);
  const secret = await post('/browser', { action: 'open', url: new URL(`file:///${join(root, '.env').replace(/\\/g, '/')}`).href });
  assert.equal(secret.status, 403);
  assert.ok(!secret.text.includes('super-secret'));
});

test('POST /browser: external sites need allowedSites unless mode is all (criterion 29)', async () => {
  const edits = await post('/browser', { action: 'open', url: 'https://example.com', mode: 'edits' });
  assert.equal(edits.status, 403);
  assert.equal(edits.json.code, 'site_not_allowed');
  assert.equal((await post('/browser', { action: 'open', url: 'https://example.com', mode: 'plan' })).status, 403);

  assert.equal((await post('/browser', { action: 'open', url: 'https://example.com', mode: 'edits', allowedSites: ['example.com'] })).status, 200);
  assert.equal((await post('/browser', { action: 'open', url: 'https://www.example.com/x', mode: 'edits', allowedSites: ['Example.com'] })).status, 200, 'a subdomain of an allowed host');
  assert.equal((await post('/browser', { action: 'open', url: 'https://notexample.com', mode: 'edits', allowedSites: ['example.com'] })).status, 403);
  assert.equal((await post('/browser', { action: 'open', url: 'http://localhost:3000', mode: 'edits' })).status, 200, 'this computer needs no allow');
  assert.equal((await post('/browser', { action: 'open', url: 'https://example.com', mode: 'plan', allowedSites: ['example.com'] })).status, 200, 'plan may look');
  assert.equal((await post('/browser', { action: 'open', url: 'https://example.com', allowedSites: 'example.com' })).status, 400);
});

test('POST /browser: a browser that cannot start → 502', async () => {
  await post('/browser', { action: 'close' });
  FakeBrowser.startError = 'There’s no Chrome, Edge, Chromium or Brave on this computer.';
  try {
    const r = await post('/browser', { action: 'open', url: 'https://example.com' });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'no_browser');
    assert.equal(r.json.ok, false);
  } finally {
    FakeBrowser.startError = undefined;
  }
});

test('POST /browser: the window is closed when the server stops', async () => {
  const open = await post('/browser', { action: 'open', url: 'https://example.com' });
  assert.equal(open.status, 200);
  const b = last();
  await Promise.all(app.onShutdown.map((hook) => hook()));
  assert.equal(b.closed, true);
});
