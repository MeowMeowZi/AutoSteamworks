// 同步计划测试（离线）：plan.ts 的纯函数，不开浏览器
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { scanCells, parseCell } from '../src/local/imageCells.js';
import { clearCellRecords, manifestAfterUpload, newLanguages, planAssets, planDelete, planPush, pullBlockers, pushEntries, snapshotAfterPush } from '../src/plan.js';
import { png } from './png.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-plan-'));
const cfgFile = join(ws, 'steam.config.yaml');
writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }
languages: [english, schinese]
apps:
  game: { appid: 100 }
`);
const A = join(ws, 'apps', 'game', 'assets');
const put = (rel: string, data: Buffer) => { const p = join(A, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); };
const D = (lang: string) => `app[content][short_description][${lang}]`;

let ok = false;
try {
  const [app] = loadConfig(cfgFile).apps;

  // ---- 拉取 ----
  const base = { [D('english')]: 'a', [D('schinese')]: '甲' };
  assert.deepEqual(pullBlockers(undefined, undefined), [], '没有本地文件时直接拉');
  assert.deepEqual(pullBlockers(base, base), [], '本地没改可以拉');
  assert.deepEqual(pullBlockers({ ...base, [D('english')]: 'b' }, base), [D('english')], '本地改过就挡住');
  assert.deepEqual(pullBlockers({ ...base, [D('english')]: 'b' }, base, true), [], 'force 不挡');
  const sup = (l: string) => `app[content][supported_languages][${l}][supported]`;
  assert.deepEqual(newLanguages({ [sup('english')]: true, [sup('japanese')]: '1', [sup('tchinese')]: false }, ['english']), ['japanese'], '只加勾选了、还没同步的语言');

  // ---- 推送文本 ----
  const T = (lang: string) => `app[content][about][${lang}]`;
  const local = { [D('english')]: 'local', [D('schinese')]: '本地', [T('english')]: 'same' };
  const remote = { [D('english')]: 'a', [D('schinese')]: '线上', [T('english')]: 'same' };
  let p = planPush(local, remote, base, {});
  assert.deepEqual(p.changes.map((c) => [c.key, c.kind]), [[D('english'), 'local'], [D('schinese'), 'conflict']]);
  assert.deepEqual(pushEntries(p), [[D('english'), 'local']], '冲突默认不推');
  p = planPush(local, remote, base, { force: true });
  assert.deepEqual(p.toPush.map((c) => c.key), [D('english'), D('schinese')], 'force 连冲突一起推');
  p = planPush(local, remote, base, { only: [D('schinese')], force: true });
  assert.deepEqual(p.changes.map((c) => c.key), [D('schinese')], 'only 只看指定字段');
  const snap = snapshotAfterPush(base, [D('english')], { [D('english')]: 'local', [D('schinese')]: '线上' });
  assert.deepEqual(snap, { [D('english')]: 'local', [D('schinese')]: '甲' }, '只有保存成功的字段进快照');

  // ---- 上传图片 ----
  put('store/english/header.png', png(920, 430));
  put('store/schinese/header.png', png(920, 430, 2));
  put('library/english/hero.png', png(3840, 1240));
  put('screenshots/s1.png', png(1920, 1080));
  put('store/english/bad.png', png(100, 100));
  let scan = scanCells(app);
  const rels = (x: { todo: { file: { rel: string } }[] }) => x.todo.map((t) => t.file.rel);
  let a = planAssets(scan, {}, { allAges: true });
  assert.deepEqual(rels(a), ['store/english/header.png', 'store/schinese/header.png', 'library/english/hero.png', 'screenshots/s1.png'], '顺序：商店 → 库 → 截图');
  assert.equal(a.total, 4);
  assert.deepEqual(a.rejected.map((r) => r.rel), ['store/english/bad.png'], '尺寸不对的图在本地就拒绝');
  assert.match(a.rejected[0].reason, /100x100/);
  assert.equal(a.error, undefined);
  assert.match(planAssets(scan, {}, {}).error ?? '', /screenshotsAllAges/, '要传截图但没声明年龄');

  const hashOf = (rel: string) => a.todo.find((t) => t.file.rel === rel)!.file.hash;
  const manifest = manifestAfterUpload({}, a.todo, a.todo.map((t, i) => ({ rel: t.file.rel, ok: i !== 1, type: 'x' })), 'T');
  assert.deepEqual(Object.keys(manifest).sort(), ['library/english/hero.png', 'screenshots/s1.png', 'store/english/header.png'], '失败的不记录');
  assert.equal(manifest['store/english/header.png'].hash, hashOf('store/english/header.png'));
  assert.equal(manifest['store/english/header.png'].uploadedAt, 'T');

  a = planAssets(scan, manifest, { allAges: true });
  assert.deepEqual(rels(a), ['store/schinese/header.png'], '传过的不再传');
  assert.deepEqual(a.todo.map((t) => t.state), ['new']);
  put('store/english/header.png', png(920, 430, 9));
  scan = scanCells(app);
  a = planAssets(scan, manifest, { allAges: true });
  assert.deepEqual(a.todo.map((t) => [t.file.rel, t.state]), [['store/english/header.png', 'changed'], ['store/schinese/header.png', 'new']]);
  assert.equal(planAssets(scan, manifest, { force: true }).todo.length, 4, 'force 全部重传');
  a = planAssets(scan, manifest, { only: ['library/english/hero.png'] });
  assert.deepEqual(rels(a), ['library/english/hero.png'], 'only 即使没改也传');
  assert.deepEqual(a.rejected, [], 'only 不包含的坏图不报');
  assert.equal(a.error, undefined, '不传截图就不要求声明年龄');

  // ---- 删除后台图片 ----
  const d = planDelete(app, ['header|english', 'page_background|*', 'screenshot|*', 'nope|english']);
  assert.deepEqual(d.cells.map((c) => c.slot.id), ['header', 'page_background']);
  assert.deepEqual(d.errors.map((e) => e.target), ['screenshot|*', 'nope|english']);
  assert.match(d.errors[0].msg, /截图暂不支持删除/);
  const cl = clearCellRecords(manifest, scan, parseCell(app, 'header|english'));
  assert.deepEqual(cl.cleared, ['store/english/header.png']);
  assert.equal(cl.manifest['store/english/header.png'], undefined);
  assert.ok(manifest['store/english/header.png'], '不改原来的记录');
  assert.deepEqual(clearCellRecords(manifest, scan, parseCell(app, 'header|schinese')).cleared, [], '没上传记录的不算');

  ok = true;
  console.log('✓ 同步计划测试通过');
} finally {
  rmSync(ws, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}
