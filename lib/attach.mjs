// Stage 3B: `files` of /ask, /execute and /start — paths in the project folder that the server reads itself and sends
// to the site as the `files` of the request (https://ask.oryxml.com/v1/docs, "Files and pictures").
import { isAbsolute, relative, sep } from 'node:path';
import { readOne, Refused } from '../build/ask-code-core.mjs';
import { HttpError } from './errors.mjs';
import { refusing } from './direct.mjs';

/** The site takes up to 200 000 characters of one text file. */
export const TEXT_LIMIT = 200_000;
const TRUNCATED = '\n… (truncated)';
export const DEFAULT_FILES_MAX = 5;
export const DEFAULT_FILES_MAX_BYTES = 30_000_000;

/**
 * An absolute path inside the root becomes a path relative to it (models often send the full path).
 * Anything else comes back unchanged, so a path outside the root is still refused later.
 */
export function inRootPath(root, path) {
  if (!isAbsolute(path)) return path;
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return path;
  return rel.replace(/\\/g, '/');
}

/**
 * Checks the `files` field of a request body: undefined or a list of paths (a string, or `{path}`).
 * @returns {string[]} the paths
 * @throws {HttpError} 400 invalid_files
 */
export function checkFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new HttpError(400, 'files must be a list of paths', 'invalid_files');
  return files.map((f) => {
    const path = typeof f === 'string' ? f : f && typeof f === 'object' ? f.path : undefined;
    if (typeof path !== 'string' || !path.trim()) throw new HttpError(400, 'every item of files must be a non-empty path', 'invalid_files');
    return path.trim();
  });
}

/**
 * Reads the files under `config.root` and returns the `files` array of the site's request.
 * A text, a PDF's text or an Office file's text → `{kind:"text", name, text}`; a picture or a PDF's pages →
 * `{kind:"image", name, mediaType, data}`. Secret files (.env, keys) and paths outside the folder are refused.
 * @param {{root: string, filesMax?: number, filesMaxBytes?: number}} config
 * @param {string[]} paths from checkFiles
 * @throws {HttpError} 403 secret / outside, 404 not_found, 413 too_many_files / too_large
 */
export async function attachFiles(config, paths) {
  if (!paths.length) return [];
  const max = config.filesMax ?? DEFAULT_FILES_MAX;
  const maxBytes = config.filesMaxBytes ?? DEFAULT_FILES_MAX_BYTES;
  if (paths.length > max) throw new HttpError(413, `at most ${max} files per request (got ${paths.length})`, 'too_many_files');
  const out = [];
  let bytes = 0;
  const add = (item) => {
    bytes += (item.data?.length ?? 0) + Buffer.byteLength(item.text ?? '');
    if (bytes > maxBytes) throw new HttpError(413, `the files are too big (more than ${Math.round(maxBytes / 1e6)} MB in all); split them or send the text with read_file`, 'too_large');
    out.push(item);
  };
  for (const given of paths) {
    const path = inRootPath(config.root, given);
    const r = await refusing(() => readOne(config.root, { path, offset: 1, limit: 1_000_000 }), Refused);
    let text = String(r.output ?? '');
    if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT - TRUNCATED.length) + TRUNCATED;
    const name = path.replace(/\\/g, '/');
    // A picture file comes as a picture only; its "Here it is" line is no text of the file.
    // A PDF has "--- Page N ---" blocks: their text goes along with the page pictures.
    const isPdfText = /^--- Page \d+ ---$/m.test(text);
    if (!r.images?.length || isPdfText || !/\ba picture\b/.test(text)) add({ kind: 'text', name, text });
    let n = 0;
    for (const img of r.images ?? []) {
      if (out.length >= max) break; // the site takes no more than `max` files; the rest of a PDF's pages stay out
      n += 1;
      add({ kind: 'image', name: r.images.length > 1 ? `${name} (page ${n})` : name, mediaType: img.mediaType, data: img.data });
    }
  }
  return out;
}
