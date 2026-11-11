// 命令行和网页共用的同步操作。输出都通过 log 回调，命令行打到终端，网页推送到浏览器。
import { createTwoFilesPatch } from 'diff';
import type { Page } from 'playwright-core';
import type { AppConfig, Config } from './config.js';
import type { FieldValue } from './partner/form.js';
import { fetchRemote, pushStore } from './partner/store.js';
import { hasLocal, readLocal, readSnapshot, splitLocalized, writeLocal, writeSnapshot } from './local/storeFiles.js';
import { localEdits, threeWay, type Change } from './sync.js';
import { openAssetsPage, uploadAssets } from './partner/assets.js';
import { saveRemoteMeta } from './partner/meta.js';
import { SLOTS } from './slots.js';
import { assetStates, readManifest, scanAssets, writeManifest } from './local/assetFiles.js';

export type Log = (line: string) => void;

export const preview = (v: FieldValue | undefined) => {
  if (v === undefined) return '∅';
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
};

/** 把字段 name 显示成本地文件里的写法，方便对照 */
export const display = (key: string) => {
  const loc = splitLocalized(key);
  return loc ? `${loc.lang}/${loc.path}` : key;
};

export function printChange(log: Log, c: Change, verbose: boolean) {
  const tag = { local: '↑ 本地改动', remote: '↓ 线上改动', conflict: '⚠ 冲突', gone: '✗ 线上无此字段' }[c.kind];
  log(`  ${tag}  ${display(c.key)}`);
  if (!verbose) return;
  if (typeof c.local === 'string' && typeof c.remote === 'string') {
    const patch = createTwoFilesPatch('remote', 'local', c.remote.replace(/\r\n/g, '\n') + '\n', c.local + '\n', '', '', { context: 2 });
    log(patch.split('\n').slice(3).map((l) => '      ' + l).join('\n'));
  } else {
    log(`      线上: ${preview(c.remote)}\n      本地: ${preview(c.local)}`);
  }
}

/** 拉取线上内容。本地有未推送的改动时不覆盖（除非 force）。返回是否拉取了 */
export async function pullApp(page: Page, c: Config, app: AppConfig, o: { force?: boolean }, log: Log) {
  const base = readSnapshot(c, app);
  if (hasLocal(app) && base && !o.force) {
    const edits = localEdits(readLocal(app), base);
    if (edits.length) {
      log(`  跳过：本地有 ${edits.length} 个未推送的改动（${edits.slice(0, 3).map(display).join(', ')}…），先 push 或加 --force`);
      return false;
    }
  }
  const fields = await fetchRemote(page, c, app);
  await saveRemoteMeta(page, c, app);
  writeLocal(app, fields);
  writeSnapshot(c, app, fields);
  log(`  ✓ ${Object.keys(fields).length} 个字段 → ${app.storeDir}`);
  return true;
}

/** 三方对比。没 pull 过返回 undefined */
export async function diffApp(page: Page, c: Config, app: AppConfig): Promise<Change[] | undefined> {
  const base = readSnapshot(c, app);
  if (!hasLocal(app) || !base) return undefined;
  const remote = await fetchRemote(page, c, app);
  await saveRemoteMeta(page, c, app);
  return threeWay(readLocal(app), remote, base);
}

export interface PushOpts {
  dryRun?: boolean;
  force?: boolean;
  /** 只推送这些字段（name）；不传就推送全部本地改动 */
  only?: string[];
}

/** 推送商店文本。返回 failed / pushed 两个标志 */
export async function pushApp(page: Page, c: Config, app: AppConfig, o: PushOpts, log: Log) {
  const base = readSnapshot(c, app);
  if (!hasLocal(app) || !base) {
    log('  尚未 pull，跳过（必须先 pull 才能安全地推送）');
    return { failed: false, pushed: false };
  }
  let changes = threeWay(readLocal(app), await fetchRemote(page, c, app), base);
  if (o.only) changes = changes.filter((ch) => o.only!.includes(ch.key));
  changes.filter((ch) => ch.kind !== 'local').forEach((ch) => printChange(log, ch, false));
  const toPush = changes.filter((ch) => ch.kind === 'local' || (o.force && ch.kind === 'conflict'));
  if (!toPush.length) {
    log('  没有需要推送的改动');
    return { failed: false, pushed: false };
  }
  toPush.forEach((ch) => printChange(log, ch, !!o.dryRun));
  if (o.dryRun) return { failed: false, pushed: false };

  const r = await pushStore(page, c, app, toPush.map((ch) => [ch.key, ch.local!]));
  await saveRemoteMeta(page, c, app); // pushStore 最后停在重新加载的编辑页上
  // 只把成功保存的字段写进快照；其他字段保持原来的基准，否则会误把线上改动当成本地改动
  const snap = { ...base };
  for (const k of r.saved) snap[k] = r.after[k];
  writeSnapshot(c, app, snap);
  log(`  ✓ 已保存 ${r.saved.length} 个字段（HTTP ${r.status}）`);
  if (r.missing.length) log(`  ✗ 页面上找不到: ${r.missing.map(display).join(', ')}`);
  if (r.notPersisted.length) log(`  ✗ 提交了但重新加载后值不对: ${r.notPersisted.map(display).join(', ')}`);
  return { failed: r.missing.length > 0 || r.notPersisted.length > 0, pushed: r.saved.length > 0 };
}

