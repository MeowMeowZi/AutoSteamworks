// runner 测试（模拟后台，进程内直接调用 runOperation）：结果字段、未登录、后台是否被改、日志的 result 标记
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { start } from './mock-partner.js';
import { png } from './png.js';
import { runOperation, type RunRequest } from '../src/runner.js';
import { DRAFT_NOTE } from '../src/ops.js';

const srv = await start();
const ws = mkdtempSync(join(tmpdir(), 'autosw-runner-'));
const configPath = join(ws, 'steam.config.yaml');
writeFileSync(configPath, `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
partner: { storeEditUrl: "${srv.url}/admin/game/editbyappid/{appid}", delayMs: 0 }
languages: [english, schinese]
apps:
  game: { appid: 100 }
  nologin: { appid: 999 }
`);

/** 后台状态快照（打开编辑页时自动保存） */
const metaFile = join(ws, '.autosw', 'remote', 'game.json');
const meta = () => JSON.parse(readFileSync(metaFile, 'utf8'));

/** 执行并收集日志；result 行单独记下来 */
async function op(req: RunRequest) {
  const all: string[] = [], results: string[] = [];
  const r = await runOperation({ configPath, ...req }, (line, kind) => {
    all.push(line);
    if (kind === 'result') results.push(line.trim());
  });
  console.log(all.join('\n'));
  return { ...r, results };
}

let ok = false;
try {
  // 没拉取过：diff 成功但没有对比结果
  let r = await op({ action: 'diff', apps: ['game'] });
  assert.ok(r.ok && !r.changedRemote && !r.needLogin);
  assert.equal(r.apps.length, 1);
  assert.equal(r.apps[0].changes, undefined);
  assert.ok(r.results.some((l) => l.startsWith('尚未从后台拉取过')), JSON.stringify(r.results));
  assert.ok(existsSync(metaFile), '没拉取过的 diff 也刷新后台状态快照');
  assert.ok(meta().assets && meta().labels, JSON.stringify(meta()));

  r = await op({ action: 'pull', apps: ['game'] });
  assert.ok(r.ok && !r.changedRemote, '拉取不改后台');
  assert.ok(r.results.some((l) => /^✓ \d+ 个字段/.test(l)));
  assert.ok(!r.results.some((l) => l.startsWith('■')), '标题行不是结果行');

  // 本地改一处，diff 返回带类型的改动
  writeFileSync(join(ws, 'apps', 'game', 'store', 'english', 'short_description.bbcode'), 'Local edit');
  r = await op({ action: 'diff', apps: ['game'] });
  assert.deepEqual(r.apps[0].changes?.map((c) => [c.kind, c.key]), [['local', 'app[content][short_description][english]']]);
  assert.ok(r.results.includes('本地改动 1，后台被改过 0，冲突 0，后台已删除 0'), JSON.stringify(r.results));

  // 本地有没上传的改动时拉取被跳过：算失败
  r = await op({ action: 'pull', apps: ['game'] });
  assert.ok(!r.ok && !r.apps[0].ok);
  assert.ok(r.results.some((l) => l.startsWith('跳过：本地有')));

  // 演练不改后台
  r = await op({ action: 'push', apps: ['game'], dryRun: true });
  assert.ok(r.ok && !r.changedRemote);
  assert.ok(!r.results.includes(DRAFT_NOTE));

  r = await op({ action: 'push', apps: ['game'] });
  assert.ok(r.ok && r.changedRemote);
  assert.equal(r.results.filter((l) => l === DRAFT_NOTE).length, 1, '草稿提醒只出现一次');

  // 上传、删除图片
  const p = join(ws, 'apps', 'game', 'assets', 'store', 'english', 'small.png');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, png(462, 174));
  r = await op({ action: 'assets', apps: ['game'] });
  assert.ok(r.ok && r.changedRemote);
  assert.ok(r.results.some((l) => l.startsWith('后台位置：')), JSON.stringify(r.results));
  assert.ok(meta().assets.small_capsule?.image?.english, '快照是上传后的样子');

  r = await op({ action: 'delete-images', apps: ['game'], targets: ['small_capsule|english'], dryRun: true });
  assert.ok(r.ok && !r.changedRemote, '演练删除不改后台');
  assert.ok(meta().assets.small_capsule?.image?.english, '演练删除后快照里图还在');
  r = await op({ action: 'delete-images', apps: ['game'], targets: ['small_capsule|english'] });
  assert.ok(r.ok && r.changedRemote, '删除图片也算改了后台');
  assert.ok(r.results.some((l) => l.startsWith('✓ 已删除 小宣传图')));
  assert.ok(!meta().assets.small_capsule?.image?.english, '快照是删除后的样子');

  // 没登录：needLogin，后面的 App 不再执行
  r = await op({ action: 'pull', apps: ['nologin', 'game'] });
  assert.ok(!r.ok && r.needLogin);
  assert.deepEqual(r.apps.map((a) => [a.key, a.ok]), [['nologin', false]], '没登录时立刻停下');
  assert.ok(r.results.some((l) => l.startsWith('✗ 错误: Steamworks 还没登录')), JSON.stringify(r.results));

  // 不认识的 App：请求错误直接抛出
  await assert.rejects(op({ action: 'pull', apps: ['nope'] }));
  // 没有配置文件时只能登录
  await assert.rejects(runOperation({ action: 'pull' }, () => {}), /缺少配置文件/);

  ok = true;
  console.log('\n✓ runner 测试全部通过');
} finally {
  srv.close();
  if (!ok) console.log('工作目录保留在', ws);
}
