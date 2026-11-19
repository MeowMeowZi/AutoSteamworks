// 操作运行：读配置 → 选 App → 开浏览器 → 逐个 App 执行 → 关浏览器 → 汇总结果。命令行和网页都只调用 runOperation。
import { defaultBrowser, loadConfig, selectApps, type AppConfig, type Config } from './config.js';
import type { Page } from 'playwright-core';
import { NotLoggedInError, openBrowser } from './browser.js';
import type { Change } from './sync.js';
import { findDemos, type DemoCandidate } from './partner/demos.js';
import { readSnapshot } from './local/storeFiles.js';
import { draftItems } from './local/draftSettings.js';
import { readManifest, writeManifest } from './local/assetFiles.js';
import { applyDraftSetting } from './partner/draftSettings.js';
import { assetsApp, deleteImagesApp, diffApp, DRAFT_NOTE, loginFlow, printChange, pullApp, pushApp, type Log } from './ops.js';

interface Common {
  /** 配置文件路径。不传时只能 login，用所有项目共用的登录 */
  configPath?: string;
  /** App 的 key；不传就是配置里的全部 App */
  apps?: string[];
  /** 显示浏览器窗口（login 总是显示） */
  headed?: boolean;
}

export type RunRequest = Common & (
  | { action: 'pull'; force?: boolean }
  | { action: 'diff' }
  | { action: 'push'; dryRun?: boolean; force?: boolean; /** 只推送这些字段 */ only?: string[] }
  | { action: 'assets'; dryRun?: boolean; force?: boolean; /** 只上传这些图片（相对 assets 目录） */ only?: string[] }
  | { action: 'upload'; fields: string[]; images: string[]; settings?: string[]; overwriteConflicts?: string[]; dryRun?: boolean }
  | { action: 'delete-images'; dryRun?: boolean; /** "<槽位 id>|<语言>" */ targets: string[] }
  | { action: 'login' }
  /** 搜正式版的 Demo（apps 里只放正式版）。term 是名称或 Demo 的 appid，不写就用正式版的名称 */
  | { action: 'find-demos'; term?: string }
);

export type Action = RunRequest['action'];
export const ACTIONS: Action[] = ['pull', 'diff', 'push', 'assets', 'upload', 'delete-images', 'login', 'find-demos'];

export interface AppResult {
  key: string;
  ok: boolean;
  /** 只有 diff 有：三方对比的结果；没 pull 过时没有 */
  changes?: Change[];
}

export interface RunResult {
  /** 没有任何失败 */
  ok: boolean;
  /** 后台真的被改了（保存了草稿）：要提示发布，旧的对比结果作废 */
  changedRemote: boolean;
  /** 因为没登录或登录过期而失败 */
  needLogin: boolean;
  apps: AppResult[];
  /** 只有 find-demos 有：搜到的 Demo */
  demos?: DemoSearch;
}

export interface DemoSearch {
  /** 正式版的 key */
  parent: string;
  term: string;
  candidates: (DemoCandidate & {
    /** 名称以正式版名称开头：网页上默认选中 */
    suggested: boolean;
    /** 已经在配置里了：App 的 key */
    added?: string;
  })[];
}

const ACTION_NAMES: Record<Action, string> = {
  pull: '拉取', diff: '刷新后台状态', push: '上传文本', assets: '上传图片', upload: '上传到后台草稿', 'delete-images': '删除后台图片', login: '登录', 'find-demos': '查找 Demo',
};

