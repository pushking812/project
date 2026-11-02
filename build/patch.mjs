// Adds `export` to api, events and doTool of the vendored ask-code.mjs and writes build/ask-code-core.mjs.
// Idempotent: a name that is already exported is left alone. The vendor file itself is never changed.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VENDOR = new URL('../vendor/ask-code.mjs', import.meta.url);
const CORE = new URL('./ask-code-core.mjs', import.meta.url);

const DECLARATIONS = ['async function api(', 'async function* events(', 'async function doTool('];
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
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(CORE, patch(await readFile(VENDOR, 'utf8')));
  console.error('[INFO] [patch] wrote build/ask-code-core.mjs');
}
