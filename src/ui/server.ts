// 本地后台网页：管理多个游戏项目，查看本地内容和改动，勾选后一键上传，配置也在网页上改。只监听 127.0.0.1。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { diffChars, diffLines } from 'diff';
import { appHome, loadConfig, selectApps, type AppConfig, type Config } from '../config.js';
import { openBrowser } from '../browser.js';
import type { FieldValue } from '../partner/form.js';
import { hasLocal, norm, readLocal, readSnapshot, splitLocalized, STEAM_LANGS, writeLocalField, type Fields } from '../local/storeFiles.js';
import { lint } from '../lint.js';
import type { Change } from '../sync.js';
import { assetsApp, deleteImagesApp, diffApp, DRAFT_NOTE, loginFlow, pullApp, pushApp, type Log } from '../ops.js';
import { readMeta } from '../partner/meta.js';
import { describeField, LANG_NAMES } from '../fieldInfo.js';
import { imageBoard } from './images.js';
import { addToInbox, describeItem, placeImage, sortInbox } from '../local/inbox.js';
import {
  addProject, createProjectByAppid, initProject, projectsRoot, listProjects, projectSummary, aiPrompt, readRules, readSettings, removeProject, requireProject, upgradeRules, writeRules, writeSettings,
} from '../projects.js';
import { createShortcuts, isWindows, pickFolder } from '../desktop.js';

type Action = 'pull' | 'diff' | 'push' | 'assets' | 'delete-images' | 'login';
interface RunReq { project: string; action: Action; app: string; only?: string[]; dryRun?: boolean; force?: boolean }

const eq = (a?: FieldValue, b?: FieldValue) => (a === undefined || b === undefined ? a === b : norm(a) === norm(b));

/** 文本改动的差异片段，网页上用来高亮 */
function parts(from: FieldValue | undefined, to: FieldValue | undefined) {
  if (typeof from !== 'string' || typeof to !== 'string') return undefined;
  const a = norm(from) as string, b = norm(to) as string;
  const d = a.length + b.length < 8000 ? diffChars(a, b) : diffLines(a, b);
  return d.map((p) => ({ v: p.value, t: p.added ? 1 : p.removed ? -1 : 0 }));
}

function fieldView(key: string, local: Fields, base: Fields | undefined, remote: Map<string, Change> | undefined, labels?: Record<string, string>) {
  const l = local[key], b = base?.[key];
  const edited = base ? !eq(l, b) : false;
  const r = remote?.get(key);
  return {
    key, local: l, base: b, edited, info: describeField(key, labels?.[key.replace(/\[=.*\]$/, '')]),
    parts: edited ? parts(b, l) : undefined,
    remote: r && { kind: r.kind, value: r.remote, parts: parts(r.remote, l) },
  };
}

export interface UiOptions {
  port: number;
  /** 启动时自动加入并选中的项目（游戏项目文件夹或配置文件） */
  open?: string;
  /** 网页上点“退出”时调用 */
  onQuit?: () => void;
}

