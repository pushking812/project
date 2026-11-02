#!/usr/bin/env node
// ask-code: Ask works on a project folder on your computer, from your terminal.
//
//   curl -fsSLo ask-code.mjs <site>/v1/code/ask-code.mjs
//   node ask-code.mjs [folder] [--model sonnet|opus|haiku] [--task "what to do"] [--new] [--login] [--lang ru|en] [--browser]
//
// Ask runs on the site's server with no tools of its own. Everything it does here goes through this
// script, in the folder you give it (the current one by default): reading files is automatic (text,
// pictures, PDFs and Office files: pictures and PDFs with what the computer has, built in on a Mac,
// ImageMagick and poppler elsewhere); every change and every command shows first and waits for your yes. .env files and keys are never read.
// Nothing from the folder is kept on the server. Your project notes (ASK.md in the folder) go with every
// task, and each folder's tasks (what was said, not the files) stay on this computer for 30 days after their last use,
// (~/.config/ask-code/tasks; /clear starts another, /resume goes back to one). The folder's files are never deleted. /help and ? list the keys and commands.
// With --browser (or /browser), Ask also gets a browser window of its own: Chrome, Edge, Chromium or Brave from this
// computer, with an empty profile (none of your logins), driven through the browser's built-in remote control on this
// computer only. Pages on this computer open at once, any other site after your yes; Ask never types into a password or
// card field. /watch checks a page or a command on a timer, with no AI in the loop, and alerts you when it changes.
// Needs Node 18 or newer (22 for the browser), and an API key from the site (Account → API keys) on a plan with Code.
// Zero dependencies: read it all before you run it.
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SITE = "https://ask.oryxml.com";
/** The site's language when it served this file (?lang=…); --lang or ASK_LANG win. */
const SERVED_LANG = "ru";
/** A one-time setup code the Code page put in this download: the first run swaps it for this computer's own key. */
const SERVED_SETUP = "8Z8qq40WLRT9p7D9bFXkMOHoL6jn6-_n";
const VERSION = '3';

// ─── Words: English, or Russian (the site's default) ──────────────────────────────────────────────
// What the person reads goes through tx(); what Ask reads (tool results) stays English.

const RU = {
  // The folder
  'Paths stay inside the project folder.': 'Пути должны оставаться внутри папки проекта.',
  'Use paths inside the project folder, like src/app.ts.': 'Используйте пути внутри папки проекта, например src/app.ts.',
  '{path} is a link to something that isn’t there.': '{path} — ссылка на то, чего нет.',
  'That leads outside the project folder.': 'Это ведёт за пределы папки проекта.',
  'There’s no {path} in the project.': 'В проекте нет {path}.',
  '{rel} is a folder: list it instead.': '{rel} — это папка, а не файл.',
  '{rel} is a file, not a folder: read it instead.': '{rel} — это файл, а не папка.',
  '{rel} is too big to read ({mb} MB).': '{rel} слишком большой, чтобы его прочитать ({mb} МБ).',
  '{rel} ({kind}, {size}) isn’t text, a picture, a PDF or an Office file, so it can’t be read here.':
    '{rel} ({kind}, {size}) — не текст, не картинка, не PDF и не файл Office, поэтому прочитать его здесь нельзя.',
  // Kinds of file (binaryKind)
  'ZIP archive': 'ZIP-архив',
  'old Word (.doc)': 'старый Word (.doc)',
  'old Excel (.xls)': 'старый Excel (.xls)',
  'old PowerPoint (.ppt)': 'старый PowerPoint (.ppt)',
  audio: 'аудио',
  video: 'видео',
  compressed: 'сжатый файл',
  'RAR archive': 'RAR-архив',
  '7-Zip archive': '7-Zip-архив',
  'disk image': 'образ диска',
  program: 'программа',
  'program library': 'библиотека программы',
  'Java class': 'класс Java',
  'Java archive': 'архив Java',
  'SQLite database': 'база SQLite',
  database: 'база данных',
  font: 'шрифт',
  binary: 'двоичный файл',
  // Why an Office file didn't open (OfficeProblem)
  'not a ZIP file': 'это не ZIP-файл',
  'broken ZIP directory': 'файл повреждён',
  'broken ZIP entry': 'файл повреждён',
  'too big once unpacked': 'после распаковки он слишком большой',
  'no document inside': 'внутри нет документа',
  'no content inside': 'внутри нет документа',
  'packed in a way this reader doesn’t know': 'он упакован неизвестным способом',
  'not an Office file': 'это не файл Office',
  // Names: the same in Russian.
  'Apple Pages': 'Apple Pages',
  'Apple Numbers': 'Apple Numbers',
  'Apple Keynote': 'Apple Keynote',
  WebAssembly: 'WebAssembly',
  Photoshop: 'Photoshop',
  Sketch: 'Sketch',
  Figma: 'Figma',
  '{rel} is locked with a password.': '{rel} защищён паролем.',
  '{rel} couldn’t be opened as a PDF.': '{rel} не открывается как PDF.',
  '{rel} is a PDF, and reading PDFs on this computer needs poppler (pdftotext). Install it (for example sudo apt install poppler-utils), or open the folder in the site’s Code tab.':
    '{rel} — это PDF, а для чтения PDF на этом компьютере нужен poppler (pdftotext). Установите его (например, sudo apt install poppler-utils) или откройте папку во вкладке «Код» на сайте.',
  '{rel} is a picture this computer can’t convert (it needs ImageMagick). Install it, or save the picture as JPG or PNG.':
    '{rel} — картинка, которую этот компьютер не может преобразовать (нужен ImageMagick). Установите его или сохраните картинку в JPG или PNG.',
  '{rel} couldn’t be opened as a picture.': '{rel} не открывается как картинка.',
  '{rel} is too big to send as a picture.': '{rel} слишком большой, чтобы отправить его как картинку.',
  '{rel} couldn’t be opened: {why}.': '{rel} не открывается: {why}.',
  '{rel} has no text in it.': 'В {rel} нет текста.',
  'PDF, pages: {n}': 'PDF, страниц: {n}',
  'picture': 'картинка',
  'as pictures: {n}': 'картинками: {n}',
  'Give a file path, like src/app.ts.': 'Нужен путь к файлу, например src/app.ts.',
  '{name} holds secrets, so it isn’t shared.': 'В {name} хранятся секреты, поэтому он не передаётся.',
  'That folder holds dependencies or build output: use the source instead.': 'В этой папке зависимости или результат сборки: нужны исходники.',
  'Give something to search for.': 'Не сказано, что искать.',
  'That regular expression isn’t valid.': 'В регулярном выражении ошибка.',
  'old_text is empty.': 'old_text пустой.',
  'old_text isn’t in the file (it must match exactly, spaces included). Read the file again.': 'old_text нет в файле (он должен совпадать точно, с пробелами).',
  'old_text appears more than once: include more of the lines around it.': 'old_text встречается в файле больше одного раза.',
  'That didn’t work: {err}': 'Не получилось: {err}',
  'Edited {rel}.': 'Изменён {rel}.',
  'Wrote {rel} ({n} lines).': 'Записан {rel} (строк: {n}).',
  'Couldn’t start it: {err}': 'Не получилось запустить: {err}',
  'stopped after {s} s': 'остановлено через {s} с',
  'stopped by the person': 'остановлено вами',
  'killed by {sig}': 'прервано сигналом {sig}',
  'exit code {code}': 'код выхода {code}',
  // The terminal
  'working…': 'работаю…',
  '{s} s': '{s} с',
  '… and {n} more lines': '… и ещё строк: {n}',
  'the folder': 'папка проекта',
  'Looked through {path}': 'Просмотрено: {path}',
  'Read {path}': 'Прочитано: {path}',
  'Searched for “{q}”': 'Поиск: «{q}»',
  'Searched the web: “{q}”': 'Поиск в интернете: «{q}»',
  'Opened {page}': 'Открыто: {page}',
  'To start, make an API key on {site}/account (API keys → Make a key) and paste it here.': 'Для начала создайте API-ключ на {site}/account (API-ключи → Создать ключ) и вставьте его сюда.',
  'API key: ': 'API-ключ: ',
  'That doesn’t look like a key from the site (they start with sk-ask-). Run this again with a new one.': 'Это не похоже на ключ с сайта (они начинаются с sk-ask-). Запустите ещё раз с новым ключом.',
  'Saved in {file}, readable only by you.': 'Сохранён в {file}, читать его можете только вы.',
  'The site answered {status}.': 'Сайт ответил {status}.',
  '{used} of {limit} today': '{used} из {limit} сегодня',
  '5-hour allowance {a} used · week {b}': '5-часовой лимит: {a} · неделя: {b}',
  'Stopping…': 'Останавливаю…',
  'Waiting for a free slot ({n} ahead)…': 'Жду свободного места (впереди: {n})…',
  'Thinking…': 'Думаю…',
  'Couldn’t send that back: {err}': 'Не получилось отправить результат: {err}',
  'The connection dropped ({err}). Ask again to carry on.': 'Связь прервалась ({err}). Спросите ещё раз, чтобы продолжить.',
  'Stopped. Say what to do next, or /new to start over.': 'Остановлено. Скажите, что делать дальше, или /new, чтобы начать заново.',
  'Something went wrong. Ask again.': 'Что-то пошло не так. Спросите ещё раз.',
  'You can carry on after {when}.': 'Продолжить можно после {when}.',
  '— done · {bits}': '— готово · {bits}',
  '{in} in · {out} out': '{in} на входе · {out} на выходе',
  '[y]es · [n]o · [a]ll the rest of this task': '[y] да · [n] нет · [a] всё до конца задачи',
  '[y]es · [n]o': '[y] да · [n] нет',
  'Allow this change?': 'Разрешить это изменение?',
  'Ask gets this at its next step.': 'Ask получит это на следующем шаге.',
  'still running in the background as app {n}, at {url}': 'работает в фоне как приложение {n}, адрес {url}',
  'still running in the background as app {n}': 'работает в фоне как приложение {n}',
  'Stopped everything Ask started.': 'Всё, что запустил Ask, остановлено.',
  'Stopped app {n}.': 'Приложение {n} остановлено.',
  'There’s no running app {n}. /apps lists them.': 'Приложения {n} среди запущенных нет. Список — /apps.',
  'Nothing Ask started is running. When Ask starts your app or a dev server, it keeps running here until you quit.': 'Ничего из запущенного Ask сейчас не работает. Когда Ask запустит ваше приложение или dev-сервер, оно будет работать, пока вы не выйдете.',
  '/apps stop N stops one; they all stop when you quit.': '/apps stop N — остановить одно; при выходе остановятся все.',
  'Ask builds without asking: it changes files, runs commands and opens sites in this folder on its own. Shift+Tab to have it ask again. /help for more.': 'Ask делает всё без вопросов: сам меняет файлы, запускает команды и открывает сайты в этой папке. Shift+Tab — снова спрашивать. /help — подробнее.',
  'no asking': 'без вопросов',
  'No asking: Ask changes files, runs commands and opens sites on its own.': 'Без вопросов: Ask сам меняет файлы, запускает команды и открывает сайты.',
  'Ask wants to create {rel}': 'Ask хочет создать {rel}',
  'Ask wants to change {rel}': 'Ask хочет изменить {rel}',
  'a file': 'файл',
  'Couldn’t change {path}: {err}': 'Не получилось изменить {path}: {err}',
  'Not changed.': 'Не изменено.',
  'Couldn’t write {rel}: {err}': 'Не получилось записать {rel}: {err}',
  'Refused a command with hidden control characters: {cmd}': 'Команда со скрытыми управляющими символами не выполнена: {cmd}',
  'Ask wants to run, in this folder:': 'Ask хочет выполнить в этой папке:',
  '⚠ This reads a private file (.env or a key): what it prints would go to Ask.': '⚠ Это читает личный файл (.env или ключ): всё, что он выведет, уйдёт к Ask.',
  'Run it?': 'Выполнить?',
  'Not run.': 'Не выполнено.',
  '… {n} more lines (Ask sees them all)': '… ещё строк: {n} (Ask видит все)',
  'ask-code needs Node 18 or newer (nodejs.org).': 'Для ask-code нужен Node 18 или новее (nodejs.org).',
  'Which site? Download this again from the site’s Code page, or pass --site https://….': 'Какой сайт? Скачайте файл заново со страницы «Код» на сайте или укажите --site https://….',
  'The site must start with https:// (http:// only for localhost).': 'Адрес сайта должен начинаться с https:// (http:// — только для localhost).',
  'There’s no folder {folder}. Give the path of your project folder.': 'Папки {folder} нет. Укажите путь к папке проекта.',
  'Give a project folder, not the whole disk (cd into the project first).': 'Нужна папка проекта, а не весь диск (сначала перейдите в проект через cd).',
  'Started in your home folder, so Ask works in a folder of its own: {dir}. For another project, cd into its folder first.':
    'Вы запустили ask-code в домашней папке, поэтому Ask работает в отдельной папке: {dir}. Для другого проекта сначала перейдите в его папку через cd.',
  'Keys from the site start with sk-ask-. Copy the whole key and paste it again.': 'Ключи сайта начинаются с sk-ask-. Скопируйте ключ целиком и вставьте снова.',
  'The site doesn’t know this key either. Make a new one on {site}/account and paste it.': 'Этот ключ сайт тоже не знает. Создайте новый на {site}/account и вставьте его.',
  'Signed in as {name}. The key is saved in {file}, readable only by you: next time just run ask.': 'Вы вошли как {name}. Ключ сохранён в {file}, его можете прочитать только вы: в следующий раз просто запустите ask.',
  'Not signed in. Run ask again and paste a key from {site}/account (API keys → Make a key).': 'Вход не выполнен. Запустите ask снова и вставьте ключ с {site}/account (API-ключи → Создать ключ).',
  'Make one on {site}/account (API keys → Make a key) and paste it here: it replaces the old one.': 'Создайте новый на {site}/account (API-ключи → Создать ключ) и вставьте сюда — он заменит старый.',
  'Paste a key from {site}/account (API keys → Make a key).': 'Вставьте ключ с {site}/account (API-ключи → Создать ключ).',
  'The key in ASK_KEY doesn’t work: it was deleted, or it’s from another account.': 'Ключ из ASK_KEY не работает: его удалили, или он от другого аккаунта.',
  'Signed in as {name}: this computer has its own key now, saved in {file} (Account → API keys lists it).':
    'Вы вошли как {name}: у этого компьютера теперь свой ключ, он сохранён в {file} (он есть в списке «Аккаунт → API-ключи»).',
  'This download’s sign-in has expired or was already used. Download ask-code again from the Code page, or paste an API key.':
    'Вход из этой загрузки уже истёк или использован. Скачайте ask-code заново со страницы «Код» или вставьте API-ключ.',
  'Saved this key for next time: from now on just run ask.': 'Этот ключ сохранён: дальше просто запускайте ask.',
  'Your saved key no longer works: it was deleted, or it’s from another account.': 'Сохранённый ключ больше не работает: его удалили, или он от другого аккаунта.',
  'Couldn’t reach {site}: {err}': 'Не получилось связаться с {site}: {err}',
  'Code is part of Plus. Switch on {site}/plans, then run this again.': 'Код входит в Plus. Перейдите на него на {site}/plans и запустите снова.',
  '{model} isn’t on your plan. You can use: {list}.': '{model} нет в вашем тарифе. Доступны: {list}.',
  'default model': 'модель по умолчанию',
  'Working in {root}': 'Работаю в {root}',
  'Reading is automatic. Every change and every command asks you first. /help for more.': 'Чтение — без вопросов. Каждое изменение и каждая команда — только после вашего «да». /help — подробнее.',
  'New task. The last one is kept: /sessions lists them.': 'Новая задача. Прошлая сохранена: список — /sessions.',
  'Now using {model}.': 'Теперь работает {model}.',
  'On your plan: {list}. Type /model sonnet, say.': 'В вашем тарифе: {list}. Например: /model sonnet.',
  // Memory: notes and history
  'Carrying on your last task here ({requests}, {when}). /new starts fresh, /sessions lists the others.': 'Продолжаю прошлую задачу в этой папке ({requests}, {when}). /new — начать заново, /sessions — другие задачи.',
  '1 request': '1 запрос',
  '{n} requests': 'запросов: {n}',
  'No earlier tasks in this folder yet.': 'В этой папке пока нет прошлых задач.',
  'Tasks in this folder (a conversation untouched for {days} days is cleared; your files always stay):': 'Задачи в этой папке (переписку, к которой не возвращались {days} дней, ask-code сотрёт; файлы остаются всегда):',
  'open now': 'открыта сейчас',
  'Type /resume and a number to carry on one of them.': 'Чтобы продолжить одну из них, введите /resume и номер.',
  'There’s no task {i} here. /sessions lists them.': 'Задачи {i} здесь нет. Список — /sessions.',
  'That task is already open.': 'Эта задача уже открыта.',
  'Couldn’t open that task.': 'Не получилось открыть эту задачу.',
  'Back to “{title}” ({requests}, {when}).': 'Возвращаемся к «{title}» ({requests}, {when}).',
  'Ask reads your notes with every task: {where}.': 'Ask читает ваши заметки в каждой задаче: {where}.',
  'Tip: /init has Ask write ASK.md, notes about this project for every task. It lives in your folder and never expires.':
    'Совет: /init — Ask напишет ASK.md, заметки о проекте для каждой задачи. Файл лежит в вашей папке и не устаревает никогда.',
  'No notes for every folder yet.': 'Общих заметок для всех папок пока нет.',
  'Set $EDITOR to open it here, or write it yourself: Ask reads it in every folder.': 'Задайте $EDITOR, чтобы открывать его здесь, или напишите его сами: Ask читает его в любой папке.',
  'Saved: Ask reads it with every task, in every folder.': 'Сохранено: Ask читает это в каждой задаче, в любой папке.',
  'ASK.md is too long: Ask gets its first {n} characters.': 'ASK.md слишком длинный: Ask получит первые {n} символов.',
  'Saved in ASK.md: Ask reads it with every task in this folder.': 'Сохранено в ASK.md: Ask читает его в каждой задаче в этой папке.',
  'Say what to remember, like /remember tests run with npm test.': 'Скажите, что запомнить, например: /remember тесты запускаются через npm test.',
  'Couldn’t save the note: {err}': 'Не получилось сохранить заметку: {err}',
  // Keys and commands
  'Press Ctrl+C again to quit.': 'Нажмите Ctrl+C ещё раз, чтобы выйти.',
  'no match': 'не нашлось',
  'type to search': 'начните печатать',
  'search:': 'поиск:',
  'Image #{n}': 'Картинка №{n}',
  'Picture attached: {name}': 'Картинка прикреплена: {name}',
  'Type a command after !, like !git status.': 'Напишите команду после !, например !git status.',
  'Its output stays here: the command reads a private file.': 'Вывод останется здесь: команда читает закрытый файл.',
  'Ask sees this with your next request.': 'Ask увидит это вместе со следующим запросом.',
  'There’s no ASK.md here yet.': 'ASK.md здесь пока нет.',
  'To change it: # a note, /remember a note, /init to have Ask write it, or set $EDITOR to open it here.':
    'Чтобы изменить: # заметка, /remember заметка, /init — Ask напишет его сам, или задайте $EDITOR, чтобы открывать его здесь.',
  'ASK.md saved: Ask reads it with every task in this folder.': 'ASK.md сохранён: Ask читает его в каждой задаче в этой папке.',
  'Couldn’t open {editor}. Check $EDITOR.': 'Не получилось открыть {editor}. Проверьте $EDITOR.',
  'Nothing to fold yet: the task is short.': 'Сворачивать пока нечего: задача короткая.',
  'Folding the task into a summary…': 'Сворачиваю задачу в краткое резюме…',
  'Couldn’t fold it this time. The task is as it was.': 'Сейчас свернуть не получилось. Задача осталась как была.',
  'Folded {requests} into a summary: Ask carries on from it.': 'Свернул ({requests}) в краткое резюме: Ask продолжит с него.',
  'Nothing to save yet.': 'Сохранять пока нечего.',
  You: 'Вы',
  'Saved the task in {rel}.': 'Задача сохранена в {rel}.',
  '{file} is already there. Give another name, like /export notes.md.': '{file} уже есть. Укажите другое имя, например /export notes.md.',
  '{site} answers and knows your key': '{site} отвечает и знает ваш ключ',
  '{site}: {err}': '{site}: {err}',
  'Code is on your plan': 'Код есть в вашем тарифе',
  'Pictures of any kind can be read': 'Картинки читаются любые',
  'Only PNG, JPG, GIF and WebP pictures can be read': 'Читаются только картинки PNG, JPG, GIF и WebP',
  'install ImageMagick for the rest': 'для остальных установите ImageMagick',
  'PDFs can be read': 'PDF читаются',
  'PDFs can’t be read': 'PDF не читаются',
  'install poppler (pdftotext)': 'установите poppler (pdftotext)',
  'Ctrl+V pastes pictures': 'Ctrl+V вставляет картинки',
  'Ctrl+V can’t paste pictures': 'Ctrl+V не может вставлять картинки',
  'install wl-clipboard or xclip, or drag the picture’s file in': 'установите wl-clipboard или xclip либо перетащите файл картинки в окно',
  'Keys: ↑, Ctrl+R, Tab, Shift+Tab, Esc work here': 'Клавиши ↑, Ctrl+R, Tab, Shift+Tab, Esc здесь работают',
  'Input comes from a pipe, so the keys don’t work': 'Ввод идёт не из терминала, поэтому клавиши не работают',
  'run it in a terminal window': 'запустите в окне терминала',
  '/memory opens ASK.md in {editor}': '/memory открывает ASK.md в {editor}',
  '/memory shows ASK.md here': '/memory показывает ASK.md здесь',
  'set $EDITOR to edit it in your editor': 'задайте $EDITOR, чтобы править его в своём редакторе',
  'ASK.md: Ask reads it with every task': 'ASK.md: Ask читает его в каждой задаче',
  'No ASK.md yet': 'ASK.md пока нет',
  '/init has Ask write one': '/init — Ask напишет его',
  'What went wrong? (Enter: never mind)': 'Что пошло не так? (Enter — передумали)',
  'Sent (report #{id}). Thank you!': 'Отправлено (отчёт №{id}). Спасибо!',
  'Couldn’t send it: {err}': 'Не получилось отправить: {err}',
  'Plan first: nothing changed or run yet': 'Сначала план: пока ничего не меняю и не запускаю',
  '? for shortcuts · Shift+Tab: accept edits or plan first · Ctrl+V: paste a picture': '? — клавиши · Shift+Tab — правки без вопросов или сначала план · Ctrl+V — вставить картинку',
  'accept edits': 'правки без вопросов',
  'plan first': 'сначала план',
  'Every change asks first.': 'Каждое изменение — после вашего «да».',
  'Accept edits: file changes go in without asking (commands still ask).': 'Правки без вопросов: изменения в файлах вносятся сразу (команды по-прежнему спрашивают).',
  'Plan first: Ask looks around and writes a plan, without changing anything.': 'Сначала план: Ask всё изучит и напишет план, ничего не меняя.',
  'Shift+Tab: next mode.': 'Shift+Tab — следующий режим.',
  'Up to {n} pictures per request.': 'Не больше {n} картинок в одном запросе.',
  'There’s no picture in the clipboard. Copy one (or take a screenshot to the clipboard), then Ctrl+V.':
    'В буфере обмена нет картинки. Скопируйте её (или сделайте снимок экрана в буфер) и нажмите Ctrl+V.',
  'To paste pictures here, install wl-clipboard or xclip. Or drag the picture’s file into this window.':
    'Чтобы вставлять сюда картинки, установите wl-clipboard или xclip. Или перетащите файл картинки в это окно.',
  'Say what to remember after #, like # tests run with npm test.': 'Напишите после #, что запомнить, например: # тесты запускаются через npm test.',
  'Which one? Its number (Enter: stay here):': 'Какую? Номер (Enter — остаться здесь):',
  now: 'сейчас',
  'Which one? Its number or name (Enter: keep this one):': 'Какую? Номер или название (Enter — оставить эту):',
  'This run: {requests} · {in} in · {out} out.': 'За этот запуск: {requests} · {in} на входе · {out} на выходе.',
  'Your plan has no limit to show here.': 'В вашем тарифе нет лимита, который можно здесь показать.',
  'Your plan and its limits: {site}/plans': 'Ваш тариф и его лимиты: {site}/plans',
  'Site:': 'Сайт:',
  'Account:': 'Аккаунт:',
  'Model:': 'Модель:',
  'Folder:': 'Папка:',
  'Mode:': 'Режим:',
  'every change asks first': 'каждое изменение — после «да»',
  'Task:': 'Задача:',
  new: 'новая',
  '{n} characters': 'символов: {n}',
  'none yet (/init makes one)': 'пока нет (/init создаст его)',
  'Sent with each request, in tokens (about):': 'С каждым запросом уходит, в токенах (примерно):',
  'This task:': 'Эта задача:',
  'Ask’s memory of this folder:': 'Память Ask об этой папке:',
  'The folder now (git):': 'Папка сейчас (git):',
  'Context left until auto-compact: {n}% (/compact now, or /clear for a new task)': 'До автосжатия задачи осталось места: {n}% (/compact — сжать сейчас, /clear — новая задача)',
  'Files Ask reads cost tokens only in the request that reads them: later requests keep a one-line note of what was read and changed.':
    'Файлы, которые читает Ask, стоят токенов только в том запросе, где он их читает: дальше остаётся одна строка о том, что прочитано и изменено.',
  'Remembered in Ask’s memory of this folder: {path}': 'Запомнил в своей памяти об этой папке: {path}',
  'Couldn’t save to memory: {err}': 'Не удалось сохранить в память: {err}',
  'Compacted: the earliest part of this task is now short notes, so Ask keeps the point at a fraction of the tokens. Your files, ASK.md and Ask’s memory are untouched.':
    'Задача сжата: её начало стало краткими заметками — Ask помнит суть, а токенов уходит в разы меньше. Ваши файлы, ASK.md и память Ask не тронуты.',
  'Memory:': 'Память:',
  '{n} characters in MEMORY.md': 'в MEMORY.md символов: {n}',
  'nothing yet (Ask saves what it learns here)': 'пока пусто (Ask сохраняет сюда то, что узнаёт)',
  'Ask’s memory of this folder (kept on this computer, never expires): {dir}': 'Память Ask об этой папке (хранится на этом компьютере, не устаревает): {dir}',
  'Nothing yet: Ask saves here what it learns about the project as it works.': 'Пока пусто: Ask сохраняет сюда то, что узнаёт о проекте по ходу работы.',
  'Topics:': 'Темы:',
  'To change it, tell Ask (“forget that…”, “remember that…”); /memory forget clears it all.': 'Чтобы изменить, скажите Ask («забудь, что…», «запомни, что…»); /memory forget стирает всё.',
  'Clear everything Ask remembers about this folder? Your files and ASK.md stay.': 'Стереть всё, что Ask помнит об этой папке? Ваши файлы и ASK.md останутся.',
  'Kept.': 'Оставлено как было.',
  'Cleared. Ask starts learning this folder again from the next task.': 'Стёрто. Со следующей задачи Ask начнёт узнавать папку заново.',
  'Memory files are Markdown: name it .ask-memory/<topic>.md.': 'Файлы памяти — Markdown: назовите его .ask-memory/<тема>.md.',
  'A memory file holds {n} characters at most: keep it short, or split it by topic.': 'В файле памяти не больше {n} символов: короче, или разделите по темам.',
  'The memory is full ({n} files): merge or delete some first.': 'Память заполнена ({n} файлов): сначала объедините или удалите часть.',
  'Signed out: the saved key is deleted. Next time, paste a key again (or set ASK_KEY).': 'Вы вышли: сохранённый ключ удалён. В следующий раз вставьте ключ снова (или задайте ASK_KEY).',
  'There’s no /{name} here. /help lists the commands.': 'Команды /{name} нет. Список — /help.',
  'Couldn’t find {path}.': 'Не нашёл {path}.',
  'The connection dropped before the step finished. Ask again to carry on.': 'Связь прервалась, пока шаг не закончился. Спросите ещё раз, чтобы продолжить.',
  // What /init and /review ask Ask, in the person's language (Ask answers in it).
  'Look through this project and write ASK.md at its top level: notes for you, read with every later task here. What the project is, how to install, run, build and test it (the exact commands), the main folders and what’s in them, and the conventions to follow. Keep it short and to the point. If ASK.md is already there, improve it and keep what the person wrote.':
    'Изучи этот проект и напиши ASK.md в корне папки: заметки для тебя, которые ты будешь читать в каждой следующей задаче здесь. Что это за проект, как его установить, запустить, собрать и протестировать (точные команды), основные папки и что в них, каких правил держаться. Коротко и по делу. Если ASK.md уже есть, улучши его и сохрани то, что написал человек.',
  'Review the changes in this folder that aren’t committed yet (git status and git diff). Look for bugs, risks and anything unclear. Don’t change files: list what you would fix, most important first.':
    'Проверь незакоммиченные изменения в этой папке (git status и git diff). Ищи ошибки, риски и всё непонятное. Файлы не меняй: перечисли, что бы ты исправил, сначала самое важное.',
  // The site's messages (the app translates these too)
  'Answers aren’t working right now because of a problem on our side. The team has been told; try again a bit later.': 'Ответы сейчас не работают из-за проблемы на нашей стороне. Команда уже знает; попробуйте чуть позже.',
  'The model is busy right now. Try again in a moment.': 'Модель сейчас занята. Попробуйте ещё раз чуть позже.',
  'All answer slots are busy right now. Try again in a moment.': 'Сейчас все места для ответов заняты. Попробуйте ещё раз чуть позже.',
  'That took too long on our side. Try again, or split the question.': 'У нас это заняло слишком много времени. Попробуйте ещё раз или разбейте задачу на части.',
  'Something went wrong on our side. Try again.': 'У нас что-то пошло не так. Попробуйте ещё раз.',
  'The AI has reached its usage limit for now. Answers come back when it resets.': 'ИИ пока исчерпал свой лимит. Ответы вернутся, когда он обновится.',
  'We couldn’t reach the AI just now. Try again in a moment.': 'Не получилось связаться с ИИ. Попробуйте ещё раз чуть позже.',
  'That’s too long for the model. Shorten it, or start a new chat.': 'Для модели это слишком длинно. Сократите текст или начните заново (/new).',
  'Too many questions at once. Give it a few seconds.': 'Слишком много запросов сразу. Подождите несколько секунд.',
  'Let the current answer finish first.': 'Сначала дождитесь, пока закончится текущий ответ.',
  'Answers are paused for a moment. Try again later.': 'Ответы ненадолго приостановлены. Попробуйте позже.',
  'Code is part of Plus. Switch to Plus to let Ask work in your folder.': 'Код входит в Plus. Перейдите на Plus, чтобы Ask работал в вашей папке.',
  // The browser and watches
  'Browser: opened {url}': 'Браузер: открыт {url}',
  'Browser: clicked {what}': 'Браузер: нажато {what}',
  'Browser: typed {n} characters': 'Браузер: введено символов: {n}',
  'Browser: pressed {key}': 'Браузер: нажата клавиша {key}',
  'Browser: read the page': 'Браузер: прочитана страница',
  'Browser: looked at the console': 'Браузер: просмотрена консоль',
  'Browser: page width {w} px': 'Браузер: ширина страницы {w} px',
  'Browser: closed the window': 'Браузер: окно закрыто',
  'Browser: looked at the page': 'Браузер: просмотрена страница',
  'Ask wants to open {site} in its browser window.': 'Ask хочет открыть {site} в своём окне браузера.',
  'Allow this site?': 'Разрешить этот сайт?',
  'Plan first: nothing clicked or typed yet': 'Сначала план: пока ничего не нажато и не введено',
  'Browser: not opened ({why})': 'Браузер: не открыто ({why})',
  'Not opened.': 'Не открыто.',
  'That field is for a password or a card: type it yourself in the browser window.': 'Это поле для пароля или карты: введите его сами в окне браузера.',
  'Browser: {err}': 'Браузер: {err}',
  'The browser is on. /browser off turns it off.': 'Браузер включён. /browser off — выключить.',
  'There’s no Chrome, Edge, Chromium or Brave on this computer. Install Google Chrome (or set ASK_BROWSER to your browser’s path), then /browser again.': 'На этом компьютере нет Chrome, Edge, Chromium или Brave. Установите Google Chrome (или укажите путь к браузеру в ASK_BROWSER) и снова наберите /browser.',
  'The browser needs Node 22 or newer (nodejs.org). Update Node, then /browser again.': 'Для браузера нужен Node 22 или новее (nodejs.org). Обновите Node и снова наберите /browser.',
  'The browser stays off.': 'Браузер остаётся выключенным.',
  'The browser is on: Ask can open, test and watch web pages in its own window. /browser off turns it off.': 'Браузер включён: Ask может открывать, проверять и отслеживать сайты в своём окне. /browser off — выключить.',
  'Ask gets a browser window of its own': 'У Ask будет своё окно браузера',
  'Ask gets a Safari window of its own': 'У Ask будет своё окно Safari',
  'Safari is on: Ask opens, reads and clicks in a Safari window of its own, with your Safari sign-ins. /browser off turns it off.': 'Safari включён: Ask открывает, читает и нажимает в своём окне Safari, с вашими входами на сайты. /browser off — выключить.',
  'If Safari says no: Settings → Advanced → «Show features for web developers», then Develop → «Allow JavaScript from Apple Events».': 'Если Safari не пускает: Настройки → Дополнения → «Показывать функции для веб-разработчиков», затем меню «Разработка» → «Разрешить JavaScript из Apple Events».',
  'It’s your own Safari, so sites you’re signed in to there stay signed in for Ask. Sites on this computer open at once; any other site asks you first. Ask never types passwords or card numbers: you do. Close its window or press Esc to stop it.': 'Это ваш Safari: на сайтах, где вы вошли, Ask тоже будет в аккаунте. Сайты на этом компьютере открываются сразу, любой другой — после вашего «да». Пароли и номера карт Ask не вводит никогда: это делаете вы. Закройте его окно или нажмите Esc, чтобы остановить.',
  'Watch {id}: the site says too many requests, so it waits longer: next look in {n} min.': 'Слежение {id}: сайт пишет, что запросов слишком много, поэтому ждём дольше: следующая проверка через {n} мин.',
  'Watch {id}: {site} shows a human check instead of the page, so it waits longer: next look in {n} min. Solve it in Ask’s window (ask Ask to open the page) and the watch carries on.':
    'Слежение {id}: {site} показывает проверку «вы не робот» вместо страницы, поэтому ждём дольше: следующая проверка через {n} мин. Пройдите её в окне Ask (попросите Ask открыть страницу), и слежение продолжится.',
  'Ask: {site} asks if you’re human': 'Ask: {site} проверяет, что вы не робот',
  'Your turn in the browser window: {todo}': 'Ваша очередь в окне браузера: {todo}',
  'Ask carries on by itself once it’s done. Or type a note and press Enter; Esc stops.': 'Ask продолжит сам, когда всё будет готово. Или напишите заметку и нажмите Enter; Esc — остановить.',
  'Ask needs you in the browser': 'Ask нужна ваша помощь в браузере',
  'Ask needs you at your computer': 'Ask ждёт вас за компьютером',
  'Solve it in Ask’s window on your computer, and the watch carries on.': 'Пройдите проверку в окне Ask на компьютере, и наблюдение продолжится.',
  'Get these calls on your phone too: open Ask there → Account → Notifications.': 'Чтобы эти вызовы приходили и на телефон, откройте там Ask → Аккаунт → Уведомления.',
  'Done: Ask carries on.': 'Готово: Ask продолжает.',
  'Still waiting after {n} min: Ask stops here.': 'Ждём уже {n} мин: Ask останавливается здесь.',
  'Browser: handed over to you': 'Браузер: передано вам',
  'Finish this step in the window': 'Завершите этот шаг в окне',
  'The page asks if you’re human ({kind}). Solve it in the window.': 'Страница проверяет, что вы не робот ({kind}). Пройдите проверку в окне.',
  'Ask opens, clicks and types in it, sees it, and reads its errors: to test your site, check a page for you, or build a watcher.': 'Ask открывает в нём страницы, нажимает, вводит текст, видит экран и читает ошибки: чтобы проверить ваш сайт, посмотреть страницу за вас или настроить слежение.',
  'It’s a separate window with an empty profile: none of your logins, cookies or passwords. Sites on this computer open at once; any other site asks you first. Ask never types passwords or card numbers: you do. Close the window or press Esc to stop it.': 'Это отдельное окно с пустым профилем: в нём нет ваших входов, cookies и паролей. Сайты на этом компьютере открываются сразу, любой другой сайт — только после вашего «да». Пароли и номера карт Ask никогда не вводит: их вводите вы. Чтобы остановить, закройте окно или нажмите Esc.',
  'Turn the browser on?': 'Включить браузер?',
  'Watch {id}: first look done. {now}': 'Слежение {id}: первая проверка готова. {now}',
  '“{w}” is there now.': '«{w}» уже есть на странице.',
  'No “{w}” yet.': '«{w}» пока нет.',
  'Alerts when it changes.': 'Сообщу, когда что-то изменится.',
  'Watch {id}: {where} changed': 'Слежение {id}: изменилось на {where}',
  'Ask: {where} changed': 'Ask: изменилось на {where}',
  'Watch {id}: the check failed ({err}). It tries again in {n} min.': 'Слежение {id}: проверка не удалась ({err}). Повторю через {n} мин.',
  'the browser is off: /browser turns it on': 'браузер выключен: /browser — включить',
  'No watches yet. For example: /watch https://example.com/appointments every 5m for "available"': 'Слежений пока нет. Например: /watch https://example.com/appointments каждые 5м ищу "available"',
  'every {n} min · {checks} checks · {alerts} alerts': 'каждые {n} мин · проверок: {checks} · сигналов: {alerts}',
  '/watch stop N stops one. They run while ask-code is open.': '/watch stop N — остановить. Слежения работают, пока открыт ask-code.',
  'All watches stopped.': 'Все слежения остановлены.',
  'Watch {id} stopped.': 'Слежение {id} остановлено.',
  'There’s no watch {id}. /watch lists them.': 'Слежения {id} нет. Список — /watch.',
  'What to watch? A page or a command, like: /watch https://example.com every 5m for "available"': 'За чем следить? За страницей или командой, например: /watch https://example.com каждые 5м ищу "available"',
  'Not watched.': 'Слежение не включено.',
  'Every check runs, in this folder:': 'При каждой проверке в этой папке выполнится:',
  'Run it every {n} min?': 'Выполнять каждые {n} мин?',
  'Watch {id} is on: every {n} min. You get a notice here and on this computer’s screen when it changes.': 'Слежение {id} включено: каждые {n} мин. Когда что-то изменится, будет сообщение здесь и уведомление на экране компьютера.',
  'Keep ask-code open (the computer stays awake meanwhile). /watch lists them, /watch stop {id} stops this one.': 'Не закрывайте ask-code (пока он работает, компьютер не уснёт). Список — /watch, остановить это — /watch stop {id}.',
  'The browser is off: Ask works with the folder only.': 'Браузер выключен: Ask работает только с папкой.',
  'Ask’s own clicks in the window are coming to the site soon. /watch works now.': 'Скоро Ask сможет сам работать в этом окне. /watch работает уже сейчас.',
};

