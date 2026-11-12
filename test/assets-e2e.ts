// 图片上传端到端测试（模拟后台）：按尺寸识别类型、语言、截图年龄声明、增量上传、错误尺寸
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { start } from './mock-partner.js';
import { png } from './png.js';

const run = promisify(execFile);
const srv = await start();
const ws = mkdtempSync(join(tmpdir(), 'autosw-assets-'));
const cfgFile = join(ws, 'steam.config.yaml');
const writeCfg = (extra = '') => writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }  # 不用真实的共享登录
partner: { storeEditUrl: "${srv.url}/admin/game/editbyappid/{appid}", delayMs: 0 }
languages: [english, schinese]
apps:
  game: { appid: 100 ${extra} }
`);
const cli = async (...a: string[]) => {
  try {
    return (await run(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli.ts'), '-c', cfgFile, ...a], { encoding: 'utf8' })).stdout;
  } catch (e: any) { return 'EXIT ' + e.code + '\n' + e.stdout + e.stderr; }
};
const put = (rel: string, data: Buffer) => {
  const p = join(ws, 'apps', 'game', 'assets', rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
};

let ok = false;
try {
  writeCfg();
  put('store/english/header.png', png(920, 430));
  put('store/schinese/header_cn.png', png(920, 430, 1));
  put('store/schinese/small.png', png(462, 174));
  put('store/english/background.png', png(1438, 810));
  put('library/english/lib_header.png', png(920, 430, 2)); // 和商店形象图片同尺寸，靠目录区分
  put('screenshots/shot1.png', png(1920, 1080));

  // 没声明截图年龄时拒绝上传
  let out = await cli('assets'); console.log(out);
  assert.match(out, /EXIT 1/); assert.match(out, /screenshotsAllAges/);
  assert.equal(srv.uploads.length, 0);

  writeCfg(', assets: { screenshotsAllAges: true }');
  out = await cli('assets', '--dry-run'); console.log(out);
  assert.match(out, /store\/schinese\/small\.png\s+小宣传图 462x174 \[schinese\]/);
  assert.match(out, /library\/english\/lib_header\.png\s+库形象图片 920x430/);
  assert.equal(srv.uploads.length, 0, 'dry-run 不上传');

  out = await cli('assets'); console.log(out);
  assert.match(out, /需要上传 6 张/);
  assert.equal((out.match(/（已核对）/g) ?? []).length, 6, '每张都从后台数据里核对到了变化');
  const byFile = Object.fromEntries(srv.uploads.map((u) => [u.filename, u]));
  assert.equal(byFile['header.png'].key, 'header_image|header|assets|header_image|image|english');
  assert.equal(byFile['header_cn.png'].key, 'header_image|header|assets|header_image|image|schinese');
  assert.equal(byFile['small.png'].key, 'small_capsule|capsule|assets|small_capsule|image|schinese');
  assert.equal(byFile['background.png'].key, 'page_background|page_bg_raw|assets|page_background_raw', '非本地化类型不带语言');
  assert.equal(byFile['lib_header.png'].key, 'library_header|library_header|assets|library_header|image|english');
  assert.equal(byFile['shot1.AA1.png'].key, 'screenshot|assets|screenshots|0|english[]', '截图按后台规则命名');
  assert.equal(byFile['shot1.AA1.png'].allAges, '1');
  assert.equal(byFile['header.png'].size, png(920, 430).length, '上传原始字节');

  // 增量：没改的不重复上传；改过的重新上传
  srv.uploads.length = 0;
  out = await cli('assets'); console.log(out);
  assert.match(out, /需要上传 0 张/);
  put('store/english/header.png', png(920, 430, 9));
  put('screenshots/bad.png', png(800, 600));
  out = await cli('assets'); console.log(out);
  assert.match(out, /store\/english\/header\.png（已修改）\s+形象图片/);
  assert.match(out, /screenshots\/bad\.png\s+尺寸 800x600 对不上任何类型/, '尺寸不对的图在本地就拒绝，不发给后台');
  assert.match(out, /EXIT 1/, '有失败时退出码为 1');
  assert.deepEqual(srv.uploads.map((u) => u.filename), ['header.png']);

  // 后台拒收：显示后台给的错误信息，不写入上传记录
  rmSync(join(ws, 'apps', 'game', 'assets', 'screenshots', 'bad.png'));
  put('store/english/reject_small.png', png(462, 174));
  out = await cli('assets'); console.log(out);
  assert.match(out, /reject_small\.png\s+后台返回失败：Image rejected/);
  assert.match(out, /EXIT 1/);
  assert.match(await cli('assets', '-n'), /需要上传 1 张/, '失败的图片下次还会重试');
  rmSync(join(ws, 'apps', 'game', 'assets', 'store', 'english', 'reject_small.png'));

  // --force 重传完全相同的图片：后台数据不变是正常的，只提示、不算失败
  srv.uploads.length = 0;
  out = await cli('assets', '--force'); console.log(out);
  assert.doesNotMatch(out, /EXIT/);
  assert.equal(srv.uploads.length, 6);

  // 从后台删除：先演练，只找删除链接
  out = await cli('delete-image', 'game', 'header|schinese', '-n'); console.log(out);
  assert.match(out, /→ 删除 形象图片（简体中文）\s+会清空：app\[assets\]\[header_image\]\[image\]\[schinese\]、.*image2x_raw/);
  assert.equal(srv.deletes.length, 0, '演练不删除');
  out = await cli('delete-image', 'game', 'header|schinese', 'page_background|*'); console.log(out);
  assert.doesNotMatch(out, /EXIT/);
  assert.match(out, /✓ 已删除 形象图片（简体中文）（已核对）/);
  assert.match(out, /✓ 已删除 页面背景（已核对）/);
  assert.match(out, /本地文件 store\/schinese\/header_cn\.png 没有删除/);
  assert.deepEqual(srv.deletes.filter((k) => k.includes('[image][')), ['app[assets][header_image][image][schinese]', 'app[assets][page_background_raw][image][english]']);
  assert.match(await cli('assets', '-n'), /需要上传 2 张/, '删掉后本地的图变回待上传');
  // 后台已经没有这张图了：找不到删除链接
  out = await cli('delete-image', 'game', 'header|schinese'); console.log(out);
  assert.match(out, /没有这张图的“删除”链接/); assert.match(out, /EXIT 1/);
  // 后台拒绝
  out = await cli('delete-image', 'game', 'small_capsule|schinese'); console.log(out);
  assert.match(out, /后台返回失败：Delete failed/); assert.match(out, /EXIT 1/);
  // 不认识的位置 / 不同步的语言：不打开后台就报错
  out = await cli('delete-image', 'game', 'nope|english', 'header|japanese'); console.log(out);
  assert.match(out, /nope\|english\s+不认识的位置/); assert.match(out, /japanese 不在这个 App 的同步语言里/);
  ok = true;
  console.log('\n✓ 图片上传测试全部通过');
} finally {
  srv.close();
  rmSync(ws, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
}
