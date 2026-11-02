// Stage 2E: POST /compact — the session's task folded into a short summary that stands in for it (SSE).
import { COMPACT_PROMPT, FOLDED_MARK } from '../build/ask-code-core.mjs';
import { HttpError, readJson } from './errors.mjs';
import { askStream } from './ask-proxy.mjs';
import { pipeSSE, logged } from './sse.mjs';
import { folderOf, optString } from './direct.mjs';
import { checkSessionId, lockSession, replaceHistory, sessionOrCurrent } from './sessions.mjs';
import { log } from './log.mjs';

const MIN_HISTORY = 4;
const FOCUS_CHARS = 500;

/**
 * @param {{config: object, route: Function}} app
 */
export function addCompactRoutes(app) {
  const { config, route } = app;

  route('POST', /^\/compact$/, async (req, res) => {
    const body = await readJson(req);
    const focus = optString(body, 'focus')?.trim().slice(0, FOCUS_CHARS);
    const id = body.session_id === undefined ? undefined : checkSessionId(body.session_id);
    const folder = await folderOf(config, body.folder, 403);
    const session = await sessionOrCurrent(config, folder, id);
    if (!session) throw new HttpError(404, 'there is no session in this folder yet', 'not_found');
    if (session.history.length < MIN_HISTORY) throw new HttpError(400, 'nothing to fold yet: the task is short', 'too_short');
    const release = lockSession(config, folder, session.id); // 409 while a task runs in it

    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    const requests = Math.ceil(session.history.length / 2);

    async function* fold() {
      let text = '';
      const prompt = `${COMPACT_PROMPT}${focus ? `\nKeep in particular: ${focus}` : ''}`;
      const fields = { prompt, ...(config.model ? { model: config.model } : {}), history: session.history };
      for await (const item of askStream(config, fields, aborter.signal)) {
        if (item.event === 'delta') text += item.data.text;
        if (item.event !== 'done') yield item;
      }
      const summary = text.trim();
      if (!summary) throw new Error('could not fold the task this time: it is as it was');
      await replaceHistory(config, folder, session, [
        { role: 'user', text: FOLDED_MARK },
        { role: 'assistant', text: summary },
      ]);
      log('info', 'compact', `folded ${requests} request(s) of session ${session.id}`);
      yield { event: 'done', data: { summary, requests, session_id: session.id } };
    }

    try {
      await pipeSSE(res, logged('compact', fold()));
    } finally {
      release();
    }
  });
}
