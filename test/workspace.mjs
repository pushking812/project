// Run: node --test test/workspace.mjs  (also part of npm test)
// Stage 3A: GET/POST /workspace and the checks of lib/workspace.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { loadConfig } from '../lib/config.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { cleanPath, checkTarget, isInside, isSystemPath, parseAllowedRoots, defaultAllowedRoots } from '../lib/workspace.mjs';

const KEY = 'sk-ask-test-key-workspace';
const same = (x) => x;

// ---- the checks themselves, with paths of both systems ----

test('cleanPath: 400 invalid_path for a non-string, an empty string and control characters', () => {
  for (const bad of [undefined, null, 5, {}, '', '   ', 'a\u0000b', 'a\nb', 'a\u007fb']) {
    assert.throws(() => cleanPath(bad), (e) => e.status === 400 && e.code === 'invalid_path', JSON.stringify(bad));
  }
  assert.equal(cleanPath('  /ok/path '), '/ok/path');
});

test('isInside: the folder itself and what is inside, not a neighbour with the same start (Windows and Unix)', () => {
  assert.equal(isInside('/home/u/p', '/home/u', 'linux'), true);
  assert.equal(isInside('/home/u', '/home/u', 'linux'), true);
  assert.equal(isInside('/home/user2', '/home/u', 'linux'), false);
  assert.equal(isInside('/home/u/..x', '/home/u', 'linux'), true, 'a folder called ..x is inside');
  assert.equal(isInside('C:\\Users\\u\\p', 'c:\\users\\U', 'win32'), true, 'Windows ignores case');
  assert.equal(isInside('D:\\p', 'C:\\Users\\u', 'win32'), false, 'another drive');
  assert.equal(isInside('C:\\Users\\u2', 'C:\\Users\\u', 'win32'), false);
});

test('isSystemPath: system folders with everything inside, and the root of a drive', () => {
  for (const p of ['/', '/etc', '/etc/ssh', '/usr/local', '/var', '/bin', '/sbin', '/boot']) assert.equal(isSystemPath(p, 'linux', {}), true, p);
  for (const p of ['/home/u/p', '/tmp/x', '/srv/app', '/opt/x', '/var/www/site']) assert.equal(isSystemPath(p, 'linux', {}), false, p);
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' };
  for (const p of ['C:\\', 'D:\\', 'C:\\Windows', 'c:\\windows\\system32', 'C:\\Program Files\\x', 'C:\\Program Files (x86)', 'C:\\ProgramData']) assert.equal(isSystemPath(p, 'win32', env), true, p);
  for (const p of ['C:\\ProgramData\\y', 'C:\\Users\\u\\proj', 'D:\\work', 'C:\\Program Filesx']) assert.equal(isSystemPath(p, 'win32', env), false, p);
});

test('checkTarget: system_path → home_forbidden → not_allowed → not_found, in this order', () => {
  const o = { allowedRoots: ['/home/u/projects'], home: '/home/u', platform: 'linux', env: {}, real: same, isDir: () => false };
  const code = (p, extra = {}) => {
    try {
      checkTarget(p, { ...o, ...extra });
      return 'ok';
    } catch (e) {
      return `${e.status} ${e.code}`;
    }
  };
  assert.equal(code('/etc'), '403 system_path');
  assert.equal(code('/etc', { allowedRoots: ['/etc'] }), '403 system_path', 'even when it is in the list');
  assert.equal(code('/home/u'), '403 home_forbidden');
  assert.equal(code('/home/u', { allowedRoots: ['/home/u'] }), '403 home_forbidden', 'also when the list has it');
  assert.equal(code('/outside'), '403 not_allowed');
  assert.equal(code('/home/u/other'), '403 not_allowed');
  assert.equal(code('/home/u/projects/foo'), '404 not_found');
  assert.equal(code('/home/u/projects/foo', { isDir: () => true }), 'ok');
  assert.equal(code('/home/u/projects', { isDir: () => true }), 'ok', 'the allowed root itself');
  // The same on Windows paths.
  const w = { allowedRoots: ['C:\\Users\\u\\projects'], home: 'C:\\Users\\u', platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, real: same, isDir: () => true };
  assert.equal(code('C:\\Windows\\System32', w), '403 system_path');
  assert.equal(code('C:\\', w), '403 system_path');
  assert.equal(code('c:\\users\\u', w), '403 home_forbidden');
  assert.equal(code('D:\\x', w), '403 not_allowed');
  assert.equal(code('C:\\Users\\U\\Projects\\foo', w), 'ok');
});

