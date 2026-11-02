// Adds `export` to api, events and doTool of the vendored ask-code.mjs and writes build/ask-code-core.mjs.
// Idempotent: a name that is already exported is left alone. The vendor file itself is never changed.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VENDOR = new URL('../vendor/ask-code.mjs', import.meta.url);
const CORE = new URL('./ask-code-core.mjs', import.meta.url);

const DECLARATIONS = [
  'async function api(',
  'async function* events(',
  'async function doTool(',
  // Stage 2: what the direct endpoints (/write, /command, ...) need.
  'async function applyChange(',
  'class Refused ',
  'const hasControl = ',
  // Stage 2B-sessions (2В): a session title and the file name check of /export.
  'const titleOf = ',
  'function checkFile(',
  // Stage 2D: /watches.
  'class Watches ',
  // Stage 2E: /model and /compact.
  'const pickModel = ',
  'const COMPACT_PROMPT =',
];
const escape = (s) => s.replace(/[()*]/g, '\\$&');

/**
 * @param {string} source text of ask-code.mjs
 * @returns {string} the same text with api, events and doTool exported
 */
export function patch(source) {
  let out = source;
  for (const decl of DECLARATIONS) {
    if (new RegExp(`^export ${escape(decl)}`, 'm').test(out)) continue;
    const plain = new RegExp(`^${escape(decl)}`, 'm');
    if (!plain.test(out)) throw new Error(`patch: "${decl}" not found in vendor/ask-code.mjs (a new version of the monolith?)`);
    out = out.replace(plain, `export ${decl}`);
  }
  // Windows: child.kill() ends only the cmd shell, so `node serve.mjs &` lived on. Kill the whole tree instead.
  const winKill = "else child.kill('SIGTERM');";
  if (!out.includes('taskkill')) {
    if (!out.includes(winKill)) throw new Error('patch: stopTree not found in vendor/ask-code.mjs (a new version of the monolith?)');
    out = out.replace(
      winKill,
      "else if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});\n    else child.kill('SIGTERM');",
    );
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(CORE, patch(await readFile(VENDOR, 'utf8')));
  console.error('[INFO] [patch] wrote build/ask-code-core.mjs');
}
