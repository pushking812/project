// Stage 2D: GET/POST/DELETE /watches (a page or a command checked on a timer, like /watch of ask-code).
import { Watches, parseWatch, refusedUrl, siteOf } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, modeOf, needString } from './direct.mjs';
import { log, brief } from './log.mjs';


const watchView = (w) => ({ id: w.id, target: w.target, url: w.url, everyMs: w.everyMs, checks: w.checks, alerts: w.alerts, wanted: w.wanted, error: w.error });

/**
 * @param {{config: object, route: Function, onShutdown: Function[], apps: object, registry: object, browserState: {b: object|null}, siteAllowed: Function, allowedOf: Function}} app
 */
export function addWatchRoutes(app) {
  const { config, route } = app;
  /** What the checks of ask-code work with: a folder, the keys for calling the person, and the server's browser window. */
  const ctx = {
    root: config.root,
    site: config.site,
    key: config.key,
    get browser() {
      return app.browserState.b;
    },
  };
  /** Made on the first use, as in ask-code. */
  let watches = null;
  const ensure = () => (watches ??= new Watches(ctx));

  route('GET', /^\/watches$/, (req, res) => {
    sendJson(res, 200, { ok: true, watches: (watches?.list ?? []).map(watchView) });
  });

  route('POST', /^\/watches$/, async (req, res) => {
    const body = await readJson(req);
    const text = needString(body, 'spec');
    const mode = modeOf(body, config);
    const spec = parseWatch(text);
    if (!spec) throw new HttpError(400, 'spec must name a page or a command, like: https://example.com every 5m for "available"', 'bad_spec');
    if (spec.url) {
      const refused = await refusedUrl(config.root, spec.url);
      if (refused) throw new HttpError(403, refused, 'refused_url');
      if (!app.browserState.b) {
        throw new HttpError(400, 'the browser is off: open a page first (POST /browser {"action":"open"}), then start the watch', 'browser_off');
      }
      if (!app.siteAllowed(spec.url, mode, app.allowedOf(body))) throw new HttpError(403, `${siteOf(spec.url)} is not in allowedSites (mode "${mode}")`, 'site_not_allowed');
    } else {
      // A command that runs on every check: the same as running commands.
      allowWrite(mode, 'watching a command');
    }
    const w = await ensure().add(spec);
    log('info', 'watches', `watch ${w.id} ${brief(w.target, 60)} every ${Math.round(w.everyMs / 1000)}s`);
    sendJson(res, 200, { ok: true, id: w.id, target: w.target, everyMs: w.everyMs, wanted: w.wanted, checks: w.checks, error: w.error });
  });

  route('DELETE', /^\/watches\/(\d+)$/, (req, res, m) => {
    if (!watches?.stop(Number(m[1]))) throw new HttpError(404, `there is no watch ${m[1]}`, 'not_found');
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', /^\/watches$/, (req, res) => {
    watches?.stopAll();
    sendJson(res, 200, { ok: true, output: 'All watches stopped.' });
  });

  app.onShutdown.push(() => watches?.stopAll());
}
