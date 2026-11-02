// HTTP/SSE API around ask-code (stage 1). Listens on 127.0.0.1 only; logs to stderr.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, VERSION, MODES } from './lib/config.mjs';
import { log, brief, setLogLevel, setLogSecret } from './lib/log.mjs';
import { HttpError, sendError, sendJson, readJson } from './lib/errors.mjs';
import { fetchMe, askStream } from './lib/ask-proxy.mjs';
import { pipeSSE, logged, openSSE, writeEvent } from './lib/sse.mjs';
import { buildContext } from './lib/context.mjs';
import { TaskRegistry } from './lib/tasks.mjs';
import { executeTask } from './lib/executor.mjs';
import { Apps } from './build/ask-code-core.mjs';
import { addFileRoutes } from './lib/files.mjs';

const SHUTDOWN_GRACE_MS = 4_000;
const STOP_FORCE_MS = 8_000;
const SWEEP_MS = 5 * 60 * 1000;

/**
 * Builds the server (does not listen yet).
 * @param {ReturnType<typeof loadConfig>} config
 */
export function createApp(config) {
  /** @type {Array<[string, RegExp, (req, res, match: RegExpMatchArray) => Promise<void> | void]>} */
  const routes = [];
  const route = (method, pattern, handler) => routes.push([method, pattern, handler]);

  const registry = new TaskRegistry({ maxParallel: config.maxParallel });
  const app = {
    config,
    server: null,
    registry,
    /** Background apps started by POST /command (stage 2). */
    apps: new Apps(),
    /** Number of tasks running now. */
    running: () => registry.running,
    /** Hooks run on shutdown, before the server closes. */
    onShutdown: [],
    route,
  };

  route('GET', /^\/health$/, (req, res) => {
    sendJson(res, 200, { ok: true, version: VERSION, node: process.versions.node, keyPresent: Boolean(config.key), root: config.root, running: app.running(), maxParallel: config.maxParallel });
  });

  route('GET', /^\/me$/, async (req, res) => {
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    sendJson(res, 200, await fetchMe(config, aborter.signal));
  });

  route('POST', /^\/ask$/, async (req, res) => {
    const { prompt, useContext = true } = await readJson(req);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'prompt must be a non-empty string');
    if (typeof useContext !== 'boolean') throw new HttpError(400, 'useContext must be true or false');
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    const { memoryDir, ...context } = useContext ? await buildContext(config) : {};
    log('debug', 'ask', `/ask prompt=${brief(prompt, 60)} context=${useContext}`);
    await pipeSSE(res, logged('ask', askStream(config, { prompt, ...context }, aborter.signal)));
  });

  /** Reads and checks the body of /execute and /start. */
  const readTaskBody = async (req) => {
    const { prompt, mode = config.mode } = await readJson(req);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'prompt must be a non-empty string');
    if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
    return { prompt, mode };
  };

  route('POST', /^\/execute$/, async (req, res) => {
    const { prompt, mode } = await readTaskBody(req);
    const rec = registry.create({ prompt, mode }); // 429 when MAX_PARALLEL tasks run
    openSSE(res);
    res.on('close', () => {
      if (rec.status === 'running') rec.abort.abort();
    });
    await executeTask({ rec, config, onEvent: ({ event, data }) => writeEvent(res, event, data) });
    if (!res.writableEnded) res.end();
  });

  route('POST', /^\/start$/, async (req, res) => {
    const { prompt, mode } = await readTaskBody(req);
    let rec;
    try {
      rec = registry.create({ prompt, mode });
    } catch (e) {
      if (e.status === 429) log('warn', 'tasks', `max parallel reached (${config.maxParallel}), rejecting`);
      throw e;
    }
    executeTask({ rec, config }).catch((e) => log('error', 'tasks', `${rec.id} crashed: ${e.message}`));
    sendJson(res, 200, { taskId: rec.id, status: 'running' });
  });

  const findTask = (id) => {
    const rec = registry.get(id);
    if (!rec) throw new HttpError(404, 'unknown taskId');
    return rec;
  };

  route('GET', /^\/status\/([^/]+)$/, (req, res, m) => sendJson(res, 200, TaskRegistry.view(findTask(m[1]))));

  route('POST', /^\/stop\/([^/]+)$/, (req, res, m) => {
    const rec = findTask(m[1]);
    if (rec.status === 'running') {
      rec.abort.abort();
      try {
        rec.ctx?.apps.stopAll();
      } catch {}
      void rec.ctx?.browser?.close?.();
      // A tool that cannot be cancelled may hold the loop: after the grace time mark the task stopped anyway.
      const timer = setTimeout(() => {
        if (rec.status !== 'running') return;
        rec.status = 'stopped';
        rec.finishedAt = new Date().toISOString();
        log('warn', 'tasks', `${rec.id} did not end in ${config.stopForceMs ?? STOP_FORCE_MS} ms after /stop, marked stopped`);
      }, config.stopForceMs ?? STOP_FORCE_MS);
      timer.unref();
    }
    sendJson(res, 200, { status: rec.status === 'running' ? 'stopping' : rec.status });
  });

  // Stage 2
  addFileRoutes(app);

  const handle = async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    let known = false;
    for (const [method, pattern, handler] of routes) {
      const match = path.match(pattern);
      if (!match) continue;
      known = true;
      if (req.method !== method) continue;
      await handler(req, res, match);
      return;
    }
    throw new HttpError(known ? 405 : 404, known ? 'method not allowed' : 'not found');
  };

  app.server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!(e instanceof HttpError)) log('error', 'server', `${req.method} ${req.url} failed: ${e.message}`);
      sendError(res, e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.message : 'internal error', e instanceof HttpError ? e.code : undefined);
    });
  });

  let sweepTimer = null;

  /** @returns {Promise<number>} the port it listens on */
  app.listen = () =>
    new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, config.host, () => {
        app.server.off('error', reject);
        sweepTimer = setInterval(() => {
          const n = registry.sweep();
          if (n) log('debug', 'tasks', `removed ${n} old task(s)`);
        }, SWEEP_MS);
        sweepTimer.unref();
        resolve(app.server.address().port);
      });
    });

  // On shutdown: abort every task, stop their apps, give them a moment to end as "stopped".
  app.onShutdown.push(async () => {
    clearInterval(sweepTimer);
    registry.abortAll();
    try {
      app.apps.stopAll();
    } catch {}
    for (const rec of registry.tasks.values()) {
      try {
        rec.ctx?.apps.stopAll();
      } catch {}
    }
    const until = Date.now() + SHUTDOWN_GRACE_MS / 2;
    while (registry.running > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  });

  /** Aborts the tasks, waits for requests in flight (up to the grace time), closes the server. */
  app.shutdown = async (graceMs = SHUTDOWN_GRACE_MS) => {
    log('info', 'server', 'shutting down');
    for (const hook of app.onShutdown) {
      try {
        await hook();
      } catch (e) {
        log('warn', 'server', `shutdown hook failed: ${e.message}`);
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        app.server.closeAllConnections();
        resolve();
      }, graceMs);
      timer.unref();
      app.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      app.server.closeIdleConnections();
    });
  };

  return app;
}

async function main() {
  // doTool of ask-code prints its progress (even file diffs) to stdout. That must reach neither stdout nor the log.
  process.stdout.write = (chunk, encoding, callback) => {
    (typeof encoding === 'function' ? encoding : callback)?.();
    return true;
  };

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`[ERROR] [config] ${e.message}`);
    process.exit(1);
  }
  setLogLevel(config.logLevel);
  setLogSecret(config.key);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) log('warn', 'server', `ASK_HOST=${config.host} is not a loopback address: the API has no authentication`);

  const app = createApp(config);
  let port;
  try {
    port = await app.listen();
  } catch (e) {
    log('error', 'server', `cannot listen on ${config.host}:${config.port}: ${e.message}`);
    process.exit(1);
  }
  log('info', 'server', `listening on ${config.host}:${port} root=${config.root}`);

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log('info', 'server', `${signal} received`);
    app.shutdown().then(
      () => process.exit(0),
      (e) => {
        log('error', 'server', `shutdown failed: ${e.message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
