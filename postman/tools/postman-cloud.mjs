#!/usr/bin/env node
// Загрузка коллекции в облако Postman и запуск Runs через Postman CLI.
// Результаты прогонов (run results) попадают в облако Postman, потому что
// коллекция запускается по её UID, а не из локального файла.
//
//   node postman/tools/postman-cloud.mjs sync            загрузить/обновить коллекцию и окружение
//   node postman/tools/postman-cloud.mjs run [выбор]     запустить Runs (поднимает сервер сам)
//   node postman/tools/postman-cloud.mjs all [выбор]     sync + run
//   node postman/tools/postman-cloud.mjs list            показать Runs
//
// Выбор: номера через запятую (01,02,05), "auto" (по умолчанию), "keyed" (все, включая с ASK_KEY),
//        "manual" (M1, M2; нужен человек и сервер, запущенный вами).
//
// Переменные окружения:
//   POSTMAN_API_KEY      обязательно. Ключ из Postman: Settings -> Account -> API keys.
//   POSTMAN_WORKSPACE_ID необязательно: workspace для новой коллекции (иначе личный).
//   POSTMAN_API_HOST     по умолчанию https://api.getpostman.com (EU: https://api.eu.postman.com)
//   POSTMAN_CLI          команда Postman CLI (по умолчанию "postman")
//   ASK_KEY              настоящий ключ сайта Ask: нужен только для Runs с пометкой «ключ»
//   RUN_PORT             порт тестового сервера (по умолчанию 8791)
//   RUN_NO_SERVER=1      не запускать сервер, использовать уже запущенный по baseUrl

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
const COLLECTION_FILE = path.join(PROJECT, 'postman', 'ask-code-api.postman_collection.json');
const IDS_FILE = path.join(PROJECT, 'postman', '.cloud.json');
const ENV_NAME = 'ask-code local';
const AUTO_GROUP = 'Runs · автоматические';
const MANUAL_GROUP = 'Runs · ручные';

const HOST = (process.env.POSTMAN_API_HOST || 'https://api.getpostman.com').replace(/\/$/, '');
const CLI = process.env.POSTMAN_CLI || 'postman';
const PORT = process.env.RUN_PORT || '8791';
const BASE_URL = `http://127.0.0.1:${PORT}`;

function die(msg) { console.error('Ошибка: ' + msg); process.exit(1); }

function apiKey() {
  const k = process.env.POSTMAN_API_KEY;
  if (!k) die('не задан POSTMAN_API_KEY (Postman -> Settings -> Account settings -> API keys).');
  return k;
}