test('parseAllowedRoots: lists, defaults and the values that stop the server', () => {
  const lin = { platform: 'linux', home: '/home/u', real: same, cwd: '/' };
  assert.equal(parseAllowedRoots(undefined, lin), undefined);
  assert.equal(parseAllowedRoots('  ', lin), undefined);
  assert.deepEqual(parseAllowedRoots('/home/u/a:/home/u/b::/home/u/a', lin), ['/home/u/a', '/home/u/b']);
  for (const bad of ['/', '/home/u', '/etc', 'relative/dir', '/home/u/a:/']) assert.throws(() => parseAllowedRoots(bad, lin), /ASK_ALLOWED_ROOTS/, bad);
  const win = { platform: 'win32', home: 'C:\\Users\\u', real: same, cwd: 'C:\\' };
  assert.deepEqual(parseAllowedRoots('C:\\Users\\u\\a;D:\\work', win), ['C:\\Users\\u\\a', 'D:\\work']);
  for (const bad of ['C:\\', 'c:\\users\\u', 'C:\\Windows', 'work']) assert.throws(() => parseAllowedRoots(bad, win), /ASK_ALLOWED_ROOTS/, bad);

  assert.deepEqual(defaultAllowedRoots({ home: '/home/u', root: '/home/u/p', platform: 'linux' }), ['/home/u']);
  assert.deepEqual(defaultAllowedRoots({ home: '/home/u', root: '/srv/p', platform: 'linux' }), ['/home/u', '/srv/p'], 'ASK_ROOT outside the home folder');
});

test('loadConfig: ASK_ALLOWED_ROOTS is read; a value with the home folder or a drive root is an error', () => {
  const env = { ASK_KEY: KEY };
  assert.equal(loadConfig(env, tmpdir()).allowedRoots, undefined);
  const dir = realpathSync(tmpdir());
  assert.deepEqual(loadConfig({ ...env, ASK_ALLOWED_ROOTS: dir }, dir).allowedRoots, [dir]);
  assert.throws(() => loadConfig({ ...env, ASK_ALLOWED_ROOTS: parse(dir).root }, dir), /ASK_ALLOWED_ROOTS/);
});

// ---- the endpoints ----

let tmp, home, a, b, outside, app, base;
const apps = { stopped: 0, stopAll() { this.stopped++; }, running: () => [] };

class FakeBrowser {
  static made = [];
  constructor(opts) {
    this.opts = opts;
    this.closed = false;
    FakeBrowser.made.push(this);
  }
  async start() {}
  async here() {
    return { url: 'about:blank', title: '' };
  }
  async act() {
    return { ok: true, output: 'ok' };
  }
  async captchaSigns() {
    return { frames: [], marks: 0, mark: '', solved: false, inputs: 1, text: 'Hello', words: 20 };
  }
  async close() {
    this.closed = true;
  }
}

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const setRoot = (path, extra = {}) => call('POST', '/workspace', { path, ...extra });

