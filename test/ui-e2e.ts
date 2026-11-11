// 后台网页的端到端测试（模拟后台）：项目管理、初始化、设置、AI 规则、状态接口、改动高亮、规则检查、本地编辑、只上传勾选的字段、图片、安全限制、文件变动推送
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { start } from './mock-partner.js';
import { png } from './png.js';
import YAML from 'yaml';
import { startUi } from '../src/ui/server.js';

const run = promisify(execFile);
const srv = await start();
const ws = mkdtempSync(join(tmpdir(), 'autosw-ui-'));
process.env.AUTOSW_HOME = join(ws, 'home'); // 项目列表放临时目录，不碰真实的 ~/.autosteamworks
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

const ui = await startUi({ port: 0, open: cfgFile });
const origin = ui.url.replace(/\/$/, '');
const P = cfgFile; // 当前项目（启动时通过 open 加入）
const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
const rawPost = (path: string, body: unknown, o = origin) =>
  fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: o }, body: JSON.stringify(body) });
const post = (path: string, body: object, o = origin) => rawPost(path, { project: P, ...body }, o);
const stateOf = (project = P) => get('/api/state?project=' + encodeURIComponent(project));
const game = async () => (await stateOf()).current.apps[0];
const asset = (rel: string) => fetch(origin + `/api/asset?project=${encodeURIComponent(P)}&app=game&rel=${encodeURIComponent(rel)}`);
const field = (a: any, lang: string, path: string) => a.localized.find((r: any) => r.path === path)?.langs[lang];

