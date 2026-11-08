// The autonomous loop: /v1/code → tool calls done here with doTool → results back to the site.
import { Apps, doTool as coreDoTool, stepNote as coreStepNote, captchaOn, isLocalPage } from '../build/ask-code-core.mjs';
import { askApi, events as coreEvents, sendToolResult, stopRun } from './ask-proxy.mjs';
import { buildContext } from './context.mjs';
import { createMockInput } from './mock-input.mjs';
import { openSession, keepTurn } from './sessions.mjs';
import { log, brief } from './log.mjs';
import { makeBrowser } from './browser.mjs';
import { createOutputs } from './outputs.mjs';

const defaults = { makeBrowser, askApi, events: coreEvents, doTool: coreDoTool, stepNote: coreStepNote, sendToolResult, stopRun, buildContext, Apps, openSession, keepTurn };

/**
 * The context doTool works with, as ask-code's main() builds it: a folder, a mode, nobody to ask.
 * @param {{key: string, site: string, root: string}} config
 * @param {string} mode all | edits | plan
 * @param {string} memoryDir
 */
export function makeCtx(config, mode, memoryDir, AppsClass = Apps) {
  return {
    site: config.site,
    key: config.key,
    root: config.root,
    input: createMockInput(),
    state: { model: null, history: [], title: null, inputs: [], limits: null, mode, pictures: [], ran: [], used: { requests: 0, input: 0, output: 0 } },
    memoryDir,
    apps: new AppsClass(),
    browser: null,
    allowedSites: new Set(),
    browserAllSites: false,
  };
}

/**
 * Runs one task to the end and fills `rec` (answer, steps, usage, status, error, finishedAt). Never throws.
 * Events for `onEvent({event, data})`: status, delta, tool, usage, done, error.
 * @param {object} p
 * @param {ReturnType<import('./tasks.mjs').TaskRegistry['create']>} p.rec
 * @param {object} p.config
 * @param {(e: {event: string, data: any}) => void} [p.onEvent]
 * @param {object} [p.deps] replaceable parts, for tests
 */
