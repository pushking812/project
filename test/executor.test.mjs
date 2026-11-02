// Unit tests of the executor loop with ask's api, events and doTool replaced by fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRegistry } from '../lib/tasks.mjs';
import { executeTask } from '../lib/executor.mjs';

const config = { key: 'k', site: 'http://127.0.0.1:1', root: process.cwd(), maxParallel: 3 };

class FakeApps {
  static stopped = 0;
  stopAll() {
    FakeApps.stopped++;
  }
}

/** deps whose "site" plays `script`, a list of {event, data} (a function item is awaited first). */
function fakes(script, { tool = async () => ({ ok: true, output: 'x' }) } = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      buildContext: async () => ({ folder: 'f', env: 'env', memory: '', memoryDir: '/nowhere' }),
      askApi: async () => ({}),
      events: async function* () {
        for (const item of script) {
          if (typeof item === 'function') await item();
          else yield item;
        }
      },
      doTool: tool,
      sendToolResult: async (_c, runId, callId, result) => sent.push({ runId, callId, result }),
      stopRun: async () => {},
      Apps: FakeApps,
    },
  };
}

const newRec = (maxParallel = 3) => new TaskRegistry({ maxParallel }).create({ prompt: 'p', mode: 'all' });

test('a task that reads a file ends done with the step noted', async () => {
  const { deps, sent } = fakes([
    { event: 'status', data: { runId: 'r1', state: 'thinking' } },
    { event: 'tool', data: { runId: 'r1', callId: '1', name: 'read_file', input: { path: 'src/add.js' } } },
    { event: 'delta', data: { text: 'Hel' } },
    { event: 'delta', data: { text: 'lo' } },
    { event: 'usage', data: { input: 3, output: 4 } },
    { event: 'done', data: {} },
  ]);
  const rec = newRec();
  const seen = [];
  FakeApps.stopped = 0;
  await executeTask({ rec, config, deps, onEvent: (e) => seen.push(e.event) });
  assert.equal(rec.status, 'done');
  assert.equal(rec.answer, 'Hello');
  assert.deepEqual(rec.steps, ['read src/add.js']);
  assert.deepEqual(rec.usage, { input: 3, output: 4 });
  assert.ok(rec.finishedAt);
  assert.deepEqual(seen, ['status', 'status', 'tool', 'delta', 'delta', 'usage', 'done']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].callId, '1');
  assert.equal(FakeApps.stopped, 1, 'apps.stopAll() runs at the end');
});

test('an error event from the site ends the task in error', async () => {
  const { deps } = fakes([{ event: 'error', data: { message: 'quota_exceeded' } }]);
  const rec = newRec();
  await executeTask({ rec, config, deps });
  assert.equal(rec.status, 'error');
  assert.equal(rec.error, 'quota_exceeded');
});

test('a stream that ends without done is an error', async () => {
  const { deps } = fakes([{ event: 'delta', data: { text: 'a' } }]);
  const rec = newRec();
  await executeTask({ rec, config, deps });
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /dropped/);
});

test('a tool that throws is reported to the model, not fatal', async () => {
  const { deps, sent } = fakes(
    [
      { event: 'tool', data: { runId: 'r', callId: '7', name: 'run_command', input: { command: 'x' } } },
      { event: 'done', data: {} },
    ],
    { tool: async () => { throw new Error('boom'); } },
  );
  const rec = newRec();
  await executeTask({ rec, config, deps });
  assert.equal(rec.status, 'done');
  assert.equal(sent[0].result.ok, false);
  assert.match(sent[0].result.output, /boom/);
});

test('abort turns the task into stopped', async () => {
  const rec = newRec();
  const { deps } = fakes([{ event: 'delta', data: { text: 'a' } }, () => rec.abort.abort(), { event: 'delta', data: { text: 'b' } }, { event: 'done', data: {} }]);
  const seen = [];
  await executeTask({ rec, config, deps, onEvent: (e) => seen.push(e) });
  assert.equal(rec.status, 'stopped');
  assert.deepEqual(seen.at(-1), { event: 'error', data: { message: 'stopped' } });
});

test('a failed request to the site ends the task in error', async () => {
  const { deps } = fakes([]);
  deps.askApi = async () => {
    throw Object.assign(new Error('Quota used up.'), { status: 429 });
  };
  const rec = newRec();
  await executeTask({ rec, config, deps });
  assert.equal(rec.status, 'error');
  assert.equal(rec.error, 'Quota used up.');
});

test('the registry refuses a task past MAX_PARALLEL and frees the slot when one ends', () => {
  const reg = new TaskRegistry({ maxParallel: 1 });
  const a = reg.create({ prompt: 'a', mode: 'all' });
  assert.throws(() => reg.create({ prompt: 'b', mode: 'all' }), (e) => e.status === 429);
  a.status = 'done';
  assert.ok(reg.create({ prompt: 'c', mode: 'all' }));
});

test('sweep removes only finished tasks older than the TTL', () => {
  let now = 0;
  const reg = new TaskRegistry({ maxParallel: 5, ttlMs: 1000, now: () => now });
  const old = reg.create({ prompt: 'o', mode: 'all' });
  const live = reg.create({ prompt: 'l', mode: 'all' });
  old.status = 'done';
  old.finishedAt = new Date(0).toISOString();
  now = 5000;
  assert.equal(reg.sweep(), 1);
  assert.equal(reg.get(old.id), undefined);
  assert.ok(reg.get(live.id));
});
