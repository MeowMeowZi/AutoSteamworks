// 命令行和网页共用的同步操作。输出都通过 log 回调，命令行打到终端，网页推送到浏览器。
import { createTwoFilesPatch } from 'diff';
import type { Page } from 'playwright-core';
import { addAppLanguages, type AppConfig, type Config } from './config.js';
import { hasLoginCookie, isLoginPage, openBrowser, PARTNER_HOME, sleep } from './browser.js';
import type { FieldValue } from './partner/form.js';
import { fetchRemote, fetchRemoteAll, pushStore } from './partner/store.js';
import { hasLocal, keepLanguages, readLocal, readSnapshot, splitLocalized, writeLocal, writeSnapshot } from './local/storeFiles.js';
import { threeWay, type Change } from './sync.js';
import { deleteAssets, openAssetsPage, uploadAssets } from './partner/assets.js';
import { saveRemoteMeta } from './partner/meta.js';
import { remotePath, SLOTS } from './slots.js';
import { cellName, remoteLang, scanCells, type Cell } from './local/imageCells.js';
import { LANG_NAMES } from './fieldInfo.js';
import { readManifest, writeManifest } from './local/assetFiles.js';
import { clearCellRecords, manifestAfterUpload, newLanguages, planAssets, planDelete, planPush, pullBlockers, pushEntries, snapshotAfterPush } from './plan.js';

/**
 * result：结果行（成功、失败、警告、后台位置、提醒），网页的结果框只显示这些；
 * detail：过程信息，只在日志里显示。不写就是 detail
 */
export type LogKind = 'result' | 'detail';
export type Log = (line: string, kind?: LogKind) => void;

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

export function printChange(log: Log, c: Change, verbose: boolean, kind: LogKind = 'detail') {
  const tag = { local: '↑ 本地改动', remote: '↓ 线上改动', conflict: '⚠ 冲突', gone: '✗ 线上无此字段' }[c.kind];
  log(`  ${tag}  ${display(c.key)}`, kind);
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
  const edits = pullBlockers(hasLocal(app) ? readLocal(app) : undefined, readSnapshot(c, app), o.force);
  if (edits.length) {
    log(`  跳过：本地有 ${edits.length} 个未推送的改动（${edits.slice(0, 3).map(display).join(', ')}…），先 push 或加 --force`, 'result');
    return false;
  }
  const all = await fetchRemoteAll(page, c, app);
  // 后台“支持的语言”里勾了、本地还没同步的语言：加进配置，一起拉下来
  const added = newLanguages(all, app.languages);
  if (added.length) {
    addAppLanguages(c.file, app.key, added);
    app.languages = [...app.languages, ...added];
    log(`  + 后台勾选了 ${added.map((l) => LANG_NAMES[l] ?? l).join('、')}，已加进同步语言（steam.config.yaml），一起拉取`);
  }
  const fields = keepLanguages(app, all);
  await saveRemoteMeta(page, c, app);
  writeLocal(app, fields);
  writeSnapshot(c, app, fields);
  log(`  ✓ ${Object.keys(fields).length} 个字段 → ${app.storeDir}`, 'result');
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
    log('  尚未 pull，跳过（必须先 pull 才能安全地推送）', 'result');
    return { failed: false, pushed: false };
  }
  const plan = planPush(readLocal(app), await fetchRemote(page, c, app), base, o);
  plan.changes.filter((ch) => ch.kind !== 'local').forEach((ch) => printChange(log, ch, false, ch.kind === 'remote' ? 'detail' : 'result'));
  if (!plan.toPush.length) {
    log('  没有需要推送的改动', 'result');
    return { failed: false, pushed: false };
  }
  plan.toPush.forEach((ch) => printChange(log, ch, !!o.dryRun));
  if (o.dryRun) return { failed: false, pushed: false };

  const r = await pushStore(page, c, app, pushEntries(plan));
  await saveRemoteMeta(page, c, app); // pushStore 最后停在重新加载的编辑页上
  writeSnapshot(c, app, snapshotAfterPush(base, r.saved, r.after));
  log(`  ✓ 已保存 ${r.saved.length} 个字段（HTTP ${r.status}）`, 'result');
  if (r.missing.length) log(`  ✗ 页面上找不到: ${r.missing.map(display).join(', ')}`, 'result');
  if (r.notPersisted.length) log(`  ✗ 提交了但重新加载后值不对: ${r.notPersisted.map(display).join(', ')}`, 'result');
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
  const scan = scanCells(app);
  scan.warnings.forEach((w) => log(`  ⚠ ${w}`, 'result'));
  const manifest = readManifest(c, app);
  const plan = planAssets(scan, manifest, { ...o, allAges: app.assets.screenshotsAllAges });
  plan.rejected.forEach((x) => log(`  ✗ ${x.rel}  ${x.reason}`, 'result'));
  let failed = plan.rejected.length > 0, pushed = false;
  if (!plan.total && !plan.rejected.length) {
    log(`  ${app.assets.dir} 下没有图片`);
    return { failed, pushed };
  }
  log(`  共 ${plan.total} 张，需要上传 ${plan.todo.length} 张`);
  if (!plan.todo.length) return { failed, pushed };
  if (plan.error) {
    log(`  ✗ ${plan.error}`, 'result');
    return { failed: true, pushed };
  }
  if (!o.dryRun && plan.todo.some((s) => s.file.tab !== 'screenshot')) {
    log('  ℹ Steam 规定：基础宣传图只能包含游戏美术、游戏名称和官方副标题；宣传更新/活动的文字要作为替代艺术作品上传。');
  }

  await openAssetsPage(page, c, app);
  const results = await uploadAssets(page, c, plan.todo.map((s) => ({ ...s.file, expectChange: s.state !== 'same' })), { allAges: app.assets.screenshotsAllAges, dryRun: !!o.dryRun });
  for (const [i, r] of results.entries()) {
    const s = plan.todo[i];
    const note = s.state === 'changed' ? '（已修改）' : '';
    if (!r.ok) {
      failed = true;
      log(`  ✗ ${r.rel}${note}  ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`, 'result');
      if (r.body) log(`      ${r.body.slice(0, 300).replace(/\s+/g, ' ')}`);
      continue;
    }
    const where = s.file.lang && r.key?.endsWith('|' + s.file.lang) ? ` [${s.file.lang}]` : '';
    const slot = SLOTS.find((x) => x.label === r.type);
    log(`  ${o.dryRun ? '→' : '✓'} ${r.rel}${note}  ${r.type} ${r.size}${where}${r.verified ? '（已核对）' : ''}`, 'result');
    if (r.warning) log(`      ⚠ ${r.warning}`, 'result');
    if (slot && !o.dryRun) log(`      后台位置：${slot.where}${slot.localized && s.file.lang ? ' → ' + s.file.lang : ''}（后台会把文件改名，不显示原文件名）`, 'result');
    if (o.dryRun) continue;
    pushed = true;
    if (s.state === 'changed' && s.file.tab === 'screenshot') {
      log('      ⚠ 截图改动会作为一张新截图上传，旧的那张需要在后台手动删除', 'result');
    }
  }
  if (!o.dryRun) {
    writeManifest(c, app, manifestAfterUpload(manifest, plan.todo, results, new Date().toISOString()));
    if (pushed) { await openAssetsPage(page, c, app); await saveRemoteMeta(page, c, app); }
  }
  return { failed, pushed };
}

