// Обновляет коллекцию Postman: переменные proxyUrl/proxyToken, папка «Прокси OpenAI (порт 8789)»,
// описание коллекции и описание события tool у /execute. Безопасно запускать повторно.
// Запуск из папки project: node postman/tools/add-proxy-folder.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ask-code-api.postman_collection.json');
const c = JSON.parse(readFileSync(FILE, 'utf8'));

const FOLDER = 'Прокси OpenAI (порт 8789)';

// ---- переменные
for (const [key, value] of [['proxyUrl', 'http://127.0.0.1:8789'], ['proxyToken', '']]) {
  const v = c.variable.find((x) => x.key === key);
  if (v) v.value = value; else c.variable.push({ key, value });
}

// ---- описание коллекции
c.info.description =
  'HTTP/SSE API ask-code-server (этапы 1, 2A-2Е и 3) и OpenAI-совместимый прокси (папка «' + FOLDER + '»). ' +
  'Запустите сервер (npm start) и импортируйте коллекцию. Этап 1: Health, Me, Ask, Execute, Start -> Status -> Stop (taskId сохраняется автоматически). ' +
  'Этап 2: файлы, заметки и память, сессии (sessionId сохраняется после POST /sessions), браузер, watches и apps, контекст, модели, диагностика. ' +
  'Запросы /ask, /execute, /start требуют реальный ключ ASK_KEY. Этап 3: рабочая папка (workspace) и files. Перед запросами этапа 3А создайте папку из workspaceDir.\n\n' +
  'Прокси (mcp/openai_proxy.py): запустите start_servers.ps1, в переменной коллекции proxyToken укажите PROXY_TOKEN из mcp/.env (в файл коллекции токен не записывайте). ' +
  'Запрос chat/completions без tools тратит один запрос аккаунта.\n\n' +
  'Runs: папки "Runs · …" — готовые последовательности для Collection Runner. Запускайте подпапку (Run 01…10) или всю папку "Runs · автоматические" по порядку. Подробности: docs/postman-runs.md.';

// ---- описание события tool в /execute и /start
function walk(items, fn) { for (const x of items) { if (x.item) walk(x.item, fn); else fn(x); } }
walk(c.item, (r) => {
  if (r.name === 'POST /execute (SSE)') {
    r.request.description =
      'Поток: status, delta, tool, usage, done | error. mode: all | edits | plan. ' +
      'Событие tool: {"name","ok","callId","path"}; path есть, только если у вызова был путь (содержимое файлов и команды в событие не попадают). ' +
      'done.steps — краткие записи о действиях на компьютере.';
  }
});

// ---- тесты и запросы прокси
const JSON_HEADER = [{ key: 'Content-Type', value: 'application/json' }];
const AUTH = [{ key: 'Authorization', value: 'Bearer {{proxyToken}}' }];
const test = (...lines) => [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
const req = (name, method, url, { headers = [], body, description, tests } = {}) => ({
  name,
  ...(tests ? { event: test(...tests) } : {}),
  request: {
    method,
    header: [...(body ? JSON_HEADER : []), ...headers],
    ...(body ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2) } } : {}),
    url,
    ...(description ? { description } : {}),
  },
});

