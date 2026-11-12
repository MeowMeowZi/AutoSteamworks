// 网页的任务：同一时间只跑一个（共用一个浏览器配置文件）、上一个任务的结果、最近一次和线上对比的结果。
// 只管锁和结果；项目、App 是否有效由 server 先校验。
import type { Change } from '../sync.js';
import type { Log } from '../ops.js';
import { runOperation, type Action, type RunRequest, type RunResult } from '../runner.js';

/** 网页发来的请求。delete-images 的位置放在 only 里；project 已经过 server 校验（login 时可以是空字符串） */
export interface RunReq { project: string; action: Action; app: string; only?: string[]; dryRun?: boolean; force?: boolean }

export interface Job { action: Action; project: string; app: string }

/** 上一个任务的结果，网页顶部显示成结果框 */
export interface LastResult {
  project: string; app: string; action: Action; dryRun: boolean;
  ok: boolean; changedRemote: boolean; needLogin: boolean; at: string; lines: string[];
}

/**
 * 最近一次知道的登录状态。服务端读不到 Cookie（浏览器配置文件同一时间只能被一个进程打开），
 * 所以按最近一次碰过后台的任务推断：跳回首页 = 没登录，成功 = 已登录，其他失败不改变。
 * 不分项目：大多数项目共用一个登录（~/.autosteamworks/profile）。
 */
export interface LoginStatus { loggedIn: boolean; at: string }

export interface RemoteCheck { at: string; changes: Map<string, Change> }

export interface JobsOptions {
  /** 发给网页的事件：log / job / done / changed */
  notify: (event: string, data: unknown) => void;
  /** 测试时换成假的 */
  runOp?: (req: RunRequest, log: Log) => Promise<RunResult>;
}

export function createJobs({ notify, runOp = runOperation }: JobsOptions) {
  let job: Job | undefined;
  let last: LastResult | undefined;
  let login: LoginStatus | undefined;
  /** 按 项目|App 存 */
  const remoteChecks = new Map<string, RemoteCheck>();

  function toRunRequest(req: RunReq, configPath: string | undefined, app: string): RunRequest {
    const common = { configPath, apps: app ? [app] : [] };
    return req.action === 'delete-images' ? { ...common, action: req.action, targets: req.only ?? [], dryRun: req.dryRun }
      : req.action === 'push' || req.action === 'assets' ? { ...common, action: req.action, dryRun: req.dryRun, force: req.force, only: req.only }
        : req.action === 'pull' ? { ...common, action: req.action, force: req.force }
          : { ...common, action: req.action };
  }

  async function run(req: RunReq, configPath: string | undefined) {
    const { project } = req;
    const app = req.action === 'login' ? '' : req.app;
    const lines: string[] = [];
    const log: Log = (line, kind) => {
      if (kind === 'result') lines.push(line.trim());
      notify('log', line);
    };
    notify('job', { action: req.action, project, app });
    let r: RunResult = { ok: false, changedRemote: false, needLogin: false, apps: [] };
    try {
      r = await runOp(toRunRequest(req, configPath, app), log);
      if (r.needLogin || r.ok) login = { loggedIn: !r.needLogin, at: new Date().toISOString() };
      const rk = project + '|' + app;
      const diffed = r.apps[0]?.changes;
      if (req.action === 'diff' && diffed) remoteChecks.set(rk, { at: new Date().toISOString(), changes: new Map(diffed.map((ch) => [ch.key, ch])) });
      // 拉取后本地和线上一致了；后台变了的话旧的对比结果也作废
      if ((req.action === 'pull' && r.ok) || r.changedRemote) remoteChecks.delete(rk);
    } catch (e) {
      log(`✗ 错误: ${e instanceof Error ? e.message : e}`, 'result');
    } finally {
      last = {
        project, app, action: req.action, dryRun: !!req.dryRun, ok: r.ok, at: new Date().toISOString(),
        changedRemote: r.changedRemote, needLogin: r.needLogin, lines,
      };
      job = undefined;
      notify('done', { ok: r.ok });
      notify('changed', null);
    }
  }

  return {
    /** 开始一个任务。已有任务在跑时返回 error；否则 done 在任务结束时完成（server 不用等） */
    start(req: RunReq, configPath?: string): { error: string } | { done: Promise<void> } {
      if (job) return { error: `正在执行 ${job.action}，请等它结束` };
      job = { action: req.action, project: req.project, app: req.action === 'login' ? '' : req.app };
      return { done: run(req, configPath) };
    },
    current: (): Job | undefined => job && { ...job },
    /** 正在跑的是不是这个操作 */
    busyWith: (action: Action) => job?.action === action,
    lastResult: () => last,
    loginStatus: () => login,
    remoteCheck: (project: string, app: string) => remoteChecks.get(project + '|' + app),
  };
}

export type Jobs = ReturnType<typeof createJobs>;
