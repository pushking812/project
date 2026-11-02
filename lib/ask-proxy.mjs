// A thin layer over the monolith's api(): the site address and key come from the config.
import { api, events } from '../build/ask-code-core.mjs';
import { HttpError } from './errors.mjs';

export { events };

/**
 * Calls the ask site with the configured key. Throws what api() throws (Error with .status for an HTTP error).
 * @param {{site: string, key: string}} config
 * @param {string} path like /v1/me
 * @param {RequestInit} [init]
 */
export const askApi = (config, path, init) => api(config.site, config.key, path, init);

/** Turns an error from the site into the HttpError this API answers with. */
export function toHttpError(e) {
  if (e instanceof HttpError) return e;
  if (e?.status === 401) return new HttpError(401, 'invalid key');
  if (e?.status === 429) return new HttpError(429, e.message);
  return new HttpError(502, e?.status ? `ask answered ${e.status}: ${e.message}` : 'ask unreachable');
}

/** GET /v1/me: the account, as the site sends it. */
export async function fetchMe(config, signal) {
  try {
    return await (await askApi(config, '/v1/me', { signal })).json();
  } catch (e) {
    throw toHttpError(e);
  }
}
