// Stage 2G: POST /browser. One browser window for the whole server (like ctx.browser of ask-code), started on first use.
import { AskBrowser, SafariBrowser, BROWSER_ACTIONS, callPerson, findBrowser, browserUrl, refusedUrl, siteOf, captchaOn, isLocalPage } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { CAPTCHA_MODES } from './config.mjs';
import { allowWrite, modeOf, needString } from './direct.mjs';
import { log } from './log.mjs';
import { openSSE, writeEvent } from './sse.mjs';

const ACTION_TIMEOUT_MS = 30_000;
/** Actions that only look: all that `plan` mode allows (SPEC §3.1). */
const LOOKS = new Set(['open', 'read', 'screenshot', 'scroll', 'console', 'back', 'viewport']);
/** Actions that can take the window to another page. */
const NAVIGATES = new Set(['click', 'press', 'back']);
/** How long the person has to finish a hand-off, and how often the page is looked at (ask-code: 8 min, 2 s). */
const HANDOFF_MS = 8 * 60_000;
const HANDOFF_POLL_MS = 2000;

/** The browser ask-code would use: Chrome/Edge/..., or Safari on a Mac without one. Tests replace it (app.makeBrowser). */
export const makeBrowser = (config, { headless }) => {
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

  /** Headless or visible: what the last request asked for, else ASK_BROWSER_HEADLESS. It stays until a request changes it. */
  const wantHeadless = () => state.headless ?? config.browserHeadless !== false;
  const ensure = () => (state.b ??= make({ headless: wantHeadless() }));
  /** Whether this window is invisible. Safari has no headless mode. */
  const isHeadless = (b) => b.kind !== 'safari' && Boolean(b.headless);

  /** `headless` of the body: true, false or absent. */
  const headlessOf = (body) => {
    if (body.headless === undefined) return undefined;
    if (typeof body.headless !== 'boolean') throw new HttpError(400, 'headless must be true or false', 'bad_request');
    return body.headless;
  };

  /** `captcha` of the body: "manual" or "handoff", else ASK_CAPTCHA. */
  const captchaModeOf = (body) => {
    if (body.captcha === undefined) return config.captcha ?? 'manual';
    if (!CAPTCHA_MODES.includes(body.captcha)) throw new HttpError(400, `captcha must be one of ${CAPTCHA_MODES.join(', ')}`, 'bad_request');
    return body.captcha;
  };

  /**
   * Makes the window headless or visible. A running window in the other mode is closed and started again on the page it
   * was on (the profile is the same folder, so what the person signed in to stays); `reopen: false` skips that page.
   * Runs inside `exclusive`.
   */
  const applyHeadless = async (want, { reopen = true } = {}) => {
    if (want === undefined) return;
    state.headless = want;
    const old = state.b;
    if (!old || old.kind === 'safari' || isHeadless(old) === want) return;
    const url = reopen ? (await old.here().catch(() => ({ url: '' }))).url : '';
    state.b = null;
    await old.close().catch(() => {});
    const b = ensure();
    try {
      if (url && url !== 'about:blank') await b.act({ action: 'open', url });
    } catch (e) {
      throw browserError(e);
    }
    log('info', 'browser', `window is ${want ? 'headless' : 'visible'} now`);
  };

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
    else if (found.blocking) note = `The page put up a human check (${found.kind}). Never solve it yourself: call action "handoff" so the person does.${isHeadless(b) ? ' The window is invisible: call it with "headless": false to show it.' : ''}`;
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
  // /watches checks a page against the same list.
  app.siteAllowed = siteAllowed;
  app.allowedOf = allowedOf;

  // What the window is now: running or not, headless or visible, and the page.
  route('GET', /^\/browser$/, async (req, res) => {
    const b = state.b;
    const url = b ? (await b.here().catch(() => ({ url: null }))).url : null;
    sendJson(res, 200, { ok: true, running: Boolean(b), headless: b ? isHeadless(b) : wantHeadless(), url, handoff: Boolean(state.handoff) });
  });

  route('POST', /^\/browser$/, async (req, res) => {
    const body = await readJson(req);
    const action = needString(body, 'action');
    if (!BROWSER_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${BROWSER_ACTIONS.join(', ')}`, 'bad_action');
    const mode = modeOf(body, config);
    if (!LOOKS.has(action) && action !== 'close') allowWrite(mode, 'browser actions other than looking');
    const args = argsOf(action, body);
    const allowed = allowedOf(body);
    // The person has the window: nothing else moves it meanwhile (closing it ends the hand-off).
    if (state.handoff && action !== 'close') throw new HttpError(409, 'the person has the browser window (a hand-off is waiting)', 'handoff_active');
    const headless = headlessOf(body);
    const captchaMode = captchaModeOf(body);
    if (action === 'handoff') return handOff(res, body, headless);

    if (action === 'open') {
      const refused = await refusedUrl(config.root, args.url);
      if (refused) throw new HttpError(403, refused, 'refused_url');
      if (!siteAllowed(args.url, mode, allowed)) throw new HttpError(403, `${siteOf(args.url)} is not in allowedSites (mode "${mode}")`, 'site_not_allowed');
    }

    const answer = await exclusive(async () => {
      if (action === 'close') {
        const b = state.b;
        state.b = null;
        if (state.handoff) state.handoff.reason = 'stopped';
        if (b) await b.close().catch(() => {});
        return { ok: true, output: b ? 'The browser window is closed. Opening a page starts it again.' : 'The browser was not running.' };
      }
      await applyHeadless(headless, { reopen: action !== 'open' });
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
    const view = {
      ok: true,
      output: answer.output,
      ...(answer.images ? { images: answer.images } : {}),
      ...(answer.note ? { note: answer.note } : {}),
      captcha: answer.captcha ?? null,
      handoff_needed: answer.handoff_needed ?? false,
      private: false,
    };
    // "captcha": "handoff": a human check in the way calls the person at once. The answer becomes an event stream:
    // `result` (the body below), then the hand-off's own `status`, `delta`, `done` or `error`.
    if (answer.handoff_needed && captchaMode === 'handoff' && mode !== 'plan' && !answer.private) {
      try {
        return await handOff(res, { text: `The page asks if you’re human (${answer.captcha.kind}). Solve it in the window.` }, false, view);
      } catch (e) {
        if (res.headersSent) throw e;
        const why = browserError(e).message;
        log('warn', 'browser', `automatic hand-off failed: ${why}`);
        return sendJson(res, 200, { ...view, note: `${view.note ?? ''} The automatic hand-off failed (${why}): call action "handoff" yourself.`.trim() });
      }
    }
    if (answer.private) {
      // Ask never types a password or a card number: the person does, in the window.
      return sendJson(res, 403, { ok: false, error: 'that field is for a password or card details: type it in the browser window yourself', code: 'private', private: true });
    }
    sendJson(res, 200, view);
  });

  /**
   * The person's turn in the window (a captcha, a password, a code from their phone). The answer is an event stream:
   * `status`, `delta` when the page changes, then `done` or `error`. It ends when the captcha on the page is answered,
   * when the person says so (POST /browser/handoff/done), after 8 minutes (`error: timeout`), or when the client leaves.
   * Needs a window the person can see: not in headless mode.
   */
  const handOff = async (res, body, headless, first) => {
    const todo = (typeof body.text === 'string' && body.text.trim()) || 'Finish this step in the window';
    // "headless": false shows an invisible window for this step (same page, same sign-ins).
    if (headless === false) {
      try {
        await exclusive(() => applyHeadless(false));
      } catch (e) {
        throw browserError(e);
      }
    }
    const b = ensure();
    if (isHeadless(b)) {
      throw new HttpError(400, 'the browser runs headless, so the person cannot see its window: send "headless": false with the hand-off, or start the server with ASK_BROWSER_HEADLESS=0', 'headless_handoff');
    }
    try {
      await exclusive(() => b.start());
    } catch (e) {
      throw browserError(e);
    }
    const hand = { reason: null, note: null };
    state.handoff = hand;
    openSSE(res);
    res.on('close', () => {
      if (!res.writableEnded) hand.reason ??= 'gone';
    });
    try {
      if (first) writeEvent(res, 'result', first);
      writeEvent(res, 'status', { state: 'waiting', todo });
      (app.notify ?? callPerson)({ site: config.site, key: config.key }, 'turn', 'Ask needs you in the browser', todo, { title: 'Ask needs you at your computer', body: todo });
      await b.front().catch(() => {});
      const watching = !!captchaOn(await b.captchaSigns().catch(() => null));
      const every = config.handoffPollMs ?? HANDOFF_POLL_MS;
      const until = Date.now() + (config.handoffMs ?? HANDOFF_MS);
      let seen = (await b.here().catch(() => ({ url: '' }))).url;
      let how = null;
      for (let clear = 0; !how; ) {
        await new Promise((r) => setTimeout(r, every));
        if (hand.reason) how = hand.reason;
        else if (hand.note !== null) how = 'said';
        else {
          const here = await b.here().catch(() => null);
          if (here && here.url !== seen) {
            seen = here.url;
            writeEvent(res, 'delta', { text: `The person went to ${here.url}\n` });
          }
          if (watching && !captchaOn(await b.captchaSigns().catch(() => null))) {
            if (++clear >= 2) how = 'done'; // answered, and still so a moment later (not a page between two)
          } else {
            clear = 0;
            if (Date.now() > until) how = 'late';
          }
        }
      }
      if (how === 'gone') return;
      if (how === 'stopped') return void writeEvent(res, 'error', { message: 'stopped' });
      if (how === 'late') return void writeEvent(res, 'error', { message: 'timeout' });
      const view = await b.act({ action: 'screenshot' }).catch(() => ({ ok: true, output: '' }));
      const head = how === 'done' ? `The person finished: ${todo}. Carry on.` : `The person says: ${hand.note || 'done'}`;
      log('info', 'browser', `handoff ${how}`);
      writeEvent(res, 'done', { answer: `${head}\n${view.output}`.trim(), how, ...(view.images ? { images: view.images } : {}) });
    } catch (e) {
      writeEvent(res, 'error', { message: browserError(e).message });
    } finally {
      state.handoff = null;
      if (!res.writableEnded) res.end();
    }
  };

  // For a hand-off with no captcha to watch (a password, a code from the phone): the person, or whoever talks to them,
  // says it is done. A note is passed on to the model.
  route('POST', /^\/browser\/handoff\/done$/, async (req, res) => {
    const body = await readJson(req);
    if (body.note !== undefined && typeof body.note !== 'string') throw new HttpError(400, 'note must be a string', 'bad_request');
    if (!state.handoff) throw new HttpError(409, 'no hand-off is waiting', 'no_handoff');
    state.handoff.note = body.note ?? '';
    sendJson(res, 200, { ok: true });
  });

  app.onShutdown.push(async () => {
    if (state.handoff) state.handoff.reason = 'stopped';
    const b = state.b;
    state.b = null;
    await b?.close?.().catch(() => {});
  });
}
