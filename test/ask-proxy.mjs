// toHttpError: a network failure keeps its real cause in the 502 message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHttpError } from '../lib/ask-proxy.mjs';

test('toHttpError: no status and a cause gives "ask unreachable: <cause>"', () => {
  const e = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8790') });
  const h = toHttpError(e);
  assert.equal(h.status, 502);
  assert.equal(h.message, 'ask unreachable: connect ECONNREFUSED 127.0.0.1:8790');
});

test('toHttpError: no cause keeps the plain message; statuses are unchanged', () => {
  assert.equal(toHttpError(new Error('x')).message, 'ask unreachable');
  assert.equal(toHttpError(Object.assign(new Error('bad'), { status: 401 })).status, 401);
  assert.equal(toHttpError(Object.assign(new Error('boom'), { status: 500 })).message, 'ask answered 500: boom');
});