let LANG = 'en';
export const setLang = (l) => (LANG = l === 'ru' ? 'ru' : 'en');
const fill = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (all, k) => (k in p ? String(p[k]) : all)) : s);
/** The person's language; `p` fills {names} after the text is picked. */
export const tx = (en, p) => fill(LANG === 'ru' ? (RU[en] ?? en) : en, p);
export const RU_WORDS = RU;

// ─── The folder: same rules as the site's Code tab ────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__', '.idea', '.gradle', 'target', 'Pods']);
const SECRET = /^(\.env([._-].+)?|.+\.env|\.envrc|.*\.(pem|key|p12|pfx|keystore|jks|tfvars|ppk|kdbx)|id_(rsa|ed25519|ecdsa|dsa)(\..+)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|\.dockercfg|kubeconfig|credentials(\.(json|ya?ml|toml|txt|csv))?|service[-_]?account.*\.json|secrets?\.(json|ya?ml|toml|txt|env))$/i;
const PUBLIC_ENV = /^\.env[._-](example|sample|template|dist)$/i;
const MAX_READ_BYTES = 2_000_000;
// The runners' CODE_LIMITS.outputChars (runner 0.4.0): a longer answer would be cut there, without our note.
const OUTPUT_CHARS = 45_000;
const COMMAND_MS = 120_000;
const COMMAND_MAX_MS = 600_000;

export const isSecret = (name) => SECRET.test(name) && !PUBLIC_ENV.test(name);
/** A refusal: English for Ask (message), in the person's language on screen (shown). */
class Refused extends Error {
  /** `shownP`: values that read differently on screen (a kind of file, in the person's language). */
  constructor(en, p, shownP) {
    super(fill(en, p));
    this.shown = tx(en, { ...p, ...shownP });
  }
}

// Control characters (escape codes, carriage returns, bidi overrides) in anything shown could hide or
// rewrite what's on screen, a command or a diff line say. Shown visibly instead; newlines and tabs stay.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const safe = (s) => String(s ?? '').replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const hasControl = (s) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s);

const MORE = '\n… (cut here: too long for one answer. For a file, read on with offset and limit; for a list or a search, ask for a smaller part.)';
const clip = (s) => (s.length > OUTPUT_CHARS ? `${s.slice(0, OUTPUT_CHARS - MORE.length)}${MORE}` : s);
/** A command's output: its start and its end (where the errors and the exit status are), the middle left out. */
const GAP = '\n… (cut: the middle of the output is left out) …\n';
const clipMiddle = (s) => {
  if (s.length <= OUTPUT_CHARS) return s;
  const head = Math.floor(((OUTPUT_CHARS - GAP.length) * 2) / 3);
  return `${s.slice(0, head)}${GAP}${s.slice(s.length - (OUTPUT_CHARS - GAP.length - head))}`;
};
const lineCount = (s) => (s ? s.split('\n').length : 0);

/**
 * A path the model gave → an absolute, link-free path inside the folder, or Refused. Walks it one part
 * at a time: a link may point within the folder, never out of it, and never to something missing (a
 * write through it would land wherever it points).
 */
export async function inside(root, path, { mustExist = true } = {}) {
  if (typeof path !== 'string') path = '';
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || p.includes('\0') || /^[a-z]:$/i.test(p))) throw new Refused('Paths stay inside the project folder.');
  if (path.startsWith('/') && parts.length && /^(Users|home|etc|var|tmp|root|private|opt|usr|Volumes|mnt)$/.test(parts[0])) {
    throw new Refused('Use paths inside the project folder, like src/app.ts.');
  }
  let real = root;
  let missing = 0;
  for (let i = 0; i < parts.length; i++) {
    const next = join(real, parts[i]);
    let info;
    try {
      info = await lstat(next);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      missing = parts.length - i;
      break;
    }
    if (info.isSymbolicLink()) {
      try {
        real = await realpath(next);
      } catch {
        throw new Refused('{path} is a link to something that isn’t there.', { path: parts.slice(0, i + 1).join('/') });
      }
    } else real = next;
    if (real !== root && !real.startsWith(root + sep)) throw new Refused('That leads outside the project folder.');
  }
  if (mustExist && missing) throw new Refused('There’s no {path} in the project.', { path: parts.join('/') });
  const full = missing ? join(real, ...parts.slice(parts.length - missing)) : real;
  return { full, parts, rel: parts.join('/') };
}

// ─── Files that aren't text: pictures, PDFs, Office (same output as the site's Code tab) ──────────
// Done here, with what the computer already has: on a Mac, sips (pictures) and PDFKit (PDFs) are built
// in; elsewhere ImageMagick and poppler, if installed. Each runs on the one file asked for, with no
// shell, and writes only into a temporary folder that is deleted at once.

const MAX_FILE_BYTES = 100_000_000;
const IMAGE_SIDE = 1568;
const IMAGE_BASE64 = 5_000_000;
const MAX_PICTURES = 10;
const PDF_PAGES = 20;
const PDF_TEXT_PAGE = 200;
const PDF_ALL_PICTURES = 3;
const PICTURE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|ico)$/i;
export const OFFICE_EXT = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i;
const OFFICE_MAX_XML = 50_000_000;

