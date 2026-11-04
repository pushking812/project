// Stage 3B, whole cycle with real files (.xlsx, .pdf, .py): the real server, a fake site, the files on disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startStack } from './stack.mjs';
import { canReadPdf, PDF_PHRASE } from './fixtures.mjs';

let stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  await stack.stop();
});

const post = async (path, body) => {
  const r = await fetch(stack.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  const done = /^event: done\ndata: (.*)$/m.exec(text)?.[1];
  return { status: r.status, text, done: done ? JSON.parse(done) : null };
};
const answer = (r) => [...r.text.matchAll(/^data: (\{"text":.*\})$/gm)].map((m) => JSON.parse(m[1]).text).join('');
const last = () => stack.seen[stack.seen.length - 1];

test('/ask with an .xlsx: the site gets its sheet as text', async () => {
  const r = await post('/ask', { prompt: 'summarise', useContext: false, files: ['hello.xlsx'] });
  assert.equal(r.status, 200, r.text);
  const f = last().files[0];
  assert.equal(f.kind, 'text');
  assert.equal(f.name, 'hello.xlsx');
  assert.match(f.text, /--- Sheet: Sales ---/);
  assert.match(f.text, /Apple\t3/);
  assert.match(f.text, /Pear\t5/);
  assert.match(answer(r), /hello\.xlsx: --- Sheet: Sales/);
});

test('/ask with a .py: the site gets the code', async () => {
  const r = await post('/ask', { prompt: 'review', useContext: false, files: ['calc.py'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(last().files.map((f) => [f.kind, f.name]), [['text', 'calc.py']]);
  assert.match(last().files[0].text, /def add\(a, b\)/);
});

test('/ask with a .pdf: the site gets its text', { skip: !canReadPdf() && 'pdftotext (poppler) is not installed' }, async () => {
  const r = await post('/ask', { prompt: 'summarise', useContext: false, files: ['input.pdf'] });
  assert.equal(r.status, 200, r.text);
  const texts = last().files.filter((f) => f.kind === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].name, 'input.pdf');
  assert.ok(texts[0].text.includes(PDF_PHRASE), texts[0].text);
});

test('/ask with all three at once', { skip: !canReadPdf() && 'pdftotext (poppler) is not installed' }, async () => {
  const r = await post('/ask', { prompt: 'compare', useContext: false, files: ['hello.xlsx', 'input.pdf', 'calc.py'] });
  assert.equal(r.status, 200, r.text);
  const names = last().files.map((f) => f.name);
  for (const n of ['hello.xlsx', 'input.pdf', 'calc.py']) assert.ok(names.includes(n), `${n} in ${names}`);
});

test('whole cycle: /execute reads hello.xlsx, a script makes report.xlsx, output_files names it, /ask reads it back', async () => {
  const r = await post('/execute', { prompt: 'analyse hello.xlsx and make REPORT', files: ['hello.xlsx'] });
  assert.equal(r.status, 200, r.text);
  assert.match(last().files[0].text, /Apple\t3/);
  assert.equal(last().commands, true);
  assert.deepEqual(r.done.output_files, ['report.xlsx']);
  assert.ok(existsSync(join(stack.dir, 'report.xlsx')));
  const back = await post('/ask', { prompt: 'read the report', useContext: false, files: r.done.output_files });
  assert.equal(back.status, 200, back.text);
  assert.match(last().files[0].text, /Apple\t3/);
});

test('whole cycle through /start and /status: outputFiles', async () => {
  rmSync(join(stack.dir, 'report.xlsx'), { force: true }); // made by the previous test
  const s = await (await fetch(`${stack.url}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'make REPORT again', files: ['hello.xlsx'] }) })).json();
  assert.ok(s.taskId);
  let st;
  for (let i = 0; i < 100; i++) {
    st = await (await fetch(`${stack.url}/status/${s.taskId}`)).json();
    if (st.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(st.status, 'done');
  assert.deepEqual(st.outputFiles, ['report.xlsx']);
});

test('refusals still hold with real files around: .env and ../ never reach the site', async () => {
  const before = stack.seen.length;
  for (const f of ['../outside.xlsx', '.env']) {
    const r = await post('/ask', { prompt: 'x', useContext: false, files: [f] });
    assert.ok([403, 404].includes(r.status), `${f} → ${r.status}`);
  }
  assert.equal(stack.seen.length, before);
});
