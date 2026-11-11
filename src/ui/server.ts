// 本地后台网页：查看本地内容和改动，勾选后一键上传。只监听 127.0.0.1。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { diffChars, diffLines } from 'diff';
import { loadConfig, selectApps, type AppConfig, type Config } from '../config.js';
import { openBrowser } from '../browser.js';
import type { FieldValue } from '../partner/form.js';
import { hasLocal, norm, readLocal, readSnapshot, splitLocalized, writeLocalField, type Fields } from '../local/storeFiles.js';
import { assetStates, readManifest, scanAssets } from '../local/assetFiles.js';
import { lint } from '../lint.js';
import type { Change } from '../sync.js';
import { assetsApp, diffApp, DRAFT_NOTE, pullApp, pushApp, type Log } from '../ops.js';

type Action = 'pull' | 'diff' | 'push' | 'assets';
interface RunReq { action: Action; app: string; only?: string[]; dryRun?: boolean; force?: boolean }

const eq = (a?: FieldValue, b?: FieldValue) => (a === undefined || b === undefined ? a === b : norm(a) === norm(b));

/** 文本改动的差异片段，网页上用来高亮 */
function parts(from: FieldValue | undefined, to: FieldValue | undefined) {
  if (typeof from !== 'string' || typeof to !== 'string') return undefined;
  const a = norm(from) as string, b = norm(to) as string;
  const d = a.length + b.length < 8000 ? diffChars(a, b) : diffLines(a, b);
  return d.map((p) => ({ v: p.value, t: p.added ? 1 : p.removed ? -1 : 0 }));
}

function fieldView(key: string, local: Fields, base: Fields | undefined, remote: Map<string, Change> | undefined) {
  const l = local[key], b = base?.[key];
  const edited = base ? !eq(l, b) : false;
  const r = remote?.get(key);
  return {
    key, local: l, base: b, edited,
    parts: edited ? parts(b, l) : undefined,
    remote: r && { kind: r.kind, value: r.remote, parts: parts(r.remote, l) },
  };
}

