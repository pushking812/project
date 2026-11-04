// The real server (createApp) with a fake site, in a folder with real files. Used by test/integration-files.mjs and, as a
// program (`node test/stack.mjs`), by the pytest integration test of the MCP tools, which reads the printed address.
//
// The fake site answers every /v1/code with "saw: <name>: <start of its text>; ..." for the files of the request, so a test
// sees what reached the site. A prompt with the word REPORT also makes it tell a run_command that creates report.xlsx.
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../ask-code-server.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { writeFixtures, MAKE_REPORT } from './fixtures.mjs';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function startStack() {
  setLogLevel('error');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ask-stack-')));
  writeFixtures(dir);
  /** Bodies the fake site got on /v1/code. */
  const seen = [];
  const site = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/code') {
      const b = JSON.parse(body);
      seen.push(b);
      const saw = (b.files ?? []).map((f) => (f.kind === 'text' ? `${f.name}: ${f.text.replace(/\s+/g, ' ').slice(0, 120)}` : `${f.name}: [${f.kind}]`));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let out = sse('status', { runId: 'run1', state: 'thinking' });
      if (/REPORT/.test(b.prompt ?? '') && b.commands) out += sse('tool', { runId: 'run1', callId: '1', name: 'run_command', input: { command: MAKE_REPORT } });
      out += sse('delta', { text: `saw: ${saw.join(' | ') || 'nothing'}` }) + sse('done', {});
      res.end(out);
    } else if (req.url.startsWith('/v1/code/')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const app = createApp({ key: 'test-key-stack', site: `http://127.0.0.1:${site.address().port}`, root: dir, host: '127.0.0.1', port: 0, mode: 'all', maxParallel: 2, logLevel: 'error', allowedRoots: [dir], filesMax: 5, filesMaxBytes: 30_000_000, outputScan: true });
  const url = `http://127.0.0.1:${await app.listen()}`;
  return {
    url,
    dir,
    seen,
    async stop() {
      await app.shutdown(300);
      await new Promise((r) => site.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stack = await startStack();
  console.log(JSON.stringify({ url: stack.url, dir: stack.dir }));
  const quit = async () => {
    await stack.stop();
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.stdin.on('end', quit);
  process.stdin.resume();
}
