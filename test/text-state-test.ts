// App 文本状态测试（离线）：readTextState / textView / fieldShape
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { writeLocal, writeSnapshot } from '../src/local/storeFiles.js';
import { readTextState, textView } from '../src/textState.js';
import { fieldShape } from '../src/fieldInfo.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-text-'));
const cfgFile = join(ws, 'steam.config.yaml');
writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
languages: [english, schinese]
apps:
  game: { appid: 100 }
`);
const D = (lang: string) => `app[content][short_description][${lang}]`;
const MEM = 'app[content][sysreqs][windows][min][memory]';
const SUP = 'app[content][supported_languages][schinese][subtitles]';

let ok = false;
try {
  const c = loadConfig(cfgFile);
  const [app] = c.apps;

  // ---- 没有本地文件 ----
  let t = readTextState(c, app);
  assert.deepEqual([t.pulled, t.hasLocal, t.edits, t.issues], [false, false, [], []], '什么都没有');

  // ---- 有本地文件、没有快照：能做规则检查，算不出改动，不算拉取过 ----
  const fields = { [D('english')]: 'x'.repeat(250), [D('schinese')]: 'y'.repeat(301), [`${MEM}[amount]`]: '4', [`${MEM}[units]`]: 'GB', [SUP]: true };
  writeLocal(app, fields);
  t = readTextState(c, app);
  assert.deepEqual([t.pulled, t.hasLocal, t.base, t.edits], [false, true, undefined, []], '没有快照');
  assert.ok(t.issues.some((i) => i.key === D('schinese') && i.level === 'error'), '没有快照也做规则检查');

  // ---- 有快照：改动 ----
  writeSnapshot(c, app, { ...fields, [D('english')]: 'old' });
  t = readTextState(c, app);
  assert.equal(t.pulled, true);
  assert.deepEqual(t.edits, [D('english')], '只有改过的字段');

  // ---- 网页视图 ----
  const v = textView(t, new Map([
    [D('schinese'), { key: D('schinese'), kind: 'remote' as const, local: fields[D('schinese')], remote: '线上' }],
  ]));
  const row = v.localized.find((r) => r.path === 'short_description')!;
  assert.equal(row.langs.english.edited, true);
  assert.equal(row.langs.english.lang, 'english');
  assert.ok(row.langs.english.parts?.some((p) => p.t === 1), '改过的文本有差异片段');
  assert.equal(row.langs.schinese.remote?.kind, 'remote');
  assert.deepEqual(v.remoteOnly, [D('schinese')]);
  const common = Object.fromEntries(v.common.map((f) => [f.key, f]));
  assert.deepEqual(common[`${MEM}[amount]`].shape, { t: 'amount', unit: `${MEM}[units]` }, '数值指向单位');
  assert.deepEqual(common[`${MEM}[units]`].shape, { t: 'unit', amount: `${MEM}[amount]` }, '单位指向数值');
  assert.deepEqual(common[SUP].shape, { t: 'langgrid', lang: 'schinese', col: 'subtitles' });
  assert.equal(common[SUP].lang, undefined, '支持语言表不是本地化字段');

  // ---- fieldShape ----
  const none = () => false;
  assert.deepEqual(fieldShape('app[platforms][win]', none), { t: 'flag' });
  assert.deepEqual(fieldShape('rgGenres[23]', none), { t: 'flag' });
  assert.deepEqual(fieldShape('app[classification][category][category_2]', none), { t: 'flag' });
  assert.deepEqual(fieldShape(`${MEM}[units]`, none), { t: 'unit', amount: undefined }, '没有数值的单位');
  assert.deepEqual(fieldShape('app[name]', none), { t: 'plain' });
  assert.deepEqual(fieldShape(D('english'), none), { t: 'plain' }, '本地化字段一律 plain');

  ok = true;
  console.log('✓ 文本状态测试全部通过');
} finally {
  rmSync(ws, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
}