export async function startUi(configPath: string, port: number) {
  /** 最近一次和线上对比的结果，按 App 存 */
  const remoteChecks = new Map<string, { at: string; changes: Map<string, Change> }>();
  const clients = new Set<ServerResponse>();
  let job: { action: Action; app: string; log: string[] } | undefined;

  const cfg = (): Config => loadConfig(configPath);
  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  function appState(c: Config, app: AppConfig) {
    const pulled = hasLocal(app) && !!readSnapshot(c, app);
    const local = hasLocal(app) ? readLocal(app) : {};
    const base = readSnapshot(c, app);
    const remote = remoteChecks.get(app.key);
    const common: ReturnType<typeof fieldView>[] = [];
    const byPath = new Map<string, Record<string, ReturnType<typeof fieldView>>>();
    for (const key of Object.keys(local).sort()) {
      const v = fieldView(key, local, base, remote?.changes);
      const loc = splitLocalized(key);
      if (!loc) { common.push(v); continue; }
      const row = byPath.get(loc.path) ?? {};
      row[loc.lang] = v;
      byPath.set(loc.path, row);
    }
    const { assets, warnings } = scanAssets(app);
    const manifest = readManifest(c, app);
    return {
      key: app.key, appid: app.appid, name: app.name, languages: app.languages, pulled,
      storeDir: app.storeDir, assetsDir: app.assets.dir,
      common,
      localized: [...byPath].map(([path, langs]) => ({ path, langs })),
      assets: assetStates(assets, manifest).map(({ asset, state }) => ({
        rel: asset.rel, tab: asset.tab, lang: asset.lang, state, bytes: asset.bytes.length,
        type: manifest[asset.rel]?.type, uploadedAt: manifest[asset.rel]?.uploadedAt,
      })),
      assetWarnings: warnings,
      lint: lint(app, local),
      remoteCheckedAt: remote?.at,
      /** 线上有、但本地没改的变化（本地改了的已经挂在字段上） */
      remoteOnly: remote ? [...remote.changes.values()].filter((ch) => ch.kind === 'remote').map((ch) => ch.key) : [],
    };
  }

  function state() {
    const c = cfg();
    return { config: resolve(configPath), job: job && { action: job.action, app: job.app }, apps: c.apps.map((a) => appState(c, a)) };
  }

  async function run(req: RunReq) {
    const c = cfg();
    const [app] = selectApps(c, [req.app]);
    job = { action: req.action, app: app.key, log: [] };
    const log: Log = (line) => { job!.log.push(line); send('log', line); };
    send('job', { action: req.action, app: app.key });
    let ok = true;
    const { ctx, page } = await openBrowser(c, true);
    try {
      log(`■ ${app.key} (${app.appid}) ${({ pull: '拉取', diff: '和线上对比', push: '上传文本', assets: '上传图片' })[req.action]}${req.dryRun ? '（演练）' : ''}`);
      if (req.action === 'pull') {
        ok = await pullApp(page, c, app, { force: req.force }, log);
        if (ok) remoteChecks.delete(app.key);
      } else if (req.action === 'diff') {
        const changes = await diffApp(page, c, app);
        if (!changes) { log('  尚未 pull'); ok = false; }
        else {
          remoteChecks.set(app.key, { at: new Date().toISOString(), changes: new Map(changes.map((ch) => [ch.key, ch])) });
          const n = (k: string) => changes.filter((ch) => ch.kind === k).length;
          log(changes.length ? `  本地改动 ${n('local')}，线上改动 ${n('remote')}，冲突 ${n('conflict')}，线上已删除 ${n('gone')}` : '  ✓ 已同步');
        }
      } else {
        const r = req.action === 'push'
          ? await pushApp(page, c, app, { dryRun: req.dryRun, force: req.force, only: req.only }, log)
          : await assetsApp(page, c, app, { dryRun: req.dryRun, force: req.force, only: req.only }, log);
        ok = !r.failed;
        if (r.pushed) {
          log(DRAFT_NOTE);
          remoteChecks.delete(app.key); // 线上变了，旧的对比结果作废
        }
      }
    } catch (e) {
      ok = false;
      log(`错误: ${e instanceof Error ? e.message : e}`);
    } finally {
      await ctx.close().catch(() => {});
      job = undefined;
      send('done', { ok });
      send('changed', null);
    }
  }

  // 本地文件变了（AI 或编辑器改的）就通知网页刷新。文件不多，直接轮询 mtime
  const signature = () => {
    try {
      const c = cfg();
      const parts: string[] = [String(statSync(resolve(configPath)).mtimeMs)];
      const walk = (p: string) => {
        if (!existsSync(p)) return;
        const s = statSync(p);
        if (!s.isDirectory()) { parts.push(p + s.mtimeMs + ':' + s.size); return; }
        for (const f of readdirSync(p)) walk(join(p, f));
      };
      for (const a of c.apps) {
        walk(a.storeDir); walk(a.assets.dir);
        walk(join(c.stateDir, 'snapshots', a.key + '.json'));
        walk(join(c.stateDir, 'assets', a.key + '.json'));
      }
      return parts.join('|');
    } catch (e) {
      return 'error:' + e;
    }
  };
  let lastSig = signature();
  const timer = setInterval(() => {
    if (!clients.size || job) return;
    const s = signature();
    if (s !== lastSig) { lastSig = s; send('changed', null); }
  }, 1000);

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = `http://${req.headers.host}`;
      // 只接受本机地址访问，防止其他网页通过 DNS 重绑定调用这里的接口
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden host' });
      if (req.method === 'POST' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(join(import.meta.dirname, 'page.html')));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/asset') {
        const [app] = selectApps(cfg(), [url.searchParams.get('app') ?? '']);
        const root = resolve(app.assets.dir);
        const p = resolve(root, url.searchParams.get('rel') ?? '');
        if (!p.startsWith(root + sep) || !existsSync(p)) return json(res, 404, { error: 'not found' });
        const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
        res.writeHead(200, { 'content-type': mime[extname(p).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        return res.end(readFileSync(p));
      }
      if (req.method === 'POST' && url.pathname === '/api/field') {
        const b = await readBody(req);
        const [app] = selectApps(cfg(), [b.app]);
        if (typeof b.value !== 'string' && typeof b.value !== 'boolean') return json(res, 400, { error: 'value 必须是字符串或布尔值' });
        writeLocalField(app, b.key, b.value);
        lastSig = signature();
        send('changed', null);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const b = (await readBody(req)) as RunReq;
        if (!['pull', 'diff', 'push', 'assets'].includes(b.action)) return json(res, 400, { error: '未知操作' });
        if (job) return json(res, 409, { error: `正在执行 ${job.action}（${job.app}），请等它结束` });
        selectApps(cfg(), [b.app]); // 先校验 App 名
        void run(b);
        return json(res, 202, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}/`;
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