before(async () => {
  setLogLevel('error');
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ask-ws-')));
  [home, a, b, outside] = ['home', 'proj-a', 'proj-b', 'outside'].map((n) => join(tmp, n));
  for (const d of [home, a, b, outside, join(home, 'sub'), join(a, 'src')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(a, 'src', 'a.js'), '// in a');
  writeFileSync(join(b, 'hello.txt'), 'hello from b');
  app = createApp({ key: KEY, site: 'http://127.0.0.1:1', root: a, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error', allowedRoots: [a, b, home], userHome: home });
  app.makeBrowser = (config, opts) => new FakeBrowser(opts);
  app.apps = apps;
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(500);
  rmSync(tmp, { recursive: true, force: true });
});

test('GET /workspace: root, allowedRoots and the current session (null before any)', async () => {
  const r = await call('GET', '/workspace');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, root: a, allowedRoots: [a, b, home], sessionId: null });
});

test('POST /workspace: 400 invalid_path for a missing, empty or odd path', async () => {
  for (const body of [{}, { path: '' }, { path: 7 }, { path: 'x\u0000y' }]) {
    const r = await call('POST', '/workspace', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'invalid_path');
  }
  assert.equal((await call('POST', '/workspace', { path: b, mode: 'wild' })).status, 400);
  assert.equal((await call('POST', '/workspace')).status, 400);
});

test('POST /workspace: system_path, home_forbidden, not_allowed, not_found (criteria of stage 3)', async () => {
  const system = process.platform === 'win32' ? process.env.SystemRoot || 'C:\\Windows' : '/etc';
  const r1 = await setRoot(system);
  assert.equal(r1.status, 403);
  assert.equal(r1.json.code, 'system_path');
  assert.equal((await setRoot(parse(tmp).root)).json.code, 'system_path', 'the root of a drive');

  const r2 = await setRoot(home);
  assert.equal(r2.status, 403);
  assert.equal(r2.json.code, 'home_forbidden');

  const r3 = await setRoot(outside);
  assert.equal(r3.status, 403);
  assert.equal(r3.json.code, 'not_allowed');
  assert.equal((await setRoot(tmp)).json.code, 'not_allowed', 'the parent of an allowed root');

  const r4 = await setRoot(join(b, 'no-such-folder'));
  assert.equal(r4.status, 404);
  assert.equal(r4.json.code, 'not_found');
  const r5 = await setRoot(join(b, 'hello.txt'));
  assert.equal(r5.status, 404, 'a file is not a folder');

  assert.equal((await call('GET', '/workspace')).json.root, a, 'nothing changed');
});

test('POST /workspace: plan mode is 403 plan_mode, before any other check but the path', async () => {
  const r = await setRoot(b, { mode: 'plan' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'plan_mode');
  const system = await setRoot(outside, { mode: 'plan' });
  assert.equal(system.json.code, 'plan_mode');
  assert.equal((await setRoot('', { mode: 'plan' })).json.code, 'invalid_path');
  assert.equal(app.config.root, a);
});

test('POST /workspace: the same folder is 200 already_current and stops nothing', async () => {
  const stopped = apps.stopped;
  const r = await setRoot(a);
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, false);
  assert.equal(r.json.already_current, true);
  assert.equal(r.json.root, a);
  assert.equal(apps.stopped, stopped);
});

test('POST /workspace: a task running → 409 tasks_running; after it ends the change works', async () => {
  const rec = app.registry.create({ prompt: 'x', mode: 'all' });
  const r = await setRoot(b);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'tasks_running');
  assert.equal(app.config.root, a);
  rec.status = 'done';
  assert.equal((await setRoot(b)).status, 200);
  assert.equal((await setRoot(a)).status, 200, 'and back');
});