/** What the first bytes say a file is. */
export async function sniff(full) {
  const fh = await open(full, 'r');
  try {
    const b = Buffer.alloc(16);
    const { bytesRead } = await fh.read(b, 0, 16, 0);
    const h = b.subarray(0, bytesRead);
    const ascii = (a, z) => h.subarray(a, z).toString('latin1');
    if (ascii(0, 5) === '%PDF-') return 'pdf';
    if (h[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
    if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
    if (ascii(0, 4) === 'GIF8') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return 'heic';
    if (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) return 'zip';
    return null;
  } finally {
    await fh.close();
  }
}

export const sizeText = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/** A program on this computer, by name, or null. */
export function findTool(name, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Runs a program on one file: arguments as a list (no shell), a time limit, no API key. */
function helper(bin, args, ms = 60_000, encoding = 'utf8') {
  const env = { ...process.env };
  delete env.ASK_KEY;
  return new Promise((done, fail) =>
    execFile(bin, args, { timeout: ms, maxBuffer: 64 * 1024 * 1024, env, encoding }, (err, stdout) => (err ? fail(err) : done(stdout))),
  );
}

async function inTemp(work) {
  const dir = await mkdtemp(join(tmpdir(), 'ask-code-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PICTURE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A picture as one the model takes: as is when it can, else made a JPEG of at most IMAGE_SIDE px. */
export async function pictureOf(full, rel, magic, size, via = process.platform === 'darwin' ? 'sips' : 'magick') {
  if (PICTURE_TYPES[magic] && Math.ceil(size / 3) * 4 <= IMAGE_BASE64) return { mediaType: PICTURE_TYPES[magic], data: (await readFile(full)).toString('base64') };
  const sips = via === 'sips' ? findTool('sips', '/usr/bin') : null;
  const magick = !sips ? (findTool('magick') ?? findTool('convert')) : null;
  const heif = !sips && !magick && magic === 'heic' ? (findTool('heif-dec') ?? findTool('heif-convert')) : null;
  if (!sips && !magick && !heif) throw new Refused('{rel} is a picture this computer can’t convert (it needs ImageMagick). Install it, or save the picture as JPG or PNG.', { rel });
  const data = await inTemp(async (dir) => {
    const out = join(dir, 'picture.jpg');
    try {
      if (sips) await helper(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', String(IMAGE_SIDE), full, '--out', out]);
      else if (magick) await helper(magick, [`${full}[0]`, '-auto-orient', '-resize', `${IMAGE_SIDE}x${IMAGE_SIDE}>`, '-quality', '85', out]);
      else await helper(heif, ['-q', '85', full, out]);
      return (await readFile(out)).toString('base64');
    } catch {
      throw new Refused('{rel} couldn’t be opened as a picture.', { rel });
    }
  });
  if (data.length > IMAGE_BASE64) throw new Refused('{rel} is too big to send as a picture.', { rel });
  return { mediaType: 'image/jpeg', data };
}

// PDFKit (built into every Mac), from JavaScript for Automation: each page's text, and a JPEG of the
// pages that are mostly pictures (or all of them, when only a few are asked for).
const PDFKIT_SCRIPT = `ObjC.import('PDFKit');
ObjC.import('AppKit');
function run(argv) {
  const [path, fromS, countS, outDir, sideS, minTextS, allS, maxS] = argv;
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(path));
  if (!doc || doc.isNil()) return JSON.stringify({ error: 'open' });
  if (doc.isLocked) return JSON.stringify({ error: 'locked' });
  const pages = Number(doc.pageCount);
  const from = Math.min(Math.max(1, Number(fromS)), Math.max(1, pages));
  const last = Math.min(pages, from + Number(countS) - 1);
  const all = allS === '1' || last - from + 1 <= Number(allS);
  const list = [];
  let pictures = 0;
  for (let n = from; n <= last; n++) {
    const page = doc.pageAtIndex(n - 1);
    const text = String(ObjC.unwrap(page.string) || '');
    const picture = all || text.replace(/\\s/g, '').length < Number(minTextS);
    let file = null;
    if (picture) {
      if (pictures >= Number(maxS)) break;
      const box = page.boundsForBox(0);
      const scale = Math.min(4, Number(sideS) / Math.max(box.size.width, box.size.height));
      const img = page.thumbnailOfSizeForBox($.NSMakeSize(Math.round(box.size.width * scale), Math.round(box.size.height * scale)), 0);
      const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
      file = outDir + '/page-' + n + '.jpg';
      rep.representationUsingTypeProperties(3, $({ NSImageCompressionFactor: 0.85 })).writeToFileAtomically(file, true);
      pictures++;
    }
    list.push({ page: n, text, file });
  }
  return JSON.stringify({ pages, list });
}`;

/** Pages from.. of a PDF: { pages, from, to, list: [{ page, text, picture }], images }. */
export async function readPdf(full, rel, from = 1, count = PDF_PAGES, via = process.platform === 'darwin' ? 'pdfkit' : 'poppler') {
  const osascript = via === 'pdfkit' ? findTool('osascript', '/usr/bin') : null;
  const pdftotext = !osascript ? findTool('pdftotext') : null;
  if (!osascript && !pdftotext) {
    throw new Refused('{rel} is a PDF, and reading PDFs on this computer needs poppler (pdftotext). Install it (for example sudo apt install poppler-utils), or open the folder in the site’s Code tab.', { rel });
  }
  count = Math.max(1, count);
  return inTemp(async (dir) => {
    let pages;
    let list;
    if (osascript) {
      const script = join(dir, 'pdf.js');
      await writeFile(script, PDFKIT_SCRIPT);
      let r;
      try {
        r = JSON.parse(await helper(osascript, ['-l', 'JavaScript', script, full, String(from), String(count), dir, String(IMAGE_SIDE), String(PDF_TEXT_PAGE), String(PDF_ALL_PICTURES), String(MAX_PICTURES)], 120_000));
      } catch {
        throw new Refused('{rel} couldn’t be opened as a PDF.', { rel });
      }
      if (r.error === 'locked') throw new Refused('{rel} is locked with a password.', { rel });
      if (r.error) throw new Refused('{rel} couldn’t be opened as a PDF.', { rel });
      pages = r.pages;
      list = r.list.map((p) => ({ page: p.page, text: p.text.replace(/[ \t]+\n/g, '\n').trim(), file: p.file }));
    } else {
      const info = await helper(findTool('pdfinfo') ?? 'pdfinfo', [full]).catch((e) => {
        throw new Refused(/password|encrypt/i.test(String(e.message)) ? '{rel} is locked with a password.' : '{rel} couldn’t be opened as a PDF.', { rel });
      });
      pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
      if (!pages) throw new Refused('{rel} couldn’t be opened as a PDF.', { rel });
      from = Math.min(Math.max(1, from), pages);
      const last = Math.min(pages, from + count - 1);
      const texts = (await helper(pdftotext, ['-f', String(from), '-l', String(last), '-enc', 'UTF-8', full, '-'])).split('\f');
      const all = last - from + 1 <= PDF_ALL_PICTURES;
      const pdftoppm = findTool('pdftoppm');
      list = [];
      let pictures = 0;
      for (let n = from; n <= last; n++) {
        const text = (texts[n - from] ?? '').replace(/[ \t]+\n/g, '\n').trim();
        let file = null;
        if (pdftoppm && (all || text.replace(/\s/g, '').length < PDF_TEXT_PAGE)) {
          if (pictures >= MAX_PICTURES) break;
          const prefix = join(dir, `page-${n}`);
          await helper(pdftoppm, ['-f', String(n), '-l', String(n), '-jpeg', '-jpegopt', 'quality=85', '-scale-to', String(IMAGE_SIDE), '-singlefile', full, prefix]);
          file = `${prefix}.jpg`;
          pictures++;
        }
        list.push({ page: n, text, file });
      }
    }
    const images = [];
    for (const p of list) if (p.file) images.push({ mediaType: 'image/jpeg', data: (await readFile(p.file)).toString('base64') });
    const first = list[0]?.page ?? from;
    return { pages, from: first, to: list.at(-1)?.page ?? first - 1, list: list.map((p) => ({ page: p.page, text: p.text, picture: !!p.file })), images };
  });
}

const pictured = (list) => {
  const pages = list.filter((p) => p.picture).map((p) => p.page);
  return pages.length === 1 ? ` (a picture of page ${pages[0]} follows)` : pages.length ? ` (pictures of pages ${pages.join(', ')} follow, in order)` : '';
};

/** A PDF read, as the model gets it (word for word what the site's Code tab sends). */
export function pdfOutput(path, r) {
  const head = `${path}: PDF, ${r.pages} page${r.pages === 1 ? '' : 's'}. ${r.from === r.to ? `Page ${r.from}` : `Pages ${r.from}–${r.to}`}${pictured(r.list)}:`;
  const body = r.list.map((p) => `\n--- Page ${p.page} ---\n${p.text || '(no text on this page: see its picture)'}`).join('\n');
  const more = r.to < r.pages ? `\n\n… (${r.pages} pages in all: read on with offset ${r.to + 1})` : '';
  return `${head}\n${body}${more}`;
}

// Office files: ZIPs of XML. A copy of @smartai/shared office.ts (test/ask-code-client.test.ts checks
// both give the same text).
class OfficeProblem extends Error {}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function unzipText(zip, want) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(zip, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new OfficeProblem('not a ZIP file');
  const count = u16(zip, end + 10);
  let at = u32(zip, end + 16);
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50) throw new OfficeProblem('broken ZIP directory');
    const method = u16(zip, at + 10);
    const packed = u32(zip, at + 20);
    const nameLen = u16(zip, at + 28);
    const skip = nameLen + u16(zip, at + 30) + u16(zip, at + 32);
    const local = u32(zip, at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + skip;
    if (!want(name)) continue;
    if (local + 30 > zip.length || u32(zip, local) !== 0x04034b50) throw new OfficeProblem('broken ZIP entry');
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const raw = zip.subarray(start, start + packed);
    let bytes;
    if (method === 0) bytes = raw;
    else if (method === 8) {
      try {
        bytes = inflateRawSync(raw, { maxOutputLength: Math.max(1, OFFICE_MAX_XML - total) });
      } catch (e) {
        throw new OfficeProblem(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'too big once unpacked' : 'broken ZIP entry');
      }
    } else throw new OfficeProblem('packed in a way this reader doesn’t know');
    total += bytes.length;
    if (total > OFFICE_MAX_XML) throw new OfficeProblem('too big once unpacked');
    out.set(name, bytes.toString('utf8'));
  }
  return out;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function xmlText(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (all, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
const tidy = (s) =>
  s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const byNumber = (re) => (a, b) => Number(a.match(re)?.[1] ?? 0) - Number(b.match(re)?.[1] ?? 0);

/**
 * The text of an XML part: only character data inside text elements (`inText`), so the spacing of
 * pretty-printed XML between tags never shows up; `mark` turns some tags into tabs and line breaks.
 * Elements that aren't text (deleted text, field codes) are dropped with what they hold.
 */
function xmlWalk(xml, inText, mark, collapse = false) {
  let out = '';
  let depth = 0;
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)\b[^>]*?(\/?)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (depth > 0) out += collapse ? m[4].replace(/\s+/g, ' ') : m[4];
      continue;
    }
    const [, close, tag, self] = m;
    if (inText(tag)) {
      if (!self) depth = Math.max(0, depth + (close ? -1 : 1));
      if (close && depth === 0) out += mark(`/${tag}`) ?? '';
      continue;
    }
    out += mark(close ? `/${tag}` : tag) ?? '';
  }
  return out;
}

function docxText(xml) {
  const MARKS = { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n', '/w:p': '\n', '/w:tc': '\t' };
  return tidy(xmlText(xmlWalk(xml, (tag) => tag === 'w:t', (tag) => MARKS[tag])));
}

const SLIDE_MARKS = { 'a:br': '\n', '/a:p': '\n', '/a:tc': '\t' };

function pptxText(files) {
  const slides = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber(/slide(\d+)\.xml$/));
  return slides
    .map((n, i) => {
      const text = xmlText(xmlWalk(files.get(n), (tag) => tag === 'a:t', (tag) => SLIDE_MARKS[tag]));
      return `--- Slide ${i + 1} ---\n${tidy(text)}`;
    })
    .join('\n\n');
}

const column = (ref) => [...(ref.match(/^[A-Z]+/)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

function xlsxText(files) {
  const shared = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const rels = new Map([...(files.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
  let sheets = [...(files.get('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = rels.get(m[0].match(/r:id="([^"]+)"/)?.[1]) ?? '';
    return { name: xmlText(m[0].match(/name="([^"]*)"/)?.[1] ?? ''), file: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}` };
  });
  if (!sheets.some((s) => files.has(s.file))) {
    sheets = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber(/sheet(\d+)\.xml$/)).map((file, i) => ({ name: `Sheet${i + 1}`, file }));
  }
  return sheets
    .filter((s) => files.has(s.file))
    .map((s) => {
      const rows = [...files.get(s.file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        const cells = [];
        for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const inner = c[2] ?? '';
          const type = attrs.match(/\bt="(\w+)"/)?.[1];
          const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          const value =
            type === 's'
              ? (shared[Number(v)] ?? '')
              : type === 'inlineStr'
                ? xmlText([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
                : type === 'b'
                  ? v === '1'
                    ? 'TRUE'
                    : 'FALSE'
                  : xmlText(v ?? '');
          const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
          const at = ref ? column(ref) : cells.length;
          if (at < 16_384) cells[at] = value.replace(/[\t\n]+/g, ' ');
        }
        return Array.from(cells, (x) => x ?? '').join('\t').replace(/\t+$/, '');
      });
      return `--- Sheet: ${s.name} ---\n${tidy(rows.join('\n'))}`;
    })
    .join('\n\n');
}

function odfText(xml) {
  const MARKS = { 'text:tab': '\t', 'text:line-break': '\n', '/text:p': '\n', '/text:h': '\n', '/table:table-cell': '\t', '/table:table-row': '\n', 'draw:page': '\n--- Slide ---\n' };
  const body = xml
    .replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, '')
    .replace(/<text:s(?: text:c="(\d+)")?\s*\/>/g, (_all, n) => `<text:span>${'\ue000'.repeat(Math.min(100, Number(n ?? 1)))}</text:span>`);
  return tidy(xmlText(xmlWalk(body, (tag) => tag === 'text:p' || tag === 'text:h', (tag) => MARKS[tag], true)).replace(/\ue000/g, ' '));
}

/** The text of a Word, Excel, PowerPoint or OpenDocument file. */
export function officeText(name, zip) {
  const ext = name.toLowerCase().match(/\.(\w+)$/)?.[1] ?? '';
  if (ext.startsWith('doc')) {
    const files = unzipText(zip, (n) => n === 'word/document.xml');
    if (!files.has('word/document.xml')) throw new OfficeProblem('no document inside');
    return docxText(files.get('word/document.xml'));
  }
  if (ext.startsWith('ppt')) return pptxText(unzipText(zip, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)));
  if (ext.startsWith('xls')) {
    return xlsxText(unzipText(zip, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/[^/]+\.xml$/.test(n)));
  }
  if (ext.startsWith('od')) {
    const files = unzipText(zip, (n) => n === 'content.xml');
    if (!files.has('content.xml')) throw new OfficeProblem('no content inside');
    return odfText(files.get('content.xml'));
  }
  throw new OfficeProblem('not an Office file');
}

/** What a binary file is, for when it can't be read. */
export function binaryKind(name, magic) {
  if (magic === 'zip') return 'ZIP archive';
  const ext = name.toLowerCase().match(/\.(\w+)$/)?.[1];
  const kinds = {
    doc: 'old Word (.doc)', xls: 'old Excel (.xls)', ppt: 'old PowerPoint (.ppt)', pages: 'Apple Pages', numbers: 'Apple Numbers', key: 'Apple Keynote',
    mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
    zip: 'ZIP archive', gz: 'compressed', tgz: 'compressed', rar: 'RAR archive', '7z': '7-Zip archive', dmg: 'disk image', iso: 'disk image',
    exe: 'program', dll: 'program library', so: 'program library', dylib: 'program library', wasm: 'WebAssembly', class: 'Java class', jar: 'Java archive',
    sqlite: 'SQLite database', db: 'database', ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', psd: 'Photoshop', sketch: 'Sketch', fig: 'Figma',
  };
  return (ext && kinds[ext]) ?? 'binary';
}

async function readText(full, rel) {
  const info = await stat(full);
  if (info.isDirectory()) throw new Refused('{rel} is a folder: list it instead.', { rel });
  if (info.size > MAX_READ_BYTES) throw new Refused('{rel} is too big to read ({mb} MB).', { rel, mb: Math.round(info.size / 1e6) });
  const text = await readFile(full, 'utf8');
  if (text.includes('\u0000')) {
    const kind = binaryKind(rel, await sniff(full));
    throw new Refused('{rel} ({kind}, {size}) isn’t text, a picture, a PDF or an Office file, so it can’t be read here.', { rel, kind, size: sizeText(info.size) }, { kind: tx(kind) });
  }
  return text;
}

async function* walk(dir, prefix, depth) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.name !== '.DS_Store' && !(e.isDirectory() && SKIP_DIRS.has(e.name)));
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    const path = prefix + e.name;
    if (e.isSymbolicLink()) continue; // never followed while walking
    yield { path, dir: e.isDirectory(), full: join(dir, e.name) };
    if (e.isDirectory() && depth > 1) yield* walk(join(dir, e.name), `${path}/`, depth - 1);
  }
}

function checkFile(parts, full) {
  if (!parts.length) throw new Refused('Give a file path, like src/app.ts.');
  const name = parts.at(-1);
  // The name asked for and, through a link, the file it really is.
  if (isSecret(name) || isSecret(basename(full))) throw new Refused('{name} holds secrets, so it isn’t shared.', { name });
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) throw new Refused('That folder holds dependencies or build output: use the source instead.');
}

async function listFiles(root, input) {
  const { full, rel } = await inside(root, input.path);
  if (rel && (await stat(full)).isFile()) throw new Refused('{rel} is a file, not a folder: read it instead.', { rel });
  const depth = Math.min(4, Math.max(1, Number(input.depth) || 2));
  const out = [];
  for await (const e of walk(full, rel ? `${rel}/` : '', depth)) {
    out.push(e.dir ? `${e.path}/` : isSecret(basename(e.path)) ? `${e.path} (private: not shared)` : e.path);
    if (out.length >= 800) {
      out.push('… (more: list a subfolder)');
      break;
    }
  }
  return out.length ? out.join('\n') : '(empty folder)';
}

/** Lines offset.. of a text (at most limit), with where to read on. Windows line ends read as \n (edits put them back). */
function textPart(text, input) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const from = Math.max(1, Number(input.offset) || 1);
  const limit = Math.max(1, Number(input.limit) || 2000);
  const more = from - 1 + limit < lines.length ? `\n… (${lines.length} lines in all: read on with offset ${from + limit})` : '';
  return clip(lines.slice(from - 1, from - 1 + limit).join('\n') + more);
}

/** Any file: text, a picture, a PDF's pages, an Office file's text, or what kind of file it is. */
async function readOne(root, input) {
  const { full, parts, rel } = await inside(root, input.path);
  checkFile(parts, full);
  const info = await stat(full);
  if (info.isDirectory()) throw new Refused('{rel} is a folder: list it instead.', { rel });
  const magic = await sniff(full);
  const big = () => {
    throw new Refused('{rel} is too big to read ({mb} MB).', { rel, mb: Math.round(info.size / 1e6) });
  };
  if (magic === 'pdf') {
    if (info.size > MAX_FILE_BYTES) big();
    const r = await readPdf(full, rel, Number(input.offset) || 1, Number(input.limit) || PDF_PAGES);
    return { output: clip(pdfOutput(rel, r)), images: r.images, note: tx('PDF, pages: {n}', { n: r.pages }) + (r.images.length ? `, ${tx('as pictures: {n}', { n: r.images.length })}` : '') };
  }
  if (PICTURE_TYPES[magic] || magic === 'heic' || (!magic && PICTURE_EXT.test(rel))) {
    if (info.size > MAX_FILE_BYTES) big();
    const picture = await pictureOf(full, rel, magic, info.size);
    return { output: `${rel}: a picture (${sizeText(info.size)}). Here it is.`, images: [picture], note: tx('picture') };
  }
  if (magic === 'zip' && OFFICE_EXT.test(rel)) {
    if (info.size > MAX_FILE_BYTES) big();
    let text;
    try {
      text = officeText(rel, await readFile(full));
    } catch (e) {
      if (e instanceof OfficeProblem) throw new Refused('{rel} couldn’t be opened: {why}.', { rel, why: e.message }, { why: tx(e.message) });
      throw e;
    }
    return { output: text ? textPart(text, input) : fill('{rel} has no text in it.', { rel }) };
  }
  return { output: textPart(await readText(full, rel), input) };
}

async function search(root, input) {
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Refused('Give something to search for.');
  let test;
  if (input.regex) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      throw new Refused('That regular expression isn’t valid.');
    }
    test = (l) => re.test(l);
  } else {
    const needle = pattern.toLowerCase();
    test = (l) => l.toLowerCase().includes(needle);
  }
  const { full, rel } = await inside(root, input.path);
  const hits = [];
  let files = 0;
  // A file's path: that file alone (walking "into" a file failed).
  const entries = rel && (await stat(full)).isFile() ? [{ path: rel, dir: false, full }] : walk(full, rel ? `${rel}/` : '', 12);
  for await (const e of entries) {
    if (e.dir || isSecret(basename(e.path))) continue;
    if (++files > 3000) break;
    const info = await stat(e.full);
    if (info.size > MAX_READ_BYTES) continue;
    const text = await readFile(e.full, 'utf8');
    if (text.includes('\u0000')) continue;
    text.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      if (hits.length < 200 && test(line)) hits.push(`${e.path}:${i + 1}: ${line.trim().slice(0, 240)}`);
    });
    if (hits.length >= 200) break;
  }
  return hits.length ? clip(hits.join('\n') + (hits.length >= 200 ? '\n… (first 200 matches)' : '')) : 'No matches.';
}

/** Most of the file's lines end the Windows way (\r\n). */
function windowsLineEnds(text) {
  if (!text) return false;
  const crlf = text.split('\r\n').length - 1;
  return crlf > 0 && crlf * 2 >= text.split('\n').length - 1;
}

/** Text Ask wrote (with \n) in the file's own line ends: a Windows file keeps its \r\n. */
export const inLineEnds = (before, text) => (windowsLineEnds(before) ? text.replace(/\r?\n/g, '\r\n') : text);

/** The text without what editors disagree on at a line's end (\r, spaces and tabs before it), and where each character came from. */
function looseLines(text) {
  let s = '';
  const at = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      let j = i;
      while (text[j] === ' ' || text[j] === '\t') j++;
      if (text[j] === '\r') j++;
      if (text[j] === '\n') {
        i = j - 1; // the \n itself comes next
        continue;
      }
    }
    s += c;
    at.push(i);
  }
  return { s, at };
}

/**
 * The text after an edit, or why it can't be done. Word for word first; then with line ends compared loosely (the AI
 * writes \n where a Windows file has \r\n, or misses spaces at a line's end). The new text takes the file's line ends.
 */
export function applyEdit(text, oldText, newText) {
  if (typeof oldText !== 'string' || !oldText) throw new Refused('old_text is empty.');
  const replacement = inLineEnds(text, String(newText ?? ''));
  const first = text.indexOf(oldText);
  if (first >= 0) {
    if (text.indexOf(oldText, first + 1) >= 0) throw new Refused('old_text appears more than once: include more of the lines around it.');
    return text.slice(0, first) + replacement + text.slice(first + oldText.length);
  }
  const { s, at } = looseLines(text);
  const old = oldText.replace(/[ \t]*\r?\n/g, '\n');
  const k = s.indexOf(old);
  if (k < 0) throw new Refused('old_text isn’t in the file (it must match exactly, spaces included). Read the file again.');
  if (s.indexOf(old, k + 1) >= 0) throw new Refused('old_text appears more than once: include more of the lines around it.');
  const from = old.startsWith('\n') ? (k > 0 ? at[k - 1] + 1 : 0) : at[k];
  const to = at[k + old.length - 1] + 1;
  return text.slice(0, from) + replacement + text.slice(to);
}

/** What a write or edit would do, before it's allowed: { rel, before, after } or Refused. */
export async function planChange(root, name, input) {
  const { full, parts, rel } = await inside(root, input.path, { mustExist: name === 'edit_file' });
  checkFile(parts, full);
  const before = existsSync(full) ? await readText(full, rel) : null;
  const after = name === 'edit_file' ? applyEdit(before ?? '', input.old_text, input.new_text) : inLineEnds(before, typeof input.content === 'string' ? input.content : '');
  return { full, rel, before, after };
}

async function applyChange(change, name) {
  await mkdir(dirname(change.full), { recursive: true });
  await writeFile(change.full, change.after);
  const [en, p] = name === 'edit_file' ? ['Edited {rel}.', { rel: change.rel }] : ['Wrote {rel} ({n} lines).', { rel: change.rel, n: lineCount(change.after) }];
  return { output: fill(en, p), shown: tx(en, p) };
}

/** A server on this computer, as a command prints its address ("Local: http://localhost:5173/"). */
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b[^\s"'<>)]*/;
/** How long a command ending in "&" has to say how it went before Ask hears it's running. */
const BACKGROUND_WAIT_MS = 8000;

/** "npm run dev &" → "npm run dev": a command to keep running; null for a plain one ("a && b" is plain). */
export function backgroundOf(command) {
  const m = String(command).match(/^([\s\S]*?[^&])\s*&\s*$/);
  return m && !/&&\s*$/.test(command) ? m[1].trim() : null;
}

/**
 * Apps Ask started that keep running (a dev server, the app it built): they run until the person quits ask-code
 * or stops them (/apps), not until a timeout. Each keeps the end of its output, for /apps and for Ask.
 */
export class Apps {
  constructor() {
    this.list = [];
    this.next = 1;
  }
  add(command, child, url) {
    const app = { n: this.next++, command, child, url, tail: '', running: true };
    child.on('close', () => (app.running = false));
    this.list.push(app);
    return app;
  }
  running() {
    this.list = this.list.filter((a) => a.running);
    return this.list;
  }
  stop(n) {
    const app = this.list.find((a) => a.n === n && a.running);
    if (!app) return false;
    stopTree(app.child);
    app.running = false;
    return true;
  }
  stopAll() {
    for (const a of this.running()) stopTree(a.child);
    this.list = [];
  }
}

function stopTree(child) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 2000).unref();
}

/**
 * run_command: in the folder, through the shell, with a timeout; output capped. Never gets the API key.
 * With `apps`, a command can keep running: one ending in "&", or one that starts serving on this computer (prints a
 * local address). Ask then hears it's running (its first output and address) and it stays up, in `apps`.
 */
export function runCommand(root, input, { onOutput = () => {}, signal, apps } = {}) {
  let command = String(input.command ?? '').trim();
  if (!command) return Promise.resolve({ ok: false, output: 'Give a command to run.' });
  if (hasControl(command)) return Promise.resolve({ ok: false, output: 'Refused: the command has hidden control characters. Use plain text only.' });
  const asked = apps ? backgroundOf(command) : null;
  if (asked) command = asked;
  const ms = Math.min(COMMAND_MAX_MS, Math.max(1000, (Number(input.timeout_sec) || COMMAND_MS / 1000) * 1000));
  const env = { ...process.env };
  delete env.ASK_KEY;
  return new Promise((done) => {
    const child = spawn(command, { cwd: root, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '';
    let why = null;
    let app = null;
    let settle = null;
    const finish = (r) => {
      clearTimeout(timer);
      clearTimeout(settle);
      done(r);
    };
    // Keeps running: Ask hears so now, and the app stays up in `apps`.
    const keep = () => {
      if (app || why) return;
      const url = out.match(LOCAL_URL)?.[0];
      app = apps.add(command, child, url);
      app.tail = out.slice(-4000);
      const [en, p] = url ? ['still running in the background as app {n}, at {url}', { n: app.n, url }] : ['still running in the background as app {n}', { n: app.n }];
      const note = `It stays up until the person quits ask-code or stops it (/apps stop ${app.n}).`;
      finish({ ok: true, output: clipMiddle(`$ ${command}\n${out}${out.endsWith('\n') || !out ? '' : '\n'}(${fill(en, p)}. ${note})`), code: null, status: `(${fill(en, p)})`, shown: `(${tx(en, p)})`, app: app.n, url });
    };
    const take = (chunk) => {
      const s = chunk.toString('utf8');
      if (app) {
        app.tail = (app.tail + s).slice(-4000);
        return;
      }
      onOutput(s);
      out += s;
      if (out.length > OUTPUT_CHARS * 2) out = out.slice(0, OUTPUT_CHARS) + '\n… (cut) …\n' + out.slice(-OUTPUT_CHARS / 2);
      // Serving here: a moment for the rest of its first lines, then it's running.
      if (apps && !settle && LOCAL_URL.test(out)) {
        clearTimeout(timer); // it's serving: no timeout stops it now
        settle = setTimeout(keep, 1500);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = (reason) => {
      if (app) return;
      why = reason;
      stopTree(child);
    };
    const timer = asked ? setTimeout(keep, BACKGROUND_WAIT_MS) : setTimeout(() => kill(['stopped after {s} s', { s: Math.round(ms / 1000) }]), ms);
    signal?.addEventListener('abort', () => kill(['stopped by the person']), { once: true });
    child.on('error', (e) => {
      if (app) return;
      finish({ ok: false, output: `Couldn’t start it: ${e.message}`, shown: tx('Couldn’t start it: {err}', { err: e.message }) });
    });
    child.on('close', (code, sig) => {
      if (app) return;
      // English in what Ask gets, the person's language on screen.
      const [en, p] = why ?? (sig ? ['killed by {sig}', { sig }] : ['exit code {code}', { code }]);
      const wrap = (s) => (why || sig ? `(${s})` : s);
      const status = wrap(fill(en, p));
      finish({ ok: !why && code === 0, output: clipMiddle(`$ ${command}\n${out}${out.endsWith('\n') || !out ? '' : '\n'}${status}`), code, status, shown: wrap(tx(en, p)) });
    });
  });
}

/** A command that names a private file (.env, a key): its output would reach Ask, so the person is told. */
export function touchesSecret(command) {
  return String(command)
    .split(/[\s'"`;|&<>()=]+/)
    .map((w) => w.split('/').at(-1))
    .some((w) => w && isSecret(w));
}

/** The tools that need no Allow. */
export async function runReadTool(root, name, input) {
  try {
    if (name === 'read_file') {
      const { output, images, note } = await readOne(root, input);
      return { ok: true, output, ...(images?.length ? { images } : {}), ...(note ? { note } : {}) };
    }
    const output = name === 'list_files' ? await listFiles(root, input) : await search(root, input);
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: e instanceof Refused ? e.message : `That didn’t work: ${e.message}`, shown: e instanceof Refused ? e.shown : tx('That didn’t work: {err}', { err: e.message }) };
  }
}

/** A small line diff: removed (-), added (+) and nearby unchanged lines. */
export function lineDiff(before, after, context = 2) {
  const a = before === '' || before == null ? [] : before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return b.map((text) => ({ kind: '+', text }));
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const all = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      all.push({ kind: ' ', text: a[i++] });
      j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) all.push({ kind: '-', text: a[i++] }); // removed lines first
    else all.push({ kind: '+', text: b[j++] });
  }
  const out = [];
  all.forEach((l, k) => {
    if (l.kind !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x.kind !== ' ')) out.push(l);
    else if (out.at(-1)?.kind !== '…') out.push({ kind: '…', text: '' });
  });
  return out;
}


// ─── Tab, pictures from the clipboard or dragged in ───────────────────────────────────────────────

/** The commands, as Tab completes them. */
export const COMMANDS = ['/clear', '/new', '/resume', '/sessions', '/model', '/init', '/memory', '/remember', '/compact', '/review', '/cost', '/usage', '/status', '/context', '/export', '/doctor', '/browser', '/watch', '/apps', '/bug', '/login', '/logout', '/help', '/exit', '/quit'];

/** Tab: a /command at the start of the line, or an @path in the folder anywhere in it. [hits, the part they replace]. */
export async function complete(root, line) {
  if (/^\/[\w-]*$/.test(line)) return [COMMANDS.filter((c) => c.startsWith(line)), line];
  const at = /(?:^|\s)@([^\s@]*)$/.exec(line);
  if (!at) return [[], line];
  const typed = at[1];
  const dir = typed.includes('/') ? typed.slice(0, typed.lastIndexOf('/') + 1) : '';
  const start = typed.slice(dir.length);
  const { full } = await inside(root, dir);
  const names = (await readdir(full, { withFileTypes: true }))
    .filter((e) => e.name.startsWith(start) && (start.startsWith('.') || !e.name.startsWith('.')) && !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .map((e) => `@${dir}${e.name}${e.isDirectory() ? '/' : ''}`)
    .sort()
    .slice(0, 200);
  return [names, `@${typed}`];
}

/**
 * Pictures dragged into the terminal arrive as their paths (quoted, or with \ before spaces): the ones that
 * look like a picture's full path. [{ text: as typed, path }].
 */
export function droppedPictures(line, home = homedir()) {
  const out = [];
  for (const m of line.matchAll(/'([^']+)'|"([^"]+)"|((?:\\.|[^\s\\'"])+)/g)) {
    const bare = m[3] ?? '';
    const raw = m[1] ?? m[2] ?? (/^[A-Za-z]:\\/.test(bare) ? bare : bare.replace(/\\(.)/g, '$1'));
    const path = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
    if ((path.startsWith('/') || /^[A-Za-z]:\\/.test(path)) && PICTURE_EXT.test(path)) out.push({ text: m[0], path });
  }
  return out;
}

/** A picture file (dragged in, or saved from the clipboard) as one the model takes, or Refused. */
export async function attachPicture(full, name) {
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new Refused('Couldn’t find {path}.', { path: name });
  if (info.size > MAX_FILE_BYTES) throw new Refused('{rel} is too big to read ({mb} MB).', { rel: name, mb: Math.round(info.size / 1e6) });
  return pictureOf(full, name, await sniff(full), info.size);
}

/** How this computer hands over the clipboard's picture, or null if it can't (Linux without wl-paste or xclip). */
export function clipboardTool(platform = process.platform) {
  if (platform === 'darwin') return findTool('osascript', '/usr/bin') ?? findTool('osascript');
  if (platform === 'win32') return findTool('powershell.exe') ?? findTool('powershell') ?? 'powershell';
  return findTool('wl-paste') ?? findTool('xclip');
}

/** The clipboard's picture, saved as a PNG in dir: its path, or null when there's no picture there. */
export async function clipboardPicture(dir, platform = process.platform) {
  const tool = clipboardTool(platform);
  if (!tool) return null;
  const out = join(dir, 'clipboard.png');
  try {
    if (platform === 'darwin') {
      const script = ['on run argv', 'set f to open for access (POSIX file (item 1 of argv)) with write permission', 'try', 'write (the clipboard as «class PNGf») to f', 'end try', 'close access f', 'end run'];
      await helper(tool, [...script.flatMap((l) => ['-e', l]), out], 15_000);
    } else if (platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
      await helper(tool, ['-NoProfile', '-STA', '-Command', ps], 15_000);
    } else {
      const bytes = await helper(tool, basename(tool) === 'xclip' ? ['-selection', 'clipboard', '-t', 'image/png', '-o'] : ['--no-newline', '--type', 'image/png'], 15_000, 'buffer');
      await writeFile(out, bytes);
    }
    return (await stat(out)).size > 0 && (await sniff(out)) ? out : null;
  } catch {
    return null;
  }
}

// ─── The terminal ─────────────────────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const clay = paint('38;5;173');
const print = (s = '') => process.stdout.write(`${s}\n`);

/** "working…" while Ask thinks between steps (a terminal only; pipes get nothing). */
function spinner() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let timer = null;
  let since = 0;
  return {
    start() {
      if (!tty || timer) return;
      since = Date.now();
      let i = 0;
      timer = setInterval(() => {
        const secs = Math.round((Date.now() - since) / 1000);
        process.stdout.write(`\r\x1b[2K${clay(frames[i++ % frames.length])} ${dim(`${tx('working…')}${secs >= 3 ? ` ${tx('{s} s', { s: secs })}` : ''}`)}`);
      }, 100);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stdout.write('\r\x1b[2K');
    },
  };
}

/**
 * Terminals that know it (iTerm2, kitty, WezTerm, Ghostty, …) tell Shift+Enter from Enter once asked to
 * (`CSI > 1 u`); others ignore the request. In that mode they send Esc and keys with Ctrl or Option as
 * `CSI code ; mods u`, which readline doesn't know: this turns one back into the key readline would have got
 * (`{ str, key }`), or null for anything else.
 */
export const KEYS_ON = '\x1b[>1u';
export const KEYS_OFF = '\x1b[<u';
export function kittyKey(sequence) {
  const m = /^\x1b\[(\d+)(?::\d*)*(?:;(\d+)(?::\d+)?)?u$/.exec(sequence ?? '');
  if (!m) return null;
  const code = Number(m[1]);
  const mods = Math.max(0, Number(m[2] ?? 1) - 1);
  const key = { sequence, shift: !!(mods & 1), meta: !!(mods & 2), ctrl: !!(mods & 4) };
  const named = { 13: 'return', 9: 'tab', 27: 'escape', 127: 'backspace', 8: 'backspace', 32: 'space' }[code];
  if (named) return { str: undefined, key: { ...key, name: named } };
  if (code < 32 || code > 0x10ffff) return null;
  const ch = String.fromCodePoint(code);
  if (/^[a-z]$/i.test(ch)) return { str: key.ctrl || key.meta ? undefined : key.shift ? ch.toUpperCase() : ch, key: { ...key, name: ch.toLowerCase() } };
  return { str: key.ctrl || key.meta ? undefined : ch, key: { ...key, name: ch } };
}

/**
 * Lines from stdin, one at a time, whether it's a person typing or a pipe. In a terminal, the keys work like
 * ↑/↓ and Ctrl+R go through what was typed, Tab completes /commands and @files, Esc or Ctrl+C
 * stops a task, Ctrl+C twice quits, Shift+Tab switches the mode, Ctrl+V pastes a picture, Shift+Enter (where
 * the terminal tells it from Enter), Option+Enter or \ then Enter starts a new line, and a paste of several
 * lines is one request.
 */
class Input {
  constructor(root = process.cwd()) {
    this.lines = [];
    /** While a task runs: what the person types goes to it, with its next step (not to a question it asks). */
    this.running = false;
    this.notes = [];
    this.waiting = null;
    this.closed = false;
    this.terminal = !!process.stdin.isTTY;
    /** For ↑ and Ctrl+R: the open task's lines from earlier runs, and the lines typed at the > prompt in this one. */
    this.past = [];
    this.mine = [];
    /** Set by main: Shift+Tab (the next mode) and Ctrl+V (the clipboard's picture). */
    this.onMode = null;
    this.onPicture = null;
    this.burst = [];
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.terminal,
      historySize: INPUTS,
      escapeCodeTimeout: 50,
      completer: (line, done) => {
        if (this.noComplete) {
          this.noComplete = false;
          return done(null, [[], line]);
        }
        complete(root, line).then(
          (r) => done(null, r),
          () => done(null, [[], line]),
        );
      },
    });
    this.rl.on('line', (l) => {
      if (this.search) l = this.endSearch('run') ?? l;
      if (!this.terminal) return this.deliver(l);
      // Lines that arrive together are a paste: one request, not one per line.
      this.burst.push(l);
      clearTimeout(this.burstTimer);
      this.burstTimer = setTimeout(() => this.deliver(this.burst.splice(0).join('\n')), 15);
    });
    this.rl.on('close', () => {
      clearTimeout(this.burstTimer);
      if (this.burst.length) this.deliver(this.burst.splice(0).join('\n'));
      this.closed = true;
      this.waiting?.(null);
      this.waiting = null;
    });
    // Ctrl+C: stops the running task (and answers "no" to a question it's waiting on); at the prompt it clears
    // what's typed, and on an empty line asks for a second press to quit.
    this.rl.on('SIGINT', () => {
      if (this.onInterrupt) return this.stop();
      if (this.search) return this.endSearch('cancel');
      if (this.rl.line) return this.clearLine();
      if (!this.terminal || Date.now() - (this.ctrlCAt ?? 0) < 2000) {
        print();
        process.exit(130);
      }
      this.ctrlCAt = Date.now();
      this.hint(tx('Press Ctrl+C again to quit.'));
    });
    // Ours first, before readline sees the key. A `CSI … u` key goes to readline as the key it stands for.
    if (this.terminal) {
      process.stdin.prependListener('keypress', (str, key) => {
        const k = kittyKey(key?.sequence);
        if (!k) return this.key(key ?? {});
        this.key(k.key);
        if (!(k.key.name === 'return' && (k.key.shift || k.key.meta)) && !this.closed) this.rl.write(k.str, k.key);
      });
      // Only while readline has the terminal: not in an editor, after Ctrl+Z, or once ask-code is gone.
      this.keys(true);
      this.rl.on('pause', () => this.keys(false));
      this.rl.on('resume', () => this.keys(true));
      process.on('exit', () => this.keys(false));
    }
  }
  keys(on) {
    if (this.keysOn === on) return;
    this.keysOn = on;
    process.stdout.write(on ? KEYS_ON : KEYS_OFF);
  }
  key(key) {
    if (key.name === 'tab' && (key.shift || this.search)) {
      this.noComplete = true; // readline takes Shift+Tab for Tab
      if (this.search) setImmediate(() => this.endSearch('edit'));
      else this.onMode?.();
    } else if (key.name === 'escape') {
      if (this.onInterrupt) this.stop();
      else if (this.search) this.endSearch('edit');
    } else if (key.ctrl && key.name === 'r') this.startSearch();
    else if (key.ctrl && key.name === 'v') this.onPicture?.();
    else if (key.name === 'return' && (key.meta || key.shift)) {
      // Option+Enter or Shift+Enter: a new line in the same request (as "\" then Enter).
      setImmediate(() => {
        this.rl.write('\\');
        this.rl.write(null, { name: 'return' });
      });
    } else if (this.search) setImmediate(() => this.showSearch());
  }
  stop() {
    this.onInterrupt();
    this.waiting?.(null);
    this.waiting = null;
  }
  deliver(l) {
    this.atPrompt = false;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(l);
    } else if (this.terminal && this.running && l?.trim() && !/^[/!#]/.test(l.trim())) {
      // Typed while Ask works: Ask reads it with its next step's result, as you'd tell a person mid-job.
      this.notes.push(l.trim());
      this.hint(`↳ ${tx('Ask gets this at its next step.')}`);
    } else this.lines.push(l);
  }
  clearLine() {
    this.rl.write(null, { ctrl: true, name: 'e' });
    this.rl.write(null, { ctrl: true, name: 'u' });
  }
  /** A line under the prompt (or in the output, while a task runs), then the prompt again as it was. */
  hint(text) {
    if (!this.terminal) return;
    process.stdout.write(`\n${dim(text)}\n`);
    if (this.atPrompt) this.rl.prompt(true);
  }
  /** Ctrl+R: type to find an earlier line; Ctrl+R again for an older match, Enter runs it, Tab or Esc to edit it. */
  startSearch() {
    if (!this.atPrompt) return;
    if (this.search) this.search.skip++;
    else {
      this.search = { saved: this.rl.line, prompt: this.rl.getPrompt(), skip: 0, match: null };
      this.clearLine();
    }
    setImmediate(() => this.showSearch());
  }
  showSearch() {
    if (!this.search) return;
    const q = this.rl.line.toLowerCase();
    const found = q ? upArrow(this.past, this.mine).filter((l) => l.toLowerCase().includes(q)) : [];
    if (this.search.skip >= found.length) this.search.skip = Math.max(0, found.length - 1);
    this.search.match = found[this.search.skip] ?? null;
    const room = Math.max(20, (process.stdout.columns || 80) - q.length - 24);
    const shown = this.search.match ? safe(this.search.match).slice(0, room) : q ? dim(tx('no match')) : dim(tx('type to search'));
    this.rl.setPrompt(`${clay('↶')} ${shown} ${dim(`│ ${tx('search:')}`)} `);
    this.rl.prompt(true);
  }
  /** 'run' (Enter: the match is the line), 'edit' (the match goes back to the prompt), 'cancel' (what was typed before). */
  endSearch(how) {
    const { saved, prompt, match } = this.search;
    this.search = null;
    this.rl.setPrompt(prompt);
    if (how === 'run') return match;
    this.clearLine();
    this.rl.write(how === 'edit' && match ? match : saved);
    this.rl.prompt(true);
    return null;
  }
  /**
   * The next line, or null once stdin is closed. `recall`: the > prompt, where ↑ goes back through the task's
   * lines (y/n answers to questions are left out).
   */
  ask(prompt, { recall = false } = {}) {
    if (recall && Array.isArray(this.rl.history)) this.rl.history.splice(0, this.rl.history.length, ...upArrow(this.past, this.mine));
    this.atPrompt = recall;
    if (this.terminal) {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    } else process.stdout.write(prompt);
    if (this.lines.length) {
      const l = this.lines.shift();
      if (!this.terminal) process.stdout.write(`${l}\n`);
      return Promise.resolve(l);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => (this.waiting = (l) => (!this.terminal && l != null && process.stdout.write(`${l}\n`), r(l))));
  }
  /** While another program has the terminal (an editor): readline lets go of it, then takes it back. */
  async lend(work) {
    this.rl.pause();
    if (this.terminal) process.stdin.setRawMode(false);
    try {
      return await work();
    } finally {
      if (this.terminal) process.stdin.setRawMode(true);
      this.rl.resume();
    }
  }
  close() {
    this.rl.close();
  }
}

