// Run: node --test test/last-root.mjs  (also part of npm test)
// Stage 3: the server remembers the last root of POST /workspace (lib/last-root.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootFile, rememberRootOn, loadLastRoot, saveLastRoot, restorableRoot } from '../lib/last-root.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ask-lastroot-'));

test('rootFile: ASK_ROOT_FILE wins; APPDATA on Windows; ~/.config elsewhere', () => {
  assert.equal(rootFile({ ASK_ROOT_FILE: 'x.json' }, 'linux', '/h'), 'x.json');
  assert.match(rootFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), /ask-code[\\/]last-root\.json$/);
  assert.match(rootFile({}, 'linux', '/home/u').replace(/\\/g, '/'), /\/home\/u\/\.config\/ask-code\/last-root\.json$/);
});

test('rememberRootOn: off with ASK_ROOT or ASK_REMEMBER_ROOT=0', () => {
  assert.equal(rememberRootOn({}), true);
  assert.equal(rememberRootOn({ ASK_ROOT: '/x' }), false);
  for (const v of ['0', 'false', 'off', 'no']) assert.equal(rememberRootOn({ ASK_REMEMBER_ROOT: v }), false, v);
});

test('save and load: a round trip; a missing or broken file gives undefined; saving never throws', () => {
  const d = tmp();
  try {
    const f = join(d, 'sub', 'last-root.json');
    assert.equal(loadLastRoot(f), undefined);
    assert.equal(saveLastRoot(f, '/some/root'), true);
    assert.equal(loadLastRoot(f), '/some/root');
    writeFileSync(f, '{broken', 'utf8');
    assert.equal(loadLastRoot(f), undefined);
    writeFileSync(f, JSON.stringify({ root: 5 }), 'utf8');
    assert.equal(loadLastRoot(f), undefined);
    assert.equal(saveLastRoot(join(d, 'sub', 'last-root.json', 'x', 'y.json'), 'r'), false, 'a path under a file');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('restorableRoot: an allowed existing folder comes back; a missing, system or outside one does not', () => {
  const d = tmp();
  try {
    const allowed = join(d, 'allowed');
    const work = join(allowed, 'work');
    mkdirSync(work, { recursive: true });
    const f = join(d, 'last-root.json');
    const config = { root: d, allowedRoots: [allowed] };
    saveLastRoot(f, work);
    assert.equal(restorableRoot(f, config), work);
    saveLastRoot(f, join(allowed, 'gone'));
    assert.equal(restorableRoot(f, config), undefined, 'folder deleted');
    saveLastRoot(f, d);
    assert.equal(restorableRoot(f, config), undefined, 'outside the allowed roots');
    saveLastRoot(f, process.platform === 'win32' ? 'C:\\Windows' : '/etc');
    assert.equal(restorableRoot(f, config), undefined, 'a system folder');
    assert.equal(restorableRoot(join(d, 'nofile.json'), config), undefined);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).root.length > 0, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