/**
 * 从后台删除图片。targets 是 "<槽位 id>|<语言>"（不分语言的槽位用 *），例如 "header|schinese"、"page_background|*"。
 * 本地文件不动；删掉后把同一位置本地图片的上传记录也清掉，这样网页上会显示“待上传”而不是“已在后台”。
 */
export async function deleteImagesApp(page: Page, c: Config, app: AppConfig, o: { targets: string[]; dryRun?: boolean }, log: Log) {
  const plan = planDelete(app, o.targets);
  plan.errors.forEach((e) => log(`  ✗ ${e.target}  ${e.msg}`, 'result'));
  if (plan.errors.length) return { failed: true, pushed: false };

  let failed = false, pushed = false;
  await openAssetsPage(page, c, app);
  const name = (x: Cell) => cellName(x, (l) => LANG_NAMES[l] ?? l);
  const results = await deleteAssets(page, c, app, plan.cells.map((x) => ({ assetKey: x.slot.assetKey, lang: x.slot.localized ? x.lang : undefined })), !!o.dryRun);
  let manifest = readManifest(c, app);
  const scan = scanCells(app);
  for (const [i, r] of results.entries()) {
    const x = plan.cells[i], slot = x.slot;
    if (!r.ok) { failed = true; log(`  ✗ 删除 ${name(x)}  ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`, 'result'); continue; }
    if (o.dryRun) { log(`  → 删除 ${name(x)}  会清空：${Object.keys(r.fields ?? {}).join('、')}`, 'result'); continue; }
    pushed = true;
    if (r.after && remotePath(r.after, slot, remoteLang(x))) {
      failed = true;
      log(`  ✗ 删除 ${name(x)}  后台返回成功，但重新读取后图片还在`, 'result');
      continue;
    }
    const verified = r.before && r.after && remotePath(r.before, slot, remoteLang(x)) ? '（已核对）' : '';
    log(`  ✓ 已删除 ${name(x)}${verified}`, 'result');
    log(`      后台位置：${slot.where}${slot.localized ? ' → ' + x.lang : ''}`, 'result');
    const cleared = clearCellRecords(manifest, scan, x);
    manifest = cleared.manifest;
    for (const rel of cleared.cleared) log(`      本地文件 ${rel} 没有删除，下次上传会再传上去；不需要的话请把它删掉`, 'result');
  }
  if (!o.dryRun && pushed) {
    writeManifest(c, app, manifest);
    await openAssetsPage(page, c, app);
    await saveRemoteMeta(page, c, app);
  }
  return { failed, pushed };
}

/** 弹出浏览器让用户手动登录 Steamworks，检测到登录 Cookie 后保存。返回是否成功 */
export async function loginFlow(c: Pick<Config, 'profileDir' | 'browserChannel'>, log: Log, timeoutMs = 10 * 60_000) {
  const { ctx, page } = await openBrowser(c, false);
  try {
    await page.goto(PARTNER_HOME);
    log('请在弹出的浏览器窗口里登录 Steamworks（包括 Steam Guard），登录成功后会自动检测并保存（最多等 10 分钟）…');
    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (!ok && Date.now() < deadline && ctx.pages().length > 0) {
      await sleep(2000);
      ok = (await hasLoginCookie(ctx)) && !isLoginPage(page.url());
    }
    if (ok) await sleep(3000); // 让 Steam 完成重定向、写完剩下的 Cookie
    log(ok ? `✓ 登录成功，所有项目共用这个登录（保存在 ${c.profileDir}）` : '✗ 没有检测到登录（浏览器被关掉了或超时），请重试', 'result');
    return ok;
  } finally {
    await ctx.close().catch(() => {});
  }
}

export const DRAFT_NOTE = '提醒：改动已保存为草稿，要在 Steamworks 的“发布”页面发布后才会在商店生效。';
