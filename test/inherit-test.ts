// Demo 继承正式版的测试（离线）：配置、文本的继承和覆盖、拉取时写覆盖的规则、图片的继承、收件箱只看 Demo 自己的文件
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { addDemoApp, loadConfig, selectApps } from '../src/config.js';
import { clearOverride, readLocal, readLocalLayers, writeLocal, writeLocalField, writeSnapshot } from '../src/local/storeFiles.js';
import { filesIn, parseCell, scanCells } from '../src/local/imageCells.js';
import { placeImage, planInbox, restoreInherited } from '../src/local/inbox.js';
import { readTextState, textView } from '../src/textState.js';
import { localEdits } from '../src/sync.js';
import { png } from './png.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-inherit-'));
const cfgFile = join(ws, 'steam.config.yaml');
writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
languages: [english, schinese]
assets: { screenshotsAllAges: true }
apps:
  game: { appid: 100 }
`);
const ABOUT = (l: string) => `app[content][about][${l}]`;
const DESC = (l: string) => `app[content][short_description][${l}]`;
const NAME = 'app[name]';
const EA = 'app[content][earlyaccess][why][english]';
const STANDALONE = 'app[content][standalone_demo_page]';
const PLAT = 'app[platforms][windows]';
const OS = 'app[content][sysreqs][windows][min][os][english]';

let ok = false;
try {
  // ---- 配置：addDemoApp、继承语言和截图设置、Demo 排在后面 ----
  assert.equal(addDemoApp(cfgFile, 'game', { appid: 200, itemid: 1200, name: 'Game Demo' }), 'demo');
  assert.throws(() => addDemoApp(cfgFile, 'game', { appid: 200, itemid: 1200 }), /已经在这个项目里了/);
  assert.throws(() => addDemoApp(cfgFile, 'demo', { appid: 300, itemid: 1300 }), /本身就是 Demo/);
  let c = loadConfig(cfgFile);
  let [game, demo] = c.apps;
  assert.equal(demo.inherits, game);
  assert.deepEqual([demo.itemid, demo.languages, demo.assets.screenshotsAllAges], [1200, ['english', 'schinese'], true]);
  assert.deepEqual(selectApps(c, ['demo', 'game']).map((a) => a.key), ['game', 'demo'], '正式版先');

  // ---- 文本：Demo 没拉取过 ----
  const gameFields = { [NAME]: 'Game', [ABOUT('english')]: 'About EN', [ABOUT('schinese')]: '关于', [DESC('english')]: 'Short EN', [EA]: 'why', [PLAT]: true, [OS]: 'Win10' };
  writeLocal(game, gameFields);
  writeSnapshot(game, gameFields);
  assert.deepEqual(readLocal(demo), {}, '没拉取过的 Demo 不知道表单里有什么，不继承');

  // ---- 拉取 Demo：只写覆盖 ----
  const demoRemote = { [NAME]: 'Game Demo', [ABOUT('english')]: 'About EN', [ABOUT('schinese')]: '', [DESC('english')]: '', [DESC('schinese')]: '', [STANDALONE]: '1', [PLAT]: false, [OS]: 'Win10' };
  writeLocal(demo, demoRemote);
  writeSnapshot(demo, demoRemote);
  let layers = readLocalLayers(demo);
  assert.deepEqual(layers.own, { [NAME]: 'Game Demo', [STANDALONE]: '1', [PLAT]: false }, '和正式版不同且不是空字符串的才写成覆盖');
  assert.ok(!existsSync(join(demo.storeDir, 'english')) && !existsSync(join(demo.storeDir, 'schinese')), '没有覆盖的语言不建目录');
  assert.deepEqual(readLocal(demo), {
    [NAME]: 'Game Demo', [ABOUT('english')]: 'About EN', [ABOUT('schinese')]: '关于', [DESC('english')]: 'Short EN', [STANDALONE]: '1', [PLAT]: false, [OS]: 'Win10',
  }, '继承正式版、只取 Demo 表单里有的字段（没有抢先体验）');
  assert.deepEqual(localEdits(readLocal(demo), demoRemote).sort(), [ABOUT('schinese'), DESC('english')].sort(), 'Demo 后台空着的字段算本地改动，推送时填上');

  // ---- 网页视图：继承 / 单独设置 ----
  let t = readTextState(demo);
  let view = textView(t);
  const inh = (k: string) => [...view.common, ...view.localized.flatMap((r) => Object.values(r.langs))].find((f) => f.key === k)?.inherit;
  assert.deepEqual([inh(ABOUT('english')), inh(NAME), inh(STANDALONE)], ['inherited', 'overridden', undefined]);

  // ---- 单独设置 / 恢复继承 ----
  writeLocalField(demo, ABOUT('schinese'), 'Demo 的关于');
  assert.equal(readFileSync(join(demo.storeDir, 'schinese', 'about.bbcode'), 'utf8'), 'Demo 的关于', '长文本覆盖写成 .bbcode');
  writeLocalField(demo, DESC('english'), 'Demo short');
  assert.equal(readFileSync(join(demo.storeDir, 'english', 'short_description.bbcode'), 'utf8'), 'Demo short');
  writeLocalField(demo, OS, 'Win11');
  assert.equal(readFileSync(join(demo.storeDir, 'english', '_fields.yaml'), 'utf8'), 'sysreqs.windows.min.os: Win11\n', '其余的写进 _fields.yaml');
  t = readTextState(demo);
  assert.ok(t.overridden.has(ABOUT('schinese')) && t.overridden.has(DESC('english')));
  clearOverride(demo, ABOUT('schinese'));
  clearOverride(demo, DESC('english'));
  clearOverride(demo, OS);
  assert.equal(readLocal(demo)[OS], 'Win10');
  assert.equal(readLocal(demo)[ABOUT('schinese')], '关于', '恢复继承');
  assert.equal(readLocal(demo)[DESC('english')], 'Short EN');
  assert.throws(() => clearOverride(demo, STANDALONE), /正式版本地没有/, 'Demo 独有的字段不能恢复继承');
  assert.throws(() => clearOverride(game, NAME), /只有继承了正式版/);

  // ---- 正式版的本地改动传到 Demo ----
  writeLocalField(game, ABOUT('english'), 'About EN v2');
  assert.equal(readLocal(demo)[ABOUT('english')], 'About EN v2');
  assert.ok(localEdits(readLocal(demo), demoRemote).includes(ABOUT('english')));

  // ---- 再拉取 Demo：原来有覆盖的字段保留覆盖（即使和正式版一样了），不再覆盖的语言清掉旧文件 ----
  writeLocalField(demo, ABOUT('schinese'), 'Demo 关于');
  const remote2 = { ...demoRemote, [NAME]: 'Game', [ABOUT('schinese')]: '关于' };
  writeLocal(demo, remote2);
  layers = readLocalLayers(demo);
  assert.equal(layers.own[NAME], 'Game', '原来有覆盖：照写');
  assert.equal(layers.own[ABOUT('schinese')], '关于', '原来有覆盖：照写');
  // 正式版本地改了还没上传：Demo 后台的值和正式版上次同步的一样，算跟随正式版，不写成覆盖
  writeLocalField(game, DESC('english'), 'Short EN v2');
  writeLocal(demo, { ...remote2, [DESC('english')]: 'Short EN' });
  assert.ok(!(DESC('english') in readLocalLayers(demo).own), '和正式版上次同步的值一样：不写成覆盖');
  assert.equal(readLocal(demo)[DESC('english')], 'Short EN v2', '正式版的改动传到 Demo');
  writeLocal(demo, { [STANDALONE]: '1' });
  assert.ok(!existsSync(join(demo.storeDir, 'schinese', 'about.bbcode')), '线上没有了的覆盖清掉');

  // ---- 图片继承 ----
  const G = game.assets.dir, Dm = demo.assets.dir;
  const put = (root: string, rel: string, data: Buffer) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); };
  put(G, 'store/english/header.png', png(920, 430, 1));
  put(G, 'store/schinese/header.png', png(920, 430, 2));
  put(G, 'store/english/small.png', png(462, 174, 3));
  put(G, 'store/schinese/small.png', png(462, 174, 4));
  put(G, 'store/english/bg.png', png(1438, 810, 5));
  put(G, 'screenshots/s1.png', png(1920, 1080, 6));
  put(G, 'screenshots/s2.png', png(1920, 1080, 7));
  put(Dm, 'store/english/small.png', png(462, 174, 8)); // Demo 自己的英文小宣传图：中文不再继承
  put(Dm, 'store/schinese/header.png', png(920, 430, 9)); // Demo 自己的中文形象图

  let scan = scanCells(demo);
  const one = (k: string) => filesIn(scan, parseCell(demo, k)).map((f) => `${f.rel}${f.inherited ? ' (继承)' : ''}`);
  assert.deepEqual(one('header|english'), ['../../game/assets/store/english/header.png (继承)'], '没有就用正式版同一格');
  assert.deepEqual(one('header|schinese'), ['store/schinese/header.png'], 'Demo 自己有就用自己的');
  assert.deepEqual(one('small_capsule|english'), ['store/english/small.png']);
  assert.deepEqual(one('small_capsule|schinese'), [], 'Demo 有英文版时不继承（Steam 会回退到 Demo 的英文版）');
  assert.deepEqual(one('page_background|*'), ['../../game/assets/store/english/bg.png (继承)']);
  assert.deepEqual(one('screenshot|*'), ['../../game/assets/screenshots/s1.png (继承)', '../../game/assets/screenshots/s2.png (继承)'], 'Demo 没有截图时整组继承');
  assert.equal(filesIn(scanCells(demo, { inherit: false }), parseCell(demo, 'header|english')).length, 0, 'inherit: false 只看自己的');
  assert.equal(filesIn(scanCells(game), parseCell(game, 'header|english'))[0].inherited, undefined, '正式版不受影响');

  put(Dm, 'screenshots/d1.png', png(1920, 1080, 10));
  scan = scanCells(demo);
  assert.deepEqual(one('screenshot|*'), ['screenshots/d1.png'], 'Demo 有一张截图就不继承');

  // ---- 收件箱 / 拖放只动 Demo 自己的文件 ----
  const line = placeImage(demo, 'h.png', png(920, 430, 11), 'header|english');
  assert.match(line, /store\/english\/h\.png/);
  assert.ok(!line.includes('已替换'), '继承来的正式版图片不会被挪走');
  assert.ok(existsSync(join(G, 'store/english/header.png')), '正式版的图还在');
  put(Dm, '待分类/bg.png', png(1438, 810, 12));
  assert.deepEqual(planInbox(demo)[0].replaces, [], '待分类不会替换继承来的图');

  // ---- 恢复继承 ----
  assert.match(restoreInherited(demo, 'header|english'), /恢复用正式版的图/);
  assert.ok(existsSync(join(Dm, '已替换/store/english/h.png')));
  scan = scanCells(demo);
  assert.deepEqual(one('header|english'), ['../../game/assets/store/english/header.png (继承)']);
  assert.match(restoreInherited(demo, 'small_capsule|english'), /恢复用正式版的图/);
  assert.match(restoreInherited(demo, 'header|english'), /本来就在用正式版的图/);
  assert.throws(() => restoreInherited(game, 'header|english'), /只有继承了正式版/);

  ok = true;
  console.log('✓ Demo 继承测试通过');
} finally {
  rmSync(ws, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}