/** 配置读不出来、App 不存在这类请求错误会直接抛出；执行中的错误都记进结果 */
export async function runOperation(req: RunRequest, log: Log): Promise<RunResult> {
  const result: RunResult = { ok: true, changedRemote: false, needLogin: false, apps: [] };

  if (req.action === 'login') {
    const c = req.configPath ? loadConfig(req.configPath) : defaultBrowser();
    result.ok = await loginFlow(c, log);
    return result;
  }

  if (!req.configPath) throw new Error('缺少配置文件');
  const c = loadConfig(req.configPath);
  const apps = selectApps(c, req.apps ?? []);
  const dry = 'dryRun' in req && req.dryRun ? '（演练）' : '';
  if (req.action === 'upload' || req.action === 'push' || req.action === 'assets') {
    log(`正在启动浏览器，准备${ACTION_NAMES[req.action]}${dry}…`);
  }
  const { ctx, page } = await openBrowser(c, !req.headed);
  try {
    if (req.action === 'find-demos') {
      if (apps.length !== 1 || apps[0].inherits) throw new Error('查找 Demo 时要指定一个正式版');
      result.demos = await findDemosFor(page, c, apps[0], req.term, log);
      return result;
    }
    for (const app of apps) {
      log(`■ ${app.key} (${app.appid}) ${ACTION_NAMES[req.action]}${dry} [${app.languages.join(', ')}]`);
      const r: AppResult = { key: app.key, ok: true };
      result.apps.push(r);
      try {
        switch (req.action) {
          case 'pull':
            r.ok = await pullApp(page, c, app, { force: req.force }, log);
            break;
          case 'diff': {
            const changes = await diffApp(page, c, app);
            if (!changes) { log('  尚未从后台拉取过，已读取后台的图片状态。拉取后才能对比文本。', 'result'); break; }
            r.changes = changes;
            const n = (k: Change['kind']) => changes.filter((ch) => ch.kind === k).length;
            log(changes.length ? `  本地改动 ${n('local')}，后台被改过 ${n('remote')}，冲突 ${n('conflict')}，后台已删除 ${n('gone')}` : '  ✓ 文本和后台一致', 'result');
            changes.forEach((ch) => printChange(log, ch, true));
            break;
          }
          case 'upload': {
            const selected = new Set(req.settings);
            const settings = selected.size ? draftItems(app).filter(item => selected.has(item.id)) : [];
            if (settings.length !== selected.size) throw new Error('所选后台设置已变化，请刷新后再预览');
            if (req.fields.length) {
              const text = await pushApp(page, c, app, { only: req.fields, overwriteConflicts: req.overwriteConflicts, dryRun: req.dryRun }, log);
              r.ok = !text.failed;
              result.changedRemote ||= text.pushed;
            }
            if (req.images.length) {
              const images = await assetsApp(page, c, app, { only: req.images, pendingOnly: true, dryRun: req.dryRun }, log);
              r.ok &&= !images.failed;
              result.changedRemote ||= images.pushed;
            }
            for (const item of settings) {
              if (req.dryRun) { log(`  → ${item.label}\n    ${item.preview}`, 'result'); continue; }
              log(`  正在核对并保存${item.label}…`);
              try {
                const changed = await applyDraftSetting(page, c, app, item.value);
                result.changedRemote ||= changed;
                const manifest = readManifest(c, app);
                manifest[item.id] = { hash: item.hash, type: item.label, uploadedAt: new Date().toISOString() };
                writeManifest(c, app, manifest);
                log(`  ✓ ${item.label}：${changed ? '已保存并核对' : '后台已有相同设置'}`, 'result');
              } catch (e) {
                if (e instanceof NotLoggedInError) throw e;
                r.ok = false;
                log(`  ✗ ${item.label}：${e instanceof Error ? e.message : e}`, 'result');
              }
            }
            break;
          }
          default: {
            const x = req.action === 'push' ? await pushApp(page, c, app, req, log)
              : req.action === 'assets' ? await assetsApp(page, c, app, req, log)
                : await deleteImagesApp(page, c, app, req, log);
            r.ok = !x.failed;
            result.changedRemote ||= x.pushed;
          }
        }
      } catch (e) {
        r.ok = false;
        log(`  ✗ 错误: ${e instanceof Error ? e.message : e}`, 'result');
        if (e instanceof NotLoggedInError) { result.needLogin = true; break; } // 后面的 App 也一定会失败
      }
    }
  } catch (e) {
    if (req.action !== 'find-demos') throw e;
    result.ok = false;
    result.needLogin = e instanceof NotLoggedInError;
    log(`  ✗ 错误: ${e instanceof Error ? e.message : e}`, 'result');
    return result;
  } finally {
    await ctx.close().catch(() => {});
  }
  result.ok = result.apps.every((a) => a.ok);
  if (result.changedRemote) log(req.action === 'upload' && req.settings?.length
    ? '已保存的项目见上方核对结果。可在 Steamworks 对应的内容调查、商店页或客户端图片页复核。'
    : DRAFT_NOTE, 'result');
  return result;
}

/** 正式版的名称：配置里写的，没有就用上次拉取到的商店名称 */
const parentName = (app: AppConfig) => app.name?.trim() || String(readSnapshot(app)?.['app[name]'] ?? '').trim();

async function findDemosFor(page: Page, c: Config, parent: AppConfig, term: string | undefined, log: Log): Promise<DemoSearch> {
  const name = parentName(parent);
  const q = term?.trim() || name;
  if (!q) throw new Error(`不知道 ${parent.key} 的名称：请填写正式版名称或 Demo 的 App ID 再搜`);
  log(`  搜索“${q}”…`);
  const found = await findDemos(page, c, parent, q);
  const candidates = found.map((d) => ({
    ...d,
    suggested: !!name && d.name.toLowerCase().startsWith(name.toLowerCase()),
    added: c.apps.find((a) => a.appid === d.appid)?.key,
  }));
  if (!candidates.length) log(`  没有找到名称或 App ID 里有“${q}”的 Demo。可以换个关键词，或者直接填 Demo 的 App ID`, 'result');
  for (const d of candidates) {
    log(`  ${d.added ? '✓' : '·'} ${d.name}${d.localName ? `（${d.localName}）` : ''}  App ID ${d.appid}${d.added ? `  已添加（${d.added}）` : ''}`, 'result');
  }
  return { parent: parent.key, term: q, candidates };
}
