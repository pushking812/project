// Stage 2B (sessions): a folder's tasks kept on this computer, so /execute and /start can carry on an earlier one.
// Files are those of ask-code (historyFile / loadHistory / saveHistory): the folder's own file is the session named
// by its hash, the others sit next to it as <id>.json. Which one is "current" is a small pointer file, so a session's
// id never changes (ask-code's /resume renames files, which would change ids).
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { historyFile, loadHistory, saveHistory, trimHistory, stepsLine, titleOf } from '../build/ask-code-core.mjs';
import { HttpError } from './errors.mjs';
import { log } from './log.mjs';

const INPUTS = 100;
const POINTER = '.current';
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Sessions created by POST /sessions that have no turn yet (nothing on disk to list). dir → id → {title, createdAt} */
const pending = new Map();
/** Sessions a task is running in now: one task at a time per session. */
const busy = new Set();

/** Where the folder's sessions are: the folder's own file, its id, and the directory of the others. */
function placeOf(config, folder) {
  const own = historyFile(config.site, folder, config.home);
  return { own, ownId: basename(own, '.json'), dir: own.replace(/\.json$/, '') };
}

/** @throws {HttpError} 400 */
export function checkSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new HttpError(400, 'session id must be 1-64 letters, digits, - or _', 'bad_session_id');
  return id;
}

const fileOf = (place, id) => (id === place.ownId ? place.own : join(place.dir, `${id}.json`));
const pendingOf = (place) => pending.get(place.dir) ?? pending.set(place.dir, new Map()).get(place.dir);

