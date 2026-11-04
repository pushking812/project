// Stage 3A: GET /workspace, POST /workspace — the folder the server works in, changed while it runs.
import { homedir } from 'node:os';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { allowWrite, modeOf } from './direct.mjs';
import { listSessions } from './sessions.mjs';
import { log } from './log.mjs';
import { cleanPath, targetOf, checkTarget, samePath, defaultAllowedRoots, realOf } from './workspace.mjs';

/**
 * Whatever holds the root (the browser window, watches, apps) registers in `app.onWorkspaceChange`, a hook like the
 * ones of `app.onShutdown`: it gets `{from, to}` after `config.root` has changed and must let go of the old folder.
 * @param {{config: object, route: Function, registry: object, running: () => number, onWorkspaceChange: Function[]}} app
 */
export function addWorkspaceRoutes(app) {
  const { config, route } = app;
  const startRoot = config.root;
  const platform = () => config.platform ?? process.platform;
  const home = () => config.userHome ?? homedir();
  const allowedRoots = () => config.allowedRoots ?? defaultAllowedRoots({ home: home(), root: startRoot, platform: platform() });
  const currentSession = async () => (await listSessions(config, config.root).catch(() => [])).find((s) => s.current)?.id ?? null;
  let changing = false;

  route('GET', /^\/workspace$/, async (req, res) => {
    sendJson(res, 200, { ok: true, root: config.root, allowedRoots: allowedRoots(), sessionId: await currentSession() });
  });

  route('POST', /^\/workspace$/, async (req, res) => {
    const body = await readJson(req);
    const path = cleanPath(body.path); // 400 invalid_path
    allowWrite(modeOf(body, config), 'changing the workspace'); // 403 plan_mode
    const from = config.root;
    const target = targetOf(path, from, { platform: platform() });
    if (samePath(target, realOf(from), platform()) || samePath(target, from, platform())) {
      return sendJson(res, 200, { ok: true, root: from, changed: false, already_current: true, sessionId: await currentSession() });
    }
    checkTarget(target, { allowedRoots: allowedRoots(), home: home(), platform: platform() }); // 403 system_path, home_forbidden, not_allowed; 404
    if (changing) throw new HttpError(409, 'the workspace is being changed', 'tasks_running');
    if (app.running() > 0) throw new HttpError(409, `${app.running()} task(s) are running: wait for them or stop them first`, 'tasks_running');

    const busy = app.activeRequests?.() ?? 0;
    if (busy > 0) throw new HttpError(409, `${busy} request(s) (/ask, /browser, /compact) are in flight: wait for them first`, 'tasks_running');

    changing = true;
    try {
      config.root = target;
      log('info', 'workspace', `root changed: ${from} → ${target} (by request)`);
      for (const hook of app.onWorkspaceChange) {
        try {
          await hook({ from, to: target });
        } catch (e) {
          log('warn', 'workspace', `cleanup after the change failed: ${e.message}`);
        }
      }
    } finally {
      changing = false;
    }
    sendJson(res, 200, { ok: true, root: target, changed: true, sessionId: await currentSession() });
  });
}