test('POST /workspace: the change moves root, /health, files and context; the browser, apps and watches are let go (criterion 5)', async () => {
  // Something that belongs to the old folder: a browser window, a watch, an app.
  await call('POST', '/browser', { action: 'open', url: 'https://example.com' });
  const oldWindow = FakeBrowser.made.at(-1);
  assert.equal(oldWindow.closed, false);
  const watch = await call('POST', '/watches', { spec: 'node -v every 1h' });
  assert.equal(watch.status, 200, JSON.stringify(watch.json));
  assert.equal((await call('GET', '/watches')).json.watches.length, 1);
  const stopped = apps.stopped;

  const r = await setRoot(b);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.root, b);
  assert.equal(r.json.changed, true);

  assert.equal(oldWindow.closed, true, 'the window of the old folder is closed');
  assert.equal((await call('GET', '/browser')).json.running, false);
  assert.equal(apps.stopped, stopped + 1, 'apps are stopped');
  assert.equal((await call('GET', '/watches')).json.watches.length, 0, 'watches are gone');

  assert.equal((await call('GET', '/health')).json.root, b);
  assert.equal((await call('GET', '/workspace')).json.root, b);

  // Relative paths now count from the new folder.
  const read = await call('POST', '/read', { path: 'hello.txt' });
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.match(JSON.stringify(read.json), /hello from b/);

  // The next browser step starts a window for the new folder.
  const before = FakeBrowser.made.length;
  await call('POST', '/browser', { action: 'open', url: 'https://example.com' });
  assert.equal(FakeBrowser.made.length, before + 1);
  assert.equal((await setRoot(a)).json.root, a);
});

test('POST /workspace: relative path is counted from the current root; each change is logged', async () => {
  const r = await setRoot('src'); // a/src is inside the allowed root a
  assert.equal(r.status, 200);
  assert.equal(r.json.root, join(a, 'src'));
  assert.equal((await setRoot('..')).json.root, a);
});

test('POST /workspace: sessions are the folder’s own (GET /workspace follows the root)', async () => {
  await call('POST', '/sessions', { title: 'in a' });
  const inA = (await call('GET', '/workspace')).json.sessionId;
  assert.ok(inA);
  await setRoot(b);
  assert.equal((await call('GET', '/workspace')).json.sessionId, null, 'the other folder has none yet');
  await setRoot(a);
  assert.equal((await call('GET', '/workspace')).json.sessionId, inA);
});

test('POST /workspace: a /ask in flight → 409 tasks_running; the counter drops when it ends', async () => {
  // A site that does not answer until it is told to: the /ask stays in flight.
  const held = [];
  const site = createServer((req, res) => held.push(res));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const own = createApp({ key: KEY, site: `http://127.0.0.1:${site.address().port}`, root: a, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error', allowedRoots: [a, b, home], userHome: home });
  const url = `http://127.0.0.1:${await own.listen()}`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ac = new AbortController();
  try {
    assert.equal(own.activeRequests(), 0);
    const pending = fetch(url + '/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', useContext: false }), signal: ac.signal }).catch(() => null);
    for (let i = 0; i < 100 && held.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(held.length, 1, 'the request reached the site');
    assert.equal(own.activeRequests(), 1);
    const r = await post('/workspace', { path: b });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'tasks_running');
    assert.equal(own.config.root, a, 'the root did not change');
    // The client leaves: the request ends, the counter goes back to 0, the change works.
    ac.abort();
    await pending;
    for (let i = 0; i < 100 && own.activeRequests() > 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(own.activeRequests(), 0);
    assert.equal((await post('/workspace', { path: b })).status, 200);
    // A plain GET or an ended request never leaves the counter above 0.
    await fetch(url + '/health');
    assert.equal(own.activeRequests(), 0);
  } finally {
    for (const res of held) res.destroy();
    await own.shutdown(300);
    await new Promise((r) => site.close(r));
  }
});

test('POST /workspace: a hook that fails does not stop the change', async () => {
  const hook = () => {
    throw new Error('boom');
  };
  app.onWorkspaceChange.push(hook);
  try {
    assert.equal((await setRoot(b)).status, 200);
    assert.equal(app.config.root, b);
  } finally {
    app.onWorkspaceChange.splice(app.onWorkspaceChange.indexOf(hook), 1);
    await setRoot(a);
  }
});
