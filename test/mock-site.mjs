// A stand-in for the ask site, for tests: /v1/me, /v1/code (SSE with tool calls) and the tool-result endpoint.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const GOOD_KEY = 'sk-ask-test-good';

/**
 * @param {{ scenario?: (ctx: {body: any, emit: Function, callTool: Function, sleep: Function, closed: () => boolean}) => Promise<void> }} [opts]
 *   scenario plays one /v1/code run; the default answers "ok".
 */
export async function startMockSite({ scenario } = {}) {
  const requests = [];
  const runs = new Map();
  const state = { scenario: scenario ?? (async ({ emit }) => emit('delta', { text: 'ok' })) };

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const readBody = async (req) => {
    let s = '';
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const body = req.method === 'POST' ? await readBody(req) : null;
    requests.push({ method: req.method, path: url.pathname, body, key: bearer });

    if (bearer !== GOOD_KEY) return json(res, 401, { error: { code: 'bad_key', message: 'The key is wrong.' } });
    if (req.method === 'GET' && url.pathname === '/v1/me') return json(res, 200, { name: 'Tester', plan: 'plus', code: true, models: ['claude-sonnet'], limits: null });

    if (req.method === 'POST' && url.pathname === '/v1/code') {
      if (body.prompt === '__quota__') return json(res, 429, { error: { code: 'quota_exceeded', message: 'Quota used up.' } });
      const runId = randomUUID();
      const run = { pending: new Map(), stopped: false, results: [] };
      runs.set(runId, run);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let closed = false;
      res.on('close', () => (closed = true));
      const emit = (event, data) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let n = 0;
      const callTool = (name, input) =>
        new Promise((resolve) => {
          const callId = String(++n);
          run.pending.set(callId, resolve);
          emit('tool', { runId, callId, name, input });
        });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      emit('status', { runId, state: 'thinking' });
      try {
        await state.scenario({ body, emit, callTool, sleep, closed: () => closed || run.stopped, run });
        if (!closed && !run.stopped) {
          emit('usage', { input: 10, output: 5 });
          emit('done', {});
        }
      } catch (e) {
        emit('error', { message: e.message });
      }
      res.end();
      return;
    }

    let m = url.pathname.match(/^\/v1\/code\/([^/]+)\/tools\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const run = runs.get(m[1]);
      run?.results.push(body);
      run?.pending.get(m[2])?.(body);
      return json(res, 200, {});
    }
    m = url.pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
    if (req.method === 'POST' && m) {
      const run = runs.get(m[1]);
      if (run) {
        run.stopped = true;
        for (const resolve of run.pending.values()) resolve({ ok: false, output: 'stopped' });
      }
      return json(res, 200, {});
    }
    json(res, 404, { error: { message: 'not found' } });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setScenario: (fn) => (state.scenario = fn),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}