export async function executeTask({ rec, config, onEvent = () => {}, deps = {} }) {
  const d = { ...defaults, ...deps };
  const emit = (event, data) => {
    try {
      onEvent({ event, data });
    } catch {}
  };
  const { signal } = rec.abort;
  const started = Date.now();
  let runId = null;
  let commandAbort = null;
  let finished = false;
  let failed = null;
  const steps = new Set();
  /** Files this task made or changed (write_file, edit_file; files a command wrote). */
  const outputs = createOutputs(config.root, { scan: config.outputScan !== false });
  /** The session this task continues (POST /execute and /start with session_id), else null: stateless. */
  let session = null;

  log('info', 'tasks', `started ${rec.id} prompt="${brief(rec.prompt)}"`);
  signal.addEventListener(
    'abort',
    () => {
      commandAbort?.abort();
      if (runId) void d.stopRun(config, runId);
    },
    { once: true },
  );

  try {
    if (rec.sessionId) session = await d.openSession(config, config.root, rec.sessionId);
    const context = await d.buildContext(config);
    const { memoryDir, ...fields } = context;
    const ctx = (rec.ctx = makeCtx(config, rec.mode, memoryDir, d.Apps));
    // "browser": true gives this task its own window (started on first use, closed when the task ends).
    // The request's "headless" wins over ASK_BROWSER_HEADLESS.
    let headless = rec.headless ?? config.browserHeadless !== false;
    // "captcha": "handoff": a human check in the way shows the window and calls the person (ask-code then waits for
    // them as usual). The person solves it; Ask never does. "manual" leaves the window as it is.
    const autoHandoff = (rec.captcha ?? config.captcha) === 'handoff';
    /** Makes `b` show its window when a captcha that needs the person comes up in an invisible one. */
    const watchCaptcha = (b) => {
      if (!autoHandoff || b.kind === 'safari') return b;
      const act = b.act.bind(b);
      b.act = async (args) => {
        const r = await act(args);
        if (!headless || !r?.ok || args?.action === 'close' || !ctx.browser || ctx.browser !== b) return r;
        const found = captchaOn(await b.captchaSigns().catch(() => null));
        if (!found?.blocking) return r;
        const { url } = await b.here().catch(() => ({ url: '' }));
        if (isLocalPage(url)) return r;
        headless = false;
        log('info', 'tasks', `${rec.id} captcha in the way: the window is visible now`);
        await b.close().catch(() => {});
        const shown = watchCaptcha(d.makeBrowser(config, { headless: false }));
        ctx.browser = shown;
        if (url && url !== 'about:blank') await shown.act({ action: 'open', url }).catch(() => {});
        return r;
      };
      return b;
    };
    if (rec.browser) {
      ctx.browser = watchCaptcha(d.makeBrowser(config, { headless }));
      for (const s of rec.allowedSites ?? []) ctx.allowedSites.add(s);
    }
    const flags = { allowAll: () => true, setAllowAll: () => {}, setCommandAbort: (a) => (commandAbort = a) };
    emit('status', { state: 'thinking' });
    let lastState = 'thinking';

    const res = await d.askApi(config, '/v1/code', {
      method: 'POST',
      body: JSON.stringify({ prompt: rec.prompt, ...(config.model ? { model: config.model } : {}), history: session?.history ?? [], ...fields, ...(rec.files?.length ? { files: rec.files } : {}), commands: true, ...(ctx.browser ? { browser: true } : {}) }),
      headers: { accept: 'text/event-stream' },
      signal,
    });

    for await (const { event, data } of d.events(res)) {
      if (event === 'status') {
        if (data.runId) {
          runId = data.runId;
          if (signal.aborted) void d.stopRun(config, runId);
        }
        if (data.state !== lastState || data.position != null) emit('status', { state: data.state, ...(data.position != null ? { position: data.position } : {}) });
        lastState = data.state;
      } else if (event === 'delta') {
        rec.answer += data.text;
        emit('delta', { text: data.text });
      } else if (event === 'tool') {
        let result;
        await outputs.before(data.name).catch(() => {});
        try {
          if (rec.browser && data.name === 'browser' && data.input?.action === 'handoff' && headless && ctx.browser?.kind !== 'safari') {
            // Nobody can see a headless window: waiting for a person would only run into the 8-minute limit.
            result = { ok: false, output: 'The browser runs headless, so the person cannot see its window. Tell them what needs doing by hand and stop here. (A hand-off needs a visible window: the request must say "headless": false, or the server must run with ASK_BROWSER_HEADLESS=0.)' };
          } else result = await d.doTool(ctx, data, flags);
        } catch (e) {
          result = { ok: false, output: `That didn’t work: ${e.message}` };
        }
        commandAbort = null;
        const note = d.stepNote(data.name, data.input ?? {}, result);
        if (note) steps.add(note);
        rec.steps = [...steps];
        await outputs.after(data.name, data.input ?? {}, result, note).catch(() => {});
        rec.outputFiles = outputs.list();
        log('debug', 'tasks', `${rec.id} tool ${data.name} ok=${result.ok}`);
        // Only the path goes along (never contents or commands), so a client can show which file was touched.
        const shownPath = typeof data.input?.path === 'string' && data.input.path.trim() ? data.input.path.trim().slice(0, 200) : null;
        emit('tool', { name: data.name, ok: Boolean(result.ok), callId: String(data.callId), ...(shownPath ? { path: shownPath } : {}) });
        if (signal.aborted) break;
        try {
          await d.sendToolResult(config, data.runId, data.callId, result, signal);
        } catch (e) {
          if (!signal.aborted) log('warn', 'tasks', `${rec.id} could not send the result of ${data.name}: ${e.message}`);
        }
      } else if (event === 'usage') {
        rec.usage = { input: data.input ?? 0, output: data.output ?? 0 };
        emit('usage', rec.usage);
      } else if (event === 'done') finished = true;
      else if (event === 'error') failed = data.message || 'ask failed';
    }
    if (!signal.aborted && !finished && !failed) failed = 'the connection to ask dropped before the task finished';
  } catch (e) {
    if (!signal.aborted) {
      failed = e?.message || 'failed';
      if (e?.status) log('error', 'ask', `/v1/code failed: ${e.status} ${brief(e.message, 80)}`);
    }
  } finally {
    try {
      rec.ctx?.apps.stopAll();
    } catch {}
    await rec.ctx?.browser?.close?.().catch(() => {});
  }

  rec.steps = [...steps];
  rec.outputFiles = outputs.list();
  // The request joins the session's saved task (also when stopped or cut off, as in ask-code), then the session is free.
  let kept = null;
  try {
    if (session) kept = await d.keepTurn(config, config.root, session, { prompt: rec.prompt, answer: rec.answer, steps: rec.steps, outcome: signal.aborted ? 'stopped' : failed ? 'cut' : 'done' });
  } finally {
    rec.release?.();
  }
  if (rec.status !== 'running') {
    // /stop already marked the task stopped (the loop was stuck in a tool that cannot be cancelled).
    log('info', 'tasks', `late end of ${rec.id}, already ${rec.status}`);
    return rec;
  }
  if (kept) emit('session', kept);
  rec.finishedAt = new Date().toISOString();
  if (signal.aborted) {
    rec.status = 'stopped';
    emit('error', { message: 'stopped' });
  } else if (failed) {
    rec.status = 'error';
    rec.error = failed;
    emit('error', { message: failed });
  } else {
    rec.status = 'done';
    emit('done', { steps: rec.steps, answer: rec.answer, ...(rec.outputFiles.length ? { output_files: rec.outputFiles } : {}) });
  }
  log(rec.status === 'error' ? 'warn' : 'info', 'tasks', `finished ${rec.id} status=${rec.status} duration=${((Date.now() - started) / 1000).toFixed(1)}s`);
  return rec;
}
