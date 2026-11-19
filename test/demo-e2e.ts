// Demo 端到端测试（模拟后台，进程内调用 runOperation）：查找 Demo、正式版先拉取、Demo 只写覆盖、正式版的改动推到 Demo、继承的图上传到 Demo
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { start } from './mock-partner.js';
import { png } from './png.js';
import { runOperation, type RunRequest } from '../src/runner.js';
import { addDemoApp, loadConfig } from '../src/config.js';
import { readLocal, readLocalLayers, readSnapshot, writeLocalField, writeSnapshot } from '../src/local/storeFiles.js';
import { RELATED_DEMO } from '../src/demo.js';

const srv = await start();
const ws = mkdtempSync(join(tmpdir(), 'autosw-demo-'));
process.env.AUTOSW_HOME = join(ws, 'home');
const configPath = join(ws, 'steam.config.yaml');
writeFileSync(configPath, `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
partner: { storeEditUrl: "${srv.url}/admin/game/editbyappid/{appid}", delayMs: 0 }
languages: [english, schinese]
assets: { screenshotsAllAges: true }
apps:
  game: { appid: 100, name: 示例冒险 }
`);
const DESC = 'app[content][short_description][english]';
const NAME = 'app[name]';

async function op(req: RunRequest) {
  const all: string[] = [], results: string[] = [];
  const r = await runOperation({ configPath, ...req }, (line, kind) => {
    all.push(line);
    if (kind === 'result') results.push(line.trim());
  });
  console.log(all.join('\n'));
  return { ...r, results };
}
const apps = () => { const c = loadConfig(configPath); return { game: c.apps[0], demo: c.apps[1] }; };