/** 等后台任务结束，返回期间的日志 */
async function runJob(body: object) {
  const r = await post('/api/run', { app: 'game', ...body });
  assert.equal(r.status, 202, await r.text());
  for (let i = 0; i < 300; i++) {
    await new Promise((ok) => setTimeout(ok, 200));
    if (!(await stateOf()).job) return;
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
  assert.deepEqual(await get('/api/ping'), { app: 'autosteamworks' });

  // ---- 项目管理：添加一个空文件夹 → 网页上初始化 → 设置 → AI 规则 → 移除 ----
  const g2 = join(ws, 'game2');
  mkdirSync(g2);
  writeFileSync(join(g2, '.gitignore'), 'Library/');
  const c2 = join(g2, 'steam.config.yaml');
  assert.equal((await rawPost('/api/projects/add', { path: g2 })).status, 200);
  let st = await get('/api/state');
  assert.deepEqual(st.projects.map((p: any) => [p.config, p.configured]), [[P, true], [c2, false]], '启动时 open 的项目和新加的都在列表里');
  assert.equal(st.openProject, P);
  assert.equal((await rawPost('/api/projects/add', { path: join(ws, 'nope') })).status, 500, '不存在的路径');
  let r = await rawPost('/api/projects/init', { project: c2, name: '第二个游戏', appid: 'abc', languages: ['english'] });
  assert.match((await r.json()).error, /appid/);
  r = await rawPost('/api/projects/init', { project: c2, name: '第二个游戏', appid: 2000, languages: ['english', 'japanese'] });
  assert.equal(r.status, 200);
  assert.ok(existsSync(join(g2, 'STEAM_RULES.md')));
  assert.match(readFileSync(join(g2, 'CLAUDE.md'), 'utf8'), /STEAM_RULES\.md/, '初始化时让 Claude Code 知道规则文件');
  assert.ok(existsSync(join(g2, 'apps', 'game', 'assets', '待分类')), '初始化时建好图片收件箱');
  assert.match(readFileSync(join(g2, '.gitignore'), 'utf8'), /^Library\/\n# AutoSteamworks.*\n\.autosw\/\n$/);
  st = await stateOf(c2);
  assert.equal(st.current.configured, true);
  assert.equal(st.current.apps[0].appid, 2000);
  assert.deepEqual(st.current.apps[0].languages, ['english', 'japanese']);

  const s2 = await get('/api/settings?project=' + encodeURIComponent(c2));
  assert.deepEqual(s2.apps, [{ key: 'game', name: '第二个游戏', appid: 2000, languages: [], screenshotsAllAges: null }]);
  writeFileSync(c2, '# 用户自己的注释\n' + readFileSync(c2, 'utf8'));
  s2.apps[0].screenshotsAllAges = true;
  s2.apps.push({ key: 'demo', name: '试玩版', appid: 2001, languages: ['english'], screenshotsAllAges: null });
  assert.equal((await rawPost('/api/settings', { project: c2, settings: s2 })).status, 200);
  let y = YAML.parse(readFileSync(c2, 'utf8'));
  assert.match(readFileSync(c2, 'utf8'), /# 用户自己的注释/, '保留注释');
  assert.equal(y.apps.game.assets.screenshotsAllAges, true);
  assert.deepEqual(y.apps.demo, { appid: 2001, name: '试玩版', languages: ['english'] });
  s2.apps = s2.apps.filter((x: any) => x.key !== 'demo');
  s2.apps[0].screenshotsAllAges = null;
  assert.equal((await rawPost('/api/settings', { project: c2, settings: s2 })).status, 200);
  y = YAML.parse(readFileSync(c2, 'utf8'));
  assert.deepEqual(Object.keys(y.apps), ['game']);
  assert.equal(y.apps.game.assets, undefined, '空的 assets 被清掉');
  assert.equal((await rawPost('/api/settings', { project: c2, settings: { ...s2, apps: [{ ...s2.apps[0], key: 'Bad Key' }] } })).status, 500);

  const rules = await get('/api/rules?project=' + encodeURIComponent(c2));
  assert.equal(rules.exists, true);
  assert.equal((await rawPost('/api/rules', { project: c2, text: rules.text + '\n- 术语：邪神 = Evil God\n' })).status, 200);
  assert.match(readFileSync(join(g2, 'STEAM_RULES.md'), 'utf8'), /邪神 = Evil God/);
  assert.equal((await get('/api/rules?project=' + encodeURIComponent(c2))).outdated, false, '只改了风格一节不算旧版');

  // 复制给 AI：项目现状 + 完整规则
  const prompt = (await get('/api/rules/prompt?project=' + encodeURIComponent(c2))).text as string;
  assert.match(prompt, /appid 2000/);
  assert.match(prompt, /还没从后台拉取/);
  assert.match(prompt, /-c ".*steam\.config\.yaml" check/);
  assert.match(prompt, /邪神 = Evil God/, '带上规则全文');

  // 旧版规则：通用部分被换成新模板，风格一节保留
  writeFileSync(join(g2, 'STEAM_RULES.md'), '# 旧规则\n\n旧的通用内容\n\n## 本项目的风格（用户自己填写）\n\n- 语气：轻松\n');
  assert.equal((await get('/api/rules?project=' + encodeURIComponent(c2))).outdated, true);
  assert.equal((await rawPost('/api/rules/upgrade', { project: c2 })).status, 200);
  const upgraded = readFileSync(join(g2, 'STEAM_RULES.md'), 'utf8');
  assert.doesNotMatch(upgraded, /旧的通用内容/);
  assert.match(upgraded, /## 工作流程/);
  assert.match(upgraded, /- 语气：轻松\n$/);
  assert.equal((await get('/api/rules?project=' + encodeURIComponent(c2))).outdated, false);
  assert.equal(readFileSync(join(g2, 'CLAUDE.md'), 'utf8').match(/STEAM_RULES\.md/g)!.length, 1, '指引不重复添加');

  assert.equal((await rawPost('/api/projects/remove', { project: c2 })).status, 200);
  assert.ok(existsSync(c2), '移除项目不删文件');
  assert.match((await (await rawPost('/api/rules', { project: c2, text: 'x' })).json()).error, /未知项目/, '不在列表里的项目不能读写');

  // ---- 只填 App ID 添加：自动建文件夹并初始化；同一个 appid 不重复建 ----
  const root = join(ws, 'home', 'projects');
  assert.equal((await get('/api/state')).projectsRoot, root);
  assert.match((await (await rawPost('/api/projects/create', { appid: 'x' })).json()).error, /appid/);
  let cr = await (await rawPost('/api/projects/create', { appid: 3000, name: '新游戏: 第一部' })).json();
  const c3 = join(root, '3000 新游戏 第一部', 'steam.config.yaml');
  assert.deepEqual([cr.config, cr.existed], [c3, false], '文件夹名去掉了 Windows 不允许的字符');
  assert.ok(existsSync(join(root, '3000 新游戏 第一部', 'STEAM_RULES.md')));
  st = await stateOf(c3);
  assert.deepEqual([st.current.apps[0].appid, st.current.apps[0].name, st.current.apps[0].languages], [3000, '新游戏: 第一部', ['english', 'schinese']]);
  cr = await (await rawPost('/api/projects/create', { appid: 3000 })).json();
  assert.deepEqual([cr.config, cr.existed], [c3, true], '同一个 appid 直接返回已有项目');
  cr = await (await rawPost('/api/projects/create', { appid: 100 })).json();
  assert.equal(cr.config, P, '用文件夹添加的项目也按 appid 认出来');
  cr = await (await rawPost('/api/projects/create', { appid: 3001 })).json();
  assert.equal(cr.config, join(root, '3001', 'steam.config.yaml'), '不填名称时文件夹就叫 appid');
  assert.equal(YAML.parse(readFileSync(cr.config, 'utf8')).apps.game.name, 'App 3001');
  for (const c of [c3, cr.config]) assert.equal((await rawPost('/api/projects/remove', { project: c })).status, 200);
  cr = await (await rawPost('/api/projects/create', { appid: 3001 })).json();
  assert.deepEqual([cr.existed, (await get('/api/state')).projects.some((p: any) => p.config === cr.config)], [true, true], '移除后再添加：沿用原来的文件夹');
  assert.equal((await rawPost('/api/projects/remove', { project: cr.config })).status, 200);

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
  assert.equal((await asset('../store/_common.yaml')).status, 404);

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
  for (let i = 0; i < 100 && (await stateOf()).job; i++) await new Promise((r) => setTimeout(r, 200));

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
  // 待分类：网页上能看到每张图会去哪里，点“整理”移动
  put('待分类/竖向_英文.png', png(748, 896));
  a = await game();
  assert.deepEqual(a.images.inbox.items.map((x: any) => [x.from, x.to, x.slot]), [['待分类/竖向_英文.png', 'store/english/竖向_英文.png', '竖向宣传图']]);
  const sorted = await rawPost('/api/images/sort', { project: P, app: 'game' });
  assert.equal(sorted.status, 200);
  assert.match((await sorted.json()).lines[0], /竖向宣传图/);
  a = await game();
  assert.equal(a.images.inbox.items.length, 0);
  assert.equal(cell(a, 'vertical_capsule', 'english').status, 'pending', '整理后就是待上传');
  rmSync(join(ws, 'apps', 'game', 'assets', 'store', 'english', '竖向_英文.png'));

  // 拖拽：请求体就是文件本身
  const drop = async (q: Record<string, string>, data: Buffer, o = origin) => {
    const r = await fetch(origin + '/api/images/drop?' + new URLSearchParams({ project: P, app: 'game', ...q }),
      { method: 'POST', headers: { origin: o, 'content-type': 'image/png' }, body: new Uint8Array(data) });
    return { status: r.status, ...(await r.json()) };
  };
  const AD = join(ws, 'apps', 'game', 'assets');
  // 拖到页面空白处：先进待分类，再整理
  let d = await drop({ name: '竖向_cn.png' }, png(748, 896, 3));
  assert.equal(d.status, 200);
  assert.ok(existsSync(join(AD, '待分类', '竖向_cn.png')));
  assert.equal((await drop({ name: '竖向_cn.png' }, png(748, 896, 4))).line, '已放进 待分类/竖向_cn-2.png', '重名加序号，不覆盖');
  assert.equal((await rawPost('/api/images/sort', { project: P, app: 'game' })).status, 200);
  // 按文件名顺序，竖向_cn-2.png 排在前面，先占了位置
  assert.ok(existsSync(join(AD, 'store', 'schinese', '竖向_cn-2.png')));
  assert.ok(existsSync(join(AD, '待分类', '竖向_cn.png')), '抢同一个位置的留在待分类');
  rmSync(join(AD, '待分类', '竖向_cn.png'));
  // 拖到某一格：直接放到那个位置和语言，原来的挪到 已替换/
  d = await drop({ name: 'new_vertical.png', slot: 'vertical_capsule', lang: 'schinese' }, png(748, 896, 5));
  assert.match(d.line, /store\/schinese\/new_vertical\.png.*原来的 store\/schinese\/竖向_cn-2\.png 挪到 已替换/);
  assert.ok(existsSync(join(AD, '已替换', 'store', 'schinese', '竖向_cn-2.png')));
  d = await drop({ name: 'x.png', slot: 'vertical_capsule', lang: 'schinese' }, png(920, 430));
  assert.equal(d.status, 500);
  assert.match(d.error, /920 x 430.*竖向宣传图要求 748 x 896/, '尺寸不对的格子拒绝');
  assert.match((await drop({ name: 'x.png', slot: 'header', lang: 'japanese' }, png(920, 430))).error, /japanese/);
  assert.match((await drop({ name: 'evil.exe' }, Buffer.from('MZ'))).error, /只支持/);
  assert.equal((await drop({ name: '..\\..\\escape.png' }, png(920, 430))).line, '已放进 待分类/escape.png', '文件名里的路径被去掉');
  assert.equal((await drop({ name: 'a.png' }, png(920, 430), 'http://evil.example')).status, 403, '别的网页不能往这里放文件');
  rmSync(join(AD, '待分类', 'escape.png'));
  rmSync(join(AD, 'store', 'schinese'), { recursive: true });
  rmSync(join(AD, '已替换'), { recursive: true });
  a = await game();

  const img = await asset('store/english/header.png');
  assert.equal(img.headers.get('content-type'), 'image/png');

  await runJob({ action: 'assets', only: ['store/english/small.png'] });
  assert.deepEqual(srv.uploads.map((u) => u.filename), ['small.png']);
  a = await game();
  assert.equal(cell(a, 'small_capsule', 'english').status, 'synced', '上传后自动读取后台状态并核对');
  assert.match(cell(a, 'small_capsule', 'english').remoteUrl, /h1\/small\.png$/);
  assert.equal(cell(a, 'header', 'english').status, 'pending');
  const lr = (await stateOf()).lastResult;
  assert.ok(lr.ok && lr.lines.some((l: string) => l.startsWith('后台位置：商店页管理 → 图像资产 → 商店资产 → 小宣传图 → english')), '结果框写明后台位置');

  // 从后台删除图片：后台没有了，本地那张变回待上传
  await runJob({ action: 'delete-images', only: ['small_capsule|english'] });
  assert.deepEqual(srv.deletes.filter((k) => k.includes('[image][')), ['app[assets][small_capsule][image][english]']);
  a = await game();
  assert.equal(cell(a, 'small_capsule', 'english').remoteUrl, undefined, '删除后自动读取后台状态');
  assert.equal(cell(a, 'small_capsule', 'english').status, 'pending');
  const dr = (await stateOf()).lastResult;
  assert.ok(dr.ok && dr.action === 'delete-images', JSON.stringify(dr));
  assert.ok(dr.lines.some((l: string) => /^✓ 已删除 小宣传图（英语）（已核对）/.test(l)), JSON.stringify(dr.lines));
  assert.ok(dr.lines.some((l: string) => l.startsWith('本地文件 store/english/small.png 没有删除')), '结果框提醒本地文件还在');

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
