// Stage 2B (sessions): GET/POST /sessions, POST /sessions/resume, GET /sessions/:id, POST /sessions/:id/export.
import { listSessions, createSession } from './sessions.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { folderOf, optString, queryOf } from './direct.mjs';
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
}