function showDiff(before, after) {
  const lines = lineDiff(before ?? '', after);
  const shown = lines.slice(0, 120);
  for (const l of shown) print(l.kind === '+' ? green(`  + ${safe(l.text)}`) : l.kind === '-' ? red(`  - ${safe(l.text)}`) : l.kind === '…' ? dim('  …') : dim(`    ${safe(l.text)}`));
  if (lines.length > shown.length) print(dim(`  ${tx('… and {n} more lines', { n: lines.length - shown.length })}`));
}

const describe = (name, input) => {
  const path = typeof input.path === 'string' && input.path ? input.path : tx('the folder');
  return name === 'list_files' ? tx('Looked through {path}', { path }) : name === 'read_file' ? tx('Read {path}', { path }) : name === 'search' ? tx('Searched for “{q}”', { q: String(input.pattern ?? '') }) : name;
};

function parseArgs(argv) {
  const o = { folder: '.', model: null, task: null, site: process.env.ASK_SITE || SITE, help: false, fresh: false, setup: process.env.ASK_SETUP || SERVED_SETUP, lang: process.env.ASK_LANG || (/^(ru|en)$/.test(SERVED_LANG) ? SERVED_LANG : 'en') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-m' || a === '--model') o.model = argv[++i];
    else if (a === '-t' || a === '--task') o.task = argv[++i];
    else if (a === '--site') o.site = argv[++i];
    else if (a === '--new') o.fresh = true;
    else if (a === '--login') o.login = true;
    else if (a === '--setup') o.setup = argv[++i] ?? '';
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--browser') o.browser = /^(safari|chrome|edge)$/i.test(argv[i + 1] ?? '') ? argv[++i] : 'on';
    else if (a === '--safari') o.browser = 'safari';
    else if (a === '--no-ask' || a === '--yes') o.noAsk = true;
    else o.folder = a;
  }
  o.site = String(o.site).replace(/\/+$/, '');
  return o;
}

const HELP = {
  en: `ask-code: Ask works on a folder on your computer.

  node ask-code.mjs [folder] [--model sonnet|opus|haiku|fable] [--task "what to do"] [--new] [--login] [--lang ru|en] [--browser [safari]] [--no-ask]

Type what you want done. Reading is automatic; every change and command asks first (--no-ask: Ask just builds).
  /clear (/new)      start a fresh task (the last one is kept)
  /resume [N]        carry on an earlier task (/sessions lists them)
  /model [name]      switch model                /compact [focus]   fold the task into a summary
  /init              Ask writes ASK.md        /memory [user]     open ASK.md (# note adds to it)
  /memory auto       what Ask remembers here  /memory forget     clear Ask’s memory of this folder
  /review            Ask reviews uncommitted changes
  /browser [safari|off]  Ask gets a browser window (Chrome or Edge, or your Safari): opens, clicks, tests pages (asks before other sites)
  /watch URL every 5m for "words"   check a page (or a command) on a timer, alert when it changes · /watch stop N
  /apps              what Ask started that keeps running (your app, a dev server) · /apps stop N
  /cost (/usage)     this run and your limits    /status, /context  what's set and what's sent
  /export [file]     save the task as Markdown   /doctor            check this computer
  /bug [what]        tell the site's team        /login, /logout    a new key · forget the saved one
  /help, ?           this, and the keys          /exit              quit (or Ctrl+D)
  !command           run it here yourself (Ask sees the output with your next request)
  # note             remember it in ASK.md       @path              point at a file (Tab completes)
Ask reads ASK.md with every task: this folder's, the folders' above it
and yours for every folder (~/.config/ask-code/ASK.md, /memory user). ASK.md lives with your files and
never expires: keep there what Ask should always know. Ask also keeps its own memory of each folder
(how it's built and tested, decisions, your preferences), and it never expires either (/memory auto).
Each folder carries on its last task: as it grows, its oldest part is compacted into notes, by tokens,
to save tokens. Its conversation is saved on this computer only and cleared after 30 days untouched.
Your files always stay. ? for the keys.`,
  ru: `ask-code: Ask работает с папкой на вашем компьютере.

  node ask-code.mjs [папка] [--model sonnet|opus|haiku|fable] [--task "что сделать"] [--new] [--login] [--lang ru|en] [--browser [safari]] [--no-ask]

Напишите, что нужно сделать. Чтение — без вопросов; каждое изменение и команда — после «да» (--no-ask: Ask просто делает).
  /clear (/new)       новая задача (прошлая сохранится)
  /resume [N]         продолжить прошлую задачу (список — /sessions)
  /model [имя]        сменить модель                /compact [о чём]   свернуть задачу в краткое резюме
  /init               Ask напишет ASK.md         /memory [user]     открыть ASK.md (# заметка — добавить)
  /memory auto        что Ask помнит о папке     /memory forget     стереть память Ask о папке
  /review             Ask проверит незакоммиченные изменения
  /browser [safari|off]  окно браузера для Ask (Chrome/Edge или ваш Safari): открывает, нажимает, проверяет сайты (чужие — после «да»)
  /watch URL каждые 5м ищу "слова"   проверять страницу (или команду) по таймеру и сообщить об изменении · /watch stop N
  /apps               что Ask запустил и что работает (ваше приложение, dev-сервер) · /apps stop N
  /cost (/usage)      расход и лимиты               /status, /context  настройки и что уходит Ask
  /export [файл]      сохранить задачу в Markdown   /doctor            проверить этот компьютер
  /bug [что]          написать команде сайта        /login, /logout    новый ключ · забыть сохранённый
  /help, ?            справка и клавиши             /exit              выйти (или Ctrl+D)
  !команда            выполнить самому (Ask увидит вывод в следующем запросе)
  # заметка           запомнить в ASK.md            @путь              указать файл (Tab дополняет)
Ask читает ASK.md в каждой задаче: из этой папки, из папок выше
и ваш общий для всех папок (~/.config/ask-code/ASK.md, /memory user). ASK.md лежит рядом с файлами
и не устаревает никогда: пишите туда то, что Ask должен помнить всегда. Ещё Ask ведёт свою память
о каждой папке (как собрать и проверить, решения, ваши пожелания), и она тоже не устаревает (/memory auto).
В каждой папке продолжается её прошлая задача: когда она растёт, её начало сжимается в заметки — по токенам,
чтобы экономить токены. Переписка хранится только на этом компьютере и стирается через 30 дней без работы.
Ваши файлы остаются всегда. ? — клавиши.`,
};

/** "?": the keys. */
const KEYS = {
  en: `Keys:
  Enter             send                     Shift+Enter, Option+Enter, \\ then Enter   new line
  ↑ / ↓             earlier lines            Ctrl+R            search them (Enter runs, Tab edits)
  Tab               complete /commands, @files
  Shift+Tab         mode: every change asks → accept edits → no asking → plan first
  Ctrl+V            paste a picture (or drag its file into the window)
  Esc, Ctrl+C       stop Ask              Ctrl+C            clear the line; twice to quit
  Ctrl+L            clear the screen         Ctrl+D            quit
  Ctrl+A / Ctrl+E   start / end of line      Ctrl+U / Ctrl+K   delete to start / end
  Ctrl+W            delete a word            Option+click      move the cursor (Terminal, iTerm2)
  (Shift+Enter needs a terminal that tells it from Enter: iTerm2, kitty, WezTerm, Ghostty.)`,
  ru: `Клавиши:
  Enter             отправить                Shift+Enter, Option+Enter, \\ и Enter   новая строка
  ↑ / ↓             прошлые строки           Ctrl+R            поиск по ним (Enter — выполнить, Tab — править)
  Tab               дополнить /команду или @файл
  Shift+Tab         режим: всё с вопросом → правки без вопросов → без вопросов вообще → сначала план
  Ctrl+V            вставить картинку (или перетащите её файл в окно)
  Esc, Ctrl+C       остановить Ask        Ctrl+C            стереть строку; дважды — выйти
  Ctrl+L            очистить экран           Ctrl+D            выйти
  Ctrl+A / Ctrl+E   начало / конец строки    Ctrl+U / Ctrl+K   стереть до начала / до конца
  Ctrl+W            стереть слово            Option+клик       поставить курсор (Terminal, iTerm2)
  (Shift+Enter работает в терминалах, которые отличают его от Enter: iTerm2, kitty, WezTerm, Ghostty.)`,
};

const keyFile = (site) => join(homedir(), '.config', 'ask-code', `${new URL(site).host.replace(/[^a-z0-9.-]/gi, '_')}.key`);

/** The API key: ASK_KEY, or the one saved for this site (asked once, kept 0600 in your home folder). */
/** Saves a key that works, readable only by the person: the next plain run starts with it. */
async function saveKey(site, key) {
  const file = keyFile(site);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, key, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** GET /v1/me with this key: the account, or 'refused' when the site doesn't know the key (401). */
export async function checkKey(site, key) {
  try {
    return await (await api(site, key, '/v1/me')).json();
  } catch (e) {
    if (e.status === 401) return 'refused';
    throw new Error(tx('Couldn’t reach {site}: {err}', { site, err: e.message }));
  }
}

/** Asks for a key and checks it with the site until one works (3 tries), then saves it in place of any other. */
async function askForKey(site, input, why) {
  print(why);
  for (let i = 0; i < 3; i++) {
    const key = (await input.ask(tx('API key: ')))?.trim();
    if (key == null) break;
    if (!key.startsWith('sk-ask-')) {
      print(red(tx('Keys from the site start with sk-ask-. Copy the whole key and paste it again.')));
      continue;
    }
    const me = await checkKey(site, key);
    if (me === 'refused') {
      print(red(tx('The site doesn’t know this key either. Make a new one on {site}/account and paste it.', { site })));
      continue;
    }
    await saveKey(site, key);
    print(green(tx('Signed in as {name}. The key is saved in {file}, readable only by you: next time just run ask.', { name: safe(me.name ?? '—'), file: keyFile(site) })));
    return { key, me };
  }
  throw new Error(tx('Not signed in. Run ask again and paste a key from {site}/account (API keys → Make a key).', { site }));
}

/**
 * The key and its account, checked with the site first: ASK_KEY, else the saved key, else
 * one pasted here. A key the site refuses (deleted, or another account's) is asked for again on the spot, checked
 * and saved in its place, so the next plain run works. A working ASK_KEY is saved when the saved key is missing or
 * no longer works. `fresh` (--login, /login): always ask for a new one.
 */
export async function signIn(site, input, { fresh = false, setup = '' } = {}) {
  const saved = await readFile(keyFile(site), 'utf8').then((s) => s.trim(), () => '');
  const env = process.env.ASK_KEY?.trim();
  const make = tx('Make one on {site}/account (API keys → Make a key) and paste it here: it replaces the old one.', { site });
  if (fresh) return askForKey(site, input, tx('Paste a key from {site}/account (API keys → Make a key).', { site }));
  if (env) {
    const me = await checkKey(site, env);
    if (me === 'refused') return askForKey(site, input, `${red(tx('The key in ASK_KEY doesn’t work: it was deleted, or it’s from another account.'))}\n${make}`);
    if (env !== saved && (!saved || (await checkKey(site, saved)) === 'refused')) {
      await saveKey(site, env);
      print(dim(tx('Saved this key for next time: from now on just run ask.')));
    }
    return { key: env, me };
  }
  let savedMe = null;
  if (saved) {
    savedMe = await checkKey(site, saved);
    if (savedMe !== 'refused') return { key: saved, me: savedMe };
  }
  // The download came with a setup code (Code page): this computer gets its own key, nothing to paste.
  if (/^[A-Za-z0-9_-]{32}$/.test(setup)) {
    try {
      const got = await (await api(site, '', '/v1/code/setup/claim', { method: 'POST', body: JSON.stringify({ code: setup, name: `ask-code · ${hostname().replace(/\.local$/, '')}`.slice(0, 40) }) })).json();
      const me = await checkKey(site, got.key);
      if (me !== 'refused') {
        await saveKey(site, got.key);
        print(green(tx('Signed in as {name}: this computer has its own key now, saved in {file} (Account → API keys lists it).', { name: safe(me.name ?? '—'), file: keyFile(site) })));
        return { key: got.key, me };
      }
    } catch (e) {
      print(red(safe(e.message)));
    }
  }
  if (savedMe === 'refused') return askForKey(site, input, `${red(tx('Your saved key no longer works: it was deleted, or it’s from another account.'))}\n${make}`);
  return askForKey(site, input, tx('To start, make an API key on {site}/account (API keys → Make a key) and paste it here.', { site }));
}

/** The site is updating (503 restarting) or reading many big files (503 busy_files): nothing started, so ask again. */
const WAIT_FOR_SITE_MS = 150_000;

async function api(site, key, path, init = {}) {
  let res;
  for (const until = Date.now() + WAIT_FOR_SITE_MS; ; ) {
    res = await fetch(`${site}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': `ask-code/${VERSION}`, ...(init.headers ?? {}) } });
    if (res.status !== 503 || Date.now() > until) break;
    const code = await res.clone().json().then((b) => b?.error?.code, () => null);
    if (code !== 'restarting' && code !== 'busy_files') break;
    const wait = Math.min(15, Math.max(2, Number(res.headers.get('retry-after')) || 5));
    await new Promise((r) => setTimeout(r, wait * 1000));
    if (init.signal?.aborted) break;
  }
  if (!res.ok && res.status !== 204) {
    let msg = tx('The site answered {status}.', { status: res.status });
    try {
      const m = (await res.json()).error?.message;
      if (m) msg = tx(m);
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** SSE events from a fetch response. */
async function* events(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

const pickModel = (me, name) => {
  if (!name) return null;
  const want = name.toLowerCase();
  return me.models.find((m) => m === want) ?? me.models.find((m) => m.startsWith(`claude-${want}`)) ?? false;
};

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function limitsLine(l) {
  if (!l || l.kind === 'subscription') return '';
  if (l.kind === 'asks') return tx('{used} of {limit} today', { used: l.used, limit: l.limit });
  const w = l.windows;
  if (!w) return '';
  const pct = (x) => `${Math.min(100, Math.round((x.used / Math.max(1, x.limit)) * 100))}%`;
  return tx('5-hour allowance {a} used · week {b}', { a: pct(w.session), b: pct(w.week) });
}

// ─── Memory: the folder's notes (ASK.md) and its last task, both on this computer ──────────────────

export const NOTES_FILE = 'ASK.md';
export const NOTES_CHARS = 20_000;
/** A task's conversation (never the folder's files) is cleared after this many days untouched. */
const HISTORY_DAYS = 30;
/** What ↑ can bring back: the last lines typed at the > prompt in a task (requests and /commands). */
const INPUTS = 100;
/** A task's turns sent with each request (the site's limit). Long before that, the site folds the oldest into notes. */
const HISTORY_TURNS = 400;
/** The turn that stands for the folded ones; the next is their notes (the site's FOLDED_MARK, word for word). */
export const FOLDED_MARK = '[Earlier in this conversation, folded into notes]';

/** The task's last HISTORY_TURNS turns, keeping its notes (the folded pair) at the front. */
export function trimHistory(history, max = HISTORY_TURNS) {
  if (history.length <= max) return history;
  const notes = history[0]?.text === FOLDED_MARK ? history.slice(0, 2) : [];
  return [...notes, ...history.slice(notes.length).slice(-(max - notes.length))];
}

/** The site folded the first `count` turns as sent into `summary`: they become the notes pair. */
export const applyFolded = (history, { summary, count }) => [{ role: 'user', text: FOLDED_MARK }, { role: 'assistant', text: summary }, ...history.slice(count)];

/** ↑ order, newest first: the open task's earlier lines, then this run's; each line once (its newest), one-line ones only. */
export function upArrow(past, mine, max = INPUTS) {
  const out = [];
  const all = [...past, ...mine];
  for (let i = all.length - 1; i >= 0 && out.length < max; i--) {
    const l = all[i];
    if (typeof l === 'string' && l.trim() && !l.includes('\n') && !out.includes(l)) out.push(l);
  }
  return out;
}

/** ASK.md at the top of the folder (not through a link out of it), or null. */
export async function readNotes(root) {
  try {
    const { full, parts } = await inside(root, NOTES_FILE);
    checkFile(parts, full); // a link to .env inside the folder is still .env
    const text = await readText(full, NOTES_FILE);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Your notes for every folder (/memory user). */
export const personalNotesFile = (home = homedir()) => join(home, '.config', 'ask-code', NOTES_FILE);

/** An ASK.md outside the folder (yours, or a folder's above it), or null: never through a link to a secret. */
async function readOuterNotes(full) {
  try {
    if (isSecret(basename(await realpath(full)))) return null;
    const text = await readText(full, NOTES_FILE);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Every ASK.md Ask gets with a task: yours for every folder, the ones in the folders
 * above this one (inside your home folder only) and this folder's own. The folder's own comes first in the room
 * (NOTES_CHARS); the others share what's left, yours first. `sources`: where each came from, for /status.
 */
export async function gatherNotes(root, home = homedir()) {
  const own = await readNotes(root);
  const outer = [];
  const mine = await readOuterNotes(personalNotesFile(home));
  if (mine) outer.push({ where: '~/.config/ask-code/ASK.md', text: mine });
  const homeReal = await realpath(home).catch(() => home);
  const above = [];
  for (let dir = dirname(root); dir !== root && (dir === homeReal || dir.startsWith(homeReal + sep)); dir = dirname(dir)) {
    const text = await readOuterNotes(join(dir, NOTES_FILE));
    if (text) above.unshift({ where: dir === homeReal ? '~/ASK.md' : `~/${dir.slice(homeReal.length + 1)}/ASK.md`, text });
    if (dir === homeReal) break;
  }
  outer.push(...above);
  const sources = outer.map((o) => ({ where: o.where, chars: o.text.length }));
  if (own) sources.push({ where: 'ASK.md', chars: own.length });
  if (!outer.length) return { text: own, sources, clipped: (own?.length ?? 0) > NOTES_CHARS };
  const ownBlock = own ? `[This folder's ASK.md]\n${own.trim()}`.slice(0, NOTES_CHARS) : '';
  let room = NOTES_CHARS - ownBlock.length;
  const parts = [];
  let clipped = !!own && own.length > NOTES_CHARS;
  for (const o of outer) {
    const head = `[${o.where}]\n`;
    const fits = room - head.length - 2;
    if (fits < 200) {
      clipped = true;
      break;
    }
    const body = o.text.trim().slice(0, fits);
    if (body.length < o.text.trim().length) clipped = true;
    parts.push(head + body);
    room -= head.length + body.length + 2;
  }
  if (ownBlock) parts.push(ownBlock);
  return { text: parts.join('\n\n') || null, sources, clipped };
}

/** /remember: the person's own note, added to ASK.md (made if it isn't there). */
export async function remember(root, note) {
  const { full, parts } = await inside(root, NOTES_FILE, { mustExist: false });
  checkFile(parts, full);
  const line = `- ${note.replace(/\s*\n\s*/g, ' ').trim()}\n`;
  let before = null;
  try {
    before = await readText(full, NOTES_FILE);
  } catch (e) {
    if (e instanceof Refused || e.code !== 'ENOENT') throw e;
  }
  if (before == null) await writeFile(full, `# Notes for Ask\n\nAbout this project, for every task here.\n\n${line}`);
  else await appendFile(full, `${before.endsWith('\n') || !before ? '' : '\n'}${line}`);
}

// ─── Ask's memory of each folder, tokens, the folder now ─────────────────────────────────────────────────────

/** The path Ask's tools use for its memory of the project. It isn't in the folder: memoryDir is. */
export const MEMORY_DIR = '.ask-memory';
/** How much of the memory's index (MEMORY.md) goes with each request: the site's CODE_MEMORY_CHARS. */
export const MEMORY_CHARS = 12_000;
/** A memory file's size at most, and how many files the memory holds. */
const MEMORY_FILE_CHARS = 40_000;
const MEMORY_FILES = 100;

/**
 * Where Ask keeps what it learns about a folder, across tasks: on this computer,
 * outside the project (nothing to commit by mistake), readable only by the person, and it never expires.
 */
export function memoryDir(site, root, home = homedir()) {
  const id = createHash('sha256').update(`${site}\n${root}`).digest('hex').slice(0, 32);
  return join(home, '.config', 'ask-code', 'memory', id);
}

/** A tool path into the memory (`.ask-memory/…`) → the path inside memoryDir; null for any other path. */
export function memoryPath(path) {
  if (typeof path !== 'string') return null;
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  return parts[0] === MEMORY_DIR ? parts.slice(1).join('/') : null;
}

/** The memory's index, what goes with every request: its first 200 lines (MEMORY_CHARS at most), or ''. */
export async function readMemory(dir) {
  try {
    const text = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    return text.split('\n').slice(0, 200).join('\n').slice(0, MEMORY_CHARS).trim();
  } catch {
    return '';
  }
}

/**
 * Ask's tools on its memory: reading and listing as anywhere; writing without asking (it's Ask's own notes,
 * not the project), Markdown files only, within MEMORY_FILE_CHARS and MEMORY_FILES.
 */
export async function memoryTool(dir, name, args) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const rest = memoryPath(args.path) ?? '';
  if (name === 'list_files' || name === 'read_file' || name === 'search') return runReadTool(dir, name, { ...args, path: rest });
  if (name !== 'write_file' && name !== 'edit_file') return { ok: false, output: `${name} doesn’t work on the memory.` };
  try {
    if (!/\.md$/i.test(rest)) throw new Refused('Memory files are Markdown: name it .ask-memory/<topic>.md.');
    const change = await planChange(dir, name, { ...args, path: rest });
    if (change.after.length > MEMORY_FILE_CHARS) throw new Refused('A memory file holds {n} characters at most: keep it short, or split it by topic.', { n: MEMORY_FILE_CHARS });
    if (change.before == null && (await readdir(dir)).filter((n) => n.endsWith('.md')).length >= MEMORY_FILES) {
      throw new Refused('The memory is full ({n} files): merge or delete some first.', { n: MEMORY_FILES });
    }
    await mkdir(dirname(change.full), { recursive: true, mode: 0o700 });
    await writeFile(change.full, change.after, { mode: 0o600 });
    return { ok: true, output: `Saved ${MEMORY_DIR}/${change.rel}.`, rel: change.rel };
  } catch (e) {
    return { ok: false, output: e instanceof Refused ? e.message : `That didn’t work: ${e.message}`, shown: e instanceof Refused ? e.shown : e.message };
  }
}

/** Tokens, near enough (the site's estimateTokens): ~4 characters each in English and code, ~2.5 in Cyrillic. */
export function estimateTokens(text) {
  let ascii = 0;
  let alphabet = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) ascii++;
    else if (c >= 0x2e80) wide++;
    else alphabet++;
  }
  return Math.ceil(ascii / 4 + alphabet / 2.5 + wide);
}
/** The task's turns the site keeps word for word (its CODE_HISTORY_BUDGET_TOKENS); past 70% it compacts the oldest. */
export const TASK_TOKENS = 20_000;
const COMPACT_AT = 0.7;
/** The task's size in tokens, as the site measures it. */
export const taskTokens = (history) => history.reduce((n, h) => n + estimateTokens(h.text) + 4, 0);

/** The folder as it is now, sent with each request: the system, the date, git's branch, changes and last commits. */
export async function folderNow(root) {
  const git = (args) =>
    new Promise((done) => execFile('git', args, { cwd: root, timeout: 3_000, maxBuffer: 1 << 20 }, (err, out) => done(err ? null : String(out).trimEnd())));
  const os = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? process.platform;
  const lines = [`System: ${os}. Today: ${new Date().toISOString().slice(0, 10)}.`];
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch == null) return `${lines[0]}\nNot a git repository.`;
  lines.push(`Git branch: ${branch}.`);
  const status = (await git(['status', '--short'])) ?? '';
  const changed = status ? status.split('\n') : [];
  lines.push(changed.length ? `Changed, not committed (${changed.length}):\n${changed.slice(0, 20).join('\n')}${changed.length > 20 ? `\n… ${changed.length - 20} more` : ''}` : 'Nothing changed since the last commit.');
  const log = await git(['log', '-3', '--format=%h %s']);
  if (log) lines.push(`Last commits:\n${log}`);
  return lines.join('\n').slice(0, 4_000);
}

