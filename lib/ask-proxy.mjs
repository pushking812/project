// A thin layer over the monolith's api(): the site address and key come from the config.
import { api, events } from '../build/ask-code-core.mjs';
import { HttpError } from './errors.mjs';

export { events };

/**
 * Calls the ask site with the configured key. Throws what api() throws (Error with .status for an HTTP error).
 * @param {{site: string, key: string}} config
 * @param {string} path like /v1/me
 * @param {RequestInit} [init]
 */
export const askApi = (config, path, init) => api(config.site, config.key, path, init);

/** Turns an error from the site into the HttpError this API answers with. */
export function toHttpError(e) {
  if (e instanceof HttpError) return e;
  if (e?.status === 401) return new HttpError(401, 'invalid key');
  if (e?.status === 429) return new HttpError(429, e.message);
  if (e?.status) return new HttpError(502, `ask answered ${e.status}: ${e.message}`);
  const why = e?.cause?.message || e?.cause?.code;
  return new HttpError(502, why ? `ask unreachable: ${why}` : 'ask unreachable');
}

/** The message of an error with its network cause, like "fetch failed: connect ECONNREFUSED 127.0.0.1:8790". */
export function withCause(e) {
  const msg = e?.message || 'failed';
  const why = e?.cause?.message || e?.cause?.code;
  return why && !msg.includes(why) ? `${msg}: ${why}` : msg;
}

/** Tells the site to stop a run now (a dropped connection reaches it late). Never throws. */
export const stopRun = (config, runId) => askApi(config, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }).catch(() => {});

/** Answers a tool call of the model with the result. */
export const sendToolResult = (config, runId, callId, result, signal) =>
  askApi(config, `/v1/code/${encodeURIComponent(runId)}/tools/${encodeURIComponent(callId)}`, {
    method: 'POST',
    body: JSON.stringify({ ok: result.ok, output: result.output, ...(result.images?.length ? { images: result.images } : {}) }),
    signal,
  });

/**
 * One answer without tools, as `{event, data}` items: delta, usage, done (error is thrown as Error).
 * The site has one conversation endpoint, /v1/code; like ask-code's own quiet question, a tool call is
 * refused so the model answers from the conversation alone.
 * @param {object} config
 * @param {object} body fields of the /v1/code request
 * @param {AbortSignal} signal
 */
export async function* askStream(config, body, signal) {
  const res = await askApi(config, '/v1/code', { method: 'POST', body: JSON.stringify({ history: [], ...body, commands: false }), headers: { accept: 'text/event-stream' }, signal }).catch((e) => {
    throw toHttpError(e);
  });
  let runId = null;
  let finished = false;
  try {
    for await (const { event, data } of events(res)) {
      if (event === 'status' && data.runId) runId = data.runId;
      else if (event === 'delta') yield { event: 'delta', data: { text: data.text } };
      else if (event === 'usage') yield { event: 'usage', data: { input: data.input ?? 0, output: data.output ?? 0 } };
      else if (event === 'tool') await sendToolResult(config, data.runId, data.callId, { ok: false, output: 'Not now: answer from the conversation alone, with no tools.' }).catch(() => {});
      else if (event === 'done') {
        finished = true;
        yield { event: 'done', data: {} };
      } else if (event === 'error') throw new Error(data.message || 'ask failed');
    }
  } finally {
    if (!finished && runId) void stopRun(config, runId);
  }
  if (!finished) throw new Error('the connection to ask dropped before the answer was complete');
}

/** GET /v1/me: the account, as the site sends it. */
export async function fetchMe(config, signal) {
  try {
    return await (await askApi(config, '/v1/me', { signal })).json();
  } catch (e) {
    throw toHttpError(e);
  }
}
