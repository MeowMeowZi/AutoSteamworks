// 本地后台网页：管理多个游戏项目，查看本地内容和改动，勾选后一键上传，配置也在网页上改。只监听 127.0.0.1。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { loadConfig, readSettings, selectApps, writeSettings, type AppConfig, type Config } from '../config.js';
import { STEAM_LANGS, writeLocalField } from '../local/storeFiles.js';
import { readTextState, textView } from '../textState.js';
import { ACTIONS } from '../runner.js';
import { createJobs, type RunReq } from './jobs.js';
import { createWatch } from './watch.js';
import { readMeta } from '../partner/meta.js';
import { LANG_NAMES } from '../fieldInfo.js';
import { imageBoard } from './images.js';
import { addToInbox, describeItem, placeImage, sortInbox } from '../local/inbox.js';
import { addProject, createProjectByAppid, projectsRoot, listProjects, projectSummary, removeProject, requireProject } from '../projects.js';
import { initProject } from '../projectInit.js';
import { aiPrompt, readRules, upgradeRules, writeRules } from '../aiRules.js';
import { createShortcuts, isWindows, pickFolder } from '../desktop.js';

export interface UiOptions {
  port: number;
  /** 启动时自动加入并选中的项目（游戏项目文件夹或配置文件） */
  open?: string;
  /** 网页上点“退出”时调用 */
  onQuit?: () => void;
}

export async function startUi(o: UiOptions) {
  const jobs = createJobs({ notify: (event, data) => watch.send(event, data) });
  // 任务进行中不轮询文件；任务结束时 jobs 自己会通知
  const watch = createWatch({ paused: () => !!jobs.current() });
  const touched = watch.touched;

  const openProject = o.open ? addProject(o.open).config : undefined;

  function appState(c: Config, project: string, app: AppConfig) {
    const text = readTextState(c, app);
    const remote = jobs.remoteCheck(project, app.key);
    const meta = readMeta(c, app);
    const view = textView(text, remote?.changes, meta?.labels);
    const images = imageBoard(c, app, meta);
    const count = (level: 'error' | 'warn') => text.issues.filter((i) => i.level === level).length + images.issues.filter((i) => i.level === level).length;
    return {
      key: app.key, appid: app.appid, name: app.name, languages: app.languages, pulled: text.pulled,
      storeDir: app.storeDir, assetsDir: app.assets.dir,
      common: view.common,
      localized: view.localized,
      images,
      /** 上次从后台读到状态的时间（拉取、对比、上传时都会更新） */
      remoteAt: meta?.at,
      summary: { textEdits: text.edits.length, imagesPending: images.pending.length, errors: count('error'), warnings: count('warn') },
      lint: text.issues,
      remoteCheckedAt: remote?.at,
      remoteOnly: view.remoteOnly,
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
      projects, current, openProject, job: jobs.current(), lastResult: jobs.lastResult(), login: jobs.loginStatus(),
      windows: isWindows, projectsRoot: projectsRoot(), langs: STEAM_LANGS.map((l) => ({ id: l, name: LANG_NAMES[l] ?? l })),
    };
  }

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
          watch.attach(res);
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
        // 网页拖进来的图片，请求体是文件本身；不带 cell 就放进待分类，带 cell（格子 key，例如 header|schinese）就直接放到那一格
        const { app } = appOf(q('project'), q('app'));
        if (jobs.busyWith('assets')) return json(res, 409, { error: '正在上传图片，等它结束再放新图片' });
        const bytes = await readRaw(req, 50 * 1024 * 1024);
        const name = q('name') ?? '';
        const cell = q('cell');
        const line = cell ? placeImage(app, name, bytes, cell) : `已放进 ${addToInbox(app, name, bytes)}`;
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
          if (jobs.busyWith('assets')) return json(res, 409, { error: '正在上传图片，等它结束再整理' });
          const items = sortInbox(app);
          touched();
          return json(res, 200, { items, lines: items.map(describeItem) });
        }
        case '/api/run': {
          const r = b as RunReq;
          if (!ACTIONS.includes(r.action)) return json(res, 400, { error: '未知操作' });
          const busy = jobs.current();
          if (busy) return json(res, 409, { error: `正在执行 ${busy.action}，请等它结束` });
          if (r.action !== 'login') appOf(r.project, r.app); // 先校验项目和 App
          else if (r.project) requireProject(r.project);
          // 登录不需要项目配置好：没配置时用默认的共用登录目录
          const project = r.action === 'login' && !r.project ? '' : requireProject(r.project);
          const started = jobs.start({ ...r, project }, project && existsSync(project) ? project : undefined);
          if ('error' in started) return json(res, 409, { error: started.error });
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
      watch.close();
      server.closeAllConnections();
      server.close();
    },
  };
}
