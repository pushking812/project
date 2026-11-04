// Stage 3B: which files a task made or changed (`output_files` of /execute, `outputFiles` of /status).
// Two sources: write_file / edit_file (known from the call) and run_command (a script can write a .xlsx or .docx:
// the folder is compared before and after the command).
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';

/** Folders a scan never enters: they change on every install or build and are not what the person asked for. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', 'target', 'venv', '.venv']);
/** A scan looks at this many files at most; a bigger folder is only partly seen (`truncated`). */
export const SCAN_LIMIT = 5000;
/** At most this many output files are named in an answer. */
export const OUTPUT_LIMIT = 100;

/**
 * The path of a file as the answer names it: relative to the root, with "/". null when it is outside the root.
 * @param {string} root
 * @param {unknown} p a path from a tool call (relative or absolute)
 */
export function relPath(root, p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  const rel = relative(resolve(root), resolve(root, p));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Every file under `root` with a mark that changes when the file does (size and modification time).
 * Folders that start with "." and the ones in SKIP_DIRS are not entered.
 * @returns {Promise<{files: Map<string, string>, truncated: boolean}>}
 */
export async function snapshot(root, limit = SCAN_LIMIT) {
  const files = new Map();
  let truncated = false;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (files.size >= limit) {
          truncated = true;
          return;
        }
        try {
          const s = await stat(full);
          files.set(relative(root, full).split(sep).join('/'), `${s.size}:${Math.round(s.mtimeMs)}`);
        } catch {}
      }
    }
  };
  await walk(root);
  return { files, truncated };
}

/** Files that are new or changed in `after` compared with `before`. */
export function changedFiles(before, after) {
  const out = [];
  for (const [rel, mark] of after) if (before.get(rel) !== mark) out.push(rel);
  return out;
}

/**
 * Collects the output files of one task.
 * @param {string} root
 * @param {{scan?: boolean}} [opts] scan: false turns the before/after comparison for run_command off
 */
export function createOutputs(root, { scan = true } = {}) {
  /** Files in the order they were first made or changed. */
  const names = new Set();
  let last = null;
  const add = (rel) => {
    if (rel && names.size < OUTPUT_LIMIT) names.add(rel);
  };
  return {
    /** Call before a tool runs. Takes the picture of the folder before the first command. */
    async before(name) {
      if (name === 'run_command' && scan && !last) last = await snapshot(root).catch(() => null);
    },
    /**
     * Call after a tool ran.
     * @param {string} name tool name
     * @param {any} args the tool's input
     * @param {{ok?: boolean}} result
     * @param {string|null} note the step note ("remembered …" marks Ask's own memory, which is not a project file)
     */
    async after(name, args, result, note) {
      if ((name === 'write_file' || name === 'edit_file') && result?.ok) {
        if (!String(note ?? '').startsWith('remembered')) add(relPath(root, args?.path));
      } else if (name === 'run_command' && scan && last) {
        const now = await snapshot(root).catch(() => null);
        if (!now) return;
        // A folder too big to see in full gives no verdict: the picture would be partial and name files by chance.
        if (!now.truncated && !last.truncated) for (const rel of changedFiles(last.files, now.files)) add(rel);
        last = now;
      }
    },
    /** The names, without files that are gone by now (a script may delete its own scratch file). */
    list() {
      return [...names].filter((rel) => existsSync(join(root, rel)));
    },
  };
}
