/** An error that knows its HTTP status. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Sends `{"error": message}` with the status. Does nothing if the response is already on its way.
 * @param {import('node:http').ServerResponse} res
 */
export function sendError(res, status, message) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify({ error: String(message) });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** @param {import('node:http').ServerResponse} res */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const BODY_LIMIT = 1_000_000;

/**
 * The JSON body of a request ({} when empty). Throws HttpError 400 / 413.
 * @param {import('node:http').IncomingMessage} req
 */
export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object');
  return value;
}
