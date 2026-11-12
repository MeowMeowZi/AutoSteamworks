// 图片格子测试（离线）：key 解析和校验、本地目录、'*' 的语言回退、扫描时文件分到哪一格
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { cellDir, cellKey, cellName, filesIn, parseCell, remoteLang, scanCells } from '../src/local/imageCells.js';
import { png } from './png.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-cells-'));
const cfgFile = join(ws, 'steam.config.yaml');
writeFileSync(cfgFile, `
browser: { profileDir: .autosw/profile }
languages: [english, schinese]
apps:
  game: { appid: 100 }
  cn: { appid: 101, languages: [schinese] }
`);
const A = join(ws, 'apps', 'game', 'assets');
const put = (rel: string, data: Buffer) => { const p = join(A, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); };

let ok = false;
try {
  const [app, cn] = loadConfig(cfgFile).apps;

  // key 解析
  const h = parseCell(app, 'header|schinese');
  assert.equal(h.slot.id, 'header'); assert.equal(h.lang, 'schinese');
  assert.equal(cellKey(h), 'header|schinese');
  assert.equal(cellKey(parseCell(app, 'page_background')), 'page_background|*', '不写语言就是 *');
  assert.equal(cellKey(parseCell(app, 'page_background|schinese')), 'page_background|*', '不分语言的槽位不管写什么语言都是 * 那一格');
  assert.equal(cellKey(parseCell(app, 'screenshot|*')), 'screenshot|*');
  assert.throws(() => parseCell(app, 'nope|english'), /不认识的位置：nope\|english/);
  assert.throws(() => parseCell(app, 'header|japanese'), /japanese 不在这个 App 的同步语言里/);
  assert.throws(() => parseCell(app, 'header'), /\* 不在这个 App 的同步语言里/, '本地化槽位必须写语言');

  // 名字、目录、查后台用的语言
  assert.equal(cellName(h), '形象图片（schinese）');
  assert.equal(cellName(parseCell(app, 'page_background')), '页面背景');
  assert.equal(cellDir(app, h), 'store/schinese');
  assert.equal(cellDir(app, parseCell(app, 'library_logo|english')), 'library/english');
  assert.equal(cellDir(app, parseCell(app, 'page_background')), 'store/english', '不分语言的放在默认语言目录');
  assert.equal(cellDir(cn, parseCell(cn, 'page_background')), 'store/schinese', '没有 english 时用第一种语言');
  assert.equal(cellDir(app, parseCell(app, 'screenshot')), 'screenshots');
  assert.equal(remoteLang(h), 'schinese');
  assert.equal(remoteLang(parseCell(app, 'page_background')), 'english');

  // 扫描
  put('store/english/a.png', png(920, 430, 1));
  put('store/english/b.png', png(920, 430, 2));           // 同一格两张
  put('store/schinese/h.png', png(920, 430, 3));
  put('library/schinese/lh.png', png(920, 430, 4));       // 库目录里的 920x430 是库形象图片
  put('library/english/logo.png', png(1280, 500, 5));     // 宽一致 → 库徽标
  put('store/schinese/bg.png', png(1438, 810, 6));        // 页面背景放在任何语言目录都算 * 那一格
  put('screenshots/s1.png', png(1920, 1080, 7));
  put('screenshots/s2.png', png(2560, 1440, 8));
  put('store/english/bad.png', png(100, 100, 9));
  put('store/english/broken.png', Buffer.from('not a png'));
  put('store/loose.png', png(920, 430));                  // 没放在语言目录里

  const scan = scanCells(app);
  const rels = (k: string) => filesIn(scan, parseCell(app, k)).map((f) => f.rel);
  assert.deepEqual(rels('header|english'), ['store/english/a.png', 'store/english/b.png']);
  assert.deepEqual(rels('header|schinese'), ['store/schinese/h.png']);
  assert.deepEqual(rels('library_header|schinese'), ['library/schinese/lh.png']);
  assert.deepEqual(rels('library_logo|english'), ['library/english/logo.png']);
  assert.deepEqual(rels('page_background'), ['store/schinese/bg.png']);
  assert.deepEqual(rels('screenshot'), ['screenshots/s1.png', 'screenshots/s2.png'], '截图格返回所有截图');
  assert.deepEqual(rels('small_capsule|english'), []);
  assert.equal(filesIn(scan, parseCell(app, 'header|english'))[0].size, '920x430');
  assert.deepEqual([...scan.cells.keys()].sort(), ['header|english', 'header|schinese', 'library_header|schinese', 'library_logo|english', 'page_background|*']);
  assert.deepEqual(scan.unmatched.map((u) => u.rel).sort(), ['store/english/bad.png', 'store/english/broken.png']);
  assert.match(scan.unmatched.find((u) => u.rel.endsWith('bad.png'))!.reason, /尺寸 100x100 对不上任何类型/);
  assert.match(scan.unmatched.find((u) => u.rel.endsWith('broken.png'))!.reason, /读不出图片尺寸/);
  assert.equal(scan.warnings.length, 1); assert.match(scan.warnings[0], /store\/loose\.png/);

  ok = true;
  console.log('✓ 图片格子测试通过');
} finally {
  rmSync(ws, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}
