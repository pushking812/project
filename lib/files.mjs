// Stage 2A: files and commands, done directly (no model): /read /list /search /write /edit /command.
import { runReadTool, planChange, applyChange, lineDiff, runCommand, touchesSecret, hasControl, Refused } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, modeOf, needString, optInt, optString, refusal, refusing } from './direct.mjs';
import { log, brief } from './log.mjs';

const DIFF_LINES = 120;
const COMMAND_DEFAULT_SEC = 120;
const COMMAND_MAX_SEC = 600;

/**
 * Registers the stage 2A endpoints.
 * @param {{config: object, route: Function, apps: object}} app
 */
export function addFileRoutes(app) {
  const { config, route } = app;

  /** Runs a read tool of ask-code; a failure becomes the matching HTTP error. */
  const readTool = async (res, name, input) => {
    const r = await runReadTool(config.root, name, input);
    if (!r.ok) throw refusal(r.output);
    sendJson(res, 200, r);
  };

  route('POST', /^\/read$/, async (req, res) => {
    const body = await readJson(req);
    const path = needString(body, 'path');
    await readTool(res, 'read_file', { path, offset: optInt(body, 'offset'), limit: optInt(body, 'limit') });
  });

  route('POST', /^\/list$/, async (req, res) => {
    const body = await readJson(req);
    await readTool(res, 'list_files', { path: optString(body, 'path') ?? '', depth: optInt(body, 'depth') });
  });

  route('POST', /^\/search$/, async (req, res) => {
    const body = await readJson(req);
    const pattern = needString(body, 'pattern');
    if (body.regex !== undefined && typeof body.regex !== 'boolean') throw new HttpError(400, 'regex must be true or false', 'bad_request');
    await readTool(res, 'search', { pattern, path: optString(body, 'path') ?? '', regex: body.regex === true });
  });

  /** write_file / edit_file: plan, check, apply. Answers with the diff (at most 120 lines). */
  const change = async (req, res, name) => {
    const body = await readJson(req);
    const path = needString(body, 'path');
    const input = { path };
    if (name === 'write_file') {
      if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string', 'bad_request');
      if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') throw new HttpError(400, 'overwrite must be true or false', 'bad_request');
      input.content = body.content;
    } else {
      input.old_text = needString(body, 'old_text');
      if (typeof body.new_text !== 'string') throw new HttpError(400, 'new_text must be a string', 'bad_request');
      input.new_text = body.new_text;
    }
    allowWrite(modeOf(body, config), 'changing files');
    const planned = await refusing(() => planChange(config.root, name, input), Refused);
    if (name === 'write_file' && body.overwrite === false && planned.before !== null) throw new HttpError(409, `${planned.rel} already exists`, 'exists');
    const done = await applyChange(planned, name);
    const diff = lineDiff(planned.before, planned.after);
    log('info', 'files', `${name} ${planned.rel}`);
    sendJson(res, 200, { ok: true, output: done.output, shown: done.shown, diff: diff.slice(0, DIFF_LINES), ...(diff.length > DIFF_LINES ? { diffTruncated: diff.length } : {}) });
  };

  route('POST', /^\/write$/, (req, res) => change(req, res, 'write_file'));
  route('POST', /^\/edit$/, (req, res) => change(req, res, 'edit_file'));

  route('POST', /^\/command$/, async (req, res) => {
    const body = await readJson(req);
    const command = needString(body, 'command');
    let seconds = COMMAND_DEFAULT_SEC;
    if (body.timeout_sec !== undefined) {
      if (typeof body.timeout_sec !== 'number' || !(body.timeout_sec > 0)) throw new HttpError(400, 'timeout_sec must be a positive number', 'bad_request');
      seconds = Math.min(body.timeout_sec, COMMAND_MAX_SEC);
    }
    const mode = modeOf(body, config);
    if (hasControl(command)) throw new HttpError(400, 'the command has hidden control characters: use plain text only', 'control_chars');
    allowWrite(mode, 'running commands');
    if (touchesSecret(command)) throw new HttpError(403, 'the command names a private file (.env, a key), so it is not run', 'secret_command');

    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) aborter.abort();
    });
    log('info', 'files', `command ${brief(command, 80)}`);
    // On Windows ask-code stops only the shell at the timeout; a child that holds the output open keeps runCommand
    // waiting. So the answer does not wait longer than the timeout plus a short grace.
    let late;
    const deadline = new Promise((resolve) => {
      late = setTimeout(() => resolve({ status: '(stopped after timeout)', output: '', shown: '' }), /&\s*$/.test(command) ? 12_000 : seconds * 1000 + 2000);
    });
    const r = await Promise.race([runCommand(config.root, { command, timeout_sec: seconds }, { apps: app.apps, signal: aborter.signal }), deadline]);
    clearTimeout(late);
    if (res.destroyed) return;
    const { output, shown, status, code, app: appN, url, ok } = r;
    if (status?.startsWith('(stopped after')) {
      sendJson(res, 408, { ok: false, error: `the command did not end in ${seconds} s`, code: 'timeout', output, shown });
    } else sendJson(res, 200, { ok, output, shown, code, ...(appN ? { app: appN, url } : {}) });
  });
}
