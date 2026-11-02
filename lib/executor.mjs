// The autonomous loop: /v1/code → tool calls done here with doTool → results back to the site.
import { Apps, doTool as coreDoTool, stepNote as coreStepNote } from '../build/ask-code-core.mjs';
import { askApi, events as coreEvents, sendToolResult, stopRun } from './ask-proxy.mjs';
import { buildContext } from './context.mjs';
import { createMockInput } from './mock-input.mjs';
import { log, brief } from './log.mjs';

const defaults = { askApi, events: coreEvents, doTool: coreDoTool, stepNote: coreStepNote, sendToolResult, stopRun, buildContext, Apps };

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
    const context = await d.buildContext(config);
    const { memoryDir, ...fields } = context;
    const ctx = (rec.ctx = makeCtx(config, rec.mode, memoryDir, d.Apps));
    const flags = { allowAll: () => true, setAllowAll: () => {}, setCommandAbort: (a) => (commandAbort = a) };
    emit('status', { state: 'thinking' });

    const res = await d.askApi(config, '/v1/code', {
      method: 'POST',
      body: JSON.stringify({ prompt: rec.prompt, history: [], ...fields, commands: true }),
      headers: { accept: 'text/event-stream' },
      signal,
    });

    for await (const { event, data } of d.events(res)) {
      if (event === 'status') {
        if (data.runId) {
          runId = data.runId;
          if (signal.aborted) void d.stopRun(config, runId);
        }
        emit('status', { state: data.state, ...(data.position != null ? { position: data.position } : {}) });
      } else if (event === 'delta') {
        rec.answer += data.text;
        emit('delta', { text: data.text });
      } else if (event === 'tool') {
        let result;
        try {
          result = await d.doTool(ctx, data, flags);
        } catch (e) {
          result = { ok: false, output: `That didn’t work: ${e.message}` };
        }
        commandAbort = null;
        const note = d.stepNote(data.name, data.input ?? {}, result);
        if (note) steps.add(note);
        rec.steps = [...steps];
        log('debug', 'tasks', `${rec.id} tool ${data.name} ok=${result.ok}`);
        emit('tool', { name: data.name, ok: Boolean(result.ok), callId: String(data.callId) });
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
    emit('done', { steps: rec.steps, answer: rec.answer });
  }
  log(rec.status === 'error' ? 'warn' : 'info', 'tasks', `finished ${rec.id} status=${rec.status} duration=${((Date.now() - started) / 1000).toFixed(1)}s`);
  return rec;
}
