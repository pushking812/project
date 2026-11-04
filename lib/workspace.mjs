// Stage 3A: which folder may become the server's root (POST /workspace). Pure checks, no routes: lib/workspace-routes.mjs.
// Order of the checks (SPEC stage 3, decisions-stage3.md): 400 invalid_path, 403 plan_mode (the route), 403 system_path,
// 403 home_forbidden, 403 not_allowed, 404 not_found, 409 tasks_running (the route).
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32, posix } from 'node:path';
import { HttpError } from './errors.mjs';

const lib = (platform) => (platform === 'win32' ? win32 : posix);
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The real path (symbolic links followed, on Windows the true spelling), or the path itself when it is not there. */
export function realOf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Whether `child` is `parent` or lies inside it. */
export function isInside(child, parent, platform = process.platform) {
  const P = lib(platform);
  const rel = P.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel));
}

export function samePath(a, b, platform = process.platform) {
  const P = lib(platform);
  const [x, y] = [P.resolve(a), P.resolve(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** `/` or `C:\`. */
export function isDriveRoot(p, platform = process.platform) {
  const P = lib(platform);
  const n = P.resolve(p);
  return P.parse(n).root === n;
}

/** Folders that never become a root, with everything inside them. The root of a drive is refused on its own. */
export function systemRoots(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    return [env.SystemRoot || env.windir || `${drive}\\Windows`, env.ProgramFiles || `${drive}\\Program Files`, env['ProgramFiles(x86)'] || `${drive}\\Program Files (x86)`, env.ProgramW6432, env.ProgramData || `${drive}\\ProgramData`].filter(Boolean);
  }
  return ['/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/lib', '/lib32', '/lib64', '/dev', '/proc', '/sys'];
}

/** Folders that are refused only themselves: their subfolders (/var/www/site, C:\ProgramData\app) go on to the allowlist check. */
export function softSystemRoots(platform = process.platform, env = process.env) {
  if (platform === 'win32') return [env.ProgramData || `${env.SystemDrive || 'C:'}\\ProgramData`];
  return ['/var'];
}

export function isSystemPath(p, platform = process.platform, env = process.env) {
  const P = lib(platform);
  if (isDriveRoot(p, platform)) return true;
  const soft = softSystemRoots(platform, env).map((s) => P.resolve(s));
  if (soft.some((s) => samePath(p, s, platform))) return true;
  return systemRoots(platform, env).filter((s) => !soft.some((x) => samePath(s, x, platform))).some((s) => isInside(p, P.resolve(s), platform));
}

/** What a root may be without ASK_ALLOWED_ROOTS: the home folder (subfolders only), and ASK_ROOT when it is outside it. */
export function defaultAllowedRoots({ home = homedir(), root, platform = process.platform }) {
  return root && !isInside(root, home, platform) ? [home, root] : [home];
}

/**
 * ASK_ALLOWED_ROOTS: folders separated by `;` (Windows) or `:`. Throws an Error that loadConfig shows before exit(1).
 * @returns {string[] | undefined} undefined when the variable is empty (the default applies)
 */
export function parseAllowedRoots(raw, { home = homedir(), platform = process.platform, real = realOf, cwd = process.cwd() } = {}) {
  if (raw === undefined || !String(raw).trim()) return undefined;
  const P = lib(platform);
  const out = [];
  for (const part of String(raw).split(platform === 'win32' ? ';' : ':')) {
    const item = part.trim();
    if (!item) continue;
    if (!P.isAbsolute(item)) throw new Error(`ASK_ALLOWED_ROOTS: "${item}" is not an absolute path`);
    const dir = P.resolve(cwd, real(P.resolve(item)));
    if (isDriveRoot(dir, platform)) throw new Error(`ASK_ALLOWED_ROOTS must not contain the root of a drive ("${item}")`);
    if (samePath(dir, real(home), platform) || samePath(dir, home, platform)) throw new Error(`ASK_ALLOWED_ROOTS must not contain the home folder itself ("${item}"): list its subfolders`);
    if (isSystemPath(dir, platform)) throw new Error(`ASK_ALLOWED_ROOTS must not contain a system folder ("${item}")`);
    if (!out.some((o) => samePath(o, dir, platform))) out.push(dir);
  }
  return out.length ? out : undefined;
}

/** 400 invalid_path: the path must be a non-empty string without control characters. @throws {HttpError} */
export function cleanPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'path must be a non-empty string', 'invalid_path');
  if (CONTROL.test(raw)) throw new HttpError(400, 'path must not contain control characters', 'invalid_path');
  return raw.trim();
}

/** The real path `raw` leads to, relative paths counted from the current root. */
export function targetOf(raw, from, { platform = process.platform, real = realOf } = {}) {
  return real(lib(platform).resolve(from, raw));
}

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 403 system_path, 403 home_forbidden, 403 not_allowed, 404 not_found — in this order.
 * @param {string} target the real path (targetOf)
 * @param {{allowedRoots: string[], home?: string, platform?: string, env?: object, real?: Function, isDir?: Function}} o
 * @throws {HttpError}
 */
export function checkTarget(target, { allowedRoots, home = homedir(), platform = process.platform, env = process.env, real = realOf, isDir = isDirectory }) {
  if (isSystemPath(target, platform, env)) throw new HttpError(403, `${target} is a system folder and cannot be the workspace`, 'system_path');
  if (samePath(target, home, platform) || samePath(target, real(home), platform)) {
    throw new HttpError(403, 'the home folder itself cannot be the workspace: choose a folder inside it', 'home_forbidden');
  }
  if (!allowedRoots.some((a) => isInside(target, a, platform))) throw new HttpError(403, `${target} is outside ASK_ALLOWED_ROOTS`, 'not_allowed');
  if (!isDir(target)) throw new HttpError(404, `${target} does not exist or is not a folder`, 'not_found');
}
