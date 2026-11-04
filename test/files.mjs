// Stage 3B: `files` of /ask, /execute and /start. A fake site records what /v1/code receives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { checkFiles, attachFiles, inRootPath, TEXT_LIMIT } from '../lib/attach.mjs';

setLogLevel('error');
const KEY = 'test-key-files';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let dir, site, app, url;
/** Bodies the fake site got on /v1/code. */
const seen = [];

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ask-files-')));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n');
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(TEXT_LIMIT + 50_000));
  writeFileSync(join(dir, 'pic.png'), PNG);
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  writeFileSync(join(dir, 'key.pem'), '-----BEGIN PRIVATE KEY-----\n');
  for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`);
  site = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === '/v1/code') {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {}\n\n');
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  app = createApp({ key: KEY, site: `http://127.0.0.1:${site.address().port}`, root: dir, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error', allowedRoots: [dir], filesMax: 5, filesMaxBytes: 30_000_000 });
  url = `http://127.0.0.1:${await app.listen()}`;
});

after(async () => {
  await app.shutdown(300);
  await new Promise((r) => site.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const post = async (path, body) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
};
const last = () => seen[seen.length - 1];

test('checkFiles: paths as strings or {path}; anything else → 400 invalid_files', () => {
  assert.deepEqual(checkFiles(undefined), []);
  assert.deepEqual(checkFiles(['a.txt', { path: ' b.txt ' }]), ['a.txt', 'b.txt']);
  for (const bad of ['a.txt', {}, [''], [1], [null], [{ path: 5 }], [{}]]) {
    assert.throws(() => checkFiles(bad), (e) => e.status === 400 && e.code === 'invalid_files', JSON.stringify(bad));
  }
});

test('/ask with files: the site gets {kind:"text", name, text}', async () => {
  const r = await post('/ask', { prompt: 'what is in it?', useContext: false, files: ['hello.txt', 'src/a.js'] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /event: done/);
  const files = last().files;
  assert.equal(files.length, 2);
  assert.equal(files[0].kind, 'text');
  assert.equal(files[0].name, 'hello.txt');
  assert.match(files[0].text, /hello world/);
  assert.equal(files[1].name, 'src/a.js');
  assert.match(files[1].text, /export const a/);
});

test('/ask without files sends no `files` field (as before)', async () => {
  const r = await post('/ask', { prompt: 'hi', useContext: false });
  assert.equal(r.status, 200);
  assert.equal('files' in last(), false);
});

test('/ask with a picture: {kind:"image", name, mediaType, data}', async () => {
  const r = await post('/ask', { prompt: 'see', useContext: false, files: ['pic.png'] });
  assert.equal(r.status, 200, r.text);
  const files = last().files;
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'image');
  assert.equal(files[0].name, 'pic.png');
  assert.equal(files[0].mediaType, 'image/png');
  assert.equal(Buffer.from(files[0].data, 'base64').equals(PNG), true);
});

test('/ask with a long text: cut to the site’s 200 000 characters', async () => {
  const r = await post('/ask', { prompt: 'x', useContext: false, files: ['big.txt'] });
  assert.equal(r.status, 200, r.text);
  assert.ok(last().files[0].text.length <= TEXT_LIMIT);
});

test('/ask refusals: secret, outside, missing, too many, bad shape — before any request to the site', async () => {
  const before = seen.length;
  const cases = [
    [['.env'], 403, 'secret'],
    [['key.pem'], 403, 'secret'],
    [['../../etc/passwd'], 403, 'outside'],
    [['nope.txt'], 404, 'not_found'],
    [['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt'], 413, 'too_many_files'],
    ['hello.txt', 400, 'invalid_files'],
    [[''], 400, 'invalid_files'],
    [['src'], 400, 'refused'],
  ];
  for (const [files, status, code] of cases) {
    const r = await post('/ask', { prompt: 'x', useContext: false, files });
    assert.equal(r.status, status, `${JSON.stringify(files)} → ${r.text}`);
    assert.equal(r.json.code, code, JSON.stringify(files));
    assert.equal(r.text.includes(KEY), false);
  }
  assert.equal(seen.length, before, 'nothing went to the site');
});

test('inRootPath: an absolute path inside the root becomes relative; outside or relative ones stay as they are', () => {
  assert.equal(inRootPath(dir, join(dir, 'hello.txt')), 'hello.txt');
  assert.equal(inRootPath(dir, join(dir, 'src', 'a.js')), 'src/a.js');
  assert.equal(inRootPath(dir, 'src/a.js'), 'src/a.js');
  const out = join(dir, '..', 'elsewhere', 'x.txt');
  assert.equal(inRootPath(dir, out), out);
  assert.equal(inRootPath(dir, dir), dir, 'the root itself is no file');
});

test('/ask with the absolute path of a file inside the root works and is named relatively; outside → 403', async () => {
  const r = await post('/ask', { prompt: 'x', useContext: false, files: [join(dir, 'src', 'a.js')] });
  assert.equal(r.status, 200, r.text);
  assert.equal(last().files[0].name, 'src/a.js');
  assert.match(last().files[0].text, /export const a/);
  const n = seen.length;
  const bad = await post('/ask', { prompt: 'x', useContext: false, files: [join(dir, '..', 'x.txt')] });
  assert.equal(bad.status, 403, bad.text);
  assert.equal(bad.json.code, 'outside');
  assert.equal(seen.length, n);
});

test('attachFiles: more than the byte limit → 413 too_large', async () => {
  await assert.rejects(attachFiles({ root: dir, filesMax: 5, filesMaxBytes: 1000 }, ['big.txt']), (e) => e.status === 413 && e.code === 'too_large');
});

test('/execute with files: the first /v1/code request carries them', async () => {
  const r = await post('/execute', { prompt: 'analyse', files: ['hello.txt'] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /event: done/);
  assert.equal(last().files[0].name, 'hello.txt');
  assert.match(last().files[0].text, /hello world/);
  assert.equal(last().commands, true);
});

test('/start with files: same; a refused file answers 403 and starts no task', async () => {
  const ok = await post('/start', { prompt: 'analyse', files: ['hello.txt'] });
  assert.equal(ok.status, 200, ok.text);
  for (let i = 0; i < 100 && app.running() > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(last().files[0].name, 'hello.txt');
  const before = app.registry.tasks.size;
  const bad = await post('/start', { prompt: 'analyse', files: ['.env'] });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.code, 'secret');
  assert.equal(app.registry.tasks.size, before);
});
