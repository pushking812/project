// Stage 2D: GET /apps, DELETE /apps/:n, DELETE /apps — what the server and its tasks started that keeps running.
import { HttpError, sendJson } from './errors.mjs';

/**
 * One numbering for every app the server started (POST /command and the commands of /execute tasks).
 * ask-code numbers apps per Apps object; here each task has its own Apps, so a shared counter keeps the numbers unique.
 * @param {new () => {next: number}} Base the Apps class of ask-code
 * @returns {new () => object} a class whose instances all count from the same number
 */
export function sharedApps(Base) {
  const counter = { n: 1 };
  return class SharedApps extends Base {
    constructor() {
      super();
      Object.defineProperty(this, 'next', { get: () => counter.n, set: (v) => (counter.n = v), configurable: true });
    }
  };
}

/** Apps of POST /command and of the tasks that run now. @param {{route: Function, apps: object, registry: object}} app */
export function addAppRoutes(app) {
  const { route } = app;
  const pools = () => [app.apps, ...[...app.registry.tasks.values()].map((rec) => rec.ctx?.apps).filter(Boolean)];

  route('GET', /^\/apps$/, (req, res) => {
    const apps = pools().flatMap((p) => p.running().map((a) => ({ n: a.n, command: a.command, url: a.url ?? null, running: true })));
    sendJson(res, 200, { ok: true, apps: apps.sort((a, b) => a.n - b.n) });
  });

  route('DELETE', /^\/apps\/(\d+)$/, (req, res, m) => {
    if (!pools().some((p) => p.stop(Number(m[1])))) throw new HttpError(404, `there is no running app ${m[1]}`, 'not_found');
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', /^\/apps$/, (req, res) => {
    for (const p of pools()) p.stopAll();
    sendJson(res, 200, { ok: true, output: 'Stopped everything.' });
  });
}
