// 操作运行：读配置 → 选 App → 开浏览器 → 逐个 App 执行 → 关浏览器 → 汇总结果。命令行和网页都只调用 runOperation。
import { join } from 'node:path';
import { appHome, loadConfig, selectApps, type Config } from './config.js';
import { NotLoggedInError, openBrowser } from './browser.js';
import type { Change } from './sync.js';
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
  | { action: 'delete-images'; dryRun?: boolean; /** "<槽位 id>|<语言>" */ targets: string[] }
  | { action: 'login' }
);

export type Action = RunRequest['action'];
export const ACTIONS: Action[] = ['pull', 'diff', 'push', 'assets', 'delete-images', 'login'];

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
}

const ACTION_NAMES: Record<Action, string> = {
  pull: '拉取', diff: '刷新后台状态', push: '上传文本', assets: '上传图片', 'delete-images': '删除后台图片', login: '登录',
};

/** 配置读不出来、App 不存在这类请求错误会直接抛出；执行中的错误都记进结果 */
export async function runOperation(req: RunRequest, log: Log): Promise<RunResult> {
  const result: RunResult = { ok: true, changedRemote: false, needLogin: false, apps: [] };

  if (req.action === 'login') {
    const c: Pick<Config, 'profileDir' | 'browserChannel'> = req.configPath
      ? loadConfig(req.configPath)
      : { profileDir: join(appHome(), 'profile'), browserChannel: 'msedge' };
    result.ok = await loginFlow(c, log);
    return result;
  }

  if (!req.configPath) throw new Error('缺少配置文件');
  const c = loadConfig(req.configPath);
  const apps = selectApps(c, req.apps ?? []);
  const dry = 'dryRun' in req && req.dryRun ? '（演练）' : '';
  const { ctx, page } = await openBrowser(c, !req.headed);
  try {
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
  } finally {
    await ctx.close().catch(() => {});
  }
  result.ok = result.apps.every((a) => a.ok);
  if (result.changedRemote) log(DRAFT_NOTE, 'result');
  return result;
}
