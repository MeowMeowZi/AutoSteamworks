// 网页任务测试（离线）：jobs.ts 的锁、上一个任务的结果、对比结果的写入和作废。用假的 runOperation，不开浏览器
import assert from 'node:assert/strict';
import { createJobs, type RunReq } from '../src/ui/jobs.js';
import type { RunRequest, RunResult } from '../src/runner.js';
import type { Change } from '../src/sync.js';

const events: [string, unknown][] = [];
const calls: RunRequest[] = [];
/** 下一次 runOp 的行为 */
let next: (req: RunRequest, log: (line: string, kind?: 'result') => void) => Promise<RunResult>;
const jobs = createJobs({
  notify: (e, d) => events.push([e, d]),
  runOp: (req, log) => { calls.push(req); return next(req, log); },
});
const result = (o: Partial<RunResult> = {}): RunResult => ({ ok: true, changedRemote: false, needLogin: false, apps: [], ...o });
const change = { key: 'app[content][about][english]', status: 'local' } as unknown as Change;
const req = (action: RunReq['action'], o: Partial<RunReq> = {}): RunReq => ({ project: 'P', app: 'game', action, ...o });
const start = (r: RunReq, configPath = 'P') => {
  const s = jobs.start(r, configPath);
  assert.ok(!('error' in s), '应该能开始');
  return s.done;
};

// ---- 锁 ----
let release!: () => void;
next = (_r, log) => new Promise((ok) => { log('进行中'); log(' ✓ 完成 ', 'result'); release = () => ok(result({ apps: [{ key: 'game', ok: true, changes: [change] }] })); });
const done = start(req('diff'));
assert.deepEqual(jobs.current(), { action: 'diff', project: 'P', app: 'game' });
assert.ok(jobs.busyWith('diff') && !jobs.busyWith('assets'));
const second = jobs.start(req('push'));
assert.ok('error' in second && second.error === '正在执行 diff，请等它结束', '有任务时不能再开始');
release();
await done;
assert.equal(jobs.current(), undefined, '结束后释放锁');
assert.equal(calls.length, 1);
assert.deepEqual(calls[0], { configPath: 'P', apps: ['game'], action: 'diff' });

// ---- 结果和事件 ----
const last = jobs.lastResult()!;
assert.equal(last.ok, true);
assert.deepEqual(last.lines, ['✓ 完成'], '只记结果行');
assert.deepEqual(events.map((e) => e[0]), ['job', 'log', 'log', 'done', 'changed']);

// ---- 对比结果 ----
const rc = jobs.remoteCheck('P', 'game');
assert.ok(rc && rc.changes.get(change.key) === change, '对比后写入');
assert.equal(jobs.remoteCheck('P', 'other'), undefined);

next = async () => result({ ok: true, changedRemote: false });
await start(req('push', { dryRun: true, only: ['x'] }));
assert.ok(jobs.remoteCheck('P', 'game'), '演练没改后台，对比结果保留');
assert.deepEqual(calls.at(-1), { configPath: 'P', apps: ['game'], action: 'push', dryRun: true, force: undefined, only: ['x'] });
assert.equal(jobs.lastResult()!.dryRun, true);

next = async () => result({ ok: true, changedRemote: true });
await start(req('delete-images', { only: ['header|schinese'] }));
assert.equal(jobs.remoteCheck('P', 'game'), undefined, '后台改了就作废');
assert.deepEqual(calls.at(-1), { configPath: 'P', apps: ['game'], action: 'delete-images', targets: ['header|schinese'], dryRun: undefined });

next = async () => result({ apps: [{ key: 'game', ok: true, changes: [change] }] });
await start(req('diff'));
next = async () => result({ ok: false });
await start(req('pull'));
assert.ok(jobs.remoteCheck('P', 'game'), '拉取失败不作废');
next = async () => result({ ok: true });
await start(req('pull', { force: true }));
assert.equal(jobs.remoteCheck('P', 'game'), undefined, '拉取成功就作废');

// ---- 出错 ----
next = async () => { throw new Error('炸了'); };
await start(req('assets'));
assert.equal(jobs.current(), undefined, '出错也释放锁');
assert.equal(jobs.lastResult()!.ok, false);
assert.deepEqual(jobs.lastResult()!.lines, ['✗ 错误: 炸了']);

// ---- 登录：不带 App，可以没有配置文件 ----
next = async () => result({ needLogin: false });
const login = jobs.start(req('login', { project: '', app: 'game' }));
assert.ok(!('error' in login));
await login.done;
assert.deepEqual(calls.at(-1), { configPath: undefined, apps: [], action: 'login' });
assert.equal(jobs.lastResult()!.app, '');

console.log('✓ 网页任务测试通过');
