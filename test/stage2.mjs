// Integration tests of stage 2 (direct endpoints). They need no ask site: nothing here talks to a model.
// Run: npm test  (or: node --test test/stage2.mjs)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';

const KEY = 'sk-ask-test-key-stage2';
let root, app, base;

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
  root = mkdtempSync(join(tmpdir(), 'ask-s2-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'let x = 1\n// TODO: fix\nconsole.log(x)\n');
  writeFileSync(join(root, '.env'), 'TOKEN=super-secret');
  app = createApp({ key: KEY, site: 'http://127.0.0.1:1', root, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error' });
  base = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(500);
  try {
    // On Windows a command that outlived its timeout may still hold the folder.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {}
});

// ─── 2A: files and commands ─────────────────────────────────────────────────────────────────────

test('POST /read: a file; offset and limit; errors 400 / 403 secret / 403 outside / 404', async () => {
  const r = await post('/read', { path: 'src/app.js' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.output, /let x = 1/);

  const part = await post('/read', { path: 'src/app.js', offset: 2, limit: 1 });
  assert.match(part.json.output, /TODO/);
  assert.ok(!part.json.output.includes('let x'));

  assert.equal((await post('/read', {})).status, 400);
  const env = await post('/read', { path: '.env' });
  assert.equal(env.status, 403);
  assert.equal(env.json.code, 'secret');
  assert.equal(env.json.ok, false);
  assert.ok(!env.text.includes('super-secret'));
  const out = await post('/read', { path: '../../../etc/passwd' });
  assert.equal(out.status, 403);
  assert.equal(out.json.code, 'outside');
  const missing = await post('/read', { path: 'src/none.js' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'not_found');
});

test('POST /list and /search', async () => {
  const list = await post('/list', { path: 'src', depth: 1 });
  assert.equal(list.status, 200);
  assert.match(list.json.output, /src\/app\.js/);
  const root_ = await post('/list', {});
  assert.match(root_.json.output, /private: not shared/);

  const found = await post('/search', { pattern: 'TODO' });
  assert.equal(found.status, 200);
  assert.match(found.json.output, /src\/app\.js:2: \/\/ TODO: fix/);
  const rx = await post('/search', { pattern: 'let \\w+ = \\d', regex: true, path: 'src' });
  assert.match(rx.json.output, /app\.js:1/);
  assert.match((await post('/search', { pattern: 'NOPE_NOT_THERE' })).json.output, /No matches/);
  assert.equal((await post('/search', {})).status, 400);
  assert.equal((await post('/search', { pattern: 'x', regex: 'yes' })).status, 400);
});

test('POST /write: creates a file with a diff; overwrite:false gives 409; plan gives 403; secrets and outside are refused', async () => {
  const w = await post('/write', { path: 'new/hello.js', content: 'console.log(1)' });
  assert.equal(w.status, 200);
  assert.equal(w.json.ok, true);
  assert.match(w.json.output, /Wrote new\/hello\.js/);
  assert.deepEqual(w.json.diff, [{ kind: '+', text: 'console.log(1)' }]);
  assert.equal(readFileSync(join(root, 'new', 'hello.js'), 'utf8'), 'console.log(1)');

  const again = await post('/write', { path: 'new/hello.js', content: 'two', overwrite: false });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'exists');
  assert.equal(readFileSync(join(root, 'new', 'hello.js'), 'utf8'), 'console.log(1)');
  assert.equal((await post('/write', { path: 'new/hello.js', content: 'two' })).status, 200);

  const plan = await post('/write', { path: 'plan.txt', content: 'x', mode: 'plan' });
  assert.equal(plan.status, 403);
  assert.equal(plan.json.code, 'plan_mode');
  assert.ok(!existsSync(join(root, 'plan.txt')));

  assert.equal((await post('/write', { path: '.env', content: 'x' })).json.code, 'secret');
  assert.equal((await post('/write', { path: '../escape.txt', content: 'x' })).json.code, 'outside');
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN=super-secret');
  assert.equal((await post('/write', { path: 'a.txt' })).status, 400);
  assert.equal((await post('/write', { path: 'a.txt', content: 'x', mode: 'nope' })).status, 400);
});

test('POST /write: a long diff is cut to 120 lines', async () => {
  const content = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const w = await post('/write', { path: 'long.txt', content });
  assert.equal(w.json.diff.length, 120);
  assert.equal(w.json.diffTruncated, 300);
});

test('POST /edit: replaces; a wrong old_text is 409 old_text_not_found; ambiguous is 409; missing file 404; plan 403', async () => {
  const e = await post('/edit', { path: 'src/app.js', old_text: 'let x = 1', new_text: 'let x = 2' });
  assert.equal(e.status, 200);
  assert.match(e.json.output, /Edited src\/app\.js/);
  assert.ok(e.json.diff.some((l) => l.kind === '+' && l.text === 'let x = 2'));
  assert.ok(e.json.diff.some((l) => l.kind === '-' && l.text === 'let x = 1'));
  assert.match(readFileSync(join(root, 'src', 'app.js'), 'utf8'), /let x = 2/);

  const bad = await post('/edit', { path: 'src/app.js', old_text: 'let x = 99', new_text: 'y' });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, 'old_text_not_found');

  writeFileSync(join(root, 'twice.txt'), 'a\na\n');
  const twice = await post('/edit', { path: 'twice.txt', old_text: 'a', new_text: 'b' });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.code, 'old_text_ambiguous');

  assert.equal((await post('/edit', { path: 'nope.txt', old_text: 'a', new_text: 'b' })).status, 404);
  assert.equal((await post('/edit', { path: 'src/app.js', new_text: 'b' })).status, 400);
  assert.equal((await post('/edit', { path: 'src/app.js', old_text: 'a' })).status, 400);
  assert.equal((await post('/edit', { path: 'src/app.js', old_text: 'console', new_text: 'x', mode: 'plan' })).status, 403);
});

test('POST /command: runs, exit codes, secret and control characters and plan are refused, timeout is 408', async () => {
  const ok = await post('/command', { command: 'node -e "console.log(6*7)"' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.code, 0);
  assert.match(ok.json.output, /42/);

  const fail = await post('/command', { command: 'node -e "process.exit(3)"' });
  assert.equal(fail.status, 200);
  assert.equal(fail.json.ok, false);
  assert.equal(fail.json.code, 3);

  const secret = await post('/command', { command: 'cat .env' });
  assert.equal(secret.status, 403);
  assert.equal(secret.json.code, 'secret_command');
  assert.ok(!secret.text.includes('super-secret'));

  const control = await post('/command', { command: 'echo \u001b[31mred' });
  assert.equal(control.status, 400);
  assert.equal(control.json.code, 'control_chars');

  const plan = await post('/command', { command: 'echo hi', mode: 'plan' });
  assert.equal(plan.status, 403);
  assert.equal(plan.json.code, 'plan_mode');

  assert.equal((await post('/command', {})).status, 400);
  assert.equal((await post('/command', { command: 'echo', timeout_sec: -1 })).status, 400);

  const slow = await post('/command', { command: 'node -e "setTimeout(()=>{}, 6000)"', timeout_sec: 1 });
  assert.equal(slow.status, 408);
  assert.equal(slow.json.code, 'timeout');
});

test('POST /command does not pass ASK_KEY to the command', async () => {
  process.env.ASK_KEY = KEY;
  try {
    const r = await post('/command', { command: `node -e "console.log('unset=' + (process.env.ASK_KEY === undefined))"` });
    assert.match(r.json.output, /unset=true/);
    assert.ok(!r.text.includes(KEY));
  } finally {
    delete process.env.ASK_KEY;
  }
});

// ─── 2B: notes and memory ───────────────────────────────────────────────────────────────────────

test('POST /remember adds to ASK.md, GET /notes shows it; plan, empty note and a folder outside are refused', async () => {
  const r = await post('/remember', { note: 'tests run with npm test' });
  assert.equal(r.status, 200);
  assert.equal(r.json.output, 'Saved in ASK.md.');
  assert.match(readFileSync(join(root, 'ASK.md'), 'utf8'), /- tests run with npm test/);

  const n = await get('/notes');
  assert.equal(n.status, 200);
  assert.match(n.json.text, /tests run with npm test/);
  assert.ok(n.json.sources.some((s) => s.where === 'ASK.md' && s.chars > 0));
  assert.equal(typeof n.json.clipped, 'boolean');

  assert.equal((await post('/remember', {})).status, 400);
  assert.equal((await post('/remember', { note: 'x', mode: 'plan' })).status, 403);
  assert.equal((await post('/remember', { note: 'x', folder: '..' })).status, 403);
  assert.equal((await get('/notes?folder=..')).status, 400);
  assert.equal((await get('/notes?folder=src')).status, 200);
  assert.equal((await get('/notes?folder=nope')).status, 404);
});

test('memory: write, list, read, edit; bad topics and plan are refused; DELETE clears', async () => {
  try {
    const empty = await get('/memory');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.topics, []);

    const w = await post('/memory', { topic: 'project.md', content: '## Project\nNode 22\n' });
    assert.equal(w.status, 200);
    assert.match(w.json.output, /Saved \.ask-memory\/project\.md/);
    await post('/memory', { topic: 'MEMORY.md', content: '- [project](project.md)\n' });

    const list = await get('/memory');
    assert.deepEqual(list.json.topics, ['project.md']);
    assert.match(list.json.index, /project\.md/);
    assert.equal(typeof list.json.dir, 'string');

    const t = await get('/memory/project.md');
    assert.equal(t.status, 200);
    assert.match(t.json.text, /Node 22/);

    const e = await post('/memory', { topic: 'project.md', old_text: 'Node 22', new_text: 'Node 24' });
    assert.equal(e.status, 200);
    assert.match((await get('/memory/project.md')).json.text, /Node 24/);
    assert.equal((await post('/memory', { topic: 'project.md', old_text: 'zzz', new_text: 'a' })).status, 409);
    assert.equal((await post('/memory', { topic: 'none.md', old_text: 'a', new_text: 'b' })).status, 404);

    assert.equal((await post('/memory', { topic: 'notes.txt', content: 'x' })).status, 400);
    assert.equal((await post('/memory', { topic: '../x.md', content: 'x' })).status, 400);
    assert.equal((await post('/memory', { topic: 'a.md' })).status, 400);
    const big = await post('/memory', { topic: 'big.md', content: 'x'.repeat(40_001) });
    assert.equal(big.status, 400);
    assert.equal(big.json.code, 'too_big');
    assert.equal((await post('/memory', { topic: 'p.md', content: 'x', mode: 'plan' })).status, 403);
    assert.equal((await get('/memory/none.md')).status, 404);
    assert.equal((await get('/memory/notes.txt')).status, 400);

    assert.equal((await call('DELETE', '/memory?mode=plan')).status, 403);
    assert.equal((await call('DELETE', '/memory?mode=edits')).status, 403);
    assert.equal((await get('/memory')).json.topics.length, 1);
    const d = await call('DELETE', '/memory');
    assert.equal(d.status, 200);
    assert.equal(d.json.output, 'Cleared.');
    assert.deepEqual((await get('/memory')).json.topics, []);
  } finally {
    await call('DELETE', '/memory');
  }
});