export interface AssetsOpts {
  dryRun?: boolean;
  force?: boolean;
  /** 只上传这些图片（相对 assets 目录的路径） */
  only?: string[];
}

/** 上传图片。返回 failed / pushed 两个标志 */
export async function assetsApp(page: Page, c: Config, app: AppConfig, o: AssetsOpts, log: Log) {
  let failed = false, pushed = false;
  const { assets, warnings } = scanAssets(app);
  warnings.forEach((w) => log(`  ⚠ ${w}`));
  if (!assets.length) {
    log(`  ${app.assets.dir} 下没有图片`);
    return { failed, pushed };
  }
  const manifest = readManifest(c, app);
  const states = assetStates(assets, manifest);
  const todo = states.filter((s) => (o.only ? o.only.includes(s.asset.rel) : o.force || s.state !== 'same'));
  log(`  共 ${assets.length} 张，需要上传 ${todo.length} 张`);
  if (!todo.length) return { failed, pushed };

  const hasShots = todo.some((s) => s.asset.tab === 'screenshot');
  if (hasShots && app.assets.screenshotsAllAges === undefined) {
    log('  ✗ 有截图要上传，但配置里没设置 assets.screenshotsAllAges（Steam 要求声明截图是否适合所有年龄）');
    return { failed: true, pushed };
  }
  if (!o.dryRun && todo.some((s) => s.asset.tab !== 'screenshot')) {
    log('  ℹ Steam 规定：基础宣传图只能包含游戏美术、游戏名称和官方副标题；宣传更新/活动的文字要作为替代艺术作品上传。');
  }

  await openAssetsPage(page, c, app);
  const results = await uploadAssets(page, c, todo.map((s) => ({ ...s.asset, expectChange: s.state !== 'same' })), { allAges: app.assets.screenshotsAllAges, dryRun: !!o.dryRun });
  for (const [i, r] of results.entries()) {
    const s = todo[i];
    const note = s.state === 'changed' ? '（已修改）' : '';
    if (!r.ok) {
      failed = true;
      log(`  ✗ ${r.rel}${note}  ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`);
      if (r.body) log(`      ${r.body.slice(0, 300).replace(/\s+/g, ' ')}`);
      continue;
    }
    const where = s.asset.lang && r.key?.endsWith('|' + s.asset.lang) ? ` [${s.asset.lang}]` : '';
    const slot = SLOTS.find((x) => x.label === r.type);
    log(`  ${o.dryRun ? '→' : '✓'} ${r.rel}${note}  ${r.type} ${r.size}${where}${r.verified ? '（已核对）' : ''}`);
    if (r.warning) log(`      ⚠ ${r.warning}`);
    if (slot && !o.dryRun) log(`      后台位置：${slot.where}${slot.localized && s.asset.lang ? ' → ' + s.asset.lang : ''}（后台会把文件改名，不显示原文件名）`);
    if (o.dryRun) continue;
    pushed = true;
    manifest[r.rel] = { hash: s.asset.hash, type: r.type, uploadedAt: new Date().toISOString() };
    if (s.state === 'changed' && s.asset.tab === 'screenshot') {
      log('      ⚠ 截图改动会作为一张新截图上传，旧的那张需要在后台手动删除');
    }
  }
  if (!o.dryRun) {
    writeManifest(c, app, manifest);
    if (pushed) { await openAssetsPage(page, c, app); await saveRemoteMeta(page, c, app); }
  }
  return { failed, pushed };
}

export const DRAFT_NOTE = '提醒：改动已保存为草稿，要在 Steamworks 的“发布”页面发布后才会在商店生效。';