// WAF Cloudflare режет тела со строками вроде "../", "/etc/", "C:/Windows", ".env"
// (в коллекции они есть в тестах на отказы). Экранируем '.', '/', ':' в таких местах
// через \uXXXX: это тот же JSON, Postman прочитает исходные строки.
function wafSafe(json) {
  const esc = (s) => s.replace(/[./:]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return json.replace(/\.\.\/|\/etc\/|\/passwd|C:\/Windows|\.env/gi, esc);
}

async function api(method, route, body) {
  const res = await fetch(HOST + route, {
    method,
    headers: {
      'x-api-key': apiKey(),
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'PostmanRuntime/7.43.0 (ask-code postman-cloud)',
    },
    body: body ? wafSafe(JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const blocked = /Cloudflare|Attention Required/i.test(text);
    die(`${method} ${route} -> ${res.status}: ` + (blocked
      ? 'запрос заблокирован Cloudflare (WAF перед API Postman), а не самим API. Попробуйте другую сеть/без VPN или прокси, либо импортируйте файл коллекции вручную (Import в Postman).'
      : text.slice(0, 400)));
  }
  return json;
}

async function readIds() {
  try { return JSON.parse(await readFile(IDS_FILE, 'utf8')); } catch { return {}; }
}

async function readLocalCollection() {
  return JSON.parse(await readFile(COLLECTION_FILE, 'utf8'));
}

// ---------- sync ----------
async function sync() {
  const local = await readLocalCollection();
  const ids = await readIds();
  const ws = process.env.POSTMAN_WORKSPACE_ID;
  const wsQuery = ws ? `?workspace=${encodeURIComponent(ws)}` : '';

  // коллекция: ищем по сохранённому uid, потом по имени
  let uid = ids.collectionUid;
  if (!uid) {
    const list = await api('GET', '/collections' + wsQuery);
    uid = (list.collections || []).find((c) => c.name === local.info.name)?.uid;
  }
  if (uid) {
    // PUT без id у элементов: Postman пересоздаёт элементы заново (так задумано, файл — источник правды)
    await api('PUT', `/collections/${uid}`, { collection: local });
    console.log('Коллекция обновлена:', uid);
  } else {
    const r = await api('POST', '/collections' + wsQuery, { collection: local });
    uid = r.collection.uid;
    console.log('Коллекция создана:', uid);
  }

  // окружение
  const values = [{ key: 'baseUrl', value: BASE_URL, enabled: true, type: 'default' }];
  let envUid = ids.environmentUid;
  if (!envUid) {
    const list = await api('GET', '/environments' + wsQuery);
    envUid = (list.environments || []).find((e) => e.name === ENV_NAME)?.uid;
  }
  if (envUid) {
    await api('PUT', `/environments/${envUid}`, { environment: { name: ENV_NAME, values } });
    console.log('Окружение обновлено:', envUid);
  } else {
    const r = await api('POST', '/environments' + wsQuery, { environment: { name: ENV_NAME, values } });
    envUid = r.environment.uid;
    console.log('Окружение создано:', envUid);
  }
  await writeFile(IDS_FILE, JSON.stringify({ collectionUid: uid, environmentUid: envUid }, null, 2));
  return { collectionUid: uid, environmentUid: envUid };
}

// ---------- список Runs из облачной коллекции ----------
async function cloudRuns(collectionUid) {
  const r = await api('GET', `/collections/${collectionUid}`);
  const owner = collectionUid.split('-')[0];
  const uidOf = (it) => it.uid || `${owner}-${it.id}`;
  const out = [];
  for (const g of r.collection.item || []) {
    const kind = g.name.startsWith(AUTO_GROUP) ? 'auto' : g.name.startsWith(MANUAL_GROUP) ? 'manual' : null;
    if (!kind) continue;
    for (const s of g.item || []) {
      const m = /^Run (\S+)/.exec(s.name);
      out.push({
        kind,
        num: m ? m[1] : s.name,
        name: s.name,
        uid: uidOf(s),
        needsKey: /\(ключ\)|успех с ключом|— ключ\)/.test(s.name),
        needsChrome: /Chrome/.test(s.name),
      });
    }
  }
  return out;
}

function pick(runs, sel) {
  const s = (sel || 'auto').toLowerCase();
  if (s === 'auto') return runs.filter((r) => r.kind === 'auto' && !r.needsKey);
  if (s === 'keyed') return runs.filter((r) => r.kind === 'auto');
  if (s === 'manual') return runs.filter((r) => r.kind === 'manual');
  const want = s.split(',').map((x) => x.trim().toLowerCase());
  return runs.filter((r) => want.includes(r.num.toLowerCase()));
}

// ---------- сервер для прогона ----------
async function waitHealth(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(BASE_URL + '/health'); if (r.ok) return true; } catch { /* ждём */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function startServer() {
  if (process.env.RUN_NO_SERVER === '1') {
    if (!(await waitHealth(3000))) die(`RUN_NO_SERVER=1, но ${BASE_URL}/health не отвечает.`);
    return { stop: async () => {} };
  }
  if (await waitHealth(1000)) die(`порт ${PORT} уже занят другим сервером. Задайте RUN_PORT или RUN_NO_SERVER=1.`);
  // корень внутри проекта (он внутри домашней папки, поэтому разрешён для смены корня)
  const root = path.join(PROJECT, '.postman-root');
  await mkdir(root, { recursive: true });
  // файл с секретом: запросы «/read .env - 403» проверяют отказ, а для несуществующего файла сервер даёт 404
  await writeFile(path.join(root, '.env'), 'POSTMAN_TEST_SECRET=1\n');
  const patch = spawnSync(process.execPath, ['build/patch.mjs'], { cwd: PROJECT, stdio: 'ignore' });
  if (patch.status !== 0) die('build/patch.mjs завершился с ошибкой.');
  const child = spawn(process.execPath, ['ask-code-server.mjs'], {
    cwd: PROJECT,
    stdio: 'ignore',
    env: { ...process.env, ASK_PORT: PORT, ASK_ROOT: root, ASK_KEY: process.env.ASK_KEY || 'test', ASK_BROWSER_HEADLESS: process.env.ASK_BROWSER_HEADLESS || '1' },
  });
  if (!(await waitHealth())) { child.kill(); die('тестовый сервер не поднялся за 30 с.'); }
  console.log(`Сервер запущен: ${BASE_URL}, корень ${root}`);
  return {
    stop: async () => {
      child.kill();
      await new Promise((r) => setTimeout(r, 500));
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---------- Postman CLI ----------
function cli(args, opts = {}) {
  return spawnSync(CLI, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', cwd: PROJECT });
}

function preflightCli() {
  const r = cli(['--version'], { capture: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error || r.status !== 0 || !/^\d+\.\d+/.test(out.split(/\s+/).pop() || '')) {
    die(`Postman CLI не найден или это не он (команда «${CLI} --version» дала: «${out || r.error?.message}»).\n` +
      '  Windows (PowerShell): powershell.exe -NoProfile -InputFormat None -ExecutionPolicy AllSigned -Command "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12; iex ((New-Object System.Net.WebClient).DownloadString(\'https://dl-cli.pstmn.io/install/win64.ps1\'))"\n' +
      '  Если установлен в другое место, задайте POSTMAN_CLI=полный_путь.\n' +
      '  Страница установки: https://learning.postman.com/docs/postman-cli/postman-cli-installation/');
  }
  console.log('Postman CLI:', out);
}

async function run(selection, ids) {
  preflightCli();
  const login = cli(['login', '--with-api-key', apiKey()], { capture: true });
  if (login.status !== 0) die('postman login не удался: ' + `${login.stdout}${login.stderr}`.slice(0, 300));

  const runs = pick(await cloudRuns(ids.collectionUid), selection);
  if (!runs.length) die('нет Runs под выбор «' + (selection || 'auto') + '». Посмотрите `list`.');
  const hasKey = !!process.env.ASK_KEY && process.env.ASK_KEY !== 'test';
  const isManual = (selection || '').toLowerCase() === 'manual';
  if (!isManual && runs.some((r) => r.needsKey) && !hasKey) {
    console.warn('Внимание: в выбранных Runs есть шаги с ключом, а ASK_KEY не задан. Эти шаги упадут.');
  }

  const server = isManual ? { stop: async () => {} } : await startServer();
  const results = [];
  try {
    for (const r of runs) {
      console.log(`\n===== Run ${r.num} · ${r.name}`);
      const a = ['collection', 'run', ids.collectionUid, '-i', r.uid, '-e', ids.environmentUid,
        '--env-var', `baseUrl=${BASE_URL}`, '--env-var', `originalRoot=${path.join(PROJECT, '.postman-root').replace(/\\/g, '/')}`,
        '--delay-request', '50', '--timeout-request', '180000', '--bail', 'failure'];
      if (process.env.RUN_VERBOSE === '1') a.push('--verbose');
      const p = cli(a);
      results.push({ num: r.num, status: p.status });
    }
  } finally {
    await server.stop();
  }
  console.log('\n===== Итог');
  for (const x of results) console.log(`  Run ${x.num}: ${x.status === 0 ? 'OK' : 'ПАДЕНИЕ (код ' + x.status + ')'}`);
  console.log('Подробные результаты: Postman -> коллекция «ask-code API» -> Runs (или ссылка «View on Postman» выше).');
  if (results.some((x) => x.status !== 0)) process.exitCode = 1;
}

// ---------- main ----------
const [cmd, sel] = process.argv.slice(2);
if (cmd === 'sync') {
  await sync();
} else if (cmd === 'list') {
  const ids = existsSync(IDS_FILE) ? await readIds() : await sync();
  for (const r of await cloudRuns(ids.collectionUid)) console.log(`${r.kind.padEnd(6)} ${r.num.padEnd(4)} ${r.needsKey ? '[ключ] ' : ''}${r.needsChrome ? '[Chrome] ' : ''}${r.name}`);
} else if (cmd === 'run') {
  const ids = await readIds();
  if (!ids.collectionUid) die('сначала выполните `sync`.');
  await run(sel, ids);
} else if (cmd === 'all') {
  await run(sel, await sync());
} else {
  console.log('Использование: node postman/tools/postman-cloud.mjs sync | list | run [auto|keyed|manual|01,02] | all [выбор]');
  process.exit(cmd ? 1 : 0);
}