let ok = false;
try {
  // ---- 查找 Demo：默认用正式版名称搜，名称以正式版名称开头的默认选中 ----
  let r = await op({ action: 'find-demos', apps: ['game'] });
  assert.ok(r.ok, JSON.stringify(r.results));
  assert.deepEqual(r.demos?.candidates.map((d) => [d.appid, d.itemid, d.name, d.suggested, d.added]), [[200, 1200, '示例冒险 Demo', true, undefined]]);
  r = await op({ action: 'find-demos', apps: ['game'], term: '300' });
  assert.deepEqual(r.demos?.candidates.map((d) => [d.appid, d.localName, d.suggested]), [[300, '别的游戏 Demo', false]], '按 appid 搜，带本地化名');

  assert.equal(addDemoApp(configPath, 'game', { appid: 200, itemid: 1200, name: '示例冒险 Demo' }), 'demo');
  r = await op({ action: 'find-demos', apps: ['game'] });
  assert.equal(r.demos?.candidates[0].added, 'demo', '已添加的标出来');
  assert.ok(!(await op({ action: 'find-demos', apps: ['demo'] })).ok, 'Demo 不能再找 Demo');

  // ---- 正式版没拉取过：拒绝拉取 Demo ----
  r = await op({ action: 'pull', apps: ['demo'] });
  assert.ok(!r.ok);
  assert.ok(r.results.some((l) => l.includes('请先拉取 game')), JSON.stringify(r.results));

  // ---- 不指定 App：正式版先、Demo 后 ----
  r = await op({ action: 'pull', apps: ['demo', 'game'] });
  assert.ok(r.ok, JSON.stringify(r.results));
  assert.deepEqual(r.apps.map((a) => a.key), ['game', 'demo']);
  let { game, demo } = apps();
  const own = readLocalLayers(demo).own;
  assert.deepEqual(Object.keys(own).sort(), [NAME, 'app[content][standalone_demo_page]'].sort(), '只有和正式版不同的写成覆盖');
  assert.ok(!('app[broadcast][chat_visibility]' in readLocal(demo)), 'Demo 表单里没有的字段不继承');
  assert.equal(readLocal(game)[RELATED_DEMO], '', '正式版有“关联的 Demo”字段');

  // ---- 正式版本地改了：Demo 也跟着有改动，拉取 Demo 被挡住 ----
  writeFileSync(join(game.storeDir, 'english', 'short_description.bbcode'), 'Shared short');
  r = await op({ action: 'pull', apps: ['demo'] });
  assert.ok(!r.ok && r.results.some((l) => l.includes('继承 game')), JSON.stringify(r.results));
  r = await op({ action: 'diff' });
  assert.deepEqual(r.apps.map((a) => [a.key, a.changes?.map((c) => [c.kind, c.key])]), [['game', [['local', DESC]]], ['demo', [['local', DESC]]]]);

  // ---- 推送全部：两个 App 都写上 ----
  writeLocalField(game, RELATED_DEMO, '1200');
  r = await op({ action: 'push' });
  assert.ok(r.ok && r.changedRemote, JSON.stringify(r.results));
  assert.equal(readSnapshot(game)?.[RELATED_DEMO], '1200', '提交后输入框换了下标，仍能核对已保存的关联');
  assert.equal(srv.db['1100'][DESC], 'Shared short');
  assert.equal(srv.db['1200'][DESC], 'Shared short');
  assert.equal(srv.db['1200'][NAME], '示例冒险 Demo', 'Demo 的覆盖没被正式版的值盖掉');
  r = await op({ action: 'diff' });
  assert.ok(r.apps.every((a) => a.changes?.length === 0), '推送后两边都一致');
  r = await op({ action: 'pull', apps: ['demo'] });
  assert.ok(r.ok);
  assert.ok(!(DESC in readLocalLayers(apps().demo).own), '再拉取时和正式版一样的值不写成覆盖');

  // 旧版本误报后留下了空快照；重试时只核对并更新所选字段。
  const lastPost = srv.lastPost();
  writeSnapshot(game, { ...readSnapshot(game), [RELATED_DEMO]: '', [DESC]: '' });
  r = await op({ action: 'push', apps: ['game'], only: [RELATED_DEMO], dryRun: true });
  assert.equal(readSnapshot(game)?.[RELATED_DEMO], '', '预览不动快照');
  r = await op({ action: 'push', apps: ['game'], only: [RELATED_DEMO] });
  assert.ok(r.ok && !r.changedRemote);
  assert.equal(srv.lastPost(), lastPost, '重试已关联的 Demo 不再提交表单');
  assert.equal(readSnapshot(game)?.[RELATED_DEMO], '1200');
  assert.equal(readSnapshot(game)?.[DESC], '', '未选字段保留原快照');
  await op({ action: 'push', apps: ['game'] });

  r = await op({ action: 'pull', apps: ['game'] });
  assert.ok(r.ok);
  const next = 'app[related_items][demos][1][itemid]';
  assert.equal(readLocal(game)[RELATED_DEMO], '1200', '拉取保留已关联记录');
  assert.equal(readLocal(game)[next], '', '下一行仍可添加 Demo');
  writeLocalField(game, next, '9999');
  r = await op({ action: 'push', apps: ['game'] });
  assert.ok(!r.ok && !r.changedRemote, '后台没有保存的 Demo 仍然报错');
  assert.equal(readSnapshot(game)?.[next], '');
  writeLocalField(game, next, '1300');
  r = await op({ action: 'push', apps: ['game'] });
  assert.ok(r.ok && r.changedRemote);
  assert.equal(readSnapshot(game)?.[next], '1300');
  assert.equal(srv.lastPost()?.[RELATED_DEMO], undefined, '已有的关联不作为输入框回传');

  // ---- 图片：Demo 没放图的格子上传正式版的图，上传记录记在 Demo 名下 ----
  const p = join(game.assets.dir, 'store', 'english', 'small.png');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, png(462, 174));
  r = await op({ action: 'assets', apps: ['demo'], dryRun: true });
  assert.ok(r.results.some((l) => l.includes('../../game/assets/store/english/small.png')), JSON.stringify(r.results));
  const before = srv.uploads.length;
  r = await op({ action: 'assets' });
  assert.ok(r.ok, JSON.stringify(r.results));
  assert.equal(srv.uploads.length - before, 2, '正式版和 Demo 各传一张');
  const manifest = JSON.parse(readFileSync(join(ws, '.autosw', 'assets', 'demo.json'), 'utf8'));
  assert.ok(manifest['../../game/assets/store/english/small.png'], JSON.stringify(manifest));
  r = await op({ action: 'assets' });
  assert.ok(r.ok && !r.changedRemote, '传过之后不再重复上传');

  ok = true;
  console.log('\n✓ Demo 端到端测试全部通过');
} finally {
  srv.close();
  if (!ok) console.log('工作目录保留在', ws);
}
