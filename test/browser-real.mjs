// Smoke test of POST /browser with a real Chrome/Edge (headless, own temporary profile). Skipped when there is none.
// Run: npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { findBrowser } from '../build/ask-code-core.mjs';

const skip = !findBrowser() || typeof WebSocket !== 'function' ? 'no Chrome/Edge (or Node < 22) here' : false;

const PAGES = {
  '/': '<title>Home</title><h1>Welcome</h1><a href="/second">Go second</a><input id="name" name="name" placeholder="Your name"><input id="pw" type="password" name="pw"><script>console.error("boom from page")</script>',
  '/second': '<title>Second</title><h1>Second page</h1>',
  '/captcha': '<title>Form</title><form><input name="a"><div class="g-recaptcha" data-sitekey="x" style="width:300px;height:80px"></div></form>',
};

let site, root, profile, app, base, siteUrl;

const post = async (body) => {
  const res = await fetch(`${base}/browser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  if (skip) return;
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-real-'));
  profile = mkdtempSync(join(tmpdir(), 'ask-real-profile-'));
  site = createServer((req, res) => {
    const page = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' }).end(page ?? 'not found');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  app = createApp({ key: 'sk-ask-test-key-real', site: 'http://127.0.0.1:1', root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 1, logLevel: 'error', browserHeadless: true, browserDir: profile });
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  if (skip) return;
  await app.shutdown(500);
  site.close();
  for (const dir of [root, profile]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {}
  }
});

test('real browser: open, read, click, type, private field, scroll, viewport, console, back, close', { skip, timeout: 120_000 }, async () => {
  const open = await post({ action: 'open', url: siteUrl });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  assert.match(open.json.output, /Title: Home/);
  assert.equal(open.json.images[0].mediaType, 'image/jpeg');
  assert.ok(open.json.images[0].data.length > 100);
  assert.equal(open.json.captcha, null);

  const read = await post({ action: 'read' });
  assert.match(read.json.output, /Welcome/);
  assert.match(read.json.output, /Go second → .*\/second/);
  assert.match(read.json.output, /input password/);

  const typed = await post({ action: 'type', selector: '#name', text: 'Ann' });
  assert.equal(typed.status, 200, JSON.stringify(typed.json));
  assert.match(typed.json.output, /Typed 3 characters/);

  const secret = await post({ action: 'type', selector: '#pw', text: 'hunter2' });
  assert.equal(secret.status, 403);
  assert.equal(secret.json.private, true);

  assert.equal((await post({ action: 'scroll', dy: 100 })).status, 200);
  const phone = await post({ action: 'viewport', width: 375 });
  assert.equal(phone.status, 200);
  assert.match(phone.json.output, /375 px wide/);
  assert.equal((await post({ action: 'viewport' })).status, 200);

  const click = await post({ action: 'click', selector: 'text=Go second' });
  assert.equal(click.status, 200, JSON.stringify(click.json));
  assert.match(click.json.output, /Title: Second/);

  const back = await post({ action: 'back' });
  assert.match(back.json.output, /Title: Home/);

  const missing = await post({ action: 'click', selector: 'text=No such words' });
  assert.equal(missing.status, 404);

  const logs = await post({ action: 'console' });
  assert.match(logs.json.output, /boom from page/);

  const form = await post({ action: 'open', url: `${siteUrl}/captcha` });
  assert.equal(form.json.captcha?.kind, 'reCAPTCHA');
  assert.equal(form.json.captcha.local, true, 'on localhost: a note about test keys');
  assert.equal(form.json.handoff_needed, false);

  // headless: a hand-off cannot work
  const hand = await post({ action: 'handoff', text: 'Solve it' });
  assert.equal(hand.status, 400);
  assert.equal(hand.json.code, 'headless_handoff');

  assert.equal((await post({ action: 'close' })).status, 200);
});
