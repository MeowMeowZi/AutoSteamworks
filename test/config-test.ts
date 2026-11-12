// 项目配置测试（离线）：默认值、继承、loadConfig 和 readSettings 一致、addAppLanguages 的三种写法、writeSettings
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { addAppLanguages, createConfig, DEFAULTS, loadConfig, readSettings, writeSettings } from '../src/config.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-config-'));
let n = 0;
const cfg = (text: string) => { const f = join(ws, `c${n++}.yaml`); writeFileSync(f, text); return f; };
const yaml = (f: string) => YAML.parse(readFileSync(f, 'utf8'));
const PROFILE = 'browser: { profileDir: .autosw/profile }\n'; // 不用真实的共享登录

let ok = false;
try {
  // ---- 默认值 ----
  let f = cfg(`${PROFILE}apps:\n  game: { appid: 1 }\n`);
  let c = loadConfig(f);
  assert.deepEqual(c.apps[0].languages, DEFAULTS.languages);
  assert.equal(c.browserChannel, DEFAULTS.browserChannel);
  assert.equal(c.delayMs, DEFAULTS.delayMs);
  assert.deepEqual(c.apps[0].store.files, DEFAULTS.storeFiles);
  assert.equal(c.apps[0].assets.screenshotsAllAges, undefined);
  let s = readSettings(f);
  assert.deepEqual([s.languages, s.browser, s.delayMs, s.apps[0].screenshotsAllAges], [DEFAULTS.languages, DEFAULTS.browserChannel, DEFAULTS.delayMs, null]);

  // ---- 继承：App 自己的 → 顶层 ----
  f = cfg(`${PROFILE}
languages: [english, schinese]
assets: { screenshotsAllAges: true }
store: { files: [about], ignoreFields: ['a*'] }
apps:
  game: { appid: 1 }
  demo:
    appid: 2
    languages: [english]
    assets: { screenshotsAllAges: false }
    store: { files: [legal], ignoreFields: [b] }
`);
  c = loadConfig(f);
  const [game, demo] = c.apps;
  assert.deepEqual(game.languages, ['english', 'schinese'], '没写语言 = 跟随顶层');
  assert.deepEqual(demo.languages, ['english']);
  assert.equal(game.assets.screenshotsAllAges, true, '顶层的 screenshotsAllAges 也算');
  assert.equal(demo.assets.screenshotsAllAges, false, 'App 自己的优先');
  assert.deepEqual([game.store.files, demo.store.files], [['about'], ['legal']]);
  assert.deepEqual([game.store.ignoreFields, demo.store.ignoreFields], [['a*'], ['a*', 'b']], '忽略字段是合并');

  // 设置页和同步看到的是同一个值
  s = readSettings(f);
  assert.deepEqual(s.apps.map((a) => a.languages), [[], ['english']], '设置页：空 = 跟随项目');
  assert.deepEqual(s.apps.map((a) => a.screenshotsAllAges), c.apps.map((a) => a.assets.screenshotsAllAges), '设置页显示实际生效的值');

  // 原样保存一次：继承来的 screenshotsAllAges 写到 App 下面，生效的值不变
  writeSettings(f, s);
  assert.equal(yaml(f).apps.game.assets.screenshotsAllAges, true);
  assert.deepEqual(loadConfig(f).apps.map((a) => [a.languages, a.assets.screenshotsAllAges, a.store.ignoreFields]),
    c.apps.map((a) => [a.languages, a.assets.screenshotsAllAges, a.store.ignoreFields]), '保存设置不改变生效的配置');

  // ---- addAppLanguages ----
  // 1. App 有自己的语言：加到 App
  addAppLanguages(f, 'demo', ['japanese', 'english']);
  assert.deepEqual(yaml(f).apps.demo.languages, ['english', 'japanese']);
  // 2. 多个 App、这个 App 没写：给它单独写一份（顶层不变）
  const before = yaml(f).languages;
  addAppLanguages(f, 'game', ['koreana']);
  assert.deepEqual(yaml(f).apps.game.languages, ['english', 'schinese', 'koreana']);
  assert.deepEqual(yaml(f).languages, before);
  // 3. 只有一个 App：加到顶层；顶层没写时从默认值开始
  f = cfg(`# 注释要保留\n${PROFILE}apps:\n  game: { appid: 1 }\n`);
  addAppLanguages(f, 'game', ['schinese']);
  assert.deepEqual(yaml(f).languages, ['english', 'schinese']);
  assert.equal(yaml(f).apps.game.languages, undefined);
  assert.match(readFileSync(f, 'utf8'), /# 注释要保留/);

  // ---- createConfig ----
  f = join(ws, 'new.yaml');
  assert.equal(createConfig(f, { name: ' 新游戏 ', appid: 7, languages: ['english'] }), 'game');
  assert.deepEqual(yaml(f).apps, { game: { appid: 7, name: '新游戏' } });
  assert.throws(() => createConfig(f, { name: 'x', appid: 7, languages: ['english'] }), /已经存在/);
  assert.throws(() => createConfig(join(ws, 'bad.yaml'), { name: 'x', appid: 7, languages: ['klingon'] }), /不认识的语言/);

  ok = true;
  console.log('✓ 项目配置测试通过');
} finally {
  rmSync(ws, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}
