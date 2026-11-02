// Stage 2E: GET /doctor (what this computer and the site give the server), POST /bug (a report to the site's team).
import { findTool, clipboardTool, readNotes, findBrowser } from '../build/ask-code-core.mjs';
import { HttpError, sendJson, readJson } from './errors.mjs';
import { needString, folderOf, queryOf } from './direct.mjs';
import { askApi, toHttpError } from './ask-proxy.mjs';
import { VERSION } from './config.mjs';
import { log } from './log.mjs';

const REPORT_CHARS = 2_000;

/** One line of the report: ok, or not ok with what to do. */
const check = (name, ok, { value, fix } = {}) => ({ name, ok, ...(value !== undefined ? { value } : {}), ...(!ok && fix ? { fix } : {}) });

/**
 * @param {{config: object, route: Function}} app
 */
export function addDoctorRoutes(app) {
  const { config, route } = app;

  route('GET', /^\/doctor$/, async (req, res) => {
    const folder = await folderOf(config, queryOf(req).get('folder'), 400);
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    const checks = [check('Node', true, { value: process.versions.node })];

    let me = null;
    try {
      me = await (await askApi(config, '/v1/me', { signal: aborter.signal })).json();
      checks.push(check('ask', true, { value: 'reachable' }));
    } catch (e) {
      const why = e?.status === 401 ? 'the key is wrong' : e?.status ? `answered ${e.status}` : 'unreachable';
      checks.push(check('ask', false, { value: why, fix: e?.status === 401 ? 'check ASK_KEY' : `check ASK_SITE (${config.site}) and the network` }));
    }
    if (me) checks.push(check('plan', Boolean(me.code), { value: me.plan ?? undefined, fix: 'Code is part of Plus: switch on the site' }));

    const mac = process.platform === 'darwin';
    checks.push(check('ImageMagick', mac || Boolean(findTool('magick') || findTool('convert')), { fix: 'install ImageMagick to read pictures of any kind (PNG, JPG, GIF and WebP work without it)' }));
    checks.push(check('poppler', mac || Boolean(findTool('pdftotext')), { fix: 'install poppler (pdftotext) to read PDFs' }));
    checks.push(check('clipboard', Boolean(clipboardTool()), { fix: 'install wl-clipboard or xclip' }));
    const editor = process.env.VISUAL || process.env.EDITOR;
    checks.push(check('editor', Boolean(editor), { value: editor || undefined, fix: 'set $EDITOR' }));
    const browser = findBrowser();
    checks.push(check('browser', Boolean(browser), { value: browser || undefined, fix: 'install Chrome, Edge, Brave or Chromium, or set ASK_BROWSER to its path' }));
    checks.push(check('ASK.md', Boolean(await readNotes(folder)), { fix: 'add an ASK.md with notes about the project (POST /remember)' }));

    sendJson(res, 200, { ok: true, checks });
  });

  route('POST', /^\/bug$/, async (req, res) => {
    const text = needString(await readJson(req), 'text').trim().slice(0, REPORT_CHARS);
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    let sent;
    try {
      const context = { page: 'ask-code', lang: 'en', app: `ask-code-mcp/${VERSION}`, about: `${process.platform} · Node ${process.versions.node}` };
      sent = await (await askApi(config, '/v1/reports', { method: 'POST', body: JSON.stringify({ text, context }), signal: aborter.signal })).json();
    } catch (e) {
      throw toHttpError(e);
    }
    if (sent?.id === undefined || sent?.id === null) throw new HttpError(502, 'ask accepted the report but sent no id', 'bad_answer');
    log('info', 'bug', `report ${sent.id} sent`);
    sendJson(res, 200, { ok: true, id: String(sent.id) });
  });
}
