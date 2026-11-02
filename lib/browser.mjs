// Stage 2G: POST /browser. One browser window for the whole server (like ctx.browser of ask-code), started on first use.
import { AskBrowser, SafariBrowser, BROWSER_ACTIONS, findBrowser, browserUrl, refusedUrl, siteOf, captchaOn, isLocalPage } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, modeOf, needString } from './direct.mjs';
import { log } from './log.mjs';

const ACTION_TIMEOUT_MS = 30_000;
/** Actions that only look: all that `plan` mode allows (SPEC §3.1). */
const LOOKS = new Set(['open', 'read', 'screenshot', 'scroll', 'console', 'back', 'viewport']);
/** Actions that can take the window to another page. */
const NAVIGATES = new Set(['click', 'press', 'back']);
/** Actions this build of the endpoint does. */
const SUPPORTED = new Set(['open', 'read', 'screenshot', 'close', 'click', 'type', 'press', 'scroll', 'back', 'viewport', 'console']);

/** The browser ask-code would use: Chrome/Edge/..., or Safari on a Mac without one. Tests replace it (app.makeBrowser). */
const makeBrowser = (config, { headless }) => {
  const bin = findBrowser();
  if (!bin && process.platform === 'darwin') return new SafariBrowser(config.root);
  return new AskBrowser(config.root, { bin, headless, ...(config.browserDir ? { dir: config.browserDir } : {}) });
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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

  /**
   * A captcha on the page is the person's, never Ask's. One in the way needs them now (`handoff_needed`: the client
   * calls action "handoff"); one on a form is for after the rest is filled in. On the person's own dev server it is
   * only a note about the providers' test keys.
   */
  const captchaOf = async (b) => {
    const found = captchaOn(await b.captchaSigns().catch(() => null));
    if (!found) return {};
    const { url } = await b.here();
    const local = isLocalPage(url);
    const captcha = { kind: found.kind, blocking: found.blocking, ...(local ? { local: true } : {}) };
    let note;
    if (local) note = `A captcha (${found.kind}) is on this page of the person’s own project. Don’t solve it: in development, switch the project to the provider’s official test keys, then test both the passed and the failed path.`;
    else if (found.blocking) note = `The page put up a human check (${found.kind}). Never solve it yourself: call action "handoff" so the person does.`;
    else note = `This page has a captcha (${found.kind}), not answered yet. Never solve it yourself. Fill in everything else first; when only the captcha is left, call action "handoff".`;
    return { captcha, handoff_needed: found.blocking && !local, note };
  };

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
    } else if (action === 'click') {
      if (body.selector !== undefined) args.selector = needString(body, 'selector');
      else if (isNum(body.x) && isNum(body.y)) Object.assign(args, { x: body.x, y: body.y });
      else throw new HttpError(400, 'click needs a selector (CSS, or text=Words on it) or x and y', 'bad_request');
    } else if (action === 'type') {
      if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string', 'bad_request');
      args.text = body.text;
      if (body.selector !== undefined) args.selector = needString(body, 'selector');
    } else if (action === 'press') {
      if (body.key !== undefined) args.key = needString(body, 'key');
    } else if (action === 'scroll') {
      if (body.dy !== undefined) {
        if (!isNum(body.dy)) throw new HttpError(400, 'dy must be a number', 'bad_request');
        args.dy = body.dy;
      }
    } else if (action === 'viewport') {
      // No width: back to the window's own size.
      for (const name of ['width', 'height']) {
        if (body[name] === undefined) continue;
        if (!isNum(body[name]) || body[name] < 1 || body[name] > 10_000) throw new HttpError(400, `${name} must be a number from 1 to 10000`, 'bad_request');
        args[name] = body[name];
      }
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
      if (r.private) return r;
      if (!r.ok) throw new HttpError(502, r.output, 'browser_failed');
      // A click or a key can take the window to another site: that one needs the same allow as `open`.
      if (NAVIGATES.has(action) && mode !== 'all') {
        const { url } = await b.here();
        if (!siteAllowed(url, mode, allowed)) {
          await b.act({ action: 'back' }).catch(() => {});
          throw new HttpError(403, `that step went to ${siteOf(url)}, which is not in allowedSites (mode "${mode}"): the window went back`, 'site_not_allowed');
        }
      }
      return { ...r, ...(action === 'close' ? {} : await captchaOf(b)) };
    });
    log('info', 'browser', `${action}${args.url ? ` ${args.url}` : ''}`);
    if (answer.private) {
      // Ask never types a password or a card number: the person does, in the window.
      return sendJson(res, 403, { ok: false, error: 'that field is for a password or card details: type it in the browser window yourself', code: 'private', private: true });
    }
    sendJson(res, 200, {
      ok: true,
      output: answer.output,
      ...(answer.images ? { images: answer.images } : {}),
      ...(answer.note ? { note: answer.note } : {}),
      captcha: answer.captcha ?? null,
      handoff_needed: answer.handoff_needed ?? false,
      private: false,
    });
  });

  app.onShutdown.push(async () => {
    const b = state.b;
    state.b = null;
    await b?.close?.().catch(() => {});
  });
}
