// Stage 2E: GET /models, POST /model — which model the next tasks use.
import { pickModel } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { needString } from './direct.mjs';
import { fetchMe } from './ask-proxy.mjs';
import { log } from './log.mjs';

/**
 * The model is one setting of the whole server (`config.model`): /execute, /start, /ask and /compact send it to the site.
 * @param {{config: object, route: Function}} app
 */
export function addModelRoutes(app) {
  const { config, route } = app;
  const modelsOf = (me) => (Array.isArray(me.models) ? me.models : []);

  route('GET', /^\/models$/, async (req, res) => {
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    const me = await fetchMe(config, aborter.signal);
    sendJson(res, 200, { ok: true, models: modelsOf(me), current: config.model ?? null });
  });

  route('POST', /^\/model$/, async (req, res) => {
    const name = needString(await readJson(req), 'name').trim();
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    const me = await fetchMe(config, aborter.signal);
    const models = modelsOf(me);
    const picked = pickModel({ ...me, models }, name);
    if (!picked) throw new HttpError(400, `"${name}" is not on your plan. Available: ${models.map((m) => m.replace(/^claude-/, '')).join(', ') || 'none'}`, 'unknown_model');
    config.model = picked;
    log('info', 'model', `model is now ${picked}`);
    sendJson(res, 200, { ok: true, model: picked });
  });
}
