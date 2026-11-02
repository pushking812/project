# ask-code-mcp — Node.js API (stage 1)

HTTP/SSE server around `ask-code`: it runs ask tasks (model, tool calls, files, commands, memory) for a project folder.
The Python MCP layer (stage 1, commits 10–15) talks to this API; it is not part of this package yet.

## Install and run

Needs Node ≥ 18 and an ask key (plan Plus+). No npm dependencies.

```bash
export ASK_KEY=sk-ask-...      # Windows cmd: set ASK_KEY=...
npm start                      # patches vendor/ask-code.mjs into build/ask-code-core.mjs, then starts the server
npm test                       # 18 integration tests against a stand-in for the ask site (no key needed)
```

`vendor/ask-code.mjs` is a byte-for-byte copy of the monolith and is never edited. `build/patch.mjs` adds `export` to
`api`, `events` and `doTool` and writes `build/ask-code-core.mjs` (generated, not committed; idempotent).

## Configuration

| Variable | Default | Required | Description |
|---|---|---|---|
| `ASK_KEY` | — | yes | ask API key |
| `ASK_SITE` | `https://ask.oryxml.com` | no | base URL of ask (`http://` only for localhost) |
| `ASK_ROOT` | `process.cwd()` | no | project folder |
| `ASK_HOST` | `127.0.0.1` | no | HTTP host (the API has no authentication: keep it on loopback) |
| `ASK_PORT` | `8737` | no | port (`0` = any free port) |
| `ASK_MODE` | `all` | no | default mode of `/execute` and `/start` |
| `ASK_MAX_PARALLEL` | `3` | no | tasks running at once |
| `ASK_LOG_LEVEL` | `info` | no | `debug` \| `info` \| `warn` \| `error` |

Logs go to stderr as `[LEVEL] [module] message`; stdout is never written. The key, prompts and answers are not logged.

## API (curl)

```bash
B=http://127.0.0.1:8737

curl -s $B/health
curl -s $B/me

# SSE: delta, usage, done | error
curl -N -X POST $B/ask -H 'content-type: application/json' \
  -d '{"prompt":"what is in ASK.md? One line.","useContext":true}'

# SSE: status, delta, tool, usage, done | error. mode: all | edits | plan
curl -N -X POST $B/execute -H 'content-type: application/json' \
  -d '{"prompt":"create hello.txt with the text Hello","mode":"all"}'

# background
curl -s -X POST $B/start -H 'content-type: application/json' -d '{"prompt":"task","mode":"all"}'   # {"taskId","status":"running"} | 429
curl -s $B/status/<taskId>    # {status,answer,steps,usage,startedAt,finishedAt,error}; 404 if unknown
curl -s -X POST $B/stop/<taskId>   # {"status":"stopping"}; later /status says "stopped"
```

Errors are JSON `{"error": "..."}` with the HTTP status. `status` is `running` | `done` | `error` | `stopped`.

## Layout

```
ask-code-server.mjs   routes, shutdown
lib/config.mjs        env → config      lib/log.mjs      stderr logging
lib/errors.mjs        HttpError, sendError, readJson      lib/sse.mjs      SSE writer
lib/ask-proxy.mjs     calls to the ask site               lib/context.mjs  ASK.md + memory + folder state
lib/tasks.mjs         task registry, MAX_PARALLEL, TTL    lib/executor.mjs the /v1/code + doTool loop
lib/mock-input.mjs    answers doTool's questions by rule
build/patch.mjs       exports api/events/doTool
test/                 integration.mjs, executor.test.mjs, mock-site.mjs
```

## Решения и допущения

- **`/ask` goes through `/v1/code`.** The site has one conversation endpoint; `/v1/ask` is not used. `/ask` sends
  `commands: false` and answers any tool call with a refusal, so the model answers from the context alone (as ask-code's own quiet question does).
- **`mockInput` denies by default.** It answers "yes" only to "Allow this change"; every other question ("Run it?", opening a browser or a site) gets "no".
- **`doTool` writes progress to stdout** (even file diffs). `main()` replaces `process.stdout.write` with a no-op, so stdout stays free and no file content reaches the log.
- **Stopping.** `/stop` and a client disconnect from `/execute` abort the task, stop its apps and tell the site to stop the run (`/v1/runs/:id/stop`).
- **Task slots.** `/execute` takes a slot like `/start` (429 when full). Finished tasks are removed after 1 hour (swept every 5 minutes).
- **Duplicate `status: thinking`** events from the site are dropped.
- **Shutdown** (`SIGINT`/`SIGTERM`): abort all tasks, `apps.stopAll()`, wait up to 2 s for them to end as `stopped`, close the server (up to 4 s in all).
- The `ask-code.mjs` and `ТЗ.txt`/`PROMPT.txt` files at the top of the working folder are inputs, not part of the commits.

## Отклонения от ТЗ

- `POST /ask` uses `/v1/code` with `commands: false` instead of `/v1/ask` (see the first decision above; the vendored client has no `/v1/ask`).
- `POST /stop/:id` on a task that already finished answers `200` with its final status (`done`/`error`/`stopped`) instead of `stopping`.
- `/execute` ends with `event: error {"message":"stopped"}` when it is aborted (as in §10, commit 8), not `done`.
- The integration test is a plain script (`node test/integration.mjs`) built on `node:test`.
- `SIGINT` handling was checked through `app.shutdown()` and by tests; real signal delivery to a child process is not reliable on Windows, so it was not tested there (§9 item 11 should be checked once on Linux/macOS).

## Известные ограничения

- No authentication (loopback only). No persistence: tasks live in memory and vanish on restart.
- The tests use a stand-in for ask; the real site (`/v1/code` stream format) was not exercised in the tests.
