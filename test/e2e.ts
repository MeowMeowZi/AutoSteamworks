// 端到端测试（用模拟后台）：pull → 本地修改 → status/dry-run → push → 验证线上值；再测冲突处理
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { start } from './mock-partner.js';

const run = promisify(execFile);
const srv = await start();
const ws = mkdtempSync(join(tmpdir(), 'autosw-'));
writeFileSync(join(ws, 'steam.config.yaml'), `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
partner: { storeEditUrl: "${srv.url}/admin/game/editbyappid/{appid}", delayMs: 0 }
languages: [english, schinese]
apps:
  game: { appid: 100 }
  demo: { appid: 200, languages: [english], store: { ignoreFields: ["app[name]"] } }
`);
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
// 必须异步执行：模拟服务器在本进程里，同步调用会把它卡死
const cli = async (...a: string[]) => (await run(process.execPath,
  ['--import', 'tsx', cliPath, '-c', join(ws, 'steam.config.yaml'), ...a], { encoding: 'utf8' })).stdout;
const dir = (app: string) => join(ws, 'apps', app, 'store');
const read = (p: string) => readFileSync(p, 'utf8');
const yaml = (p: string) => YAML.parse(read(p));
const patchYaml = (p: string, patch: object) => writeFileSync(p, YAML.stringify({ ...yaml(p), ...patch }));
const remote = () => srv.db['1100'];
const crlf = (s: string) => s.replace(/\r\n/g, '\n'); // 浏览器按 HTML 规范会把换行提交成 CRLF

let ok = false;
try {
  console.log(await cli('pull'));
  const g = dir('game');
  assert.equal(read(join(g, 'english', 'about.bbcode')), 'Old about\n[b]bold[/b]');
  assert.equal(read(join(g, 'schinese', 'short_description.bbcode')), '');
  assert.deepEqual(yaml(join(g, 'english', '_fields.yaml')), { 'sysreqs.windows.min.processor': '' });
  assert.ok(!existsSync(join(g, 'japanese')), '未配置的语言不拉取');
  assert.deepEqual(yaml(join(g, '_common.yaml')), {
    'app[broadcast][chat_visibility]': 'hide', 'app[classification][primary_genre]': '', 'app[content][links][website]': '',
    'app[name]': '邪神今天也在挂机',
    'app[platforms][win]': '1', 'tags[][=coop]': true, 'tags[][=pvp]': false,
  }, '内部字段（sessionid、serialized_app_data、*_compl…）被忽略');
  assert.ok(!('app[name]' in yaml(join(dir('demo'), '_common.yaml'))), 'ignoreFields 生效');

  // 本地修改：多语言长文本 + 系统要求 + 下拉 + 单选 + 复选框；about 故意用 CRLF
  writeFileSync(join(g, 'english', 'about.bbcode'), 'New about\r\n[h1]Hi[/h1]');
  writeFileSync(join(g, 'english', 'short_description.bbcode'), 'An idle game about a lazy god.');
  writeFileSync(join(g, 'schinese', 'short_description.bbcode'), '一款关于摸鱼邪神的放置游戏。');
  patchYaml(join(g, 'schinese', '_fields.yaml'), { 'sysreqs.windows.min.processor': 'Intel i3' });
  patchYaml(join(g, '_common.yaml'), { 'app[classification][primary_genre]': '23', 'app[broadcast][chat_visibility]': 'show', 'tags[][=pvp]': true });
  const st = await cli('status'); console.log(st);
  assert.match(st, /game: 7 处改动/);
  assert.match(st, /schinese\/short_description/);
  assert.match(st, /demo: 无改动/);

  console.log(await cli('push', 'game', '--dry-run'));
  assert.equal(remote()['app[content][short_description][english]'], '', 'dry-run 不写入');

  const out = await cli('push', 'game'); console.log(out);
  assert.match(out, /已保存 7 个字段/);
  const d = remote();
  assert.equal(crlf(d['app[content][about][english]']), 'New about\n[h1]Hi[/h1]');
  assert.equal(d['app[content][short_description][english]'], 'An idle game about a lazy god.', '没被界面的 submit 处理覆盖');
  assert.equal(d['app[content][short_description][schinese]'], '一款关于摸鱼邪神的放置游戏。');
  assert.equal(d['app[content][sysreqs][windows][min][processor][schinese]'], 'Intel i3');
  assert.equal(d['app[classification][primary_genre]'], '23');
  assert.equal(d['app[broadcast][chat_visibility]'], 'show');
  assert.equal(d['tags[]'], 'coop,pvp');
  assert.equal(d['app[name]'], '邪神今天也在挂机', '没改的字段保持原值');
  assert.equal(srv.lastPost()!['app[content][about][japanese]'], '', '未配置语言的字段按原值一起提交，不丢失');
  assert.match(await cli('status', 'game'), /game: 无改动/);

  // 冲突：线上和本地都改了英文简介；线上改了网站链接（本地没动）
  remote()['app[content][short_description][english]'] = 'Web edit';
  remote()['app[content][links][website]'] = 'https://example.com';
  writeFileSync(join(g, 'english', 'short_description.bbcode'), 'Local edit');
  const c = await cli('push', 'game'); console.log(c);
  assert.match(c, /冲突\s+english\/short_description/);
  assert.equal(remote()['app[content][short_description][english]'], 'Web edit', '冲突字段默认不推送');
  assert.match(await cli('pull', 'game'), /跳过：本地有/, '有未推送改动时 pull 拒绝覆盖');

  await cli('push', 'game', '--force');
  assert.equal(remote()['app[content][short_description][english]'], 'Local edit');
  assert.equal(remote()['app[content][links][website]'], 'https://example.com', '线上的其他改动不被回滚');

  // 后台“支持的语言”里勾了本地没同步的语言：拉取时加进配置并一起拉下来
  remote()['app[content][supported_languages][japanese][supported]'] = 'true';
  remote()['app[content][supported_languages][afrikaans][supported]'] = 'true'; // 没有商店文本的语言，忽略
  remote()['app[content][supported_languages][schinese][supported]'] = 'true';  // 已经在同步
  srv.db['1200']['app[content][supported_languages][japanese][supported]'] = 'true';
  const pl = await cli('pull'); console.log(pl);
  assert.match(pl, /后台勾选了 日语/);
  const cfg = yaml(join(ws, 'steam.config.yaml'));
  assert.deepEqual(cfg.languages, ['english', 'schinese'], '有多个 App 时不改顶层语言');
  assert.deepEqual(cfg.apps.game.languages, ['english', 'schinese', 'japanese'], '没单独设置的 App：写一份自己的语言');
  assert.deepEqual(cfg.apps.demo.languages, ['english', 'japanese'], '单独设置过的 App：追加到自己的列表');
  assert.ok(existsSync(join(g, 'japanese', 'about.bbcode')), '新语言的文本拉到本地');
  assert.ok(existsSync(join(dir('demo'), 'japanese')));
  assert.doesNotMatch(await cli('pull'), /后台勾选了/, '第二次拉取不再重复添加');
  ok = true;
  console.log('\n✓ 全部通过');
} finally {
  srv.close();
  rmSync(ws, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
}
