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
    this.history = [];
    this.logs = ['error: Uncaught TypeError: x is not a function', 'warning: deprecated'];
    this.url = 'about:blank';
    this.closed = false;
    FakeBrowser.made.push(this);
  }
  async start() {
    if (FakeBrowser.startError) throw new Error(FakeBrowser.startError);
  }
  /** What CAPTCHA_SIGNS of ask-code would see on the pages of these tests. */
  async captchaSigns() {
    const none = { frames: [], marks: 0, mark: '', solved: false, inputs: 3, text: 'Hello', words: 20 };
    if (this.solved) return none; // the person solved the captcha in the window
    if (this.url.startsWith('https://captcha.test/check')) return { ...none, frames: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/frame=challenge'], inputs: 0 };
    if (this.url.startsWith('https://captcha.test/form') || this.url.startsWith('http://localhost:3000/form')) return { ...none, marks: 1, mark: 'reCAPTCHA' };
    if (this.url.startsWith('https://captcha.test/solved')) return { ...none, marks: 1, mark: 'reCAPTCHA', solved: true };
    return none;
  }
  async front() {
    this.fronted = true;
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
      this.history.push(this.url);
      this.url = args.url;
      return this.view(`Opened ${args.url}.`);
    }
    if (args.action === 'click') {
      if (args.selector === 'text=Nothing here') throw new Error(`Nothing on the page matches ${args.selector}. Use read to see the page’s links and fields.`);
      const go = { 'text=Next': 'https://example.com/next', 'text=Elsewhere': 'https://other.test/' }[args.selector];
      if (go) {
        this.history.push(this.url);
        this.url = go;
      }
      return this.view(args.selector ? `Clicked a “${args.selector}”.` : `Clicked at ${args.x}, ${args.y}.`);
    }
    if (args.action === 'type') {
      if (args.selector === '#password') return { ok: false, output: 'private', private: true };
      return this.view(`Typed ${args.text.length} characters.`);
    }
    if (args.action === 'console') return { ok: true, output: this.logs.splice(0).join('\n') || 'Nothing in the console since the last look.' };
    if (args.action === 'press') return this.view(`Pressed ${args.key ?? 'Enter'}.`);
    if (args.action === 'scroll') return this.view(`Scrolled down ${args.dy ?? 600} px.`);
    if (args.action === 'back') {
      this.url = this.history.pop() ?? this.url;
      return this.view('Went back.');
    }
    if (args.action === 'viewport') return this.view(args.width ? `The page is ${args.width} px wide now.` : 'Back to the window’s own size.');
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

/** POST that may answer with an event stream: the events as they arrive, and a promise for the end. */
const stream = async (path, body, signal) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const events = [];
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) return { status: res.status, json: await res.json(), events, finished: Promise.resolve() };
  const finished = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const name = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (name) events.push({ event: name[1], data: JSON.parse(data[1]) });
        }
      }
    } catch {}
  })();
  return { status: res.status, events, finished };
};
const until = async (check, what, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const notices = [];

before(async () => {
  setLogLevel('error');
  root = mkdtempSync(join(tmpdir(), 'ask-br-'));
  writeFileSync(join(root, 'page.html'), '<h1>hi</h1>');
  writeFileSync(join(root, '.env'), 'TOKEN=super-secret');
  app = createApp({ key: KEY, site: 'http://127.0.0.1:1', root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error' });
  app.makeBrowser = (config, opts) => new FakeBrowser(opts);
  app.notify = (ctx, kind, title, body) => notices.push({ kind, title, body, key: ctx.key });
  app.config.handoffPollMs = 20;
  app.config.handoffMs = 5000;
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

test('POST /browser: click, type, press, scroll, back, viewport (criteria 24)', async () => {
  await post('/browser', { action: 'close' });
  await post('/browser', { action: 'open', url: 'https://example.com' });
  const click = await post('/browser', { action: 'click', selector: 'text=Next' });
  assert.equal(click.status, 200);
  assert.match(click.json.output, /Now at: https:\/\/example\.com\/next/);
  assert.ok(click.json.images.length);
  assert.deepEqual(last().calls.at(-1), { action: 'click', selector: 'text=Next' });

  const byXY = await post('/browser', { action: 'click', x: 100, y: 200 });
  assert.match(byXY.json.output, /Clicked at 100, 200/);
  assert.deepEqual(last().calls.at(-1), { action: 'click', x: 100, y: 200 });

  assert.match((await post('/browser', { action: 'type', text: 'hello', selector: '#q' })).json.output, /Typed 5 characters/);
  assert.deepEqual(last().calls.at(-1), { action: 'type', text: 'hello', selector: '#q' });
  assert.match((await post('/browser', { action: 'press', key: 'Enter' })).json.output, /Pressed Enter/);
  assert.match((await post('/browser', { action: 'scroll', dy: 600 })).json.output, /Scrolled down 600/);
  assert.match((await post('/browser', { action: 'viewport', width: 375 })).json.output, /375 px wide/);
  assert.deepEqual(last().calls.at(-1), { action: 'viewport', width: 375 });
  assert.match((await post('/browser', { action: 'viewport' })).json.output, /own size/);
  const back = await post('/browser', { action: 'back' });
  assert.match(back.json.output, /Now at: https:\/\/example\.com\/\nTitle/);
});

test('POST /browser: bad fields (400), an element that is not there (404)', async () => {
  assert.equal((await post('/browser', { action: 'click' })).status, 400);
  assert.equal((await post('/browser', { action: 'click', x: 1 })).status, 400);
  assert.equal((await post('/browser', { action: 'click', x: '1', y: '2' })).status, 400);
  assert.equal((await post('/browser', { action: 'type' })).status, 400);
  assert.equal((await post('/browser', { action: 'type', text: 5 })).status, 400);
  assert.equal((await post('/browser', { action: 'scroll', dy: 'far' })).status, 400);
  assert.equal((await post('/browser', { action: 'viewport', width: 0 })).status, 400);
  assert.equal((await post('/browser', { action: 'press', key: '' })).status, 400);
  const none = await post('/browser', { action: 'click', selector: 'text=Nothing here' });
  assert.equal(none.status, 404);
  assert.equal(none.json.code, 'not_found');
});

test('POST /browser: plan mode only looks; edits may click on an allowed site', async () => {
  await post('/browser', { action: 'close' });
  await post('/browser', { action: 'open', url: 'https://example.com' });
  for (const body of [{ action: 'click', selector: 'text=Next' }, { action: 'type', text: 'x' }, { action: 'press', key: 'Enter' }]) {
    const r = await post('/browser', { ...body, mode: 'plan' });
    assert.equal(r.status, 403, body.action);
    assert.equal(r.json.code, 'plan_mode');
  }
  for (const body of [{ action: 'read' }, { action: 'screenshot' }, { action: 'scroll' }, { action: 'back' }, { action: 'viewport', width: 800 }]) {
    assert.equal((await post('/browser', { ...body, mode: 'plan' })).status, 200, body.action);
  }
  assert.equal((await post('/browser', { action: 'close', mode: 'plan' })).status, 200);

  await post('/browser', { action: 'open', url: 'https://example.com', mode: 'edits', allowedSites: ['example.com'] });
  assert.equal((await post('/browser', { action: 'click', selector: 'text=Next', mode: 'edits', allowedSites: ['example.com'] })).status, 200);
});

test('POST /browser: a click that leaves the allowed sites goes back and is 403', async () => {
  await post('/browser', { action: 'close' });
  await post('/browser', { action: 'open', url: 'https://example.com', mode: 'edits', allowedSites: ['example.com'] });
  const r = await post('/browser', { action: 'click', selector: 'text=Elsewhere', mode: 'edits', allowedSites: ['example.com'] });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'site_not_allowed');
  assert.match(r.json.error, /other\.test/);
  assert.equal(last().url, 'https://example.com/', 'the window went back');
  // In mode all the same click is fine.
  assert.equal((await post('/browser', { action: 'click', selector: 'text=Elsewhere' })).status, 200);
});

test('POST /browser console: what the page logged, once', async () => {
  await post('/browser', { action: 'close' });
  await post('/browser', { action: 'open', url: 'https://example.com' });
  const first = await post('/browser', { action: 'console', mode: 'plan' });
  assert.equal(first.status, 200);
  assert.match(first.json.output, /Uncaught TypeError/);
  assert.match((await post('/browser', { action: 'console' })).json.output, /Nothing in the console/);
});

test('POST /browser: typing in a password field is refused with private:true (criterion 25)', async () => {
  await post('/browser', { action: 'close' });
  await post('/browser', { action: 'open', url: 'https://example.com' });
  const r = await post('/browser', { action: 'type', selector: '#password', text: 'hunter2' });
  assert.equal(r.status, 403);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.private, true);
  assert.equal(r.json.code, 'private');
  assert.ok(!r.text.includes('hunter2'));
  // an ordinary field is fine, and says private:false
  const ok = await post('/browser', { action: 'type', selector: '#q', text: 'hello' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.private, false);
});

test('POST /browser: a captcha on the page is reported; one in the way asks for a hand-off (criterion 26)', async () => {
  await post('/browser', { action: 'close' });
  const plain = await post('/browser', { action: 'open', url: 'https://example.com' });
  assert.equal(plain.json.captcha, null);
  assert.equal(plain.json.handoff_needed, false);

  const check = await post('/browser', { action: 'open', url: 'https://captcha.test/check' });
  assert.equal(check.status, 200);
  assert.equal(check.json.captcha.blocking, true);
  assert.equal(check.json.captcha.kind, 'Cloudflare');
  assert.equal(check.json.handoff_needed, true);
  assert.match(check.json.note, /handoff/);

  const form = await post('/browser', { action: 'open', url: 'https://captcha.test/form' });
  assert.deepEqual(form.json.captcha, { kind: 'reCAPTCHA', blocking: false });
  assert.equal(form.json.handoff_needed, false);

  const solved = await post('/browser', { action: 'open', url: 'https://captcha.test/solved' });
  assert.equal(solved.json.captcha, null, 'an answered captcha is none');

  const local = await post('/browser', { action: 'open', url: 'http://localhost:3000/form' });
  assert.equal(local.json.captcha.local, true);
  assert.equal(local.json.handoff_needed, false, 'on the own dev server: test keys, no hand-off');
  assert.match(local.json.note, /test keys/);
});

test('handoff in headless mode is 400 headless_handoff, in plan mode 403 (criterion 28)', async () => {
  await post('/browser', { action: 'close' });
  const r = await post('/browser', { action: 'handoff', text: 'Solve the captcha' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'headless_handoff');
  assert.equal(r.json.ok, false);
  assert.equal((await post('/browser', { action: 'handoff', mode: 'plan' })).status, 403);
  assert.equal(notices.length, 0, 'nobody is called for a hand-off that cannot work');
});

test('handoff: SSE status → delta → done once the captcha is solved (criterion 27)', async () => {
  app.config.browserHeadless = false;
  try {
    await post('/browser', { action: 'close' });
    const open = await post('/browser', { action: 'open', url: 'https://captcha.test/check' });
    assert.equal(open.json.handoff_needed, true);
    const b = last();
    assert.equal(b.headless, false);

    const h = await stream('/browser', { action: 'handoff', text: 'Solve the captcha' });
    assert.equal(h.status, 200);
    await until(() => h.events.length >= 1, 'the status event');
    assert.deepEqual(h.events[0], { event: 'status', data: { state: 'waiting', todo: 'Solve the captcha' } });
    assert.equal(notices.at(-1).body, 'Solve the captcha');
    assert.equal(notices.at(-1).key, KEY, 'the notice goes to the site with the key (not into the answer)');
    assert.equal(b.fronted, true, 'the window is brought to the front');

    // The window is the person's now.
    const busy = await post('/browser', { action: 'read' });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.code, 'handoff_active');
    assert.equal((await post('/browser', { action: 'handoff' })).status, 409);

    b.url = 'https://captcha.test/check?step=2';
    await until(() => h.events.some((e) => e.event === 'delta'), 'a delta');
    assert.match(h.events.find((e) => e.event === 'delta').data.text, /step=2/);

    b.solved = true;
    await h.finished;
    const done = h.events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.how, 'done');
    assert.match(done.data.answer, /The person finished: Solve the captcha/);
    assert.match(done.data.answer, /Now at: https:\/\/captcha\.test\/check\?step=2/);
    assert.ok(done.data.images.length, 'a screenshot after');
    assert.ok(!JSON.stringify(h.events).includes(KEY));

    assert.equal(app.browserState.handoff, null);
    assert.equal((await post('/browser', { action: 'read' })).status, 200, 'the window is Ask’s again');
  } finally {
    app.config.browserHeadless = true;
  }
});

test('handoff without a captcha: done when told (POST /browser/handoff/done); 409 when none waits', async () => {
  assert.equal((await post('/browser/handoff/done', {})).status, 409);
  app.config.browserHeadless = false;
  try {
    await post('/browser', { action: 'close' });
    await post('/browser', { action: 'open', url: 'https://example.com' });
    const h = await stream('/browser', { action: 'handoff', text: 'Type the code from your phone' });
    await until(() => h.events.length >= 1, 'the status event');
    assert.equal((await post('/browser/handoff/done', { note: 7 })).status, 400);
    assert.equal((await post('/browser/handoff/done', { note: 'code entered' })).status, 200);
    await h.finished;
    const done = h.events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.how, 'said');
    assert.match(done.data.answer, /The person says: code entered/);
  } finally {
    app.config.browserHeadless = true;
  }
});

test('handoff: error "timeout" after the time is up; "stopped" when the window is closed; a client that leaves frees the window', async () => {
  app.config.browserHeadless = false;
  try {
    await post('/browser', { action: 'close' });
    await post('/browser', { action: 'open', url: 'https://example.com' });

    app.config.handoffMs = 150;
    const late = await stream('/browser', { action: 'handoff' });
    await late.finished;
    assert.deepEqual(late.events.at(-1), { event: 'error', data: { message: 'timeout' } });
    assert.equal(app.browserState.handoff, null);
    app.config.handoffMs = 5000;

    const waiting = await stream('/browser', { action: 'handoff' });
    await until(() => waiting.events.length >= 1, 'the status event');
    assert.equal((await post('/browser', { action: 'close' })).status, 200);
    await waiting.finished;
    assert.deepEqual(waiting.events.at(-1), { event: 'error', data: { message: 'stopped' } });

    await post('/browser', { action: 'open', url: 'https://example.com' });
    const aborter = new AbortController();
    const gone = await stream('/browser', { action: 'handoff' }, aborter.signal);
    await until(() => gone.events.length >= 1, 'the status event');
    aborter.abort();
    await until(() => app.browserState.handoff === null, 'the hand-off to end');
    assert.equal((await post('/browser', { action: 'read' })).status, 200);
  } finally {
    app.config.browserHeadless = true;
    app.config.handoffMs = 5000;
  }
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
