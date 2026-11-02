import { resolve } from 'node:path';

export const VERSION = '0.1.0';
export const MODES = ['all', 'edits', 'plan'];
export const CAPTCHA_MODES = ['manual', 'handoff'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const int = (name, raw, fallback, { min, max }) => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  return n;
};

/**
 * Reads the settings from the environment (SPEC §6.1). Throws a readable Error when one is wrong.
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const key = (env.ASK_KEY ?? '').trim();
  if (!key) throw new Error('ASK_KEY is not set: put the ask API key in the environment');

  const site = (env.ASK_SITE || 'https://ask.oryxml.com').replace(/\/+$/, '');
  // Same rule as ask-code: the key travels in the clear only to this computer itself.
  if (!/^https:\/\//.test(site) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(site)) {
    throw new Error('ASK_SITE must start with https:// (http:// only for localhost)');
  }

  const mode = env.ASK_MODE || 'all';
  if (!MODES.includes(mode)) throw new Error(`ASK_MODE must be one of ${MODES.join(', ')}, got "${mode}"`);

  const logLevel = env.ASK_LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`ASK_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${logLevel}"`);

  const captcha = (env.ASK_CAPTCHA || 'manual').toLowerCase();
  if (!CAPTCHA_MODES.includes(captcha)) throw new Error(`ASK_CAPTCHA must be one of ${CAPTCHA_MODES.join(', ')}, got "${env.ASK_CAPTCHA}"`);

  return {
    key,
    site,
    root: resolve(cwd, env.ASK_ROOT || '.'),
    host: env.ASK_HOST || '127.0.0.1',
    port: int('ASK_PORT', env.ASK_PORT, 8737, { min: 0, max: 65535 }),
    mode,
    maxParallel: int('ASK_MAX_PARALLEL', env.ASK_MAX_PARALLEL, 3, { min: 1, max: 100 }),
    logLevel,
    // Stage 2G: the browser of POST /browser. Headless by default (nobody sits in front of a server's window).
    browserHeadless: !/^(0|false|no|off)$/i.test(env.ASK_BROWSER_HEADLESS ?? '1'),
    // What a captcha in the way does: "manual" tells the client (handoff_needed), "handoff" calls the person at once.
    captcha,
    browserDir: env.ASK_BROWSER_DIR ? resolve(cwd, env.ASK_BROWSER_DIR) : undefined,
  };
}
