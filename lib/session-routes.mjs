// Stage 2B (sessions): GET/POST /sessions, POST /sessions/resume, GET /sessions/:id, POST /sessions/:id/export.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Refused, inside, checkFile } from '../build/ask-code-core.mjs';
import { listSessions, createSession, readSession, resumeSession, checkSessionId, markdownOf } from './sessions.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, folderOf, modeOf, optString, queryOf, refusing } from './direct.mjs';
import { log } from './log.mjs';

/**
 * @param {{config: object, route: Function}} app
 */
export function addSessionRoutes(app) {
  const { config, route } = app;

  route('GET', /^\/sessions$/, async (req, res) => {
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    sendJson(res, 200, { ok: true, sessions: await listSessions(config, folder) });
  });

  route('POST', /^\/sessions$/, async (req, res) => {
    const body = await readJson(req);
    const title = optString(body, 'title');
    const folder = await folderOf(config, body.folder, 403);
    const id = await createSession(config, folder, title?.replace(/\s+/g, ' ').trim().slice(0, 60) || undefined);
    log('info', 'sessions', `created ${id}`);
    sendJson(res, 200, { ok: true, session_id: id });
  });

  // Registered before /sessions/:id, which would take "resume" for an id.
  route('POST', /^\/sessions\/resume$/, async (req, res) => {
    const body = await readJson(req);
    if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'id must be a non-empty string', 'bad_request');
    const folder = await folderOf(config, body.folder, 403);
    const s = await resumeSession(config, folder, body.id);
    log('info', 'sessions', `resumed ${s.id}`);
    sendJson(res, 200, { ok: true, session_id: s.id, history: s.history, title: s.title, inputs: s.inputs });
  });

  route('GET', /^\/sessions\/([^/]+)$/, async (req, res, m) => {
    const id = checkSessionId(decodeURIComponent(m[1]));
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    const s = await readSession(config, folder, id);
    if (!s) throw new HttpError(404, `no session ${id}`, 'not_found');
    sendJson(res, 200, { ok: true, history: s.history, title: s.title, inputs: s.inputs, savedAt: s.savedAt });
  });

  route('POST', /^\/sessions\/([^/]+)\/export$/, async (req, res, m) => {
    const id = checkSessionId(decodeURIComponent(m[1]));
    const body = await readJson(req);
    const filename = optString(body, 'filename');
    allowWrite(modeOf(body, config), 'saving a file');
    const folder = await folderOf(config, body.folder, 403);
    const s = await readSession(config, folder, id);
    if (!s) throw new HttpError(404, `no session ${id}`, 'not_found');
    if (!s.history.length) throw new HttpError(400, 'nothing to save yet: the session has no requests', 'empty_session');
    const name = filename?.trim() || `ask-code-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`;
    const { full, rel } = await refusing(async () => {
      const r = await inside(folder, name, { mustExist: false });
      checkFile(r.parts, r.full);
      return r;
    }, Refused);
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, markdownOf(s.title, s.history), { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') throw new HttpError(409, `${rel} is already there: give another filename`, 'file_exists');
      throw e;
    }
    log('info', 'sessions', `exported ${id} to ${rel}`);
    sendJson(res, 200, { ok: true, path: rel });
  });
}
