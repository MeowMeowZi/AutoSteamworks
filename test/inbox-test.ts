// “待分类”收件箱测试（离线）：按尺寸判断位置、按文件名判断语言、替换旧图、重名、不能分类的情况、命令行
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { langHints, planInbox, sortInbox } from '../src/local/inbox.js';
import { png } from './png.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-inbox-'));
const cfgFile = join(ws, 'steam.config.yaml');
writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }
languages: [english, schinese]
apps:
  game: { appid: 100 }
`);
const A = join(ws, 'apps', 'game', 'assets');
const put = (rel: string, data: Buffer) => { const p = join(A, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); };
const has = (rel: string) => existsSync(join(A, rel));
const run = promisify(execFile);
const cli = async (...a: string[]) => {
  try { return (await run(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli.ts'), '-c', cfgFile, ...a], { encoding: 'utf8' })).stdout; }
  catch (e: any) { return 'EXIT ' + e.code + '\n' + e.stdout + e.stderr; }
};

let ok = false;
try {
  // 语言线索
  assert.deepEqual(langHints('header_cn.png'), ['schinese']);
  assert.deepEqual(langHints('capsule-zh-TW.png'), ['tchinese'], 'zh-TW 不能同时算成简体');
  assert.deepEqual(langHints('主宣传图_繁体中文.png'), ['tchinese'], '“繁体中文”里的“中文”不能再算简体');
  assert.deepEqual(langHints('主宣传图_英文.png'), ['english']);
  assert.deepEqual(langHints('schinese/a.png'), ['schinese'], '子目录名也算');
  assert.deepEqual(langHints('header.png'), []);
  assert.deepEqual(langHints('header_en_cn.png').sort(), ['english', 'schinese']);

  const app = () => loadConfig(cfgFile).apps[0];
  // 已有的图：英文形象图片会被替换
  put('store/english/old_header.png', png(920, 430, 9));

  put('待分类/header.png', png(920, 430, 1));              // 没写语言 → english，替换 old_header
  put('待分类/header_cn.png', png(920, 430, 2));           // 简体
  put('待分类/library_header.png', png(920, 430, 3));      // 文件名带 library → 库形象图片
  put('待分类/库徽标.png', png(1280, 500, 4));               // 宽一致 → 库徽标
  put('待分类/小图_简中.png', png(462, 174, 5));
  put('待分类/bg.png', png(1438, 810, 6));                 // 页面背景，不分语言
  put('待分类/shot1.png', png(1920, 1080, 7));
  put('待分类/screenshot_wide.png', png(3840, 1240, 8));   // 和库主页图片同尺寸，文件名写了 screenshot → 截图
  put('待分类/hero.png', png(3840, 1240, 10));             // 没写 → 库主页图片
  put('待分类/japanese/header.png', png(920, 430, 11));    // 不在同步语言里
  put('待分类/odd.png', png(100, 100));                     // 尺寸不对
  put('待分类/header_english.png', png(920, 430, 12));     // 和 header.png 抢同一个位置
  put('待分类/readme.txt', Buffer.from('不是图片，忽略'));

  const plan = planInbox(app());
  const by = (f: string) => plan.find((x) => x.from === '待分类/' + f)!;
  assert.equal(plan.length, 12, '只看图片文件');
  assert.equal(by('header.png').to, 'store/english/header.png');
  assert.deepEqual(by('header.png').replaces, ['store/english/old_header.png']);
  assert.equal(by('header_cn.png').to, 'store/schinese/header_cn.png');
  assert.equal(by('library_header.png').to, 'library/english/library_header.png');
  assert.equal(by('库徽标.png').slot, '库徽标');
  assert.equal(by('小图_简中.png').to, 'store/schinese/小图_简中.png');
  assert.equal(by('bg.png').to, 'store/english/bg.png');
  assert.equal(by('bg.png').lang, undefined, '页面背景不分语言');
  assert.equal(by('shot1.png').to, 'screenshots/shot1.png');
  assert.equal(by('screenshot_wide.png').to, 'screenshots/screenshot_wide.png');
  assert.equal(by('hero.png').to, 'library/english/hero.png');
  assert.match(by('japanese/header.png').reason!, /japanese/);
  assert.match(by('odd.png').reason!, /100x100/);
  assert.match(by('header_english.png').reason!, /同一个位置/);
  assert.ok(has('待分类/header.png'), '只是计划，不动文件');

  // 命令行演练不动文件，有不能分类的图片时退出码为 1
  let out = await cli('sort-images', '-n');
  assert.match(out, /^EXIT 1/);
  assert.match(out, /演练/);
  assert.ok(has('待分类/header.png'));

  out = await cli('sort-images');
  assert.match(out, /header\.png → store\/english\/header\.png/);
  assert.ok(has('store/english/header.png') && !has('待分类/header.png'));
  assert.ok(has('已替换/store/english/old_header.png') && !has('store/english/old_header.png'), '旧图挪到 已替换/');
  assert.ok(has('screenshots/shot1.png') && has('library/english/hero.png'));
  assert.ok(!has('待分类/japanese') || readdirSync(join(A, '待分类/japanese')).length > 0, '还有图片的子目录保留');
  assert.ok(has('待分类/odd.png') && has('待分类/header_english.png'), '不能分类的留在原地');

  // 同一张图再丢一次：已经在目标位置 → 删掉待分类里的副本
  put('待分类/again.png', png(1920, 1080, 7));
  let items = sortInbox(app());
  assert.equal(items.find((x) => x.from === '待分类/again.png')!.duplicate, true);
  assert.ok(!has('待分类/again.png'));
  // 上次因为抢位置留下的第二张英文形象图片，这次没人抢了，替换上一张
  assert.deepEqual(items.find((x) => x.from === '待分类/header_english.png')!.replaces, ['store/english/header.png']);
  assert.ok(has('store/english/header_english.png') && has('已替换/store/english/header.png'));

  // 重名：截图目录里已有 shot1.png（内容不同）→ 加序号
  put('待分类/shot1.png', png(1920, 1080, 20));
  items = sortInbox(app());
  assert.equal(items.find((x) => x.from === '待分类/shot1.png')!.to, 'screenshots/shot1-2.png');
  assert.notDeepEqual(readFileSync(join(A, 'screenshots/shot1.png')), readFileSync(join(A, 'screenshots/shot1-2.png')));

  rmSync(join(A, '待分类/odd.png')); rmSync(join(A, '待分类/japanese'), { recursive: true });
  assert.deepEqual(readdirSync(join(A, '待分类')), ['readme.txt'], '图片都整理走了，别的文件不动');
  ok = true;
} finally {
  rmSync(ws, { recursive: true, force: true });
}
console.log(ok ? '✓ 待分类整理测试全部通过' : '✗ 待分类整理测试失败');