async function readPointer(place) {
  try {
    const id = (await readFile(join(place.dir, POINTER), 'utf8')).trim();
    return SESSION_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function setCurrent(place, id) {
  await mkdir(place.dir, { recursive: true, mode: 0o700 });
  await writeFile(join(place.dir, POINTER), id, { mode: 0o600 });
}

/** @returns {Promise<Array<{id: string, title: string, requests: number, savedAt: string, current: boolean}>>} newest first */
export async function listSessions(config, folder) {
  const place = placeOf(config, folder);
  const names = (await readdir(place.dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  const ids = [place.ownId, ...names.map((n) => basename(n, '.json'))];
  const out = [];
  for (const id of ids) {
    const s = await loadHistory(fileOf(place, id));
    if (s) out.push({ id, title: s.title, requests: Math.ceil(s.history.length / 2), savedAt: s.savedAt });
    else if (id !== place.ownId) await rm(fileOf(place, id), { force: true }).catch(() => {}); // expired, as ask-code does
  }
  const mine = pendingOf(place);
  for (const [id, p] of mine) {
    if (out.some((s) => s.id === id)) mine.delete(id);
    else out.push({ id, title: p.title, requests: 0, savedAt: p.createdAt });
  }
  const pointer = await readPointer(place);
  const current = out.some((s) => s.id === pointer) ? pointer : out.some((s) => s.id === place.ownId) ? place.ownId : null;
  return out.map((s) => ({ ...s, current: s.id === current })).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** A new, empty session; it becomes the current one. */
export async function createSession(config, folder, title) {
  const place = placeOf(config, folder);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  pendingOf(place).set(id, { title: title ?? '', createdAt: new Date().toISOString() });
  await setCurrent(place, id);
  return id;
}

/**
 * One session's saved task.
 * @returns {Promise<{history: object[], title: string | null, inputs: string[], savedAt: string | null} | null>} null: no such session
 */
export async function readSession(config, folder, id) {
  const place = placeOf(config, folder);
  const s = await loadHistory(fileOf(place, checkSessionId(id)));
  if (s) return s;
  const p = pendingOf(place).get(id);
  return p ? { history: [], title: p.title || null, inputs: [], savedAt: p.createdAt } : null;
}

/** POST /sessions/resume: the session becomes the current one. @throws {HttpError} 404, 409 */
export async function resumeSession(config, folder, id) {
  const place = placeOf(config, folder);
  const all = await listSessions(config, folder);
  const found = all.find((s) => s.id === checkSessionId(id));
  if (!found) throw new HttpError(404, `no session ${id}`, 'not_found');
  if (found.current) throw new HttpError(409, `session ${id} is already the current one`, 'already_current');
  await setCurrent(place, id);
  pendingOf(place).delete(id);
  return { ...(await readSession(config, folder, id)), id };
}

/**
 * Takes a session for one task. Another task in it at the same time would mix up the history.
 * @returns {() => void} release
 * @throws {HttpError} 409
 */
export function lockSession(config, folder, id) {
  const key = fileOf(placeOf(config, folder), checkSessionId(id));
  if (busy.has(key)) throw new HttpError(409, `session ${id} has a task running`, 'session_busy');
  busy.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busy.delete(key);
  };
}

/** What a task starts from: the session's history (empty for a session that has none yet). */
export async function openSession(config, folder, id) {
  const s = await readSession(config, folder, id);
  const mine = pendingOf(placeOf(config, folder)).get(id);
  return { id, history: s?.history ?? [], title: s?.title ?? (mine?.title || null), inputs: s?.inputs ?? [] };
}

/**
 * Adds the finished (or stopped, or cut off) request to the session and saves it, as ask-code's keep() does.
 * Never throws: a failed save is only logged.
 * @param {{id: string, history: object[], title: string | null, inputs: string[]}} session
 * @param {{prompt: string, answer: string, steps: string[], outcome: 'done' | 'stopped' | 'cut'}} turn
 * @returns {Promise<{session_id: string, requests: number, title: string | null} | null>} null: nothing was kept
 */
export async function keepTurn(config, folder, session, { prompt, answer, steps, outcome }) {
  const did = stepsLine(steps);
  if (outcome !== 'done' && !answer && !did) return null;
  const text = outcome === 'done' ? answer : `${answer}\n(${outcome === 'stopped' ? 'stopped' : 'cut off'})`;
  const place = placeOf(config, folder);
  const history = trimHistory([...session.history, { role: 'user', text: prompt }, { role: 'assistant', text: did ? `${text}\n\n${did}` : text }]);
  const title = session.title || titleOf(prompt);
  const inputs = [...session.inputs, prompt].slice(-INPUTS);
  try {
    await saveHistory(fileOf(place, session.id), history, title, inputs);
    await setCurrent(place, session.id);
    pendingOf(place).delete(session.id);
  } catch (e) {
    log('warn', 'sessions', `could not save session ${session.id}: ${e.message}`);
    return null;
  }
  return { session_id: session.id, requests: Math.ceil(history.length / 2), title };
}

/**
 * The session a request is about: the one named, else the folder's current one.
 * @returns {Promise<{id: string, history: object[], title: string | null, inputs: string[]} | null>} null: the folder has no session yet
 * @throws {HttpError} 404 for a named session that is not there
 */
export async function sessionOrCurrent(config, folder, id) {
  if (id !== undefined && id !== null && id !== '') {
    const s = await readSession(config, folder, id);
    if (!s) throw new HttpError(404, `no session ${id}`, 'not_found');
    return { ...s, id };
  }
  const current = (await listSessions(config, folder)).find((s) => s.current);
  if (!current) return null;
  const s = await readSession(config, folder, current.id);
  return s ? { ...s, id: current.id } : null;
}

/** /compact: the session's task becomes this history (title and inputs stay). Throws when it cannot be saved. */
export async function replaceHistory(config, folder, session, history) {
  const place = placeOf(config, folder);
  await saveHistory(fileOf(place, session.id), history, session.title, session.inputs);
  pendingOf(place).delete(session.id);
}

/** The session's task as Markdown, as ask-code's /export writes it. */
export const markdownOf = (title, history) => ['# ' + (title ?? 'ask-code'), '', ...history.map((h) => `**${h.role === 'user' ? 'You' : 'Ask'}:** ${h.text}\n`)].join('\n');

/** For tests: forget what is held in memory. */
export function resetSessions() {
  pending.clear();
  busy.clear();
}
