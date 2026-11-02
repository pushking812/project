// Stage 2B: the folder's notes (ASK.md) and Ask's memory of it: /notes /remember /memory.
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gatherNotes, remember, memoryDir, readMemory, memoryTool, MEMORY_DIR, Refused } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, folderOf, modeOf, needString, queryOf, refusal, refusing } from './direct.mjs';
import { log } from './log.mjs';

const NOTE_CHARS = 2_000;

/**
 * A topic file name of the memory: a plain name ending in .md (no folders).
 * @throws {HttpError} 400
 */
export function topicOf(value) {
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'topic must be a file name like project.md', 'bad_request');
  if (/[\\/\0]/.test(value) || value === '.' || value === '..' || value.startsWith('.')) throw new HttpError(400, 'topic must be a plain file name like project.md', 'bad_topic');
  if (!/\.md$/i.test(value)) throw new HttpError(400, 'topic must end with .md', 'not_markdown');
  return value;
}

/** The .md files in the memory folder (MEMORY.md, the index, is not a topic). */
export async function topicsOf(dir) {
  const names = await readdir(dir).catch(() => []);
  return names.filter((n) => /\.md$/i.test(n) && n !== 'MEMORY.md').sort();
}

/**
 * Registers the stage 2B endpoints.
 * @param {{config: object, route: Function}} app
 */
export function addMemoryRoutes(app) {
  const { config, route } = app;
  const dirFor = (folder) => memoryDir(config.site, folder);

  route('GET', /^\/notes$/, async (req, res) => {
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    const { text, sources, clipped } = await gatherNotes(folder);
    sendJson(res, 200, { ok: true, text, sources, clipped });
  });

  route('POST', /^\/remember$/, async (req, res) => {
    const body = await readJson(req);
    const note = needString(body, 'note');
    if (note.length > NOTE_CHARS) throw new HttpError(400, `note is too long (${NOTE_CHARS} characters at most)`, 'too_big');
    allowWrite(modeOf(body, config), 'changing notes');
    const folder = await folderOf(config, body.folder, 403);
    await refusing(() => remember(folder, note), Refused);
    log('info', 'memory', 'remembered a note');
    sendJson(res, 200, { ok: true, output: 'Saved in ASK.md.' });
  });

  route('GET', /^\/memory$/, async (req, res) => {
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    const dir = dirFor(folder);
    sendJson(res, 200, { ok: true, index: await readMemory(dir), topics: await topicsOf(dir), dir });
  });

  route('GET', /^\/memory\/([^/]+)$/, async (req, res, m) => {
    const topic = topicOf(decodeURIComponent(m[1]));
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    let text;
    try {
      text = await readFile(join(dirFor(folder), topic), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') throw new HttpError(404, `no memory file ${topic}`, 'not_found');
      throw e;
    }
    sendJson(res, 200, { ok: true, text });
  });

  route('POST', /^\/memory$/, async (req, res) => {
    const body = await readJson(req);
    const topic = topicOf(body.topic);
    const editing = body.old_text !== undefined || body.new_text !== undefined;
    let args;
    if (editing) {
      const old_text = needString(body, 'old_text');
      if (typeof body.new_text !== 'string') throw new HttpError(400, 'new_text must be a string', 'bad_request');
      args = { old_text, new_text: body.new_text };
    } else {
      if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string (or give old_text and new_text to edit)', 'bad_request');
      args = { content: body.content };
    }
    allowWrite(modeOf(body, config), 'changing the memory');
    const folder = await folderOf(config, body.folder, 403);
    const r = await memoryTool(dirFor(folder), editing ? 'edit_file' : 'write_file', { path: `${MEMORY_DIR}/${topic}`, ...args });
    if (!r.ok) throw refusal(r.output);
    log('info', 'memory', `saved ${topic}`);
    sendJson(res, 200, { ok: true, output: r.output });
  });

  route('DELETE', /^\/memory$/, async (req, res) => {
    const body = await readJson(req);
    const q = queryOf(req);
    const mode = modeOf({ mode: q.get('mode') ?? body.mode }, config);
    if (mode !== 'all') throw new HttpError(403, 'clearing the memory needs mode "all"', mode === 'plan' ? 'plan_mode' : 'mode_forbidden');
    const folder = await folderOf(config, q.get('folder') ?? body.folder, 403);
    await rm(dirFor(folder), { recursive: true, force: true });
    log('info', 'memory', 'cleared');
    sendJson(res, 200, { ok: true, output: 'Cleared.' });
  });
}