export async function startUi(o: UiOptions) {
  /** 最近一次和线上对比的结果，按 项目|App 存 */
  const remoteChecks = new Map<string, { at: string; changes: Map<string, Change> }>();
  const clients = new Set<ServerResponse>();
  let job: { action: Action; project: string; app: string; log: string[] } | undefined;
  /** 上一个任务的结果，网页顶部显示成结果框 */
  let lastResult: { project: string; app: string; action: Action; dryRun: boolean; ok: boolean; needLogin: boolean; at: string; lines: string[] } | undefined;

  const openProject = o.open ? addProject(o.open).config : undefined;

  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  function appState(c: Config, project: string, app: AppConfig) {
    const pulled = hasLocal(app) && !!readSnapshot(c, app);
    const local = hasLocal(app) ? readLocal(app) : {};
    const base = readSnapshot(c, app);
    const remote = remoteChecks.get(project + '|' + app.key);
    const meta = readMeta(c, app);
    const common: ReturnType<typeof fieldView>[] = [];
    const byPath = new Map<string, Record<string, ReturnType<typeof fieldView>>>();
    for (const key of Object.keys(local).sort()) {
      const v = fieldView(key, local, base, remote?.changes, meta?.labels);
      const loc = splitLocalized(key);
      if (!loc) { common.push(v); continue; }
      const row = byPath.get(loc.path) ?? {};
      row[loc.lang] = v;
      byPath.set(loc.path, row);
    }
    const images = imageBoard(c, app, meta);
    const issues = lint(app, local);
    const edits = Object.keys(local).filter((k) => base && !eq(local[k], base[k]));
    return {
      key: app.key, appid: app.appid, name: app.name, languages: app.languages, pulled,
      storeDir: app.storeDir, assetsDir: app.assets.dir,
      common,
      localized: [...byPath].map(([path, langs]) => ({ path, langs })),
      images,
      /** 上次从后台读到状态的时间（拉取、对比、上传时都会更新） */
      remoteAt: meta?.at,
      summary: {
        textEdits: edits.length,
        imagesPending: images.pending.length,
        errors: issues.filter((i) => i.level === 'error').length + images.issues.filter((i) => i.level === 'error').length,
        warnings: issues.filter((i) => i.level === 'warn').length + images.issues.filter((i) => i.level === 'warn').length,
      },
      lint: issues,
      remoteCheckedAt: remote?.at,
      /** 线上有、但本地没改的变化（本地改了的已经挂在字段上） */
      remoteOnly: remote ? [...remote.changes.values()].filter((ch) => ch.kind === 'remote').map((ch) => ch.key) : [],
    };
  }

  function state(project: string | null) {
    const projects = listProjects().map(projectSummary);
    let current: unknown = null;
    if (project) {
      const config = requireProject(project);
      const sum = projects.find((p) => p.config === config)!;
      let apps: unknown[] = [], error = sum.error;
      if (sum.configured && !error) {
        try {
          const c = loadConfig(config);
          apps = c.apps.map((a) => appState(c, config, a));
        } catch (e) { error = e instanceof Error ? e.message : String(e); }
      }
      current = { ...sum, error, apps };
    }
    return {
      projects, current, openProject, job: job && { action: job.action, project: job.project, app: job.app }, lastResult,
      windows: isWindows, projectsRoot: projectsRoot(), langs: STEAM_LANGS.map((l) => ({ id: l, name: LANG_NAMES[l] ?? l })),
    };
  }

  async function run(req: RunReq) {
    const project = req.action === 'login' && !req.project ? '' : requireProject(req.project);
    // 登录不需要项目配置好：没配置时用默认的共用登录目录
    const c: Config = project && existsSync(project) ? loadConfig(project) : { profileDir: join(appHome(), 'profile'), browserChannel: 'msedge' } as Config;
    const app = req.action === 'login' ? undefined : selectApps(c, [req.app])[0];
    job = { action: req.action, project, app: app?.key ?? '', log: [] };
    const log: Log = (line) => { job!.log.push(line); send('log', line); };
    send('job', { action: req.action, project, app: app?.key });
    let ok = true;
    try {
      if (req.action === 'login') {
        ok = await loginFlow(c, log);
      } else {
        const { ctx, page } = await openBrowser(c, true);
        try {
          log(`■ ${app!.key} (${app!.appid}) ${({ pull: '拉取', diff: '刷新后台状态', push: '上传文本', assets: '上传图片', 'delete-images': '删除后台图片' })[req.action]}${req.dryRun ? '（演练）' : ''}`);
          const rk = project + '|' + app!.key;
          if (req.action === 'pull') {
            ok = await pullApp(page, c, app!, { force: req.force }, log);
            if (ok) remoteChecks.delete(rk);
          } else if (req.action === 'diff') {
            const changes = await diffApp(page, c, app!);
            if (!changes) { log('  尚未从后台拉取过，已读取后台的图片状态。拉取后才能对比文本。'); }
            else {
              remoteChecks.set(rk, { at: new Date().toISOString(), changes: new Map(changes.map((ch) => [ch.key, ch])) });
              const n = (k: string) => changes.filter((ch) => ch.kind === k).length;
              log(changes.length ? `  本地改动 ${n('local')}，后台被改过 ${n('remote')}，冲突 ${n('conflict')}，后台已删除 ${n('gone')}` : '  ✓ 文本和后台一致');
            }
          } else {
            const r = req.action === 'push'
              ? await pushApp(page, c, app!, { dryRun: req.dryRun, force: req.force, only: req.only }, log)
              : req.action === 'delete-images'
                ? await deleteImagesApp(page, c, app!, { targets: req.only ?? [], dryRun: req.dryRun }, log)
                : await assetsApp(page, c, app!, { dryRun: req.dryRun, force: req.force, only: req.only }, log);
            ok = !r.failed;
            if (r.pushed) {
              log(DRAFT_NOTE);
              remoteChecks.delete(rk); // 线上变了，旧的对比结果作废
            }
          }
        } finally {
          await ctx.close().catch(() => {});
        }
      }
    } catch (e) {
      ok = false;
      log(`错误: ${e instanceof Error ? e.message : e}`);
    } finally {
      const lines = job!.log.map((l) => l.trim());
      lastResult = {
        project, app: app?.key ?? '', action: req.action, dryRun: !!req.dryRun, ok, at: new Date().toISOString(),
        needLogin: lines.some((l) => /未登录或已过期/.test(l)),
        // 只保留结果行：成功、失败、警告、后台位置、提醒
        lines: lines.filter((l) => /^(✓|✗|⚠|→|后台位置|本地文件|提醒|错误|跳过|没有需要|本地改动|尚未)/.test(l)),
      };
      job = undefined;
      send('done', { ok });
      send('changed', null);
    }
  }

  // 本地文件变了（AI 或编辑器改的）就通知网页刷新。文件不多，直接轮询 mtime
  const signature = () => {
    const parts: string[] = [];
    const walk = (p: string) => {
      if (!existsSync(p)) return;
      const s = statSync(p);
      if (!s.isDirectory()) { parts.push(p + s.mtimeMs + ':' + s.size); return; }
      for (const f of readdirSync(p)) walk(join(p, f));
    };
    walk(join(appHome(), 'projects.json'));
    for (const { config } of listProjects()) {
      try {
        walk(config);
        walk(join(config, '..', 'STEAM_RULES.md'));
        if (!existsSync(config)) continue;
        const c = loadConfig(config);
        for (const a of c.apps) {
          walk(a.storeDir); walk(a.assets.dir);
          for (const d of ['snapshots', 'assets', 'remote']) walk(join(c.stateDir, d, a.key + '.json'));
        }
      } catch (e) {
        parts.push('error:' + e);
      }
    }
    return parts.join('|');
  };
  let lastSig = signature();
  const timer = setInterval(() => {
    if (!clients.size || job) return;
    const s = signature();
    if (s !== lastSig) { lastSig = s; send('changed', null); }
  }, 1000);
  const touched = () => { lastSig = signature(); send('changed', null); };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readRaw = async (req: IncomingMessage, limit: number) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) {
      size += (ch as Buffer).length;
      if (size > limit) throw new Error(`文件太大（超过 ${limit / 1024 / 1024} MB）`);
      chunks.push(ch as Buffer);
    }
    return Buffer.concat(chunks);
  };
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };
  const appOf = (project: unknown, key: unknown) => {
    const c = loadConfig(requireProject(String(project ?? '')));
    return { c, app: selectApps(c, [String(key ?? '')])[0] };
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = (k: string) => url.searchParams.get(k);
      const origin = `http://${req.headers.host}`;
      // 只接受本机地址访问，防止其他网页通过 DNS 重绑定调用这里的接口
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden host' });
      if (req.method === 'POST' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
      const route = `${req.method} ${url.pathname}`;

      switch (route) {
        case 'GET /':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(readFileSync(join(import.meta.dirname, 'page.html')));
        case 'GET /favicon.ico':
          res.writeHead(204).end();
          return;
        case 'GET /api/ping':
          return json(res, 200, { app: 'autosteamworks' });
        case 'GET /api/state':
          return json(res, 200, state(q('project')));
        case 'GET /api/events':
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(': hi\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        case 'GET /api/asset': {
          const { app } = appOf(q('project'), q('app'));
          const root = resolve(app.assets.dir);
          const p = resolve(root, q('rel') ?? '');
          if (!p.startsWith(root + sep) || !existsSync(p)) return json(res, 404, { error: 'not found' });
          const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
          res.writeHead(200, { 'content-type': mime[extname(p).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
          return res.end(readFileSync(p));
        }
        case 'GET /api/settings':
          return json(res, 200, readSettings(requireProject(q('project'))));
        case 'GET /api/rules':
          return json(res, 200, readRules(requireProject(q('project'))));
        case 'GET /api/rules/prompt':
          return json(res, 200, { text: aiPrompt(requireProject(q('project'))) });
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      if (url.pathname === '/api/images/drop') {
        // 网页拖进来的图片，请求体是文件本身；不带 slot 就放进待分类，带 slot + lang 就直接放到那一格
        const { app } = appOf(q('project'), q('app'));
        if (job?.action === 'assets') return json(res, 409, { error: '正在上传图片，等它结束再放新图片' });
        const bytes = await readRaw(req, 50 * 1024 * 1024);
        const name = q('name') ?? '';
        const slot = q('slot');
        const line = slot ? placeImage(app, name, bytes, slot, q('lang') ?? '') : `已放进 ${addToInbox(app, name, bytes)}`;
        touched();
        return json(res, 200, { line });
      }
      const b = await readBody(req);
      switch (url.pathname) {
        case '/api/projects/pick':
          return json(res, 200, { path: (await pickFolder()) ?? null });
        case '/api/projects/add': {
          const rec = addProject(String(b.path ?? ''));
          touched();
          return json(res, 200, rec);
        }
        case '/api/projects/create': {
          const r = createProjectByAppid({ appid: b.appid, name: b.name, languages: b.languages });
          touched();
          return json(res, 200, r);
        }
        case '/api/projects/remove':
          removeProject(requireProject(b.project));
          touched();
          return json(res, 200, { ok: true });
        case '/api/projects/init': {
          const made = initProject(requireProject(b.project), { name: b.name, appid: b.appid, languages: b.languages, key: b.key });
          touched();
          return json(res, 200, { made });
        }
        case '/api/settings':
          writeSettings(requireProject(b.project), b.settings);
          touched();
          return json(res, 200, { ok: true });
        case '/api/rules':
          if (typeof b.text !== 'string') return json(res, 400, { error: 'text 必须是字符串' });
          writeRules(requireProject(b.project), b.text);
          touched();
          return json(res, 200, { ok: true });
        case '/api/rules/upgrade': {
          const text = upgradeRules(requireProject(b.project));
          touched();
          return json(res, 200, { text });
        }
        case '/api/field': {
          const { app } = appOf(b.project, b.app);
          if (typeof b.value !== 'string' && typeof b.value !== 'boolean') return json(res, 400, { error: 'value 必须是字符串或布尔值' });
          writeLocalField(app, b.key, b.value);
          touched();
          return json(res, 200, { ok: true });
        }
        case '/api/images/sort': {
          // 只在本地移动文件，不碰后台，不占用任务；只是别在上传图片的时候挪文件
          const { app } = appOf(b.project, b.app);
          if (job?.action === 'assets') return json(res, 409, { error: '正在上传图片，等它结束再整理' });
          const items = sortInbox(app);
          touched();
          return json(res, 200, { items, lines: items.map(describeItem) });
        }
        case '/api/run': {
          const r = b as RunReq;
          if (!['pull', 'diff', 'push', 'assets', 'delete-images', 'login'].includes(r.action)) return json(res, 400, { error: '未知操作' });
          if (job) return json(res, 409, { error: `正在执行 ${job.action}，请等它结束` });
          if (r.action !== 'login') appOf(r.project, r.app); // 先校验项目和 App
          else if (r.project) requireProject(r.project);
          void run(r);
          return json(res, 202, { ok: true });
        }
        case '/api/shortcut':
          return json(res, 200, { made: await createShortcuts() });
        case '/api/quit':
          json(res, 200, { ok: true });
          setTimeout(() => o.onQuit?.(), 200);
          return;
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(o.port, '127.0.0.1', ok);
  });
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : o.port}/`;
  return {
    url,
    close: () => {
      clearInterval(timer);
      for (const c of clients) c.end();
      server.closeAllConnections();
      server.close();
    },
  };
}