/**
 * One line on what a step did, kept with its answer: the next requests know which files were read and changed and
 * what ran, without carrying their contents again (Ask reads a file again when it needs it).
 */
export function stepNote(name, args, result) {
  const path = String(args.path ?? '').slice(0, 120);
  if (memoryPath(args.path) != null && result.ok && (name === 'write_file' || name === 'edit_file')) return `remembered ${path}`;
  if (name === 'read_file') return result.ok ? `read ${path}` : null;
  if (name === 'list_files' || name === 'search') return null; // looking around: nothing to carry
  if (name === 'write_file' || name === 'edit_file') return result.ok ? `${name === 'write_file' ? 'wrote' : 'edited'} ${path}` : `not changed: ${path}`;
  if (name === 'run_command') {
    const cmd = String(args.command ?? '').replace(/\s+/g, ' ').slice(0, 120);
    if (result.ok) return `ran \`${cmd}\` (ok)`;
    const tail = String(result.output ?? '').trim().split('\n').slice(-2).join(' / ').slice(0, 200);
    return `ran \`${cmd}\` (failed${tail ? `: ${tail}` : ''})`;
  }
  return null;
}

/** The steps of an answer as one compact line, or ''. Several reads of one file count once. */
export function stepsLine(notes) {
  const seen = new Set();
  const out = notes.filter((n) => n && !seen.has(n) && seen.add(n));
  if (!out.length) return '';
  let line = `[Steps: ${out.join('; ')}]`;
  if (line.length > 1_500) line = `${line.slice(0, 1_480)}…]`;
  return line;
}

/** Where a folder's last task is kept: one file per site and folder, readable only by the person. */
export function historyFile(site, root, home = homedir()) {
  const id = createHash('sha256').update(`${site}\n${root}`).digest('hex').slice(0, 32);
  return join(home, '.config', 'ask-code', 'tasks', `${id}.json`);
}

/** A task's name in /sessions: its first request, on one line and short. */
const titleOf = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
};

export async function loadHistory(file, now = Date.now()) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(saved.history) || now - Date.parse(saved.savedAt) > HISTORY_DAYS * 86_400_000) return null;
    const history = saved.history.filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string');
    const title = typeof saved.title === 'string' ? saved.title : titleOf(history.find((h) => h.role === 'user' && h.text !== FOLDED_MARK)?.text ?? '');
    // Tasks saved before typed lines were kept: their requests stand in for them.
    const typed = Array.isArray(saved.inputs) ? saved.inputs.filter((l) => typeof l === 'string') : history.filter((h) => h.role === 'user').map((h) => h.text);
    return history.length ? { history: trimHistory(history), savedAt: saved.savedAt, title, inputs: typed.slice(-INPUTS) } : null;
  } catch {
    return null;
  }
}

export async function saveHistory(file, history, title, inputs = []) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ savedAt: new Date().toISOString(), title, history, inputs: inputs.slice(-INPUTS) }), { mode: 0o600 });
  await chmod(file, 0o600);
}

// Earlier tasks in a folder (put aside by /new or /resume) sit next to its current one, for the same HISTORY_DAYS.
const sessionsDir = (file) => file.replace(/\.json$/, '');

/** /new: the folder's current task is put aside, not deleted, so /resume can bring it back. */
export async function newSession(file) {
  if (!(await loadHistory(file))) return rm(file, { force: true });
  const dir = sessionsDir(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await rename(file, join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.json`));
}

/** /sessions: the folder's tasks, newest first, the current one marked. Untouched for HISTORY_DAYS: their conversation is cleared. */
export async function listSessions(file, now = Date.now()) {
  const dir = sessionsDir(file);
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  const sessions = [];
  for (const f of [file, ...names.map((n) => join(dir, n))]) {
    const s = await loadHistory(f, now);
    if (s) sessions.push({ file: f, current: f === file, savedAt: s.savedAt, title: s.title, requests: Math.ceil(s.history.length / 2) });
    else if (f !== file) await rm(f, { force: true }).catch(() => {});
  }
  return sessions.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** /resume: an earlier task becomes the folder's current one; the current one is put aside. */
export async function resumeSession(file, chosen) {
  if (chosen !== file) {
    await newSession(file);
    await rename(chosen, file);
  }
  return loadHistory(file);
}

/** One task (or a follow-up): streams Ask's answer and does its tool calls here. `keepAs`: what the task's history keeps of the request. */
async function runTask(ctx, prompt, { keepAs = prompt, files = [] } = {}) {
  const { site, key, root, input, state } = ctx;
  const abort = new AbortController();
  // What the person adds while this runs: passed on with the steps' results, and kept with the request.
  const added = [];
  const kept = () => (added.length ? `${keepAs}\n\n[Added while Ask worked:]\n${added.join('\n')}` : keepAs);
  input.running = true;
  let commandAbort = null;
  let runId = null;
  input.onInterrupt = () => {
    print(dim(`\n${tx('Stopping…')}`));
    commandAbort?.abort();
    // Tell the server first: it stops the run at once (a dropped connection reaches it late).
    if (runId) void api(site, key, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }).catch(() => {});
    abort.abort();
  };
  let allowAll = false;
  let answer = '';
  let midLine = false;
  const started = Date.now();
  const out = (s) => {
    process.stdout.write(s);
    midLine = !s.endsWith('\n');
  };
  const newline = () => midLine && out('\n');
  const spin = spinner();
  let afterTool = false;
  let res;
  spin.start();
  const { text: notes } = await gatherNotes(root);
  const memory = ctx.memoryDir ? await readMemory(ctx.memoryDir) : undefined;
  const env = await folderNow(root);
  const steps = [];
  try {
    res = await api(site, key, '/v1/code', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        ...(state.model ? { model: state.model } : {}),
        folder: basename(root),
        history: state.history,
        ...(notes ? { notes: notes.slice(0, NOTES_CHARS) } : {}),
        ...(memory !== undefined ? { memory } : {}),
        env,
        ...(files.length ? { files } : {}),
        commands: true,
        ...(ctx.browser ? { browser: true } : {}),
      }),
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
  } catch (e) {
    spin.stop();
    input.onInterrupt = null;
    input.running = false;
    if (input.notes.length) input.lines.push(input.notes.splice(0).join('\n'));
    if (abort.signal.aborted) return;
    print(red(safe(e.message)));
    return;
  }
  let usage = null;
  let finished = false;
  let failed = null;
  let shownState = null;
  try {
    for await (const { event, data } of events(res)) {
      if (event !== 'status' && event !== 'limits' && event !== 'usage' && event !== 'folded') spin.stop();
      if (event === 'status') {
        if (data.runId) runId = data.runId;
        if (data.state !== shownState && (data.state === 'queued' || data.state === 'thinking') && !answer) {
          spin.stop();
          newline();
          out(dim(`${data.state === 'queued' ? tx('Waiting for a free slot ({n} ahead)…', { n: data.position ?? 1 }) : tx('Thinking…')}\n`));
          spin.start();
        }
        shownState = data.state;
      } else if (event === 'delta') {
        if (afterTool) out('\n'); // a blank line between the steps and Ask's words
        afterTool = false;
        answer += data.text;
        out(safe(data.text));
      } else if (event === 'tool') {
        newline();
        const result = await doTool(ctx, data, { allowAll: () => allowAll, setAllowAll: () => (allowAll = true), setCommandAbort: (a) => (commandAbort = a) });
        steps.push(stepNote(data.name, data.input ?? {}, result));
        if (abort.signal.aborted) break;
        try {
          const notes = input.notes.splice(0);
          added.push(...notes);
          const output = notes.length ? `${result.output}\n\n[The person added this while you worked; take it into account now:]\n${notes.join('\n')}` : result.output;
          await api(site, key, `/v1/code/${encodeURIComponent(data.runId)}/tools/${encodeURIComponent(data.callId)}`, { method: 'POST', body: JSON.stringify({ ok: result.ok, output, ...(result.images?.length ? { images: result.images } : {}) }) });
        } catch (e) {
          print(red(`  ${tx('Couldn’t send that back: {err}', { err: safe(e.message) })}`));
        }
        afterTool = true;
        spin.start();
      } else if (event === 'web') {
        // Ask looking something up with its own web tools: a line for each search (not again for its results) and page.
        if (data.tool === 'web_fetch' || !data.results) {
          newline();
          const what = data.tool === 'web_search' ? tx('Searched the web: “{q}”', { q: String(data.query ?? '') }) : tx('Opened {page}', { page: String(data.url ?? '').replace(/^https?:\/\/(www\.)?/, '') });
          print(dim(`  • ${safe(what)}`));
          afterTool = true;
        }
        spin.start();
      } else if (event === 'folded') {
        // A long task: its oldest turns are notes now (the site keeps nothing; this computer keeps the notes).
        state.history = applyFolded(state.history, data);
        if (ctx.historyFile) await saveHistory(ctx.historyFile, state.history, state.title, state.inputs).catch(() => {});
        newline();
        out(dim(`✻ ${tx('Compacted: the earliest part of this task is now short notes, so Ask keeps the point at a fraction of the tokens. Your files, ASK.md and Ask’s memory are untouched.')}\n`));
      } else if (event === 'usage') usage = data;
      else if (event === 'limits') state.limits = data;
      else if (event === 'done') finished = true;
      else if (event === 'error') failed = data;
    }
  } catch (e) {
    if (!abort.signal.aborted) failed = { message: tx('The connection dropped ({err}). Ask again to carry on.', { err: e.message }) };
  }
  spin.stop();
  input.onInterrupt = null;
  input.running = false;
  // Added after Ask's last step: it's the next request, sent as soon as this one is wrapped up.
  const left = input.notes.splice(0);
  if (left.length) input.lines.push(left.join('\n'));
  newline();
  // What the answer did goes with it, in one line: later requests know it without the files' contents.
  const did = stepsLine(steps);
  const withSteps = (text) => (did ? `${text}\n\n${did}` : text);
  if (abort.signal.aborted) {
    print(dim(tx('Stopped. Say what to do next, or /new to start over.')));
    if (answer || did) await keep(ctx, kept(), withSteps(`${answer}\n(stopped)`));
    return;
  }
  // Closed with neither `done` nor `error`: the connection dropped on the way (a Code step can't be picked up).
  if (!finished && !failed) failed = { message: 'The connection dropped before the step finished. Ask again to carry on.' };
  if (failed) {
    // What was written stays in the task (marked), so asking again carries on from it.
    if (answer || did) await keep(ctx, kept(), withSteps(`${answer}\n(cut off)`));
    print(red(safe(failed.message ? tx(failed.message) : tx('Something went wrong. Ask again.'))));
    if (failed.retryAt) print(dim(tx('You can carry on after {when}.', { when: new Date(failed.retryAt).toLocaleString(LANG === 'ru' ? 'ru-RU' : undefined) })));
    return;
  }
  if (usage) {
    state.used.requests++;
    state.used.input += usage.input ?? 0;
    state.used.output += usage.output ?? 0;
  }
  if (finished) {
    await keep(ctx, kept(), withSteps(answer));
    const secs = Math.round((Date.now() - started) / 1000);
    const bits = [tx('{s} s', { s: secs }), usage ? tx('{in} in · {out} out', { in: k(usage.input), out: k(usage.output) }) : '', limitsLine(state.limits)].filter(Boolean);
    print(dim(`\n${tx('— done · {bits}', { bits: bits.join(' · ') })}`));
    // A warning before it compacts.
    const left = contextLeft(state.history);
    if (left <= 25) print(dim(tx('Context left until auto-compact: {n}% (/compact now, or /clear for a new task)', { n: left })));
  }
}

/** How much room the task has before the site compacts its oldest part, in % (after its notes, as the site counts). */
export function contextLeft(history) {
  const rest = history[0]?.text === FOLDED_MARK ? history.slice(2) : history;
  return Math.max(0, Math.round(100 - (100 * taskTokens(rest)) / (TASK_TOKENS * COMPACT_AT)));
}

/** A finished (or stopped) step joins the task's history, here and in the folder's saved copy. */
async function keep(ctx, prompt, answer) {
  const { state } = ctx;
  state.history.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer });
  state.history = trimHistory(state.history);
  state.title ??= titleOf(prompt);
  if (ctx.historyFile) await saveHistory(ctx.historyFile, state.history, state.title, state.inputs).catch(() => {});
}

/**
 * A command's output as it comes, indented under it: the first lines, then (at the end) the last ones, where
 * errors usually are. Ask gets all of it.
 */
function outputLines() {
  const HEAD = 12;
  const TAIL = 8;
  let shown = 0;
  let more = 0;
  const last = [];
  let partial = '';
  const line = (l) => {
    if (shown < HEAD) {
      shown++;
      print(dim(`    │ ${safe(l)}`));
    } else {
      more++;
      last.push(l);
      if (last.length > TAIL) last.shift();
    }
  };
  return {
    add(s) {
      const parts = (partial + s).split(/\r?\n/);
      partial = parts.pop();
      parts.forEach(line);
    },
    end() {
      if (partial) line(partial);
      if (more > TAIL) print(dim(`    │ ${tx('… {n} more lines (Ask sees them all)', { n: more - TAIL })}`));
      last.forEach((l) => print(dim(`    │ ${safe(l)}`)));
    },
  };
}

// ─── Modes, ! and #, the commands ─────────────────────────────────────────────────────────────────

/**
 * Shift+Tab goes round these: every change asks · changes go in without asking · Ask builds without asking anything
 * (changes, commands, sites; --no-ask starts here) · a plan first, no changes.
 */
export const MODES = ['normal', 'edits', 'all', 'plan'];
/** Pictures with one request (the site's limit). */
const MAX_ATTACHED = 5;

const PLAN_NOTE = '[Plan mode: the person wants a plan before any change. Look at whatever you need (list, read, search), but don’t change files or run commands. End with a short numbered plan and ask whether to go ahead.]\n\n';
const INIT_PROMPT =
  'Look through this project and write ASK.md at its top level: notes for you, read with every later task here. What the project is, how to install, run, build and test it (the exact commands), the main folders and what’s in them, and the conventions to follow. Keep it short and to the point. If ASK.md is already there, improve it and keep what the person wrote.';
const REVIEW_PROMPT = 'Review the changes in this folder that aren’t committed yet (git status and git diff). Look for bugs, risks and anything unclear. Don’t change files: list what you would fix, most important first.';
// /compact: what's needed to carry on the work. Lasting facts belong in the memory, not here.
const COMPACT_PROMPT =
  'Write a summary of this task so far, to carry on from instead of the whole conversation, under these headings: Goal (what the person asked for, in their own words where it matters, and every later change of mind); ' +
  'Project (stack, structure, how to build, run and test it); Files (each file read, created or changed, and what changed in it); Commands and results (errors met and how they were fixed); ' +
  'Decisions (and why); Done so far; Still open (and the very next step). Keep exact file paths, names, commands, error messages and numbers. ' +
  'Use no tools. Write it in the language of the conversation, compact, at most about 700 words, and nothing else.';

/** A request as typed: with the pictures pasted (Ctrl+V) or dragged in, the "!" commands run since, and plan mode's note. */
async function request(ctx, typed) {
  const { state } = ctx;
  let prompt = typed;
  const files = state.pictures.splice(0);
  for (const d of droppedPictures(typed)) {
    if (files.length >= MAX_ATTACHED) break;
    const name = basename(d.path).slice(0, 100);
    try {
      files.push({ kind: 'image', name, ...(await attachPicture(d.path, name)) });
    } catch (e) {
      if (existsSync(d.path)) print(dim(`  • ${safe(e.shown ?? e.message)}`));
      continue; // not there: just words that look like a path
    }
    prompt = prompt.replace(d.text, `[${tx('Image #{n}', { n: files.length })}: ${name}]`);
    print(dim(`  • ${tx('Picture attached: {name}', { name: safe(name) })}`));
  }
  const ran = state.ran.length ? `[Commands the person ran in the folder themselves, with their output:]\n${state.ran.join('\n\n')}\n[End of their commands]\n\n` : '';
  state.ran = [];
  await runTask(ctx, `${ran}${state.mode === 'plan' ? PLAN_NOTE : ''}${prompt}`, { keepAs: `${ran}${prompt}`, files });
}

/** "!command": the person runs it in the folder themselves (so no question); Ask sees it with the next request. */
async function shell(ctx, command) {
  const { root, input, state } = ctx;
  if (!command) return print(dim(tx('Type a command after !, like !git status.')));
  const ac = new AbortController();
  input.onInterrupt = () => ac.abort();
  const shown = outputLines();
  const r = await runCommand(root, { command }, { signal: ac.signal, onOutput: shown.add });
  input.onInterrupt = null;
  shown.end();
  print(r.ok ? green(`  ✓ ${safe(r.shown)}`) : red(`  ✗ ${safe(r.shown ?? r.output)}`));
  if (touchesSecret(command)) return print(dim(`  ${tx('Its output stays here: the command reads a private file.')}`));
  state.ran.push(r.output.length > 10_000 ? `${r.output.slice(0, 3_000)}\n… (cut) …\n${r.output.slice(-6_000)}` : r.output);
  if (state.ran.length > 5) state.ran.shift();
  print(dim(`  ${tx('Ask sees this with your next request.')}`));
}

/**
 * /memory: ASK.md in the person's editor ($VISUAL or $EDITOR), made first if there's none; else shown here.
 * /memory user: yours for every folder (~/.config/ask-code/ASK.md).
 */
async function editNotes(ctx, which = '') {
  const { root, input } = ctx;
  // /memory auto: what Ask keeps on its own about this folder; /memory forget clears it.
  if (/^(auto|claude|память)$/i.test(which.trim())) {
    const index = await readMemory(ctx.memoryDir);
    const topics = (await readdir(ctx.memoryDir).catch(() => [])).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md');
    print(dim(tx('Ask’s memory of this folder (kept on this computer, never expires): {dir}', { dir: safe(ctx.memoryDir) })));
    print(index ? safe(index) : dim(tx('Nothing yet: Ask saves here what it learns about the project as it works.')));
    if (topics.length) print(dim(`${tx('Topics:')} ${safe(topics.join(', '))}`));
    return print(dim(tx('To change it, tell Ask (“forget that…”, “remember that…”); /memory forget clears it all.')));
  }
  if (/^(forget|clear|забыть|очистить)$/i.test(which.trim())) {
    if ((await confirm(input, tx('Clear everything Ask remembers about this folder? Your files and ASK.md stay.'), false)) !== 'yes') return print(dim(tx('Kept.')));
    await rm(ctx.memoryDir, { recursive: true, force: true });
    return print(green(tx('Cleared. Ask starts learning this folder again from the next task.')));
  }
  const personal = /^(user|my|me|personal|global|мой|мои|общий|все)$/i.test(which.trim());
  let full;
  try {
    if (personal) {
      full = personalNotesFile();
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    } else {
      const at = await inside(root, NOTES_FILE, { mustExist: false });
      checkFile(at.parts, at.full);
      full = at.full;
    }
  } catch (e) {
    return print(red(safe(e.shown ?? e.message)));
  }
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor || !input.terminal) {
    const notes = personal ? await readOuterNotes(full) : await readNotes(root);
    if (personal) print(dim(safe(full)));
    print(notes ? safe(notes.trimEnd()) : dim(tx(personal ? 'No notes for every folder yet.' : 'There’s no ASK.md here yet.')));
    return print(dim(tx(personal ? 'Set $EDITOR to open it here, or write it yourself: Ask reads it in every folder.' : 'To change it: # a note, /remember a note, /init to have Ask write it, or set $EDITOR to open it here.')));
  }
  if (!existsSync(full)) await writeFile(full, personal ? '# My notes for Ask\n\nFor every folder: how I like to work.\n\n' : '# Notes for Ask\n\nAbout this project, for every task here.\n\n');
  const code = await input.lend(
    () =>
      new Promise((done) => {
        const child =
          process.platform === 'win32' ? spawn(editor, [full], { stdio: 'inherit', shell: true }) : spawn('/bin/sh', ['-c', `${editor} "$1"`, 'sh', full], { stdio: 'inherit' });
        child.on('error', () => done(-1));
        child.on('close', (c) => done(c));
      }),
  );
  print(code === 0 ? green(tx(personal ? 'Saved: Ask reads it with every task, in every folder.' : 'ASK.md saved: Ask reads it with every task in this folder.')) : red(tx('Couldn’t open {editor}. Check $EDITOR.', { editor: safe(editor) })));
}

/** One answer without doing anything in the folder (for /compact), or null. */
async function quietAsk(ctx, prompt) {
  const { site, key, input, state } = ctx;
  const abort = new AbortController();
  input.onInterrupt = () => abort.abort();
  const spin = spinner();
  spin.start();
  let text = '';
  let done = false;
  try {
    const res = await api(site, key, '/v1/code', { method: 'POST', body: JSON.stringify({ prompt, ...(state.model ? { model: state.model } : {}), history: state.history, commands: true }), headers: { accept: 'text/event-stream' }, signal: abort.signal });
    for await (const { event, data } of events(res)) {
      if (event === 'delta') text += data.text;
      else if (event === 'tool')
        await api(site, key, `/v1/code/${encodeURIComponent(data.runId)}/tools/${encodeURIComponent(data.callId)}`, { method: 'POST', body: JSON.stringify({ ok: false, output: 'Not now: write it from the conversation alone, with no tools.' }) }).catch(() => {});
      else if (event === 'usage') {
        state.used.requests++;
        state.used.input += data.input ?? 0;
        state.used.output += data.output ?? 0;
      } else if (event === 'limits') state.limits = data;
      else if (event === 'done') done = true;
      else if (event === 'error') break;
    }
  } catch {
    // stopped, or the connection dropped: nothing changes
  } finally {
    spin.stop();
    input.onInterrupt = null;
  }
  return done && text.trim() ? text.trim() : null;
}

/** /compact: the task so far folded into a short summary that stands in for it (room for more, and the point kept). */
async function compact(ctx, focus) {
  const { state } = ctx;
  if (state.history.length < 4) return print(dim(tx('Nothing to fold yet: the task is short.')));
  print(dim(tx('Folding the task into a summary…')));
  const summary = await quietAsk(ctx, `${COMPACT_PROMPT}${focus ? `\nKeep in particular: ${focus}` : ''}`);
  if (!summary) return print(red(tx('Couldn’t fold it this time. The task is as it was.')));
  const n = Math.ceil(state.history.length / 2);
  state.history = [
    { role: 'user', text: FOLDED_MARK },
    { role: 'assistant', text: summary },
  ];
  if (ctx.historyFile) await saveHistory(ctx.historyFile, state.history, state.title, state.inputs).catch(() => {});
  print(green(tx('Folded {requests} into a summary: Ask carries on from it.', { requests: tx(n === 1 ? '1 request' : '{n} requests', { n }) })));
}

/** /export [file]: the task as Markdown, in the folder (never over a file that's there). */
async function exportTask(ctx, name) {
  const { root, state } = ctx;
  if (!state.history.length) return print(dim(tx('Nothing to save yet.')));
  const file = name || `ask-code-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`;
  try {
    const { full, parts, rel } = await inside(root, file, { mustExist: false });
    checkFile(parts, full);
    const md = [`# ${state.title ?? 'ask-code'}`, '', ...state.history.map((h) => `**${h.role === 'user' ? tx('You') : 'Ask'}:** ${h.text}\n`)].join('\n');
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, md, { flag: 'wx' });
    print(green(tx('Saved the task in {rel}.', { rel: safe(rel) })));
  } catch (e) {
    print(red(e.code === 'EEXIST' ? tx('{file} is already there. Give another name, like /export notes.md.', { file: safe(file) }) : safe(e.shown ?? e.message)));
  }
}

