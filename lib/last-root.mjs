// Stage 3: the server remembers the last folder POST /workspace set, and starts in it again (unless ASK_ROOT is set).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTarget, defaultAllowedRoots, realOf } from './workspace.mjs';

/** ASK_ROOT_FILE, else %APPDATA%\ask-code\last-root.json (Windows) or ~/.config/ask-code/last-root.json. */
export function rootFile(env = process.env, platform = process.platform, home = homedir()) {
  if (env.ASK_ROOT_FILE) return env.ASK_ROOT_FILE;
  const base = platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming') : join(home, '.config');
  return join(base, 'ask-code', 'last-root.json');
}

/** Off with ASK_REMEMBER_ROOT=0, and when ASK_ROOT is set (an explicit root wins). */
export function rememberRootOn(env = process.env) {
  return !/^(0|false|no|off)$/i.test(env.ASK_REMEMBER_ROOT ?? '1') && !env.ASK_ROOT;
}

/** The saved root, or undefined (no file, broken file). */
export function loadLastRoot(file) {
  try {
    const root = JSON.parse(readFileSync(file, 'utf8')).root;
    return typeof root === 'string' && root ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the root. Never throws: a failure only means the next start is in the default folder. */
export function saveLastRoot(file, root) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ root }), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved root if it may still be a root (same checks as POST /workspace), else undefined.
 * @returns {string | undefined}
 */
export function restorableRoot(file, config, { home = homedir(), platform = process.platform } = {}) {
  const saved = loadLastRoot(file);
  if (!saved) return undefined;
  const target = realOf(saved);
  const allowedRoots = config.allowedRoots ?? defaultAllowedRoots({ home, root: config.root, platform });
  try {
    checkTarget(target, { allowedRoots, home, platform });
    return target;
  } catch {
    return undefined;
  }
}