const proxy = {
  name: FOLDER,
  description: 'OpenAI-совместимый прокси к Ask (порт 8789). Нужны запущенный прокси и proxyToken (PROXY_TOKEN из mcp/.env). Не относится к Runs.',
  item: [
    req('GET /healthz', 'GET', '{{proxyUrl}}/healthz', {
      description: 'Без токена. Показывает, заданы ли ASK_API_KEY и PROXY_TOKEN (сами значения не показываются).',
      tests: [
        "pm.test('200', () => pm.response.to.have.status(200));",
        "const j = pm.response.json();",
        "pm.test('status ok', () => pm.expect(j.status).to.eql('ok'));",
        "pm.test('ask_key_set + proxy_token_set', () => { pm.expect(j.ask_key_set).to.eql(true); pm.expect(j.proxy_token_set).to.eql(true); });",
      ],
    }),
    req('GET /v1/models', 'GET', '{{proxyUrl}}/v1/models', {
      headers: AUTH,
      description: 'Список моделей. context_length = LIMIT_PROMPT / 3 (в токенах).',
      tests: [
        "pm.test('200', () => pm.response.to.have.status(200));",
        "const j = pm.response.json();",
        "pm.test('list', () => { pm.expect(j.object).to.eql('list'); pm.expect(j.data).to.be.an('array').that.is.not.empty; });",
        "pm.test('context_length', () => pm.expect(j.data[0].context_length).to.be.a('number'));",
      ],
    }),
    req('GET /v1/models - 401 (без токена)', 'GET', '{{proxyUrl}}/v1/models', {
      tests: [
        "pm.test('401', () => pm.response.to.have.status(401));",
        "pm.test('invalid_api_key', () => pm.expect(JSON.stringify(pm.response.json())).to.include('invalid_api_key'));",
      ],
    }),
    req('GET /v1/usage', 'GET', '{{proxyUrl}}/v1/usage', {
      headers: AUTH,
      description: 'Лимиты аккаунта (проксирует GET /v1/usage сайта). Ответ — объект limits. Запрос не тратит лимит.',
      tests: ["pm.test('200', () => pm.response.to.have.status(200));"],
    }),
    req('POST /v1/chat/completions - 401 (без токена)', 'POST', '{{proxyUrl}}/v1/chat/completions', {
      body: { model: 'ask', messages: [{ role: 'user', content: 'hi' }] },
      tests: ["pm.test('401', () => pm.response.to.have.status(401));"],
    }),
    req('POST /v1/chat/completions - 400 (нет messages)', 'POST', '{{proxyUrl}}/v1/chat/completions', {
      headers: AUTH,
      body: { model: 'ask' },
      tests: ["pm.test('400', () => pm.response.to.have.status(400));"],
    }),
    req('POST /v1/chat/completions (без stream)', 'POST', '{{proxyUrl}}/v1/chat/completions', {
      headers: AUTH,
      body: { model: 'ask', stream: false, messages: [{ role: 'user', content: 'Answer with one word: ok' }] },
      description: 'Тратит один запрос аккаунта. В режиме PROXY_BACKEND=code ответ приходит от задачи /execute и может идти дольше.',
      tests: [
        "pm.test('200', () => pm.response.to.have.status(200));",
        "const j = pm.response.json();",
        "pm.test('есть ответ', () => { pm.expect(j.choices).to.be.an('array').that.is.not.empty; pm.expect(j.choices[0].message.role).to.eql('assistant'); });",
      ],
    }),
    req('POST /v1/chat/completions (stream, SSE)', 'POST', '{{proxyUrl}}/v1/chat/completions', {
      headers: AUTH,
      body: { model: 'ask', stream: true, messages: [{ role: 'user', content: 'Answer with one word: ok' }] },
      description: 'Поток data: {...} и в конце data: [DONE]. Postman покажет поток после завершения ответа. Тратит один запрос аккаунта.',
      tests: [
        "pm.test('200', () => pm.response.to.have.status(200));",
        "pm.test('[DONE]', () => pm.expect(pm.response.text()).to.include('[DONE]'));",
      ],
    }),
  ],
};

// ---- Run 11: вся папка прокси (8 запросов, два из них тратят лимит) в группе ручных Runs
const RUN11 = 'Run 11 · Прокси (тратит 2 запроса аккаунта; нужен PROXY_TOKEN)';
const manual = c.item.find((x) => x.name.startsWith('Runs · ручные'));
if (manual) {
  const run11 = {
    name: RUN11,
    description: 'Ручной Run: вся папка прокси (healthz, models, usage, 401/400 и два запроса chat/completions с ответом; ' +
      'эти два тратят по одному запросу аккаунта). ' +
      'Нужны запущенный прокси и токен: Postman — proxyToken в Current value; postman-cloud.mjs — переменная окружения PROXY_TOKEN. ' +
      'Запуск (PowerShell): $env:POSTMAN_API_KEY="..."; $env:PROXY_TOKEN="..."; node postman\\tools\\postman-cloud.mjs run 11',
    item: JSON.parse(JSON.stringify(proxy.item)),
  };
  const k = manual.item.findIndex((x) => x.name.startsWith('Run 11'));
  if (k >= 0) manual.item[k] = run11; else manual.item.push(run11);
}

const i = c.item.findIndex((x) => x.name === FOLDER);
if (i >= 0) c.item[i] = proxy;
else {
  // перед папками Runs, чтобы Runs остались в конце
  const r = c.item.findIndex((x) => x.name.startsWith('Runs'));
  c.item.splice(r >= 0 ? r : c.item.length, 0, proxy);
}

writeFileSync(FILE, JSON.stringify(c, null, 2) + '\n');
console.log('готово:', FILE);