/** /doctor: what this computer and the site give ask-code, and what to do about anything missing. */
async function doctor(ctx, me) {
  const { site, key, root, input } = ctx;
  const ok = (s) => print(`  ${green('✓')} ${s}`);
  const no = (s, fix) => print(`  ${red('✗')} ${s}${fix ? dim(` · ${fix}`) : ''}`);
  ok(`Node ${process.versions.node}`);
  try {
    await api(site, key, '/v1/me');
    ok(tx('{site} answers and knows your key', { site }));
  } catch (e) {
    no(tx('{site}: {err}', { site, err: safe(e.message) }));
  }
  if (me.code) ok(tx('Code is on your plan'));
  const mac = process.platform === 'darwin';
  if (mac || findTool('magick') || findTool('convert')) ok(tx('Pictures of any kind can be read'));
  else no(tx('Only PNG, JPG, GIF and WebP pictures can be read'), tx('install ImageMagick for the rest'));
  if (mac || findTool('pdftotext')) ok(tx('PDFs can be read'));
  else no(tx('PDFs can’t be read'), tx('install poppler (pdftotext)'));
  if (clipboardTool()) ok(tx('Ctrl+V pastes pictures'));
  else no(tx('Ctrl+V can’t paste pictures'), tx('install wl-clipboard or xclip, or drag the picture’s file in'));
  if (input.terminal) ok(tx('Keys: ↑, Ctrl+R, Tab, Shift+Tab, Esc work here'));
  else no(tx('Input comes from a pipe, so the keys don’t work'), tx('run it in a terminal window'));
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) ok(tx('/memory opens ASK.md in {editor}', { editor: safe(editor) }));
  else no(tx('/memory shows ASK.md here'), tx('set $EDITOR to edit it in your editor'));
  if (await readNotes(root)) ok(tx('ASK.md: Ask reads it with every task'));
  else no(tx('No ASK.md yet'), tx('/init has Ask write one'));
}

/** /bug: tells the site's team what went wrong (your words and versions only, nothing from the folder). */
async function bug(ctx, text) {
  const { site, key, input } = ctx;
  if (!text) text = (await input.ask(`${tx('What went wrong? (Enter: never mind)')} `))?.trim();
  if (!text) return;
  try {
    const r = await (await api(site, key, '/v1/reports', { method: 'POST', body: JSON.stringify({ text: text.slice(0, 2000), context: { page: 'ask-code', lang: LANG, app: `ask-code/${VERSION}`, about: `${process.platform} · Node ${process.versions.node}` } }) })).json();
    print(green(tx('Sent (report #{id}). Thank you!', { id: safe(r.id) })));
  } catch (e) {
    print(red(tx('Couldn’t send it: {err}', { err: safe(e.message) })));
  }
}

// ─── The browser (--browser or /browser): a visible window Ask drives ────────────────────────────────
// Chrome, Edge, Chromium or Brave from this computer, started with a profile of its own (~/.config/ask-code/browser):
// none of your logins, cookies or saved passwords are in it. ask-code drives it through the browser's built-in remote
// control (the DevTools Protocol), on this computer only. Pages on this computer open at once; any other site asks you
// first. Ask never types into a password or card field: you type those in the window yourself.

const BROWSER_MAC = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser'];
const BROWSER_WIN = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe'];
const BROWSER_LINUX = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
export const BROWSER_ACTIONS = ['open', 'screenshot', 'click', 'type', 'press', 'scroll', 'read', 'console', 'back', 'viewport', 'handoff', 'close'];
/** Actions that only look: allowed in plan mode too. */
const BROWSER_LOOKS = new Set(['open', 'screenshot', 'scroll', 'read', 'console', 'back', 'viewport', 'handoff']);
const PAGE_TEXT_CHARS = 30_000;

/** The browser to drive: ASK_BROWSER, else the first Chrome-like one installed. Null: none. */
export function findBrowser(platform = process.platform, env = process.env, exists = existsSync, home = homedir()) {
  if (env.ASK_BROWSER) return exists(env.ASK_BROWSER) ? env.ASK_BROWSER : null;
  if (platform === 'darwin') return [...BROWSER_MAC.map((p) => `/Applications/${p}`), ...BROWSER_MAC.map((p) => join(home, 'Applications', p))].find((p) => exists(p)) ?? null;
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) for (const rel of BROWSER_WIN) if (exists(`${r}\\${rel}`)) return `${r}\\${rel}`;
    return null;
  }
  for (const n of BROWSER_LINUX) {
    const p = findTool(n, env.PATH ?? '');
    if (p) return p;
  }
  return null;
}

/** A typed address as a URL: "example.com" → https://example.com/, "localhost:3000" → http://localhost:3000/. */
export function browserUrl(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)/i.test(s)) {
    try {
      return new URL(s).href;
    } catch {
      return null;
    }
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(s);
  try {
    return new URL(`${local ? 'http' : 'https'}://${s}`).href;
  } catch {
    return null;
  }
}

/** On this computer: localhost and the like (a dev server), or about:blank. These open without asking. */
export function isLocalPage(url) {
  try {
    const u = new URL(url);
    if (u.href === 'about:blank') return true;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname) || u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Why this address can't be opened at all, or null. Web pages and this computer's dev servers are fine; a file must be
 * in the project folder and not a secret (a page could show what's in it); the browser's own pages and scripts never.
 */
export async function refusedUrl(root, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'That isn’t a web address. Give one like https://example.com or http://localhost:3000.';
  }
  if (u.href === 'about:blank' || u.protocol === 'http:' || u.protocol === 'https:') return null;
  if (u.protocol === 'file:') {
    const path = decodeURIComponent(u.pathname);
    try {
      const rel = relativeInside(root, path);
      if (rel == null) return 'Only files in the project folder can be opened in the browser.';
      if (isSecret(basename(rel))) return 'That’s a private file (.env or a key): it isn’t opened.';
      return null;
    } catch {
      return 'Only files in the project folder can be opened in the browser.';
    }
  }
  return `Only web pages (http, https) and files in the project folder open in this window, not ${u.protocol} addresses.`;
}

function relativeInside(root, path) {
  const full = resolve(path);
  const base = root.endsWith(sep) ? root : root + sep;
  return full === root ? '' : full.startsWith(base) ? full.slice(base.length) : null;
}

/** A host that needs the person's Allow before Ask's window goes there (null: local, or nothing to ask). */
export function siteOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? (isLocalPage(url) ? null : u.host.toLowerCase()) : null;
  } catch {
    return null;
  }
}

const KEY_CODES = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowDown: [40], ArrowUp: [38], ArrowLeft: [37], ArrowRight: [39], PageDown: [34], PageUp: [33], Home: [36], End: [35], Space: [32, ' '] };

// Run in the page. Finds an element by CSS selector, or by its words ("text=Book now"), scrolls it into view and says
// where its middle is.
const FIND_IN_PAGE = `(sel) => {
  const seen = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  let el = null;
  if (sel.startsWith('text=')) {
    const want = sel.slice(5).trim().toLowerCase();
    const words = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase();
    const all = [...document.querySelectorAll('a,button,input,select,textarea,label,summary,option,[role],[onclick],li,td,th,span,div,p,h1,h2,h3,h4')].filter(seen);
    el = all.find((e) => words(e) === want) || all.filter((e) => words(e).includes(want)).sort((a, b) => words(a).length - words(b).length)[0] || null;
  } else el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80) };
}`;

// Run in the page. True when the focused field is for a password or a card: Ask doesn't type there.
const PRIVATE_FIELD = `(() => {
  const e = document.activeElement;
  if (!e || !('value' in e)) return false;
  const type = (e.type || '').toLowerCase();
  const ac = (e.autocomplete || '').toLowerCase();
  const id = ((e.name || '') + ' ' + (e.id || '')).toLowerCase();
  return type === 'password' || ac.startsWith('cc-') || ac.includes('password') || /card.?num|cvc|cvv|security.?code|passw/.test(id);
})()`;

// ─── Captchas: the person's to solve, never Ask's ────────────────────────────────────────────────────────────
// Run in the page: what could be a captcha (frames and boxes you can see, the first words), and whether one is answered.
const CAPTCHA_SIGNS = `(() => {
  const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1; };
  const frames = [...document.querySelectorAll('iframe')].filter(shown).map((f) => f.src || '').slice(0, 40);
  const boxes = [...document.querySelectorAll('.g-recaptcha,.h-captcha,.cf-turnstile,.smart-captcha,[data-sitekey],img[src*="captcha" i],img[id*="captcha" i],img[alt*="captcha" i],input[name*="captcha" i]')].filter(shown);
  const marks = boxes.length;
  const mark = boxes.map((e) => (e.matches('.g-recaptcha') ? 'reCAPTCHA' : e.matches('.h-captcha') ? 'hCaptcha' : e.matches('.cf-turnstile') ? 'Cloudflare' : e.matches('.smart-captcha') ? 'Yandex SmartCaptcha' : '')).find(Boolean) || '';
  const solved = [...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"],[name="smart-token"]')].some((e) => !!e.value);
  const inputs = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(shown).length;
  const text = (document.title || '') + '\\n' + (document.body ? document.body.innerText.slice(0, 3000) : '');
  const words = document.body ? (document.body.innerText.match(/\\S+/g) || []).length : 0;
  return { frames, marks, mark, solved, inputs, text, words };
})()`;

const CAPTCHA_FRAMES = [
  [/google\.com\/recaptcha\/|recaptcha\.net\/recaptcha\//, 'reCAPTCHA'],
  [/hcaptcha\.com\//, 'hCaptcha'],
  [/challenges\.cloudflare\.com\//, 'Cloudflare'],
  [/smartcaptcha|captcha-api\.yandex/i, 'Yandex SmartCaptcha'],
  [/arkoselabs\.com|funcaptcha\.com/, 'Arkose'],
  [/geetest\.com/, 'GeeTest'],
];
const HUMAN_CHECK = /just a moment\.\.\.|checking (if the site connection is secure|your browser)|verify (that )?you are (a )?human|i['’]?m not a robot|я не робот|подтвердите, что вы (не робот|человек)|проверка браузера|введите (символы|код|текст) с (картинки|изображения)|enter the (characters|code|text) (you see|from the image|shown)/i;

/**
 * A captcha on the page (from CAPTCHA_SIGNS): null, or `{ kind, blocking }`. Blocking: it stands between the person
 * and the page (a check page, a picture puzzle open), so it needs them now; otherwise it's a box on a form, theirs to
 * tick once the rest is filled in. An answered one, an invisible one (reCAPTCHA v3) or a site's "protected by
 * reCAPTCHA" line is none.
 */
export function captchaOn(signs) {
  if (!signs || signs.solved) return null;
  let kind = null;
  let puzzle = false;
  for (const src of signs.frames ?? []) {
    if (/size=invisible/.test(src)) continue;
    const hit = CAPTCHA_FRAMES.find(([re]) => re.test(src));
    if (!hit) continue;
    kind ??= hit[1];
    if (/\/bframe|frame=challenge/.test(src)) puzzle = true;
  }
  const words = HUMAN_CHECK.test(String(signs.text ?? '').slice(0, 3000));
  if (!kind && !signs.marks && !words) return null;
  const checkPage = words && (signs.inputs ?? 0) <= 1 && (signs.words ?? 0) < 400;
  return { kind: kind ?? (signs.mark || 'a human check'), blocking: puzzle || checkPage };
}

/** How long the person has to finish a hand-off (the relay waits 10 min for a step). */
const HANDOFF_MS = 8 * 60_000;

// Run in the page: what's on it, as text, for Ask to read (no picture).
const READ_PAGE = `(() => {
  const seen = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const links = [...document.querySelectorAll('a[href]')].filter(seen).slice(0, 150).map((a) => (a.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80) || a.getAttribute('aria-label') || '(no text)') + ' → ' + a.href);
  const fields = [...document.querySelectorAll('input,select,textarea,button')].filter(seen).slice(0, 80).map((e) => {
    const label = (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || e.innerText || e.value || '';
    const sel = e.id ? '#' + CSS.escape(e.id) : e.name ? e.tagName.toLowerCase() + '[name="' + e.name + '"]' : '';
    return e.tagName.toLowerCase() + (e.type ? ' ' + e.type : '') + ': ' + label.trim().replace(/\\s+/g, ' ').slice(0, 60) + (sel ? '  (' + sel + ')' : '');
  });
  return { title: document.title, url: location.href, text: document.body ? document.body.innerText : '', links, fields };
})()`;

/** The DevTools Protocol over one WebSocket: commands with answers, and events. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.waiting = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (m) => {
      let msg;
      try {
        msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg.id && this.waiting.has(msg.id)) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message));
        else w.resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const w of this.waiting.values()) w.reject(new Error('The browser window was closed.'));
      this.waiting.clear();
    });
  }
  send(method, params = {}, ms = 30_000) {
    if (this.closed) return Promise.reject(new Error('The browser window was closed.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser didn’t answer (${method}).`));
      }, ms);
      this.waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** The next `method` event within `ms`, or null. */
  once(method, ms) {
    return new Promise((resolve) => {
      const l = (m) => {
        if (m.method !== method) return;
        clearTimeout(timer);
        this.listeners.delete(l);
        resolve(m.params);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        resolve(null);
      }, ms);
      this.listeners.add(l);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The window Ask drives. Started on its first use in a task, closed when ask-code quits. */
export class AskBrowser {
  constructor(root, { dir = join(homedir(), '.config', 'ask-code', 'browser'), bin = findBrowser(), headless = false } = {}) {
    this.root = root;
    this.dir = dir;
    this.bin = bin;
    this.headless = headless;
    this.cdp = null;
    this.proc = null;
    this.logs = [];
  }

  async start() {
    if (this.cdp && !this.cdp.closed) return;
    if (typeof WebSocket !== 'function') throw new Error('The browser needs Node 22 or newer on this computer (nodejs.org). Ask the person to update Node.');
    if (!this.bin) throw new Error('There’s no Chrome, Edge, Chromium or Brave on this computer. Ask the person to install Google Chrome, or to set ASK_BROWSER to their browser’s path.');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const portFile = join(this.dir, 'DevToolsActivePort');
    // A window from an earlier run that's still open: use it again (the same profile can't be opened twice).
    let port = await this.livePort(portFile);
    if (!port) {
      await rm(portFile, { force: true });
      const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${this.dir}`, '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--window-size=1280,860', ...(this.headless ? ['--headless=new'] : []), 'about:blank'];
      this.proc = spawn(this.bin, args, { stdio: 'ignore' });
      this.proc.on('exit', () => (this.proc = null));
      this.proc.on('error', () => (this.proc = null));
      for (let i = 0; i < 150 && !port; i++) {
        await pause(100);
        port = await this.livePort(portFile);
      }
      if (!port) throw new Error('The browser didn’t start. Ask the person to close any window of it that hangs, then try again.');
    }
    this.port = port;
    const base = `http://127.0.0.1:${port}`;
    const targets = await (await fetch(`${base}/json/list`)).json();
    let page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) page = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error('Couldn’t connect to the browser window.')), { once: true });
    });
    this.cdp = new Cdp(ws);
    this.cdp.listeners.add((m) => this.onEvent(m));
    await Promise.all([this.cdp.send('Page.enable'), this.cdp.send('Runtime.enable'), this.cdp.send('Log.enable')]);
  }

  /** The port a running window of this profile listens on, or null. */
  async livePort(portFile) {
    const port = Number((await readFile(portFile, 'utf8').catch(() => '')).split('\n')[0]);
    if (!port) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      return r.ok ? port : null;
    } catch {
      return null;
    }
  }

  onEvent(m) {
    const p = m.params ?? {};
    if (m.method === 'Runtime.consoleAPICalled') this.log(`${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    else if (m.method === 'Runtime.exceptionThrown') this.log(`error: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'an error'}`);
    else if (m.method === 'Log.entryAdded' && p.entry?.level !== 'verbose') this.log(`${p.entry?.level}: ${p.entry?.text}${p.entry?.url ? ` (${p.entry.url})` : ''}`);
  }

  log(line) {
    this.logs.push(String(line).slice(0, 1000));
    if (this.logs.length > 200) this.logs.shift();
  }

  async evaluate(expression) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  /** Waits for the page to finish loading (after a click that navigates, say), up to 15 s. */
  async settle() {
    await pause(300);
    for (let i = 0; i < 60; i++) {
      const state = await this.evaluate('document.readyState').catch(() => 'loading');
      if (state === 'complete') break;
      await pause(250);
    }
    await pause(200);
  }

  async here() {
    return (await this.evaluate('({ url: location.href, title: document.title })').catch(() => null)) ?? { url: '', title: '' };
  }

  captchaSigns() {
    return this.evaluate(CAPTCHA_SIGNS);
  }

  /** The window in front of the person (a hand-off). */
  async front() {
    await this.cdp.send('Page.bringToFront');
  }

  /** What Ask sees after a step: where the window is, and a picture of it. */
  async view(said) {
    const { url, title } = await this.here();
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    return { ok: true, output: `${said ? `${said}\n` : ''}Now at: ${url}\nTitle: ${title}`, images: [{ mediaType: 'image/jpeg', data: shot.data }] };
  }

  async open(url) {
    const loaded = this.cdp.once('Page.loadEventFired', 20_000);
    const r = await this.cdp.send('Page.navigate', { url });
    if (r.errorText) return { ok: false, output: `Couldn’t open ${url}: ${r.errorText}. If it’s the person’s own site, is its server running?` };
    await loaded;
    await this.settle();
    return this.view(`Opened ${url}.`);
  }

  async find(selector) {
    const at = await this.evaluate(`(${FIND_IN_PAGE})(${JSON.stringify(String(selector))})`);
    if (!at) throw new Error(`Nothing on the page matches ${selector}. Use read to see the page’s links and fields, or click by x and y from the screenshot.`);
    return at;
  }

  async clickAt(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** One step. Allow checks (a site, a private field) are the caller's: see browserStep. */
  async act(args) {
    const action = String(args.action ?? '');
    if (action === 'close') {
      await this.close();
      return { ok: true, output: 'The browser window is closed. Opening a page starts it again.' };
    }
    await this.start();
    if (action === 'open') return this.open(args.url);
    if (action === 'screenshot') return this.view('');
    if (action === 'click') {
      let said;
      if (args.selector) {
        const at = await this.find(args.selector);
        await this.clickAt(at.x, at.y);
        said = `Clicked ${at.tag}${at.text ? ` “${at.text}”` : ''}.`;
      } else if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
        await this.clickAt(args.x, args.y);
        said = `Clicked at ${Math.round(args.x)}, ${Math.round(args.y)}.`;
      } else return { ok: false, output: 'Say what to click: a selector (CSS, or text=Words on it) or x and y from the screenshot.' };
      await this.settle();
      return this.view(said);
    }
    if (action === 'type') {
      if (args.selector) {
        const at = await this.find(args.selector);
        await this.clickAt(at.x, at.y);
      }
      if (await this.evaluate(PRIVATE_FIELD).catch(() => false)) return { ok: false, output: 'private', private: true };
      await this.cdp.send('Input.insertText', { text: String(args.text ?? '') });
      await pause(200);
      return this.view(`Typed ${String(args.text ?? '').length} characters.`);
    }
    if (action === 'press') {
      const key = String(args.key ?? 'Enter');
      const [code, text] = KEY_CODES[key] ?? [0, key.length === 1 ? key : undefined];
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, ...(text ? { text } : {}) };
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await this.settle();
      return this.view(`Pressed ${key}.`);
    }
    if (action === 'scroll') {
      const size = (await this.evaluate('({ w: innerWidth, h: innerHeight })')) ?? { w: 800, h: 600 };
      const dy = Number.isFinite(args.dy) ? args.dy : Math.round(size.h * 0.8);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: size.w / 2, y: size.h / 2, deltaX: 0, deltaY: dy });
      await pause(400);
      return this.view(`Scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)} px.`);
    }
    if (action === 'read') {
      const p = await this.evaluate(READ_PAGE);
      const text = (p.text ?? '').replace(/\n{3,}/g, '\n\n');
      return {
        ok: true,
        output:
          `Now at: ${p.url}\nTitle: ${p.title}\n\n${text.slice(0, PAGE_TEXT_CHARS)}${text.length > PAGE_TEXT_CHARS ? `\n… (${text.length - PAGE_TEXT_CHARS} more characters: scroll, or look at parts with click and screenshot)` : ''}` +
          `\n\nLinks:\n${p.links.join('\n') || '(none)'}\n\nFields and buttons:\n${p.fields.join('\n') || '(none)'}`,
      };
    }
    if (action === 'console') {
      const lines = this.logs.splice(0);
      return { ok: true, output: lines.length ? lines.join('\n') : 'Nothing in the console since the last look.' };
    }
    if (action === 'back') {
      await this.evaluate('history.back()');
      await this.settle();
      return this.view('Went back.');
    }
    if (action === 'viewport') {
      const width = Math.round(Number(args.width) || 0);
      const height = Math.round(Number(args.height) || 0);
      if (!width) {
        await this.cdp.send('Emulation.clearDeviceMetricsOverride');
        await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        return this.view('Back to the window’s own size.');
      }
      const phone = width < 700;
      await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: height || (phone ? 800 : 900), deviceScaleFactor: phone ? 2 : 1, mobile: phone });
      await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: phone });
      await this.settle();
      return this.view(`The page is ${width} px wide now${phone ? ', like a phone' : ''}.`);
    }
    return { ok: false, output: `There’s no browser action “${action}”. Use one of: ${BROWSER_ACTIONS.join(', ')}.` };
  }

  /**
   * A page's words, from a tab of its own that closes after (the window Ask works in stays where it is). Watches use it:
   * the same profile, so a site the person signed in to in Ask's window stays signed in here.
   */
  async pageText(url) {
    await this.start();
    const base = `http://127.0.0.1:${this.port}`;
    const tab = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error('Couldn’t open a tab for the check.')), { once: true });
    });
    const cdp = new Cdp(ws);
    try {
      await cdp.send('Page.enable');
      const loaded = cdp.once('Page.loadEventFired', 30_000);
      const r = await cdp.send('Page.navigate', { url });
      if (r.errorText) throw new Error(r.errorText);
      await loaded;
      await pause(1500); // pages that fill themselves in after loading
      const v = await cdp.send('Runtime.evaluate', { expression: `({ title: document.title, text: document.body ? document.body.innerText : "", signs: ${CAPTCHA_SIGNS} })`, returnByValue: true });
      return v.result?.value ?? { title: '', text: '' };
    } finally {
      cdp.close();
      await fetch(`${base}/json/close/${tab.id}`).catch(() => {});
    }
  }

  async close() {
    const proc = this.proc;
    const gone = proc ? new Promise((r) => proc.once('exit', r)) : null;
    if (this.cdp && !this.cdp.closed) await this.cdp.send('Browser.close', {}, 3000).catch(() => {});
    this.cdp?.close();
    this.cdp = null;
    // Ours: wait until it's really gone (it writes its profile on the way out), then make sure.
    if (proc && gone) await Promise.race([gone, pause(5000)]);
    proc?.kill();
    this.proc = null;
  }
}

// ─── Safari (macOS): the person's own Safari, driven through AppleScript ─────────────────────────────────────
// Ask works in a Safari window of its own, with Safari's sign-ins (a site the person is signed in to stays signed
// in): a real browser a site already trusts. It needs Safari's «Allow JavaScript from Apple Events» (Develop menu)
// and, once, macOS's yes for this terminal to control Safari; pictures of the window need Screen Recording.

/** Run in the page: the element a selector (CSS, or text=Words on it) names, or null. */
const PICK_EL = `(sel) => {
  const seen = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  if (!sel.startsWith('text=')) return document.querySelector(sel);
  const want = sel.slice(5).trim().toLowerCase();
  const words = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase();
  const all = [...document.querySelectorAll('a,button,input,select,textarea,label,summary,option,[role],[onclick],li,td,th,span,div,p,h1,h2,h3,h4')].filter(seen);
  return all.find((e) => words(e) === want) || all.filter((e) => words(e).includes(want)).sort((a, b) => words(a).length - words(b).length)[0] || null;
}`;

/** Run in the page after it loads: errors kept for the `console` action (Safari doesn't share its console). */
const SAFARI_LOG = `(() => { if (window.__askLog) return; window.__askLog = []; addEventListener('error', (e) => window.__askLog.push('error: ' + e.message)); const o = console.error; console.error = (...a) => { window.__askLog.push('error: ' + a.join(' ')); o.apply(console, a); }; })()`;

/** AppleScript: `script` run with `args` (as argv: nothing to escape), its result as text. */
export function osa(script, args = [], ms = 30_000) {
  return new Promise((done, fail) =>
    execFile('osascript', ['-e', `on run argv\n${script}\nend run`, ...args.map(String)], { timeout: ms, maxBuffer: 50 << 20 }, (err, out, errOut) =>
      err ? fail(new Error(String(errOut || err.message).trim())) : done(String(out).replace(/\n$/, '')),
    ),
  );
}

/** What a Safari error means for the person, in a sentence they can act on. */
export function safariProblem(message) {
  const m = String(message);
  if (/Allow JavaScript from Apple Events|JavaScript from Apple Events/i.test(m))
    return 'Safari doesn’t let Ask into its pages yet. In Safari: Settings → Advanced → turn on «Show features for web developers»; then the Develop menu → «Allow JavaScript from Apple Events». Then ask again.';
  if (/-1743|not authorized|Not authorised|isn’t allowed to send Apple events/i.test(m))
    return 'macOS didn’t let this terminal control Safari. System Settings → Privacy & Security → Automation → your terminal app → turn on Safari. Then ask again.';
  return null;
}

export class SafariBrowser {
  constructor(root) {
    this.root = root;
    this.win = null;
    this.kind = 'safari';
  }

  async start() {
    if (process.platform !== 'darwin') throw new Error('Safari is on Macs only. Use Chrome or Edge here: /browser chrome.');
    if (this.win && (await osa('tell application "Safari" to return (exists window id (item 1 of argv as integer))', [this.win]).catch(() => 'false')) === 'true') return;
    this.win = Number(await osa('tell application "Safari"\nmake new document with properties {URL:"about:blank"}\nreturn id of front window\nend tell'));
    try {
      await this.js('1');
    } catch (e) {
      throw new Error(safariProblem(e.message) ?? e.message);
    }
  }

  /** `expr` run in Ask's tab; its value (anything JSON can carry). */
  async js(expr) {
    let out;
    try {
      out = await osa('tell application "Safari" to do JavaScript (item 1 of argv) in current tab of window id (item 2 of argv as integer)', [`JSON.stringify((() => { return (${expr}); })())`, this.win]);
    } catch (e) {
      throw new Error(safariProblem(e.message) ?? e.message);
    }
    return out && out !== 'missing value' ? JSON.parse(out) : null;
  }

  async settle() {
    await pause(400);
    for (let i = 0; i < 60; i++) {
      if ((await this.js('document.readyState').catch(() => 'loading')) === 'complete') break;
      await pause(250);
    }
    await this.js(SAFARI_LOG).catch(() => {});
    await pause(300);
  }

  async here() {
    return (await this.js('({ url: location.href, title: document.title })').catch(() => null)) ?? { url: '', title: '' };
  }

  captchaSigns() {
    return this.js(CAPTCHA_SIGNS);
  }

  async front() {
    await osa('tell application "Safari"\nactivate\nset index of window id (item 1 of argv as integer) to 1\nend tell', [this.win]);
  }

