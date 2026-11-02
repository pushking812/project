// HTTP/SSE API around ask-code (stage 1). Listens on 127.0.0.1 only; logs to stderr.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, VERSION } from './lib/config.mjs';
import { log, setLogLevel, setLogSecret } from './lib/log.mjs';
import { HttpError, sendError, sendJson } from './lib/errors.mjs';
import { fetchMe } from './lib/ask-proxy.mjs';

const SHUTDOWN_GRACE_MS = 4_000;

/**
 * Builds the server (does not listen yet).
 * @param {ReturnType<typeof loadConfig>} config
 */
export function createApp(config) {
  /** @type {Array<[string, RegExp, (req, res, match: RegExpMatchArray) => Promise<void> | void]>} */
  const routes = [];
  const route = (method, pattern, handler) => routes.push([method, pattern, handler]);

  const app = {
    config,
    server: null,
    /** Number of tasks running now (replaced by the task registry). */
    running: () => 0,
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
      sendError(res, e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.message : 'internal error');
    });
  });

  /** @returns {Promise<number>} the port it listens on */
  app.listen = () =>
    new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, config.host, () => {
        app.server.off('error', reject);
        resolve(app.server.address().port);
      });
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
  // doTool of ask-code prints its progress with process.stdout: keep stdout free, send it to the log.
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

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
