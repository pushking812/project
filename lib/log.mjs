// Logging to stderr only: stdout is not for logs. Format: [LEVEL] [module] message
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;
let secret = '';

/** @param {string} level debug | info | warn | error */
export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

/** The API key is never written to the log: any occurrence of it is masked. */
export function setLogSecret(value) {
  secret = String(value ?? '');
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} module short name of the part of the server, like "server" or "tasks"
 * @param {string} message
 */
export function log(level, module, message) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  let text = String(message).replace(/[\r\n]+/g, ' ');
  if (secret.length >= 4) text = text.split(secret).join('***');
  console.error(`[${level.toUpperCase()}] [${module}] ${text}`);
}

/** A prompt in the log is cut short; its full text is never logged. */
export const brief = (text, max = 100) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