  /** A picture of Ask's window (macOS asks once for Screen Recording; without it there's only the text). */
  async picture() {
    const b = (await osa('tell application "Safari" to return bounds of window id (item 1 of argv as integer)', [this.win]).catch(() => '')).split(/,\s*/).map(Number);
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) return null;
    return inTemp(async (dir) => {
      const file = join(dir, 'safari.jpg');
      await new Promise((ok, fail) => execFile('screencapture', ['-x', '-t', 'jpg', `-R${b[0]},${b[1]},${b[2] - b[0]},${b[3] - b[1]}`, file], { timeout: 15_000 }, (e) => (e ? fail(e) : ok())));
      await new Promise((ok) => execFile('sips', ['-Z', '1400', file], { timeout: 15_000 }, () => ok()));
      return (await readFile(file)).toString('base64');
    }).catch(() => null);
  }

  async view(said) {
    const { url, title } = await this.here();
    const data = await this.picture();
    return { ok: true, output: `${said ? `${said}\n` : ''}Now at: ${url}\nTitle: ${title}${data ? '' : '\n(No picture: macOS Screen Recording is off for this terminal. Use read to see the page.)'}`, ...(data ? { images: [{ mediaType: 'image/jpeg', data }] } : {}) };
  }

  async act(args) {
    const action = String(args.action ?? '');
    if (action === 'close') {
      await this.close();
      return { ok: true, output: 'Ask’s Safari window is closed. Opening a page starts a new one.' };
    }
    await this.start();
    const sel = JSON.stringify(String(args.selector ?? ''));
    if (action === 'open') {
      await osa('tell application "Safari" to set URL of current tab of window id (item 2 of argv as integer) to (item 1 of argv)', [args.url, this.win]);
      await this.settle();
      return this.view(`Opened ${args.url}.`);
    }
    if (action === 'screenshot') return this.view('');
    if (action === 'click') {
      if (!args.selector) return { ok: false, output: 'In Safari, say what to click by its words (text=Book now) or a CSS selector.' };
      const hit = await this.js(`(() => { const el = (${PICK_EL})(${sel}); if (!el) return null; el.scrollIntoView({ block: 'center' }); el.focus && el.focus(); el.click(); return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 80) }; })()`);
      if (!hit) return { ok: false, output: `Nothing on the page matches ${args.selector}. Use read to see the page’s links and fields.` };
      await this.settle();
      return this.view(`Clicked ${hit.tag}${hit.text ? ` “${hit.text}”` : ''}.`);
    }
    if (action === 'type') {
      if (args.selector) {
        const ok = await this.js(`(() => { const el = (${PICK_EL})(${sel}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); return true; })()`);
        if (!ok) return { ok: false, output: `Nothing on the page matches ${args.selector}. Use read to see the page’s fields.` };
      }
      if (await this.js(PRIVATE_FIELD).catch(() => false)) return { ok: false, output: 'private', private: true };
      const typed = await this.js(`(() => { const e = document.activeElement; const t = ${JSON.stringify(String(args.text ?? ''))}; if (!e) return false; if ('value' in e) { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set; set ? set.call(e, e.value + t) : (e.value += t); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; } if (e.isContentEditable) return document.execCommand('insertText', false, t); return false; })()`);
      if (!typed) return { ok: false, output: 'No field to type in: click one first, or give its selector.' };
      return this.view(`Typed ${String(args.text ?? '').length} characters.`);
    }
    if (action === 'press') {
      const key = String(args.key ?? 'Enter');
      await this.js(`(() => { const e = document.activeElement || document.body; const k = ${JSON.stringify(key)}; for (const type of ['keydown', 'keyup']) e.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true })); if (k === 'Enter' && e.form) e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit(); return true; })()`);
      await this.settle();
      return this.view(`Pressed ${key}.`);
    }
    if (action === 'scroll') {
      const dy = Number.isFinite(args.dy) ? args.dy : 600;
      await this.js(`(scrollBy(0, ${Number(dy)}), true)`);
      await pause(300);
      return this.view(`Scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)} px.`);
    }
    if (action === 'read') {
      const p = await this.js(READ_PAGE);
      const text = (p.text ?? '').replace(/\n{3,}/g, '\n\n');
      return {
        ok: true,
        output:
          `Now at: ${p.url}\nTitle: ${p.title}\n\n${text.slice(0, PAGE_TEXT_CHARS)}${text.length > PAGE_TEXT_CHARS ? `\n… (${text.length - PAGE_TEXT_CHARS} more characters)` : ''}` +
          `\n\nLinks:\n${p.links.join('\n') || '(none)'}\n\nFields and buttons:\n${p.fields.join('\n') || '(none)'}`,
      };
    }
    if (action === 'console') {
      const lines = (await this.js('(window.__askLog || []).splice(0)').catch(() => [])) ?? [];
      return { ok: true, output: lines.length ? lines.join('\n') : 'No errors on the page since the last look (Safari shares only the page’s errors).' };
    }
    if (action === 'back') {
      await this.js('(history.back(), true)');
      await this.settle();
      return this.view('Went back.');
    }
    if (action === 'viewport') {
      const width = Math.round(Number(args.width) || 1280);
      const height = Math.round(Number(args.height) || 860);
      await osa('tell application "Safari" to set bounds of window id (item 1 of argv as integer) to {40, 40, 40 + (item 2 of argv as integer), 40 + (item 3 of argv as integer)}', [this.win, width, height]);
      await this.settle();
      return this.view(`The window is ${width} px wide now.`);
    }
    return { ok: false, output: `There’s no browser action “${action}”. Use one of: ${BROWSER_ACTIONS.join(', ')}.` };
  }

  /** A page's words, from a tab of its own that closes after (for watches), with Safari's sign-ins. */
  async pageText(url) {
    await this.start();
    const out = await osa(
      `tell application "Safari"
set w to window id (item 2 of argv as integer)
set t to make new tab at end of tabs of w with properties {URL:(item 1 of argv)}
repeat 60 times
delay 0.5
try
if (do JavaScript "document.readyState" in t) is "complete" then exit repeat
end try
end repeat
delay 1.5
set r to do JavaScript (item 3 of argv) in t
close t
return r
end tell`,
      [url, this.win, `JSON.stringify({ title: document.title, text: document.body ? document.body.innerText : '', signs: ${CAPTCHA_SIGNS} })`],
      60_000,
    ).catch((e) => {
      throw new Error(safariProblem(e.message) ?? e.message);
    });
    return JSON.parse(out);
  }

  async close() {
    if (this.win) await osa('tell application "Safari" to close window id (item 1 of argv as integer)', [this.win]).catch(() => {});
    this.win = null;
  }
}

/** One line for the person: what Ask did in its window. */
function describeBrowser(args) {
  const a = String(args.action ?? '');
  if (a === 'open') return tx('Browser: opened {url}', { url: String(args.url ?? '') });
  if (a === 'click') return tx('Browser: clicked {what}', { what: args.selector ? String(args.selector) : `${Math.round(args.x ?? 0)}, ${Math.round(args.y ?? 0)}` });
  if (a === 'type') return tx('Browser: typed {n} characters', { n: String(args.text ?? '').length });
  if (a === 'press') return tx('Browser: pressed {key}', { key: String(args.key ?? 'Enter') });
  if (a === 'read') return tx('Browser: read the page');
  if (a === 'console') return tx('Browser: looked at the console');
  if (a === 'viewport') return tx('Browser: page width {w} px', { w: Number(args.width) || '—' });
  if (a === 'close') return tx('Browser: closed the window');
  if (a === 'handoff') return tx('Browser: handed over to you');
  return tx('Browser: looked at the page');
}

