// Server-Sent Events out of a Node response.
import { log } from './log.mjs';

const KEEPALIVE_MS = 15_000;

/**
 * Starts the event stream. A comment line every 15 s keeps long, quiet tasks from being cut by proxies.
 * @param {import('node:http').ServerResponse} res
 */
export function openSSE(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const timer = setInterval(() => writeRaw(res, ': ping\n\n'), KEEPALIVE_MS);
  timer.unref();
  res.on('close', () => clearInterval(timer));
}

const writeRaw = (res, text) => {
  if (res.writableEnded || res.destroyed) return false;
  res.write(text);
  return true;
};

/** @returns {boolean} false when the client is gone */
export function writeEvent(res, event, data) {
  return writeRaw(res, `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

/**
 * Passes the events through, logging their size at debug level and a failure at error level (no texts).
 * @param {string} module
 * @param {AsyncIterable<{event: string, data: any}>} iterator
 */
export async function* logged(module, iterator) {
  try {
    for await (const item of iterator) {
      if (item.event === 'delta') log('debug', 'sse', `delta ${item.data.text?.length ?? 0} chars`);
      yield item;
    }
  } catch (e) {
    log('error', module, `failed: ${e?.message ?? e}`);
    throw e;
  }
}

/**
 * Sends every `{event, data}` the iterator yields, then closes the stream. If the iterator throws,
 * the last event is `error`. Stops early when the client disconnects.
 * @param {import('node:http').ServerResponse} res
 * @param {AsyncIterable<{event: string, data: any}>} iterator
 */
export async function pipeSSE(res, iterator) {
  if (!res.headersSent) openSSE(res);
  try {
    for await (const { event, data } of iterator) {
      if (!writeEvent(res, event, data)) break;
    }
  } catch (e) {
    writeEvent(res, 'error', { message: e?.message ?? 'failed' });
  }
  if (!res.writableEnded) res.end();
}
