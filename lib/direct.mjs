// Helpers shared by the stage 2 endpoints that act directly (no model in between).
import { HttpError } from './errors.mjs';
import { MODES } from './config.mjs';

/** Refusal texts of ask-code → [HTTP status, code]. First match wins. */
const REFUSALS = [
  [/holds secrets/, 403, 'secret'],
  [/Paths stay inside|outside the project folder|Use paths inside/, 403, 'outside'],
  [/dependencies or build output/, 403, 'skipped_dir'],
  [/old_text isn’t in the file/, 409, 'old_text_not_found'],
  [/old_text appears more than once/, 409, 'old_text_ambiguous'],
  [/old_text is empty/, 400, 'old_text_empty'],
  [/There’s no |isn’t there/, 404, 'not_found'],
  [/Give a file path/, 400, 'path_required'],
];

/**
 * The HttpError for a refusal message of ask-code ("Paths stay inside the project folder." ...).
 * @param {string} message
 */
export function refusal(message) {
  for (const [pattern, status, code] of REFUSALS) if (pattern.test(message)) return new HttpError(status, message, code);
  return new HttpError(400, message, 'refused');
}

/** Runs `fn`; a Refused of ask-code becomes the matching HttpError. */
export async function refusing(fn, Refused) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Refused) throw refusal(e.message);
    throw e;
  }
}

/** The mode of a request: the `mode` field, else the server's. @throws {HttpError} 400 */
export function modeOf(body, config) {
  const mode = body.mode ?? config.mode;
  if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`, 'bad_mode');
  return mode;
}

/** Write operations and commands are not for `plan`. @throws {HttpError} 403 */
export function allowWrite(mode, what = 'this operation') {
  if (mode === 'plan') throw new HttpError(403, `mode "plan" does not allow ${what}`, 'plan_mode');
}

/** A required non-empty string field. @throws {HttpError} 400 */
export function needString(body, name) {
  if (typeof body[name] !== 'string' || !body[name].trim()) throw new HttpError(400, `${name} must be a non-empty string`, 'bad_request');
  return body[name];
}

/** An optional string field (undefined stays undefined). @throws {HttpError} 400 */
export function optString(body, name) {
  if (body[name] === undefined) return undefined;
  if (typeof body[name] !== 'string') throw new HttpError(400, `${name} must be a string`, 'bad_request');
  return body[name];
}

/** An optional positive integer field. @throws {HttpError} 400 */
export function optInt(body, name) {
  if (body[name] === undefined) return undefined;
  if (!Number.isInteger(body[name]) || body[name] < 1) throw new HttpError(400, `${name} must be a positive integer`, 'bad_request');
  return body[name];
}