/** Words of a command line: "quoted", 'quoted' or «quoted» kept whole. */
function words(line) {
  return [...String(line).matchAll(/"([^"]*)"|'([^']*)'|«([^»]*)»|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/**
 * `ask-browser <action> …` as a browser step: open URL · screenshot · click "text=Book" | click CSS | click X Y ·
 * type "words" [--into SELECTOR] · press KEY · scroll [DY] · read · console · back · viewport W [H] | reset · close.
 * Null for any other command; `{ error }` for one that doesn't make sense.
 */
export function browserCommand(command) {
  const m = String(command).trim().match(/^ask-browser(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [action = '', ...rest] = words(m[1] ?? '');
  const num = (v) => v !== undefined && /^-?\d+(\.\d+)?$/.test(v);
  const usage = 'Use: ask-browser open URL | screenshot | click "text=Words" (or a CSS selector, or X Y) | type "words" [--into SELECTOR] | press KEY | scroll [DY] | read | console | back | viewport W [H] | viewport reset | handoff "what the person should do" | close';
  if (action === 'open') return rest[0] ? { args: { action, url: rest[0] } } : { error: `Say which address. ${usage}` };
  if (action === 'click') {
    if (rest.length === 2 && rest.every(num)) return { args: { action, x: Number(rest[0]), y: Number(rest[1]) } };
    return rest.length ? { args: { action, selector: rest.join(' ') } } : { error: `Say what to click. ${usage}` };
  }
  if (action === 'type') {
    const i = rest.indexOf('--into');
    const text = (i < 0 ? rest : rest.slice(0, i)).join(' ');
    const selector = i < 0 ? '' : rest.slice(i + 1).join(' ');
    return { args: { action, text, ...(selector ? { selector } : {}) } };
  }
  if (action === 'press') return { args: { action, key: rest[0] ?? 'Enter' } };
  if (action === 'handoff') return { args: { action, text: rest.join(' ') || 'Finish this step in the window' } };
  if (action === 'scroll') return { args: { action, ...(num(rest[0]) ? { dy: Number(rest[0]) } : {}) } };
  if (action === 'viewport') return { args: rest[0] === 'reset' || !num(rest[0]) ? { action } : { action, width: Number(rest[0]), ...(num(rest[1]) ? { height: Number(rest[1]) } : {}) } };
  if (['screenshot', 'read', 'console', 'back', 'close'].includes(action)) return { args: { action } };
  return { error: `There’s no ask-browser ${action || 'action'}. ${usage}` };
}

/** Ask's window may go to this site: local, allowed before in this run, or the person says yes now. */
async function allowSite(ctx, url) {
  const site = siteOf(url);
  if (!site || ctx.browserAllSites || ctx.allowedSites.has(site) || ctx.state.mode === 'all') return true;
  print(clay(`  ● ${tx('Ask wants to open {site} in its browser window.', { site: safe(site) })}`));
  const answer = await confirm(ctx.input, `  ${tx('Allow this site?')}`, true);
  if (answer === 'no') return false;
  if (answer === 'all') ctx.browserAllSites = true;
  else ctx.allowedSites.add(site);
  return true;
}

/**
 * The person's turn in the window: a captcha, a password, a code from their phone. A notice on their screen, the window
 * in front, then Ask waits: until the captcha on the page is answered (or gone), the person types a note, Esc, or
 * 8 minutes. What the page looks like after goes back to Ask.
 */
async function handOff(ctx, flags, todo) {
  const b = ctx.browser;
  print(clay(`  ● ${tx('Your turn in the browser window: {todo}', { todo: safe(todo) })}`));
  print(dim(`    ${tx('Ask carries on by itself once it’s done. Or type a note and press Enter; Esc stops.')}`));
  callPerson(ctx, 'turn', tx('Ask needs you in the browser'), todo, { title: tx('Ask needs you at your computer'), body: todo });
  await b.front().catch(() => {});
  const ac = new AbortController();
  flags?.setCommandAbort?.(ac);
  const watching = !!captchaOn(await b.captchaSigns().catch(() => null));
  const until = Date.now() + HANDOFF_MS;
  let said = [];
  let how = null;
  try {
    for (let clear = 0; !how; ) {
      await pause(2000);
      if (ac.signal.aborted) how = 'stopped';
      else if (ctx.input.notes?.length) {
        said = ctx.input.notes.splice(0);
        how = 'said';
      } else if (watching && !captchaOn(await b.captchaSigns().catch(() => null))) {
        if (++clear >= 2) how = 'done'; // answered, and still so a moment later (not a page between two)
      } else if (Date.now() > until) how = 'late';
      else clear = 0;
    }
  } finally {
    flags?.setCommandAbort?.(null);
  }
  if (how === 'stopped') return { ok: false, output: 'Stopped while waiting for the person.' };
  if (how === 'late') {
    print(dim(`  ${tx('Still waiting after {n} min: Ask stops here.', { n: HANDOFF_MS / 60_000 })}`));
    return { ok: false, output: `The person didn’t finish “${todo}” within ${HANDOFF_MS / 60_000} minutes. Tell them where things stand and stop here; they can ask you to carry on.` };
  }
  print(green(`  ✓ ${tx('Done: Ask carries on.')}`));
  const view = await b.act({ action: 'screenshot' }).catch(() => ({ ok: true, output: '' }));
  const head = how === 'done' ? `The person finished: ${todo}. Carry on.` : `The person says: ${said.join('\n')}`;
  return { ...view, ok: true, output: `${head}\n${view.output}` };
}

/** The `browser` tool: the window Ask drives, with the person's Allow for every new site. */
async function browserStep(ctx, args, flags) {
  if (!ctx.browser) return { ok: false, output: 'The browser is off here. The person turns it on with /browser (or starts ask-code with --browser).' };
  const action = String(args.action ?? '');
  if (ctx.state.mode === 'plan' && !BROWSER_LOOKS.has(action)) {
    print(dim(`  • ${tx('Plan first: nothing clicked or typed yet')}`));
    return { ok: false, output: 'Plan mode is on: you can open, look, scroll and read, but not click or type yet. Put this step in your plan.' };
  }
  if (action === 'open') {
    const url = browserUrl(args.url);
    const refused = url ? await refusedUrl(ctx.root, url) : 'Say which address to open.';
    if (refused) {
      print(dim(`  • ${tx('Browser: not opened ({why})', { why: safe(refused) })}`));
      return { ok: false, output: refused };
    }
    if (!(await allowSite(ctx, url))) {
      print(dim(`  ${tx('Not opened.')}`));
      return { ok: false, output: `The person didn’t allow opening ${siteOf(url)}. Ask what they would like instead.` };
    }
    args = { ...args, url };
  }
  try {
    if (action === 'handoff') {
      await ctx.browser.start();
      print(dim(`  • ${safe(describeBrowser(args))}`));
      return await handOff(ctx, flags, String(args.text ?? '').trim() || tx('Finish this step in the window'));
    }
    const r = await ctx.browser.act(args);
    if (r.private) {
      print(clay(`  ● ${tx('That field is for a password or a card: type it yourself in the browser window.')}`));
      return { ok: false, output: 'That field is for a password or card details: Ask never types those. Ask the person to type it in the browser window themselves, then carry on.' };
    }
    // A click or a key can take the window to another site: that site needs the person's Allow too.
    if (r.ok && action !== 'open') {
      const { url } = await ctx.browser.here();
      if (siteOf(url) && !(await allowSite(ctx, url))) {
        await ctx.browser.act({ action: 'back' }).catch(() => {});
        return { ok: false, output: `That step went to ${siteOf(url)}, and the person didn’t allow that site: the window went back. Ask what they would like instead.` };
      }
    }
    print(dim(`  • ${safe(describeBrowser(args))}${r.ok ? '' : ` — ${safe(r.output.split('\n')[0])}`}`));
    if (r.ok && action !== 'close') return await withCaptcha(ctx, flags, r);
    return r;
  } catch (e) {
    print(red(`  ✗ ${tx('Browser: {err}', { err: safe(e.message) })}`));
    return { ok: false, output: `The browser couldn’t do that: ${e.message}` };
  }
}

/**
 * After a step: a captcha on the page is the person's. One in the way (a check page, a picture puzzle) calls them at
 * once; one on a form is pointed out, for after the rest is filled in. On the person's own project: the test keys.
 */
async function withCaptcha(ctx, flags, r) {
  const found = captchaOn(await ctx.browser.captchaSigns().catch(() => null));
  if (!found) return r;
  const { url } = await ctx.browser.here();
  if (isLocalPage(url))
    return { ...r, output: `${r.output}\n\n[A captcha (${found.kind}) is on this page of the person’s own project. Don’t solve it: in development, switch the project to the provider’s official test keys (your instructions list them), then test both the passed and the failed path.]` };
  if (found.blocking) {
    const h = await handOff(ctx, flags, tx('The page asks if you’re human ({kind}). Solve it in the window.', { kind: found.kind }));
    return { ...h, output: `[The page put up a human check (${found.kind}); ask-code handed it to the person.]\n${h.output}` };
  }
  return { ...r, output: `${r.output}\n\n[This page has a captcha (${found.kind}), not answered yet. Never solve it yourself. Fill in everything else first; when only the captcha is left, run: ask-browser handoff "Tick the captcha, then Ask carries on". ask-code calls the person and waits.]` };
}

/** /browser and --browser: the window is Ask's from the next request on (it opens on first use). */
async function browserOn(ctx, which = '') {
  const want = /safari/i.test(which) ? 'safari' : /chrom|edge|brave/i.test(which) ? 'chrome' : '';
  if (ctx.browser && (!want || ctx.browser.kind === want || (want === 'chrome' && !ctx.browser.kind))) return print(tx('The browser is on. /browser off turns it off.'));
  if (ctx.browser) {
    await ctx.browser.close().catch(() => {});
    ctx.browser = null;
  }
  // Safari when asked for, or on a Mac without Chrome, Edge, Chromium or Brave.
  const bin = want === 'safari' ? null : findBrowser();
  const safari = want === 'safari' || (!bin && process.platform === 'darwin');
  if (!safari) {
    if (!bin) return print(red(tx('There’s no Chrome, Edge, Chromium or Brave on this computer. Install Google Chrome (or set ASK_BROWSER to your browser’s path), then /browser again.')));
    if (typeof WebSocket !== 'function') return print(red(tx('The browser needs Node 22 or newer (nodejs.org). Update Node, then /browser again.')));
  }
  if (!(await browserConsent(ctx.input, safari))) return print(dim(tx('The browser stays off.')));
  ctx.browser = safari ? new SafariBrowser(ctx.root) : new AskBrowser(ctx.root, { bin });
  print(green(safari ? tx('Safari is on: Ask opens, reads and clicks in a Safari window of its own, with your Safari sign-ins. /browser off turns it off.') : tx('The browser is on: Ask can open, test and watch web pages in its own window. /browser off turns it off.')));
  if (safari) print(dim(tx('If Safari says no: Settings → Advanced → «Show features for web developers», then Develop → «Allow JavaScript from Apple Events».')));
}

/** Turning the browser on, once per computer: what it means, said plainly, and a yes. */
async function browserConsent(input, safari = false) {
  const file = join(homedir(), '.config', 'ask-code', safari ? 'safari-allowed' : 'browser-allowed');
  if (existsSync(file)) return true;
  print(`${clay('●')} ${bold(safari ? tx('Ask gets a Safari window of its own') : tx('Ask gets a browser window of its own'))}`);
  print(tx('Ask opens, clicks and types in it, sees it, and reads its errors: to test your site, check a page for you, or build a watcher.'));
  print(
    dim(
      safari
        ? tx('It’s your own Safari, so sites you’re signed in to there stay signed in for Ask. Sites on this computer open at once; any other site asks you first. Ask never types passwords or card numbers: you do. Close its window or press Esc to stop it.')
        : tx('It’s a separate window with an empty profile: none of your logins, cookies or passwords. Sites on this computer open at once; any other site asks you first. Ask never types passwords or card numbers: you do. Close the window or press Esc to stop it.'),
    ),
  );
  const answer = await confirm(input, tx('Turn the browser on?'), false);
  if (answer !== 'yes') return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return true;
}

// ─── Watches (/watch): a page or a command checked on a timer, an alert when it changes ────────────────
// No AI in the loop: each check is a page load (in a background tab of Ask's browser) or your own command, compared
// with the last one. Ask can build the check (a script in your folder) and tell you the /watch line to start it.
// Watches run while ask-code is open; the computer is kept awake meanwhile where it can be (macOS).

/** The shortest gap between checks: faster gets accounts blocked, and the sites don't change that fast. */
export const WATCH_MIN_MS = 2 * 60_000;

/**
 * "/watch https://site every 5m for "free slot"", "/watch node check.mjs every 10m". Null when there's nothing to watch.
 * `every`: in s, m or h, at least 2 minutes; 5 minutes when not said. `for`: alert when these words appear.
 */
export function parseWatch(text) {
  let rest = String(text ?? '').trim();
  let wanted = null;
  const forMatch = rest.match(/\s+(?:for|ищу|найти)\s+(?:"([^"]+)"|«([^»]+)»|'([^']+)'|(.+))$/i);
  if (forMatch) {
    wanted = (forMatch[1] ?? forMatch[2] ?? forMatch[3] ?? forMatch[4]).trim();
    rest = rest.slice(0, forMatch.index).trim();
  }
  let everyMs = 5 * 60_000;
  const every = rest.match(/\s+(?:every|каждые|каждый|раз в)\s+(\d+(?:[.,]\d+)?)\s*(s|sec|m|min|h|hr|с|сек|м|мин|ч)?\w*$/i);
  if (every) {
    const n = Number(every[1].replace(',', '.'));
    const unit = (every[2] ?? 'm').toLowerCase();
    everyMs = Math.round(n * (/^(s|с)/.test(unit) ? 1000 : /^(h|ч)/.test(unit) ? 3_600_000 : 60_000));
    rest = rest.slice(0, every.index).trim();
  }
  if (!rest) return null;
  const url = /^(https?:\/\/|localhost|127\.0\.0\.1)/i.test(rest) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(rest) ? browserUrl(rest) : null;
  return { target: rest, url, everyMs: Math.max(WATCH_MIN_MS, everyMs), wanted };
}

/** A page's or a command's output, ready to compare: spaces folded, clock-like numbers (12:41:07) left out. */
/** A page that says the site won't answer for a while (429, its bot check), not the page itself. */
export function siteLimited(text) {
  const head = String(text ?? '').slice(0, 1500);
  return /(error|ошибка|код)\s*429\b|too many requests|слишком много запросов|rate limit(ed)?\b|temporarily blocked|доступ временно ограничен/i.test(head);
}

export function watchText(text) {
  return String(text ?? '')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** What changed, in one line for the alert: the first new line, or the words looked for. */
export function watchNews(before, after, wanted) {
  if (wanted) {
    const line = after.split('\n').find((l) => l.toLowerCase().includes(wanted.toLowerCase()));
    return line ? line.slice(0, 160) : wanted;
  }
  const old = new Set(before.split('\n'));
  return (after.split('\n').find((l) => l && !old.has(l)) ?? after.split('\n')[0] ?? '').slice(0, 160);
}

/** A notice on this computer's screen (and its sound), where the system has a way to show one. */
function notifyHere(title, body) {
  const t = String(title).slice(0, 80);
  const b = String(body).slice(0, 200);
  try {
    if (process.platform === 'darwin') {
      const q = (x) => `"${x.replace(/[\\"]/g, '\\$&')}"`;
      spawn('osascript', ['-e', `display notification ${q(b)} with title ${q(t)} sound name "Glass"`], { stdio: 'ignore' }).on('error', () => {});
    } else if (process.platform === 'win32') {
      const ps = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(15000,$env:ASK_T,$env:ASK_B,'Info');Start-Sleep 16;$n.Dispose()`;
      spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', env: { ...process.env, ASK_T: t, ASK_B: b } }).on('error', () => {});
    } else if (findTool('notify-send')) spawn('notify-send', [t, b], { stdio: 'ignore' }).on('error', () => {});
  } catch {}
  process.stdout.write('\x07');
}

/**
 * Calls the person: the notice on this computer's screen, and the same on every device where they turned notifications
 * on in Ask (Account → Notifications), their phone above all: they may be away from the computer. With none on, it says
 * once where to turn them on. `phone` is what the phone shows, when it should read differently from here.
 */
export function callPerson(ctx, kind, title, body, phone = { title, body }) {
  notifyHere(title, body);
  if (!ctx?.site || !ctx.key) return;
  api(ctx.site, ctx.key, '/v1/code/call', { method: 'POST', body: JSON.stringify({ kind, title: String(phone.title).slice(0, 80), body: String(phone.body ?? '').slice(0, 200) }) })
    .then((res) => res.json())
    .then((r) => {
      if (r?.devices !== 0 || ctx.phoneHinted) return;
      ctx.phoneHinted = true;
      print(dim(`  ${tx('Get these calls on your phone too: open Ask there → Account → Notifications.')}`));
    })
    .catch(() => {});
}

/** The watches of this run: started with /watch, listed with /watch, stopped with /watch stop N. */
class Watches {
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
    this.next = 1;
    this.awake = null;
  }

  async add(spec) {
    const w = { id: this.next++, ...spec, last: null, checks: 0, alerts: 0, error: null, timer: null, busy: false, waitMs: spec.everyMs };
    this.list.push(w);
    await this.check(w, true);
    this.schedule(w);
    this.keepAwake();
    return w;
  }

  /** The next check: at the watch's pace, or later while the site says it's had too many. */
  schedule(w) {
    clearTimeout(w.timer);
    w.timer = setTimeout(async () => {
      await this.check(w, false);
      if (this.list.includes(w)) this.schedule(w);
    }, w.waitMs);
  }

  async check(w, first) {
    if (w.busy) return;
    w.busy = true;
    try {
      const page = await this.read(w);
      const text = watchText(page.text);
      w.checks++;
      w.error = null;
      // A check page instead of the page (Cloudflare's, a "not a robot" page): the person's to pass, in Ask's window
      // (same sign-ins, so the watch gets through after). Slower meanwhile, said once, and never counted as news.
      const check = captchaOn(page.signs);
      if (check?.blocking) {
        w.waitMs = Math.min(60 * 60_000, Math.max(w.everyMs, w.waitMs) * 2);
        if (!w.checking) {
          const site = siteOf(w.url) ?? w.url;
          print(clay(`  ● ${tx('Watch {id}: {site} shows a human check instead of the page, so it waits longer: next look in {n} min. Solve it in Ask’s window (ask Ask to open the page) and the watch carries on.', { id: w.id, site: safe(site), n: Math.round(w.waitMs / 60_000) })}`));
          const title = tx('Ask: {site} asks if you’re human', { site });
          callPerson(this.ctx, 'check', title, w.url, { title, body: tx('Solve it in Ask’s window on your computer, and the watch carries on.') });
        }
        w.checking = true;
        return;
      }
      w.checking = false;
      // The site says too many requests (or puts up its bot check): wait twice as long each time, up to an hour, and
      // keep the last real page to compare with. Back to the watch's pace once the page is back.
      if (siteLimited(text)) {
        const was = w.waitMs;
        w.waitMs = Math.min(60 * 60_000, Math.max(w.everyMs, w.waitMs) * 2);
        if (was !== w.waitMs) print(dim(`  ${tx('Watch {id}: the site says too many requests, so it waits longer: next look in {n} min.', { id: w.id, n: Math.round(w.waitMs / 60_000) })}`));
        return;
      }
      w.waitMs = w.everyMs;
      const had = w.wanted ? (w.last ?? '').toLowerCase().includes(w.wanted.toLowerCase()) : false;
      const has = w.wanted ? text.toLowerCase().includes(w.wanted.toLowerCase()) : false;
      if (first) {
        print(dim(`  ${tx('Watch {id}: first look done. {now}', { id: w.id, now: w.wanted ? (has ? tx('“{w}” is there now.', { w: safe(w.wanted) }) : tx('No “{w}” yet.', { w: safe(w.wanted) })) : tx('Alerts when it changes.') })}`));
      } else if (w.wanted ? has && !had : text !== w.last) {
        w.alerts++;
        const news = watchNews(w.last ?? '', text, w.wanted);
        const where = w.url ? siteOf(w.url) ?? w.url : w.target;
        print(`\n${clay('●')} ${bold(tx('Watch {id}: {where} changed', { id: w.id, where: safe(where) }))}  ${dim(new Date().toLocaleTimeString(LANG === 'ru' ? 'ru-RU' : undefined))}`);
        if (news) print(`  ${safe(news)}`);
        if (w.url) print(dim(`  ${w.url}`));
        callPerson(this.ctx, 'news', tx('Ask: {where} changed', { where }), news || w.target);
      }
      w.last = text;
    } catch (e) {
      // A check that fails says so once, not every 5 minutes; the next good one carries on.
      if (w.error !== e.message) print(red(`  ${tx('Watch {id}: the check failed ({err}). It tries again in {n} min.', { id: w.id, err: safe(e.message), n: Math.round(w.everyMs / 60_000) })}`));
      w.error = e.message;
    } finally {
      w.busy = false;
    }
  }

  async read(w) {
    if (w.url) {
      if (!this.ctx.browser) throw new Error(tx('the browser is off: /browser turns it on'));
      const p = await this.ctx.browser.pageText(w.url);
      return { text: `${p.title}\n${p.text}`, signs: p.signs };
    }
    const r = await runCommand(this.ctx.root, { command: w.target, timeout_sec: 120 });
    return { text: r.output };
  }

  stop(id) {
    const i = this.list.findIndex((w) => w.id === id);
    if (i < 0) return false;
    clearTimeout(this.list[i].timer);
    this.list.splice(i, 1);
    if (!this.list.length) this.sleepAgain();
    return true;
  }

  stopAll() {
    for (const w of this.list) clearTimeout(w.timer);
    this.list = [];
    this.sleepAgain();
  }

  /** macOS: no sleep while a watch runs (caffeinate, until this ask-code ends). */
  keepAwake() {
    if (this.awake || process.platform !== 'darwin' || !findTool('caffeinate')) return;
    this.awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    this.awake.on('error', () => (this.awake = null));
  }

  sleepAgain() {
    this.awake?.kill();
    this.awake = null;
  }
}

/** /watch: start one, list them, or stop one. */
/** /apps: what Ask started that keeps running (a dev server, the app it built) · /apps stop N | all. */
export function appsCommand(ctx, arg) {
  const apps = (ctx.apps ??= new Apps());
  const stop = String(arg ?? '').match(/^stop\s+(all|\d+)$/i);
  if (stop) {
    if (stop[1].toLowerCase() === 'all') {
      apps.stopAll();
      return print(tx('Stopped everything Ask started.'));
    }
    return print(apps.stop(Number(stop[1])) ? tx('Stopped app {n}.', { n: stop[1] }) : tx('There’s no running app {n}. /apps lists them.', { n: stop[1] }));
  }
  const list = apps.running();
  if (!list.length) return print(dim(tx('Nothing Ask started is running. When Ask starts your app or a dev server, it keeps running here until you quit.')));
  for (const a of list) print(`  ${a.n}. ${bold(safe(a.command))}${a.url ? ` ${dim('·')} ${a.url}` : ''}`);
  print(dim(tx('/apps stop N stops one; they all stop when you quit.')));
}

async function watchCommand(ctx, arg) {
  ctx.watches ??= new Watches(ctx);
  const w = ctx.watches;
  const stop = arg.match(/^(stop|стоп)\s*(\d+|all|все)?$/i);
  if (!arg || /^(list|список)$/i.test(arg)) {
    if (!w.list.length) return print(tx('No watches yet. For example: /watch https://example.com/appointments every 5m for "available"'));
    for (const x of w.list)
      print(`  ${bold(String(x.id))}  ${safe(x.target)}  ${dim(tx('every {n} min · {checks} checks · {alerts} alerts', { n: Math.round(x.everyMs / 60_000), checks: x.checks, alerts: x.alerts }))}${x.wanted ? dim(` · “${safe(x.wanted)}”`) : ''}${x.error ? red(` · ${safe(x.error)}`) : ''}`);
    return print(dim(tx('/watch stop N stops one. They run while ask-code is open.')));
  }
  if (stop) {
    if (!stop[2] || /^(all|все)$/i.test(stop[2])) {
      w.stopAll();
      return print(tx('All watches stopped.'));
    }
    return print(w.stop(Number(stop[2])) ? tx('Watch {id} stopped.', { id: stop[2] }) : tx('There’s no watch {id}. /watch lists them.', { id: stop[2] }));
  }
  const spec = parseWatch(arg);
  if (!spec) return print(tx('What to watch? A page or a command, like: /watch https://example.com every 5m for "available"'));
  if (spec.url) {
    const refused = await refusedUrl(ctx.root, spec.url);
    if (refused) return print(red(refused));
    if (!ctx.browser) await browserOn(ctx);
    if (!ctx.browser) return;
    if (!(await allowSite(ctx, spec.url))) return print(dim(tx('Not watched.')));
  } else {
    // A command: the person typed it, like "!", and it runs on every check without asking again.
    print(clay(`  ● ${tx('Every check runs, in this folder:')}`));
    print(`    ${bold(`$ ${spec.target}`)}`);
    if ((await confirm(ctx.input, `  ${tx('Run it every {n} min?', { n: Math.round(spec.everyMs / 60_000) })}`, false)) !== 'yes') return print(dim(tx('Not watched.')));
  }
  const added = await w.add(spec);
  print(green(tx('Watch {id} is on: every {n} min. You get a notice here and on this computer’s screen when it changes.', { id: added.id, n: Math.round(spec.everyMs / 60_000) })));
  print(dim(tx('Keep ask-code open (the computer stays awake meanwhile). /watch lists them, /watch stop {id} stops this one.', { id: added.id })));
}

async function confirm(input, question, all) {
  for (;;) {
    const a = (await input.ask(`${bold(question)} ${dim(tx(all ? '[y]es · [n]o · [a]ll the rest of this task' : '[y]es · [n]o'))} `))?.trim().toLowerCase();
    if (a == null) return 'no';
    if (a === 'y' || a === 'yes' || a === 'д' || a === 'да') return 'yes';
    if (a === 'n' || a === 'no' || a === 'н' || a === 'нет') return 'no';
    if (all && (a === 'a' || a === 'all' || a === 'в' || a === 'все' || a === 'всё')) return 'all';
  }
}

async function doTool(ctx, call, flags) {
  const { root, input } = ctx;
  const { name } = call;
  const args = call.input ?? {};
  // Ask's own memory of the project: outside the folder, its own notes, so writing there doesn't ask.
  if (memoryPath(args.path) != null && ctx.memoryDir) {
    const r = await memoryTool(ctx.memoryDir, name, args);
    const writes = name === 'write_file' || name === 'edit_file';
    print(dim(`  ${writes ? '✻' : '•'} ${writes ? (r.ok ? tx('Remembered in Ask’s memory of this folder: {path}', { path: safe(r.rel) }) : tx('Couldn’t save to memory: {err}', { err: safe(r.shown ?? r.output) })) : safe(describe(name, args))}`));
    return r;
  }
  if (name === 'browser') return browserStep(ctx, args, flags);
  // "ask-browser open https://…": the browser's steps as commands, for when the model has run_command but not the
  // browser tool. Never a shell: ask-code does it itself, with the same Allow for each new site.
  if (name === 'run_command') {
    const b = browserCommand(String(args.command ?? ''));
    if (b) {
      if (b.error) return { ok: false, output: b.error };
      if (!ctx.browser) await browserOn(ctx);
      if (!ctx.browser) return { ok: false, output: 'The person kept the browser off. Ask whether to turn it on (/browser, or /browser safari), or carry on without it.' };
      return browserStep(ctx, b.args, flags);
    }
  }
  if (name === 'list_files' || name === 'read_file' || name === 'search') {
    const r = await runReadTool(root, name, args);
    print(dim(`  • ${safe(describe(name, args))}${r.ok ? (r.note ? ` (${safe(r.note)})` : '') : ` — ${safe(r.shown ?? r.output)}`}`));
    return r;
  }
  const { mode } = ctx.state;
  if (mode === 'plan' && (name === 'write_file' || name === 'edit_file' || name === 'run_command')) {
    print(dim(`  • ${tx('Plan first: nothing changed or run yet')}`));
    return { ok: false, output: 'Plan mode is on: nothing is changed or run yet. Put this step in your plan; the person switches plan mode off (Shift+Tab) when they want it done.' };
  }
  if (name === 'write_file' || name === 'edit_file') {
    let change;
    try {
      change = await planChange(root, name, args);
    } catch (e) {
      print(dim(`  • ${tx('Couldn’t change {path}: {err}', { path: safe(args.path ?? tx('a file')), err: safe(e.shown ?? e.message) })}`));
      return { ok: false, output: e instanceof Refused ? e.message : `That didn’t work: ${e.message}` };
    }
    print(clay(`  ● ${tx(change.before == null ? 'Ask wants to create {rel}' : 'Ask wants to change {rel}', { rel: safe(change.rel) })}`));
    showDiff(change.before, change.after);
    const answer = flags.allowAll() || mode === 'edits' || mode === 'all' ? 'yes' : await confirm(input, `  ${tx('Allow this change?')}`, true);
    if (answer === 'all') flags.setAllowAll();
    if (answer === 'no') {
      print(dim(`  ${tx('Not changed.')}`));
      return { ok: false, output: 'The person didn’t allow this change. Ask what they would like instead, or carry on without it.' };
    }
    try {
      const msg = await applyChange(change, name);
      print(green(`  ✓ ${safe(msg.shown)}`));
      return { ok: true, output: msg.output };
    } catch (e) {
      print(red(`  ${tx('Couldn’t write {rel}: {err}', { rel: safe(change.rel), err: safe(e.message) })}`));
      return { ok: false, output: `Writing failed: ${e.message}` };
    }
  }
  if (name === 'run_command') {
    const command = String(args.command ?? '').trim();
    if (hasControl(command)) {
      print(red(`  ✗ ${tx('Refused a command with hidden control characters: {cmd}', { cmd: safe(command) })}`));
      return { ok: false, output: 'Refused: the command has hidden control characters. Use plain text only.' };
    }
    print(clay(`  ● ${tx('Ask wants to run, in this folder:')}`));
    command.split('\n').forEach((l, i) => print(`    ${bold(`${i ? ' ' : '$'} ${l}`)}`));
    if (touchesSecret(command)) print(red(`  ${tx('⚠ This reads a private file (.env or a key): what it prints would go to Ask.')}`));
    // Commands always ask, even after "all the rest" (that covers file changes only); building without asking
    // runs them, except one that reads a private file: its output (keys, passwords) would go to Ask.
    const answer = mode === 'all' && !touchesSecret(command) ? 'yes' : await confirm(input, `  ${tx('Run it?')}`, false);
    if (answer === 'no') {
      print(dim(`  ${tx('Not run.')}`));
      return { ok: false, output: 'The person didn’t allow this command. Ask what they would like instead, or carry on without it.' };
    }
    const ac = new AbortController();
    flags.setCommandAbort(ac);
    const shown = outputLines();
    const r = await runCommand(root, args, { signal: ac.signal, onOutput: shown.add, apps: (ctx.apps ??= new Apps()) });
    shown.end();
    flags.setCommandAbort(null);
    print(r.ok ? green(`  ✓ ${safe(r.shown)}`) : red(`  ✗ ${safe(r.shown ?? r.output)}`));
    return { ok: r.ok, output: r.output };
  }
  return { ok: false, output: `This app can’t do ${name}.` };
}

/**
 * The folder Ask works in. A Mac's Terminal opens in the home folder, and that's where people download and run this:
 * rather than stop there, Ask gets a folder of its own in it (~/ask-project), never the whole home folder.
 */
export async function projectFolder(folder, home = homedir()) {
  let root;
  try {
    root = await realpath(resolve(folder));
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new Error(tx('There’s no folder {folder}. Give the path of your project folder.', { folder }));
  }
  if (root === '/') throw new Error(tx('Give a project folder, not the whole disk (cd into the project first).'));
  if (root !== (await realpath(home).catch(() => home))) return { root, moved: false };
  const own = join(root, 'ask-project');
  await mkdir(own, { recursive: true });
  return { root: own, moved: true };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  setLang(opts.lang);
  if (opts.help) return print(HELP[LANG]);
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error(tx('ask-code needs Node 18 or newer (nodejs.org).'));
  if (!/^https?:\/\//.test(opts.site)) throw new Error(tx('Which site? Download this again from the site’s Code page, or pass --site https://….'));
  // The key and the folder's files travel over this: in the clear only to this computer itself.
  if (!/^https:\/\//.test(opts.site) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(opts.site)) throw new Error(tx('The site must start with https:// (http:// only for localhost).'));
  const { root, moved } = await projectFolder(opts.folder);
  if (moved) print(dim(tx('Started in your home folder, so Ask works in a folder of its own: {dir}. For another project, cd into its folder first.', { dir: safe(root) })));
  const input = new Input(root);
  let ctx = null;
  try {
    const { key, me } = await signIn(opts.site, input, { fresh: opts.login, setup: opts.setup });
    if (!me.code) throw new Error(tx('Code is part of Plus. Switch on {site}/plans, then run this again.', { site: opts.site }));
    // mode: 'normal' (every change asks), 'edits' (changes go in without asking), 'all' (changes, commands and sites
    // go without asking: --no-ask), 'plan' (look, then a plan; no changes).
    // pictures: Ctrl+V or dragged in, for the next request. ran: "!" commands, for the next request. used: this run's totals.
    const state = { model: null, history: [], title: null, inputs: [], limits: me.limits, mode: opts.noAsk ? 'all' : 'normal', pictures: [], ran: [], used: { requests: 0, input: 0, output: 0 } };
    const list = () => me.models.map((x) => x.replace(/^claude-/, '')).join(', ');
    if (opts.model) {
      const m = pickModel(me, opts.model);
      if (!m) throw new Error(tx('{model} isn’t on your plan. You can use: {list}.', { model: opts.model, list: list() }));
      state.model = m;
    }
    ctx = { site: opts.site, key, root, input, state, historyFile: historyFile(opts.site, root), memoryDir: memoryDir(opts.site, root), browser: null, allowedSites: new Set(), browserAllSites: false };
    if (opts.browser) await browserOn(ctx, opts.browser);
    print(`${clay('✻')} ${bold('ask-code')} ${dim(`· ${opts.site.replace(/^https?:\/\//, '')} · ${state.model?.replace(/^claude-/, '') ?? tx('default model')}`)}`);
    print(dim(tx('Working in {root}', { root: safe(root) })));
    print(dim(state.mode === 'all' ? tx('Ask builds without asking: it changes files, runs commands and opens sites in this folder on its own. Shift+Tab to have it ask again. /help for more.') : tx('Reading is automatic. Every change and every command asks you first. /help for more.')));
    if (input.terminal) print(dim(tx('? for shortcuts · Shift+Tab: accept edits or plan first · Ctrl+V: paste a picture')));
    const notes = await gatherNotes(root);
    if (notes.sources.length) {
      const where = notes.sources.map((s) => s.where).join(', ');
      print(dim(notes.clipped ? tx('ASK.md is too long: Ask gets its first {n} characters.', { n: NOTES_CHARS }) : tx('Ask reads your notes with every task: {where}.', { where: safe(where) })));
    }
    // No ASK.md yet: /init makes one.
    if (!notes.sources.some((s) => s.where === 'ASK.md')) print(dim(tx('Tip: /init has Ask write ASK.md, notes about this project for every task. It lives in your folder and never expires.')));
    const when = (savedAt) => new Date(savedAt).toLocaleString(LANG === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const requests = (n) => {
      const one = n === 1;
      return tx(one ? '1 request' : '{n} requests', { n });
    };
    const modeTag = () =>
      state.mode === 'edits' ? `${clay('⏵⏵')} ${dim(tx('accept edits'))} ` : state.mode === 'all' ? `${clay('⏵⏵⏵')} ${dim(tx('no asking'))} ` : state.mode === 'plan' ? `${clay('⏸')} ${dim(tx('plan first'))} ` : '';
    const promptText = () => `${modeTag()}${clay('>')} `;
    input.onMode = () => {
      state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
      const says = {
        normal: tx('Every change asks first.'),
        edits: tx('Accept edits: file changes go in without asking (commands still ask).'),
        all: tx('No asking: Ask changes files, runs commands and opens sites on its own.'),
        plan: tx('Plan first: Ask looks around and writes a plan, without changing anything.'),
      }[state.mode];
      if (input.atPrompt) {
        input.rl.setPrompt(promptText());
        input.hint(`${says} ${tx('Shift+Tab: next mode.')}`);
      } else input.hint(says);
    };
    input.onPicture = async () => {
      if (state.pictures.length >= MAX_ATTACHED) return input.hint(tx('Up to {n} pictures per request.', { n: MAX_ATTACHED }));
      const picture = await inTemp(async (dir) => {
        const file = await clipboardPicture(dir);
        return file ? attachPicture(file, 'clipboard.png').catch((e) => ({ error: e.shown ?? e.message })) : null;
      }).catch(() => null);
      if (!picture) {
        const how = clipboardTool() ? tx('There’s no picture in the clipboard. Copy one (or take a screenshot to the clipboard), then Ctrl+V.') : tx('To paste pictures here, install wl-clipboard or xclip. Or drag the picture’s file into this window.');
        return input.hint(how);
      }
      if (picture.error) return input.hint(picture.error);
      state.pictures.push({ kind: 'image', name: `Image #${state.pictures.length + 1}`, ...picture });
      // A mark where the picture goes, in the line being typed.
      input.rl.write(`[${tx('Image #{n}', { n: state.pictures.length })}] `);
    };
    const sessions = async () => {
      const all = await listSessions(ctx.historyFile).catch(() => []);
      if (!all.length) {
        print(dim(tx('No earlier tasks in this folder yet.')));
        return all;
      }
      print(tx('Tasks in this folder (a conversation untouched for {days} days is cleared; your files always stay):', { days: HISTORY_DAYS }));
      all.forEach((s, i) => print(`  ${bold(`${i + 1}.`)} ${dim(when(s.savedAt))} · ${safe(s.title)} ${dim(`· ${requests(s.requests)}${s.current ? ` · ${tx('open now')}` : ''}`)}`));
      return all;
    };
    const resume = async (all, i) => {
      const s = all[Number(i) - 1];
      if (!/^\d+$/.test(i) || !s) return print(dim(tx('There’s no task {i} here. /sessions lists them.', { i: safe(i) })));
      if (s.current) return print(dim(tx('That task is already open.')));
      const back = await resumeSession(ctx.historyFile, s.file).catch(() => null);
      if (!back) return print(red(tx('Couldn’t open that task.')));
      state.history = back.history;
      state.title = back.title;
      state.inputs = [...back.inputs];
      input.past = back.inputs;
      print(dim(tx('Back to “{title}” ({requests}, {when}).', { title: safe(back.title), requests: requests(s.requests), when: when(back.savedAt) })));
    };
    const fresh = async () => {
      state.history = [];
      state.title = null;
      state.inputs = [];
      await newSession(ctx.historyFile).catch(() => {});
    };
    if (opts.fresh) await newSession(ctx.historyFile).catch(() => {});
    else {
      const last = await loadHistory(ctx.historyFile);
      if (last) {
        state.history = last.history;
        state.title = last.title;
        state.inputs = [...last.inputs];
        input.past = last.inputs;
        const n = Math.ceil(last.history.length / 2);
        print(dim(tx('Carrying on your last task here ({requests}, {when}). /new starts fresh, /sessions lists the others.', { n, requests: requests(n), when: when(last.savedAt) })));
      }
    }
    const typed = (t) => {
      input.mine.push(t);
      state.inputs.push(t);
      if (state.inputs.length > INPUTS) state.inputs.splice(0, state.inputs.length - INPUTS);
    };
    if (opts.task) {
      typed(opts.task);
      await request(ctx, opts.task);
    }
    for (;;) {
      print();
      let line = await input.ask(promptText(), { recall: true });
      if (line == null) break;
      // "\" at the end (or Shift/Option+Enter): the request goes on on the next line.
      while (line.endsWith('\\')) {
        const more = await input.ask(dim('… '));
        if (more == null) break;
        line = `${line.slice(0, -1)}\n${more}`;
      }
      const t = line.trim();
      if (!t) continue;
      typed(t);
      const command = /^\/([a-z-]*)(?:\s+([\s\S]*))?$/i.exec(t);
      // A /command is kept with the task too (a request is, once answered).
      if ((command || t.startsWith('!') || t.startsWith('#')) && state.history.length) await saveHistory(ctx.historyFile, state.history, state.title, state.inputs).catch(() => {});
      if (t === '?') {
        print(KEYS[LANG]);
        continue;
      }
      if (t.startsWith('!')) {
        await shell(ctx, t.slice(1).trim());
        continue;
      }
      if (t.startsWith('#') && !t.startsWith('#!')) {
        const note = t.replace(/^#+/, '').trim();
        if (note) await remember(root, note).then(() => print(green(tx('Saved in ASK.md: Ask reads it with every task in this folder.')))).catch((e) => print(red(tx('Couldn’t save the note: {err}', { err: safe(e.shown ?? e.message) }))));
        else print(dim(tx('Say what to remember after #, like # tests run with npm test.')));
        continue;
      }
      if (!command) {
        await request(ctx, t);
        continue;
      }
      const [, name, rest = ''] = command;
      const arg = rest.trim();
      if (name === 'exit' || name === 'quit' || name === 'q') break;
      else if (name === '' || name === 'help') print(HELP[LANG]);
      else if (name === 'clear' || name === 'new' || name === 'reset') {
        await fresh();
        print(dim(tx('New task. The last one is kept: /sessions lists them.')));
      } else if (name === 'sessions' || name === 'resume') {
        if (arg) await resume(await listSessions(ctx.historyFile).catch(() => []), arg);
        else {
          const all = await sessions();
          // /resume alone asks which one; /sessions only lists.
          if (name === 'resume' && all.length > 1) {
            const pick = (await input.ask(`${tx('Which one? Its number (Enter: stay here):')} `))?.trim();
            if (pick) await resume(all, pick);
          } else if (all.length > 1) print(dim(tx('Type /resume and a number to carry on one of them.')));
        }
      } else if (name === 'model') {
        let want = arg;
        if (!want) {
          me.models.forEach((m, i) => print(`  ${bold(`${i + 1}.`)} ${m.replace(/^claude-/, '')}${m === state.model ? dim(` · ${tx('now')}`) : ''}`));
          want = (await input.ask(`${tx('Which one? Its number or name (Enter: keep this one):')} `))?.trim() ?? '';
          if (/^\d+$/.test(want)) want = me.models[Number(want) - 1] ?? want;
        }
        if (!want) continue;
        const m = pickModel(me, want);
        if (m) {
          state.model = m;
          print(dim(tx('Now using {model}.', { model: m.replace(/^claude-/, '') })));
        } else print(dim(tx('On your plan: {list}. Type /model sonnet, say.', { list: list() })));
      } else if (name === 'remember') {
        if (!arg) print(dim(tx('Say what to remember, like /remember tests run with npm test.')));
        else
          await remember(root, arg)
            .then(() => print(green(tx('Saved in ASK.md: Ask reads it with every task in this folder.'))))
            .catch((e) => print(red(tx('Couldn’t save the note: {err}', { err: safe(e.shown ?? e.message) }))));
      } else if (name === 'init') await request(ctx, tx(INIT_PROMPT), { shown: '/init' });
      else if (name === 'review') await request(ctx, `${tx(REVIEW_PROMPT)}${arg ? `\n\n${arg}` : ''}`, { shown: t });
      else if (name === 'memory') await editNotes(ctx, arg);
      else if (name === 'compact') await compact(ctx, arg);
      else if (name === 'cost' || name === 'usage') {
        const u = state.used;
        print(tx('This run: {requests} · {in} in · {out} out.', { requests: requests(u.requests), in: k(u.input), out: k(u.output) }));
        print(limitsLine(state.limits) || tx('Your plan has no limit to show here.'));
        print(dim(tx('Your plan and its limits: {site}/plans', { site: opts.site })));
      } else if (name === 'status') {
        const notesNow = await gatherNotes(root);
        print(`${dim(tx('Site:'))} ${opts.site}  ${dim(`(ask-code ${VERSION})`)}`);
        print(`${dim(tx('Account:'))} ${safe(me.name ?? '—')} · ${safe(me.plan ?? '')}`);
        print(`${dim(tx('Model:'))} ${state.model?.replace(/^claude-/, '') ?? tx('default model')}`);
        print(`${dim(tx('Folder:'))} ${safe(root)}`);
        print(`${dim(tx('Mode:'))} ${{ normal: tx('every change asks first'), edits: tx('accept edits'), plan: tx('plan first') }[state.mode]}`);
        print(`${dim(tx('Task:'))} ${state.title ? `${safe(state.title)} · ${requests(Math.ceil(state.history.length / 2))}` : tx('new')}`);
        const memoryNow = await readMemory(ctx.memoryDir);
        print(`${dim(tx('Memory:'))} ${memoryNow ? tx('{n} characters in MEMORY.md', { n: memoryNow.length }) : tx('nothing yet (Ask saves what it learns here)')}`);
        print(`${dim('ASK.md:')} ${notesNow.sources.length ? safe(notesNow.sources.map((s) => `${s.where} (${tx('{n} characters', { n: s.chars })})`).join(', ')) : tx('none yet (/init makes one)')}`);
      } else if (name === 'context') {
        const notesNow = (await gatherNotes(root)).text ?? '';
        const memoryNow = await readMemory(ctx.memoryDir);
        const envNow = await folderNow(root);
        print(tx('Sent with each request, in tokens (about):'));
        print(`  ${dim(tx('This task:'))} ${k(taskTokens(state.history))} · ${requests(Math.ceil(state.history.length / 2))}`);
        print(`  ${dim('ASK.md:')} ${k(estimateTokens(notesNow))}`);
        print(`  ${dim(tx('Ask’s memory of this folder:'))} ${k(estimateTokens(memoryNow))}`);
        print(`  ${dim(tx('The folder now (git):'))} ${k(estimateTokens(envNow))}`);
        print(dim(tx('Context left until auto-compact: {n}% (/compact now, or /clear for a new task)', { n: contextLeft(state.history) })));
        print(dim(tx('Files Ask reads cost tokens only in the request that reads them: later requests keep a one-line note of what was read and changed.')));
      } else if (name === 'export') await exportTask(ctx, arg);
      else if (name === 'doctor') await doctor(ctx, me);
      else if (name === 'browser') {
        if (/^(off|выкл)/i.test(arg)) {
          await ctx.browser?.close();
          ctx.browser = null;
          print(tx('The browser is off: Ask works with the folder only.'));
        } else await browserOn(ctx, arg);
      } else if (name === 'watch') await watchCommand(ctx, arg);
      else if (name === 'apps') appsCommand(ctx, arg);
      else if (name === 'bug') await bug(ctx, arg);
      else if (name === 'login') {
        // A new key for this site, checked and saved; the task carries on with it.
        try {
          ctx.key = (await signIn(opts.site, input, { fresh: true })).key;
        } catch (e) {
          print(red(safe(e.message)));
        }
      } else if (name === 'logout') {
        await rm(keyFile(opts.site), { force: true });
        print(tx('Signed out: the saved key is deleted. Next time, paste a key again (or set ASK_KEY).'));
        break;
      } else print(dim(tx('There’s no /{name} here. /help lists the commands.', { name: safe(name) })));
    }
  } finally {
    ctx?.watches?.stopAll();
    ctx?.apps?.stopAll();
    await ctx?.browser?.close().catch(() => {});
    input.close();
  }
}

// Run as a program (not imported by the tests). Real paths: /tmp and /var are symlinks on macOS.
const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  main().catch((e) => {
    print(red(safe(e.message)));
    process.exit(1);
  });
}
