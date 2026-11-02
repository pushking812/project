// Stage 2G: POST /browser. One browser window for the whole server (like ctx.browser of ask-code), started on first use.
import { AskBrowser, SafariBrowser, BROWSER_ACTIONS, findBrowser, browserUrl, refusedUrl, siteOf } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, modeOf, needString } from './direct.mjs';
import { log } from './log.mjs';

const ACTION_TIMEOUT_MS = 30_000;
/** Actions that only look: all that `plan` mode allows (SPEC §3.1). */
const LOOKS = new Set(['open', 'read', 'screenshot', 'scroll', 'console', 'back', 'viewport']);
/** Actions this build of the endpoint does. */
const SUPPORTED = new Set(['open', 'read', 'screenshot', 'close']);

/** The browser ask-code would use: Chrome/Edge/..., or Safari on a Mac without one. Tests replace it (app.makeBrowser). */
const makeBrowser = (config, { headless }) => {
  const bin = findBrowser();
  if (!bin && process.platform === 'darwin') return new SafariBrowser(config.root);
  return new AskBrowser(config.root, { bin, headless, ...(config.browserDir ? { dir: config.browserDir } : {}) });
};

/** A failure of the browser as an HttpError. */
function browserError(e) {
  if (e instanceof HttpError) return e;
  const m = String(e?.message ?? e);
  if (/Nothing on the page matches/.test(m)) return new HttpError(404, m, 'not_found');
  if (/didn’t answer/.test(m)) return new HttpError(504, m, 'timeout');
  if (/no Chrome, Edge|Node 22/.test(m)) return new HttpError(502, m, 'no_browser');
  return new HttpError(502, m, 'browser_failed');
}

/**
 * Registers POST /browser and closes the window when the server stops.
 * @param {{config: object, route: Function, onShutdown: Function[], makeBrowser?: Function}} app
 */
export function addBrowserRoutes(app) {
  const { config, route } = app;
  const state = {
    /** The window, or null while it is not started. */
    b: null,
    /** Steps run one at a time. */
    queue: Promise.resolve(),
  };
  app.browserState = state;
  const make = (opts) => (app.makeBrowser ?? makeBrowser)(config, opts);

  const ensure = () => (state.b ??= make({ headless: config.browserHeadless !== false }));

  /** Runs `fn` after the steps before it; 504 when it takes longer than 30 s (the step itself may still end later). */
  const exclusive = (fn) => {
    const run = state.queue.then(() => {
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(504, `the browser did not finish in ${ACTION_TIMEOUT_MS / 1000} s`, 'timeout')), ACTION_TIMEOUT_MS);
      });
      return Promise.race([fn(), late]).finally(() => clearTimeout(timer));
    });
    state.queue = run.catch(() => {});
    return run;
  };

  /** Fields of the body that the action needs. Returns the arguments for AskBrowser.act. */
  const argsOf = (action, body) => {
    const args = { action };
    if (action === 'open') {
      const url = browserUrl(needString(body, 'url'));
      if (!url) throw new HttpError(400, 'url is not a web address', 'bad_request');
      args.url = url;
    }
    return args;
  };

  /** `allowedSites` of the body: hosts that open without mode=all. A host also covers its subdomains. */
  const allowedOf = (body) => {
    if (body.allowedSites === undefined) return [];
    if (!Array.isArray(body.allowedSites) || body.allowedSites.some((s) => typeof s !== 'string')) throw new HttpError(400, 'allowedSites must be a list of host names', 'bad_request');
    return body.allowedSites.map((s) => s.trim().toLowerCase()).filter(Boolean);
  };
  const siteAllowed = (url, mode, allowed) => {
    const site = siteOf(url);
    if (!site || mode === 'all') return true;
    const hostname = site.replace(/:\d+$/, '');
    return allowed.some((a) => a === site || a === hostname || hostname.endsWith(`.${a}`));
  };

  route('POST', /^\/browser$/, async (req, res) => {
    const body = await readJson(req);
    const action = needString(body, 'action');
    if (!BROWSER_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${BROWSER_ACTIONS.join(', ')}`, 'bad_action');
    if (!SUPPORTED.has(action)) throw new HttpError(400, `action "${action}" is not available yet`, 'not_supported');
    const mode = modeOf(body, config);
    if (!LOOKS.has(action) && action !== 'close') allowWrite(mode, 'browser actions other than looking');
    const args = argsOf(action, body);
    const allowed = allowedOf(body);

    if (action === 'open') {
      const refused = await refusedUrl(config.root, args.url);
      if (refused) throw new HttpError(403, refused, 'refused_url');
      if (!siteAllowed(args.url, mode, allowed)) throw new HttpError(403, `${siteOf(args.url)} is not in allowedSites (mode "${mode}")`, 'site_not_allowed');
    }

    const answer = await exclusive(async () => {
      if (action === 'close') {
        const b = state.b;
        state.b = null;
        if (b) await b.close().catch(() => {});
        return { ok: true, output: b ? 'The browser window is closed. Opening a page starts it again.' : 'The browser was not running.' };
      }
      const b = ensure();
      let r;
      try {
        r = await b.act(args);
      } catch (e) {
        if (b.cdp?.closed) state.b = null; // the window was closed by hand: the next step starts a new one
        throw browserError(e);
      }
      if (!r.ok) throw new HttpError(502, r.output, 'browser_failed');
      return r;
    });
    log('info', 'browser', `${action}${args.url ? ` ${args.url}` : ''}`);
    sendJson(res, 200, { ok: true, output: answer.output, ...(answer.images ? { images: answer.images } : {}) });
  });

  app.onShutdown.push(async () => {
    const b = state.b;
    state.b = null;
    await b?.close?.().catch(() => {});
  });
}
