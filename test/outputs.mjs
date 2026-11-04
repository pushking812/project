// Stage 3B: output_files of /execute and outputFiles of /status. A fake site tells the model's tool calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { relPath, snapshot, changedFiles, createOutputs } from '../lib/outputs.mjs';

setLogLevel('error');
const KEY = 'test-key-outputs';

let dir, site, app, url;
/** The tool calls the fake site makes in the next /v1/code run (a list of {name, input}), then it says done. */
let script = [];
let results = [];

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ask-outputs-')));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'hello.txt'), 'hello\n');
  site = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/code') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const calls = script;
      script = [];
      results = [];
      let out = sse('status', { runId: 'run1', state: 'thinking' });
      calls.forEach((c, i) => (out += sse('tool', { runId: 'run1', callId: String(i + 1), name: c.name, input: c.input })));
      // The site waits for each tool result in real life; this one tells all calls, the server does them in order.
      out += sse('delta', { text: 'finished' }) + sse('done', {});
      res.end(out);
    } else if (req.url.startsWith('/v1/code/')) {
      results.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  app = createApp({ key: KEY, site: `http://127.0.0.1:${site.address().port}`, root: dir, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error', allowedRoots: [dir], filesMax: 5, filesMaxBytes: 30_000_000, outputScan: true });
  url = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(300);
  await new Promise((r) => site.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** POST /execute and the events it streams. */
async function execute(body) {
  const r = await fetch(`${url}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'p', ...body }) });
  const text = await r.text();
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((b) => {
      const ev = /^event: (.*)$/m.exec(b)?.[1];
      const data = /^data: (.*)$/m.exec(b)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : null };
    });
  return { status: r.status, events, done: events.find((e) => e.event === 'done')?.data };
}

// --- pure parts ---------------------------------------------------------------------------------------------

test('relPath: relative, with "/", and null outside the root', () => {
  const root = join(tmpdir(), 'proj');
  assert.equal(relPath(root, 'report.xlsx'), 'report.xlsx');
  assert.equal(relPath(root, './src/../src/a.js'), 'src/a.js');
  assert.equal(relPath(root, join(root, 'out', 'r.docx')), 'out/r.docx');
  assert.equal(relPath(root, '../x.txt'), null);
  assert.equal(relPath(root, join(tmpdir(), 'other', 'x.txt')), null);
  assert.equal(relPath(root, ''), null);
  assert.equal(relPath(root, undefined), null);
  assert.equal(relPath(root, '.'), null);
});

test('snapshot skips node_modules and dot folders; changedFiles names new and changed files', async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ask-snap-')));
  try {
    mkdirSync(join(d, 'node_modules'));
    mkdirSync(join(d, '.git'));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'node_modules', 'x.js'), '1');
    writeFileSync(join(d, '.git', 'HEAD'), '1');
    writeFileSync(join(d, 'sub', 'a.txt'), 'a');
    writeFileSync(join(d, 'b.txt'), 'b');
    const one = await snapshot(d);
    assert.deepEqual([...one.files.keys()].sort(), ['b.txt', 'sub/a.txt']);
    writeFileSync(join(d, 'b.txt'), 'bbbb'); // size changes
    writeFileSync(join(d, 'new.xlsx'), 'x');
    writeFileSync(join(d, 'node_modules', 'y.js'), '2');
    const two = await snapshot(d);
    assert.deepEqual(changedFiles(one.files, two.files).sort(), ['b.txt', 'new.xlsx']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('snapshot over its limit is marked truncated', async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ask-snap-')));
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(d, `f${i}.txt`), 'x');
    const s = await snapshot(d, 3);
    assert.equal(s.truncated, true);
    assert.equal(s.files.size, 3);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('createOutputs: writes count, reads and failures and Ask’s memory do not', async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ask-out-')));
  try {
    writeFileSync(join(d, 'a.txt'), 'a');
    writeFileSync(join(d, 'b.txt'), 'b');
    const o = createOutputs(d);
    await o.after('read_file', { path: 'a.txt' }, { ok: true }, 'read a.txt');
    await o.after('write_file', { path: 'a.txt' }, { ok: true }, 'wrote a.txt');
    await o.after('edit_file', { path: 'b.txt' }, { ok: false }, 'not changed: b.txt');
    await o.after('write_file', { path: '.ask/notes.md' }, { ok: true }, 'remembered .ask/notes.md');
    await o.after('write_file', { path: '../outside.txt' }, { ok: true }, 'wrote ../outside.txt');
    await o.after('write_file', { path: 'a.txt' }, { ok: true }, 'wrote a.txt');
    assert.deepEqual(o.list(), ['a.txt'], 'one name once');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('createOutputs: a file deleted later is not listed; scan:false ignores commands', async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ask-out-')));
  try {
    const o = createOutputs(d);
    writeFileSync(join(d, 'tmp.txt'), 'x');
    await o.after('write_file', { path: 'tmp.txt' }, { ok: true }, 'wrote tmp.txt');
    rmSync(join(d, 'tmp.txt'));
    assert.deepEqual(o.list(), []);

    const off = createOutputs(d, { scan: false });
    await off.before('run_command');
    writeFileSync(join(d, 'made.txt'), 'x');
    await off.after('run_command', { command: 'x' }, { ok: true }, 'ran x (ok)');
    assert.deepEqual(off.list(), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// --- through the server --------------------------------------------------------------------------------------

test('/execute: write_file and edit_file are named in done.output_files', async () => {
  script = [
    { name: 'read_file', input: { path: 'hello.txt' } },
    { name: 'write_file', input: { path: 'report.md', content: '# report\n' } },
    { name: 'edit_file', input: { path: 'src/a.js', old_text: 'a = 1', new_text: 'a = 2' } },
  ];
  const r = await execute({});
  assert.equal(r.status, 200);
  assert.deepEqual(r.done.output_files, ['report.md', 'src/a.js']);
  assert.deepEqual(r.done.steps, ['read hello.txt', 'wrote report.md', 'edited src/a.js']);
});

test('/execute without writes has no output_files', async () => {
  script = [{ name: 'read_file', input: { path: 'hello.txt' } }];
  const r = await execute({});
  assert.equal('output_files' in r.done, false);
});

test('/execute in plan mode changes nothing and names nothing', async () => {
  script = [{ name: 'write_file', input: { path: 'plan-only.md', content: 'x' } }];
  const r = await execute({ mode: 'plan' });
  assert.equal('output_files' in r.done, false);
});

test('/execute: a file a command made is named (run_command, before/after)', async () => {
  const cmd = `node -e "require('fs').writeFileSync('made-by-script.xlsx','x')"`;
  script = [
    { name: 'run_command', input: { command: cmd } },
    { name: 'run_command', input: { command: 'node -e "0"' } }, // changes nothing
  ];
  const r = await execute({});
  assert.deepEqual(r.done.output_files, ['made-by-script.xlsx']);
});

test('/start then /status: outputFiles', async () => {
  script = [{ name: 'write_file', input: { path: 'notes/status.md', content: 'x' } }];
  const s = await (await fetch(`${url}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'p' }) })).json();
  assert.ok(s.taskId);
  let st;
  for (let i = 0; i < 50; i++) {
    st = await (await fetch(`${url}/status/${s.taskId}`)).json();
    if (st.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(st.status, 'done');
  assert.deepEqual(st.outputFiles, ['notes/status.md']);
});

test('/status of a task without writes keeps its old keys', async () => {
  script = [];
  const s = await (await fetch(`${url}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'p' }) })).json();
  let st;
  for (let i = 0; i < 50; i++) {
    st = await (await fetch(`${url}/status/${s.taskId}`)).json();
    if (st.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal('outputFiles' in st, false);
});
