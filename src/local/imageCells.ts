// 图片“格子”：后台的一个图片位置（槽位）× 一种语言。不分语言的槽位（页面背景、截图）只有一格，语言记成 '*'。
// 格子的 key、本地目录、'*' 的语言回退、本地文件属于哪一格，都只在这里算。
//   key：      "header|schinese"、"page_background|*"、"screenshot|*"
//   本地目录： store/<语言>/、library/<语言>/、screenshots/；不分语言的商店/库图片放在默认语言目录（有 english 用 english，否则第一种语言）
//   查后台：   '*' 用 english 去查 serialized_app_data.assets
// 普通格子一格只放一张图（新图替换旧图）；截图可以有很多张，所以 scanCells 把截图单独列出来，不放进 cells。
// Demo（app.inherits）没放图的格子用正式版的图，规则见 scanCells。
import { join, relative } from 'node:path';
import type { AppConfig } from '../config.js';
import { classify, sizesFor, SLOTS, type Slot } from '../slots.js';
import { scanAssets, type LocalAsset } from './assetFiles.js';
import { imageSize } from './imageSize.js';

export const ANY_LANG = '*';

export interface Cell {
  slot: Slot;
  /** 本地化槽位是 Steam 语言名，不分语言的槽位是 '*' */
  lang: string;
}

/** 某个槽位在某种语言下的格子：不分语言的槽位不管传什么语言都是 '*' 那一格 */
export const cellOf = (slot: Slot, lang: string): Cell => ({ slot, lang: slot.localized ? lang : ANY_LANG });

export const cellKey = (c: Cell) => `${c.slot.id}|${c.lang}`;

/** 给人看的名字，例如 “形象图片（schinese）”、“页面背景” */
export const cellName = (c: Cell, langName: (l: string) => string = (l) => l) =>
  c.slot.localized ? `${c.slot.label}（${langName(c.lang)}）` : c.slot.label;

/** 默认语言：不分语言的图片放在这个语言目录下 */
export const defaultLang = (app: AppConfig) => (app.languages.includes('english') ? 'english' : app.languages[0]);

/** "header|schinese" → 格子。不认识的槽位、不在同步语言里的语言直接抛错（错误信息给人看） */
export function parseCell(app: AppConfig, key: string): Cell {
  const [id, lang = ANY_LANG] = String(key).split('|');
  const slot = SLOTS.find((s) => s.id === id);
  if (!slot) throw new Error(`不认识的位置：${key}`);
  if (slot.localized && !app.languages.includes(lang)) throw new Error(`${lang} 不在这个 App 的同步语言里`);
  return cellOf(slot, lang);
}

/** 格子的本地目录（相对 assets 目录） */
export function cellDir(app: AppConfig, c: Cell): string {
  if (c.slot.tab === 'screenshot') return 'screenshots';
  return `${c.slot.tab}/${c.slot.localized ? c.lang : defaultLang(app)}`;
}

/** 去后台数据里查这一格时用的语言 */
export const remoteLang = (c: Cell) => (c.lang === ANY_LANG ? 'english' : c.lang);

export interface CellFile extends LocalAsset {
  width: number;
  height: number;
  /** "920x430" */
  size: string;
}

export interface CellScan {
  /** key 是 cellKey；同一格多张时按文件名排序 */
  cells: Map<string, CellFile[]>;
  screenshots: CellFile[];
  /** 读不出尺寸或尺寸对不上任何槽位的文件 */
  unmatched: (LocalAsset & { size?: string; reason: string })[];
  /** 目录放错之类的提示（来自 scanAssets） */
  warnings: string[];
}

function scanOwn(app: AppConfig): CellScan {
  const { assets, warnings } = scanAssets(app);
  const scan: CellScan = { cells: new Map(), screenshots: [], unmatched: [], warnings };
  for (const a of assets) {
    const d = imageSize(a.bytes);
    if (!d) { scan.unmatched.push({ ...a, reason: '读不出图片尺寸（文件损坏或格式不支持）' }); continue; }
    const size = `${d.width}x${d.height}`;
    const slot = classify(a.tab, d.width, d.height);
    if (!slot) { scan.unmatched.push({ ...a, size, reason: `尺寸 ${size} 对不上任何类型。可用：${sizesFor(a.tab)}` }); continue; }
    const f: CellFile = { ...a, width: d.width, height: d.height, size };
    if (slot.tab === 'screenshot') { scan.screenshots.push(f); continue; }
    const k = cellKey(cellOf(slot, a.lang!));
    scan.cells.set(k, [...(scan.cells.get(k) ?? []), f]);
  }
  return scan;
}

/**
 * 扫描本地图片，按尺寸分到格子里（规则和后台一样，见 slots.ts 的 classify）。
 * Demo 默认带上继承的图（inherit: false 只看 Demo 自己的文件，收件箱和拖放用）：
 *   普通格子：Demo 这种语言有图 → 用它；Demo 的 english 有图 → 不继承（商店会显示 Demo 的英文版）；否则用正式版同一格的图。
 *   截图：Demo 一张都没有时整组用正式版的。
 * 继承来的文件 inherited = true，rel 相对 Demo 的 assets 目录（../../game/assets/...），上传记录记在 Demo 名下。
 */
export function scanCells(app: AppConfig, o: { inherit?: boolean } = {}): CellScan {
  const scan = scanOwn(app);
  const parent = app.inherits;
  if (!parent || o.inherit === false) return scan;
  const p = scanOwn(parent);
  const adopt = (f: CellFile): CellFile =>
    ({ ...f, inherited: true, rel: relative(app.assets.dir, join(parent.assets.dir, f.rel)).replace(/\\/g, '/') });
  for (const slot of SLOTS) {
    if (slot.tab === 'screenshot') continue;
    for (const lang of slot.localized ? app.languages : [ANY_LANG]) {
      const k = cellKey(cellOf(slot, lang));
      if (scan.cells.has(k)) continue;
      if (slot.localized && lang !== 'english' && scan.cells.has(cellKey(cellOf(slot, 'english')))) continue;
      const files = p.cells.get(k);
      if (files) scan.cells.set(k, files.map(adopt));
    }
  }
  if (!scan.screenshots.length) scan.screenshots = p.screenshots.map(adopt);
  return scan;
}

/** 某一格的本地文件；截图格返回所有截图 */
export const filesIn = (scan: CellScan, c: Cell): CellFile[] =>
  c.slot.tab === 'screenshot' ? scan.screenshots : scan.cells.get(cellKey(c)) ?? [];
