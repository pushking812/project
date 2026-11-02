// Stage 2E: what the model is given and where the task stands: GET /context, GET /status.
import { gatherNotes, readMemory, memoryDir, folderNow, estimateTokens, taskTokens, contextLeft } from '../build/ask-code-core.mjs';
import { sendJson } from './errors.mjs';
import { folderOf, queryOf } from './direct.mjs';
import { fetchMe } from './ask-proxy.mjs';
import { checkSessionId, sessionOrCurrent } from './sessions.mjs';
import { topicsOf } from './memory.mjs';

/** The session_id of the query, checked; undefined when there is none. */
const sessionParam = (req) => {
  const id = queryOf(req).get('session_id');
  return id ? checkSessionId(id) : undefined;
};

/**
 * @param {{config: object, route: Function}} app
 */
export function addInfoRoutes(app) {
  const { config, route } = app;

  route('GET', /^\/context$/, async (req, res) => {
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    const session = await sessionOrCurrent(config, folder, sessionParam(req));
    const history = session?.history ?? [];
    const [{ text: notes }, memory, env] = await Promise.all([gatherNotes(folder), readMemory(memoryDir(config.site, folder)), folderNow(folder)]);
    sendJson(res, 200, {
      ok: true,
      tokens: { task: taskTokens(history), notes: estimateTokens(notes ?? ''), memory: estimateTokens(memory ?? ''), env: estimateTokens(env) },
      contextLeft: contextLeft(history),
      requests: Math.ceil(history.length / 2),
      session_id: session?.id ?? null,
    });
  });

  route('GET', /^\/status$/, async (req, res) => {
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    const me = await fetchMe(config, aborter.signal);
    const session = await sessionOrCurrent(config, folder, sessionParam(req));
    const dir = memoryDir(config.site, folder);
    const [notes, memory, topics] = await Promise.all([gatherNotes(folder), readMemory(dir), topicsOf(dir)]);
    sendJson(res, 200, {
      ok: true,
      site: config.site,
      account: me.email ?? me.name ?? null,
      plan: me.plan ?? null,
      model: config.model ?? null,
      folder,
      mode: config.mode,
      task: { title: session?.title ?? null, requests: Math.ceil((session?.history.length ?? 0) / 2) },
      session_id: session?.id ?? null,
      memory: { chars: (memory ?? '').length, topics },
      notes: { sources: notes.sources, clipped: notes.clipped },
    });
  });
}
