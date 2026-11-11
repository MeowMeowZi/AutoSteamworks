// 后台网页的端到端测试（模拟后台）：状态接口、改动高亮、规则检查、本地编辑、只上传勾选的字段、图片、安全限制、文件变动推送
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { start } from './mock-partner.js';
import { png } from './png.js';
import { startUi } from '../src/ui/server.js';

const run = promisify(execFile);
const srv = await start();
const ws = mkdtempSync(join(tmpdir(), 'autosw-ui-'));
const cfgFile = join(ws, 'steam.config.yaml');
writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
partner: { storeEditUrl: "${srv.url}/admin/game/editbyappid/{appid}", delayMs: 0 }
languages: [english, schinese]
apps:
  game: { appid: 100, name: 测试游戏 }
`);
const cli = async (...a: string[]) => (await run(process.execPath,
  ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli.ts'), '-c', cfgFile, ...a], { encoding: 'utf8' })).stdout;
const store = join(ws, 'apps', 'game', 'store');
const remote = () => srv.db['1100'];

const ui = await startUi(cfgFile, 0);
const origin = ui.url.replace(/\/$/, '');
const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
const post = (path: string, body: unknown, o = origin) =>
  fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: o }, body: JSON.stringify(body) });
const game = async () => (await get('/api/state')).apps[0];
const field = (a: any, lang: string, path: string) => a.localized.find((r: any) => r.path === path)?.langs[lang];

/** 等后台任务结束，返回期间的日志 */
async function runJob(body: object) {
  const r = await post('/api/run', { app: 'game', ...body });
  assert.equal(r.status, 202, await r.text());
  for (let i = 0; i < 300; i++) {
    await new Promise((ok) => setTimeout(ok, 200));
    if (!(await get('/api/state')).job) return;
  }
  throw new Error('任务超时');
}

/** 订阅 SSE，返回收到的事件名列表 */
function listen() {
  const events: string[] = [];
  const ac = new AbortController();
  void fetch(origin + '/api/events', { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    for await (const chunk of r.body as any) for (const m of dec.decode(chunk).matchAll(/^event: (\w+)/gm)) events.push(m[1]);
  }).catch(() => {});
  return { events, stop: () => ac.abort() };
}

let ok = false;
try {
  assert.match(await (await fetch(origin + '/')).text(), /AutoSteamworks/);
  let a = await game();
  assert.equal(a.pulled, false);

  // 网页上拉取
  await runJob({ action: 'pull' });
  a = await game();
  assert.equal(a.pulled, true);
  assert.equal(field(a, 'english', 'about').local, 'Old about\n[b]bold[/b]');
  assert.equal(field(a, 'english', 'about').edited, false);

  // 模拟 AI 改本地文件：网页通过 SSE 收到 changed，字段显示为改动并带差异片段
  const sse = listen();
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(join(store, 'english', 'about.bbcode'), 'New about\n[b]bold[/b]');
  writeFileSync(join(store, 'english', 'short_description.bbcode'), 'Lazy god idles.');
  writeFileSync(join(store, 'schinese', 'short_description.bbcode'), '长'.repeat(301));
  for (let i = 0; i < 30 && !sse.events.includes('changed'); i++) await new Promise((r) => setTimeout(r, 100));
  sse.stop();
  assert.ok(sse.events.includes('changed'), '本地文件改动会推送 changed 事件');
  a = await game();
  const about = field(a, 'english', 'about');
  assert.equal(about.edited, true);
  assert.deepEqual(about.parts.filter((p: any) => p.t !== 0).map((p: any) => [p.t, p.v]), [[-1, 'Old'], [1, 'New']]);
  assert.ok(a.lint.some((i: any) => i.key === 'app[content][short_description][schinese]' && i.level === 'error' && /301/.test(i.msg)), '超长简短描述报错');
  assert.ok(a.lint.some((i: any) => i.key === 'app[content][about][schinese]' && /空/.test(i.msg)), '没翻译的字段提示');

  // 命令行的离线检查（给 AI 改完自查用）：有错误时退出码为 1
  const chk = await cli('check').then(() => '', (e) => `EXIT ${e.code}\n${e.stdout}`);
  assert.match(chk, /^EXIT 1/);
  assert.match(chk, /✗ schinese\/short_description  301 个字符/);
  assert.match(chk, /↑ english\/about/);

  // 网页上编辑：yaml 字段保留注释
  const fy = join(store, 'schinese', '_fields.yaml');
  writeFileSync(fy, '# 我的注释\n' + readFileSync(fy, 'utf8'));
  assert.equal((await post('/api/field', { app: 'game', key: 'app[content][sysreqs][windows][min][processor][schinese]', value: 'i5' })).status, 200);
  assert.match(readFileSync(fy, 'utf8'), /# 我的注释[\s\S]*sysreqs.windows.min.processor: "?i5"?\n/);
  assert.equal((await post('/api/field', { app: 'game', key: 'app[content][short_description][schinese]', value: '' })).status, 200);
  assert.equal(readFileSync(join(store, 'schinese', 'short_description.bbcode'), 'utf8'), '');
  assert.equal((await post('/api/field', { app: 'game', key: 'app[nope]', value: 'x' })).status, 500, '不存在的字段拒绝写入');

  // 安全：其他网站的页面不能调用写接口；图片接口不能读 assets 目录以外的文件
  assert.equal((await post('/api/field', { app: 'game', key: 'app[name]', value: 'x' }, 'http://evil.example')).status, 403);
  assert.equal((await fetch(origin + '/api/asset?app=game&rel=' + encodeURIComponent('../store/_common.yaml'))).status, 404);

  // 和线上对比：线上改了网站链接（本地没动）
  remote()['app[content][links][website]'] = 'https://example.com';
  await runJob({ action: 'diff' });
  a = await game();
  assert.ok(a.remoteCheckedAt);
  assert.ok(a.remoteAt, '对比时顺便保存了后台状态');
  assert.deepEqual(a.remoteOnly, ['app[content][links][website]']);
  assert.equal(field(a, 'english', 'about').remote.kind, 'local');

  // 只上传勾选的一个字段，演练不写入
  await runJob({ action: 'push', only: ['app[content][about][english]'], dryRun: true });
  assert.equal(remote()['app[content][about][english]'], 'Old about\n[b]bold[/b]');
  await runJob({ action: 'push', only: ['app[content][about][english]'] });
  assert.equal(remote()['app[content][about][english]'].replace(/\r\n/g, '\n'), 'New about\n[b]bold[/b]');
  assert.equal(remote()['app[content][short_description][english]'], '', '没勾选的字段不上传');
  a = await game();
  assert.equal(field(a, 'english', 'about').edited, false, '上传后变成已同步');
  assert.equal(field(a, 'english', 'short_description').edited, true, '没上传的仍是改动');
  assert.equal(a.remoteCheckedAt, undefined, '上传后旧的对比结果作废');

  // 任务进行中拒绝新任务
  const first = post('/api/run', { app: 'game', action: 'diff' });
  assert.equal((await first).status, 202);
  assert.equal((await post('/api/run', { app: 'game', action: 'diff' })).status, 409);
  await runJob({ action: 'diff' }).catch(() => {}); // 等前一个结束
  for (let i = 0; i < 100 && (await get('/api/state')).job; i++) await new Promise((r) => setTimeout(r, 200));

  // 图片：列出状态、预览、只上传勾选的
  const put = (rel: string, data: Buffer) => {
    const p = join(ws, 'apps', 'game', 'assets', rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data);
  };
  put('store/english/header.png', png(920, 430));
  put('store/english/small.png', png(462, 174));
  put('store/english/bad.png', png(100, 100));
  a = await game();
  const cell = (x: any, slot: string, lang: string) => x.images.slots.find((s: any) => s.id === slot).cells[lang];
  assert.equal(cell(a, 'header', 'english').status, 'pending');
  assert.equal(cell(a, 'header', 'english').local.size, '920x430', '离线按尺寸识别');
  assert.equal(cell(a, 'header', 'schinese').status, 'fallback', '非英语没有图时提示会显示英文版');
  assert.equal(cell(a, 'main_capsule', 'english').status, 'missing-required');
  assert.ok(a.images.issues.some((i: any) => i.level === 'error' && /主宣传图、竖向宣传图/.test(i.msg) && !/形象图片/.test(i.msg)), '缺少英文必填图');
  assert.ok(a.images.issues.some((i: any) => /bad\.png.*100x100/.test(i.msg)), '尺寸不对的图报错');
  assert.deepEqual(a.images.pending, ['store/english/header.png', 'store/english/small.png'], '尺寸不对的图不算待上传');
  assert.equal(a.summary.imagesPending, 2);
  const img = await fetch(origin + '/api/asset?app=game&rel=store/english/header.png');
  assert.equal(img.headers.get('content-type'), 'image/png');

  await runJob({ action: 'assets', only: ['store/english/small.png'] });
  assert.deepEqual(srv.uploads.map((u) => u.filename), ['small.png']);
  a = await game();
  assert.equal(cell(a, 'small_capsule', 'english').status, 'synced', '上传后自动读取后台状态并核对');
  assert.match(cell(a, 'small_capsule', 'english').remoteUrl, /h1\/small\.png$/);
  assert.equal(cell(a, 'header', 'english').status, 'pending');
  const lr = (await get('/api/state')).lastResult;
  assert.ok(lr.ok && lr.lines.some((l: string) => l.startsWith('后台位置：商店页管理 → 图像资产 → 商店资产 → 小宣传图 → english')), '结果框写明后台位置');

  // 字段显示成后台上的名字
  assert.equal(field(a, 'english', 'short_description').info.label, '简短描述');
  assert.equal(field(a, 'english', 'short_description').info.tab, '描述');

  ok = true;
  console.log('\n✓ 后台网页测试全部通过');
} finally {
  ui.close();
  srv.close();
  rmSync(ws, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
}
