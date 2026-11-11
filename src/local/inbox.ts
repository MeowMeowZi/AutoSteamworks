// “待分类”收件箱：图片随便丢进 assets/待分类/，按尺寸判断后台位置、按文件名判断语言，移动到 store/<语言>/、library/<语言>/、screenshots/。
// 位置判断和上传时一样（slots.ts 的 classify）；只有 920x430 同时是商店形象图片和库形象图片，靠文件名区分。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { AppConfig } from '../config.js';
import { ASSET_EXTS } from '../partner/assets.js';
import { classify, sizesFor, SLOTS, type Slot } from '../slots.js';
import { scanAssets } from './assetFiles.js';
import { STEAM_LANGS } from './storeFiles.js';
import { imageSize } from './imageSize.js';

export const INBOX = '待分类';
/** 被新图片替换掉的旧图片挪到这里（不会被扫描上传），用户确认后可以自己删 */
export const REPLACED = '已替换';

export interface InboxItem {
  /** 相对 assets 目录，例如 待分类/header_cn.png */
  from: string;
  size?: string;
  /** 能分类时：目标路径（相对 assets 目录） */
  to?: string;
  slot?: string;
  lang?: string;
  /** 同一位置原有的图片，会被挪到 已替换/ */
  replaces: string[];
  /** 待分类里有一张一模一样的图已经在目标位置：直接删掉待分类里的这张 */
  duplicate?: boolean;
  /** 不能分类的原因 */
  reason?: string;
}

const rel = (root: string, p: string) => relative(root, p).replace(/\\/g, '/');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const isImage = (f: string) => ASSET_EXTS.includes(extname(f).slice(1).toLowerCase());

/** 文件名（含待分类下的子目录名）里的语言线索 → Steam 语言名。拼音缩写、ISO 代码、中文都认 */
const LATIN: Record<string, string> = {
  en: 'english', eng: 'english',
  cn: 'schinese', zh: 'schinese', chs: 'schinese', zhcn: 'schinese', hans: 'schinese',
  cht: 'tchinese', tw: 'tchinese', hk: 'tchinese', zhtw: 'tchinese', hant: 'tchinese',
  ja: 'japanese', jp: 'japanese', jpn: 'japanese', ko: 'koreana', kr: 'koreana', kor: 'koreana', korean: 'koreana',
  de: 'german', ger: 'german', fr: 'french', fra: 'french', ru: 'russian', rus: 'russian', es: 'spanish', spa: 'spanish',
  ptbr: 'brazilian', br: 'brazilian', pt: 'portuguese', pl: 'polish', tr: 'turkish', th: 'thai', vi: 'vietnamese', vn: 'vietnamese', ua: 'ukrainian',
  chinese: 'schinese', japan: 'japanese',
};
const CJK: [RegExp, string][] = [
  [/繁中|繁体|繁體/, 'tchinese'],
  [/简中|简体|簡體|中文/, 'schinese'],
  [/英文|英语|英語/, 'english'],
  [/日文|日语|日語/, 'japanese'],
  [/韩文|韩语|韓語/, 'koreana'],
];

export function langHints(name: string): string[] {
  let s = name.toLowerCase()
    .replace(/zh[-_ ]?(tw|hk|hant)/g, ' cht ')
    .replace(/zh[-_ ]?(cn|hans)/g, ' chs ')
    .replace(/pt[-_ ]?br/g, ' ptbr ');
  const hits = new Set<string>();
  for (const [re, lang] of CJK) if (re.test(s)) { hits.add(lang); s = s.replace(re, ' '); if (lang === 'tchinese') s = s.replace(/中文/g, ' '); }
  for (const t of s.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (STEAM_LANGS.includes(t)) hits.add(t);
    else if (LATIN[t]) hits.add(LATIN[t]);
  }
  return [...hits];
}

const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean);
const wantsLibrary = (name: string) => tokens(name).some((t) => t === 'library' || t === 'lib') || name.includes('库');
const wantsScreenshot = (name: string) => tokens(name).some((t) => /^(screenshots?|shots?|ss)$/.test(t)) || name.includes('截图');

/** 按尺寸找位置：商店 → 库 → 截图；文件名有“库 / library”时 920x430 算库形象图片，有“截图”时大图算截图 */
function slotFor(name: string, w: number, h: number): Slot | undefined {
  const shot = classify('screenshot', w, h);
  if (shot && wantsScreenshot(name)) return shot;
  const store = classify('store', w, h), lib = classify('library', w, h);
  if (store && lib && wantsLibrary(name)) return lib;
  return store ?? lib ?? shot;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : isImage(f) ? [p] : [];
  });
}

/** 看看待分类里每张图会去哪里（不动文件） */
export function planInbox(app: AppConfig): InboxItem[] {
  const root = app.assets.dir;
  const inbox = join(root, INBOX);
  const files = walk(inbox);
  if (!files.length) return [];

  // 现有图片所在的位置，用来找“会被替换的旧图”
  const occupied = new Map<string, string[]>();
  for (const a of scanAssets(app).assets) {
    const d = imageSize(a.bytes);
    const slot = d && classify(a.tab, d.width, d.height);
    if (!slot || slot.id === 'screenshot') continue;
    const k = slot.id + '|' + (slot.localized ? a.lang : '*');
    occupied.set(k, [...(occupied.get(k) ?? []), a.rel]);
  }
  const fallback = app.languages.includes('english') ? 'english' : app.languages[0];
  const taken = new Map<string, string>();
  const targets = new Set<string>();

  return files.map((p): InboxItem => {
    const from = rel(root, p);
    const hintName = rel(inbox, p);
    const item: InboxItem = { from, replaces: [] };
    const d = imageSize(readFileSync(p));
    if (!d) return { ...item, reason: '读不出图片尺寸（文件损坏或格式不支持）' };
    item.size = `${d.width}x${d.height}`;
    const slot = slotFor(hintName, d.width, d.height);
    if (!slot) return { ...item, reason: `尺寸 ${item.size} 对不上任何位置。商店：${sizesFor('store')}；库：${sizesFor('library')}；截图：${sizesFor('screenshot')}` };

    const hints = langHints(hintName);
    if (hints.length > 1) return { ...item, reason: `文件名里同时有多种语言：${hints.join('、')}` };
    const lang = hints[0] ?? fallback;
    if (slot.localized && !app.languages.includes(lang)) {
      return { ...item, reason: `文件名表示语言是 ${lang}，但这个 App 只同步 ${app.languages.join('、')}。先在“设置”里加上这种语言` };
    }

    // 不分语言的位置（页面背景）统一放到默认语言目录
    const dir = slot.tab === 'screenshot' ? 'screenshots' : `${slot.tab}/${slot.localized ? lang : fallback}`;
    item.slot = slot.label;
    if (slot.tab !== 'screenshot') item.lang = slot.localized ? lang : undefined;

    // 目标位置已经有一模一样的文件：只删待分类里的副本
    const hash = sha(p);
    const same = (slot.tab === 'screenshot' ? walk(join(root, 'screenshots')) : walk(join(root, dir))).find((q) => sha(q) === hash);
    if (same) return { ...item, to: rel(root, same), duplicate: true };

    if (slot.tab !== 'screenshot') {
      const k = slot.id + '|' + (slot.localized ? lang : '*');
      const prev = taken.get(k);
      if (prev) return { ...item, reason: `和 ${prev} 是同一个位置（${slot.label}${item.lang ? ' · ' + item.lang : ''}），一个位置只能放一张` };
      taken.set(k, from);
      item.replaces = occupied.get(k) ?? [];
    }

    // 重名时加序号，避免覆盖已有的文件
    const ext = extname(p), stem = basename(p, ext);
    let to = `${dir}/${basename(p)}`;
    for (let n = 2; (existsSync(join(root, to)) && !item.replaces.includes(to)) || targets.has(to); n++) to = `${dir}/${stem}-${n}${ext}`;
    targets.add(to);
    return { ...item, to };
  });
}

/** 按 planInbox 的结果移动文件。返回计划（含不能分类的） */
export function sortInbox(app: AppConfig, dryRun = false): InboxItem[] {
  const root = app.assets.dir;
  mkdirSync(join(root, INBOX), { recursive: true });
  const plan = planInbox(app);
  if (dryRun) return plan;
  for (const it of plan) {
    if (!it.to) continue;
    if (it.duplicate) { rmSync(join(root, it.from)); continue; }
    for (const old of it.replaces) moveToReplaced(root, old);
    mkdirSync(dirname(join(root, it.to)), { recursive: true });
    renameSync(join(root, it.from), join(root, it.to));
  }
  // 清掉待分类里变空的子目录
  const prune = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { prune(p); if (!readdirSync(p).length) rmSync(p, { recursive: true }); }
    }
  };
  prune(join(root, INBOX));
  return plan;
}

/** 给命令行和网页的结果说明 */
export function describeItem(it: InboxItem): string {
  if (!it.to) return `✗ ${it.from}  ${it.reason}`;
  if (it.duplicate) return `✓ ${it.from}  和 ${it.to} 完全一样，已删掉待分类里的这张`;
  const where = `${it.slot}${it.lang ? `（${it.lang}）` : ''}`;
  return `✓ ${it.from} → ${it.to}  ${where}${it.replaces.length ? `，原来的 ${it.replaces.join('、')} 挪到 ${REPLACED}/` : ''}`;
}

function moveToReplaced(root: string, old: string) {
  let dst = join(root, REPLACED, old);
  for (let n = 2; existsSync(dst); n++) dst = join(root, REPLACED, `${old.replace(/(\.[^.]+)$/, '')}-${n}${extname(old)}`);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(join(root, old), dst);
}

/** 网页拖进来的文件名：只留文件名本身，去掉 Windows 不允许的字符，必须是支持的图片格式 */
function safeName(name: string): string {
  const n = basename(String(name).replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  if (!n || n.startsWith('.') || !isImage(n)) throw new Error(`${name || '（没有文件名）'}：只支持 ${ASSET_EXTS.join('、')} 格式的图片`);
  return n;
}

/** 在 dir 里找一个不重名的文件名 */
function freeName(root: string, dir: string, name: string): string {
  const ext = extname(name), stem = basename(name, ext);
  let to = `${dir}/${name}`;
  for (let n = 2; existsSync(join(root, to)); n++) to = `${dir}/${stem}-${n}${ext}`;
  return to;
}

/** 网页拖拽：先放进待分类（重名加序号），之后统一整理。返回相对 assets 目录的路径 */
export function addToInbox(app: AppConfig, name: string, bytes: Buffer): string {
  const root = app.assets.dir;
  const to = freeName(root, INBOX, safeName(name));
  mkdirSync(dirname(join(root, to)), { recursive: true });
  writeFileSync(join(root, to), bytes);
  return to;
}

/**
 * 网页拖拽到表格里的某一格：直接放到这个位置和语言，尺寸必须对得上。
 * 这一格原来的本地图片挪到 已替换/；截图是追加，不替换。返回结果说明
 */
export function placeImage(app: AppConfig, name: string, bytes: Buffer, slotId: string, lang: string): string {
  const root = app.assets.dir;
  const file = safeName(name);
  const slot = SLOTS.find((s) => s.id === slotId);
  if (!slot) throw new Error(`不认识的位置：${slotId}`);
  const fallback = app.languages.includes('english') ? 'english' : app.languages[0];
  if (slot.localized && !app.languages.includes(lang)) throw new Error(`${lang} 不在这个 App 的同步语言里`);
  const d = imageSize(bytes);
  if (!d) throw new Error(`${file}：读不出图片尺寸（文件损坏或格式不支持）`);
  if (classify(slot.tab, d.width, d.height)?.id !== slot.id) {
    const need = slot.match === 'min' ? `至少 ${slot.width} x ${slot.height}` : slot.match === 'contained' ? `宽 ${slot.width} 或高 ${slot.height}` : `${slot.width} x ${slot.height}`;
    throw new Error(`${file} 是 ${d.width} x ${d.height}，${slot.label}要求 ${need}`);
  }
  const where = `${slot.label}${slot.localized ? `（${lang}）` : ''}`;
  const dir = slot.tab === 'screenshot' ? 'screenshots' : `${slot.tab}/${slot.localized ? lang : fallback}`;

  // 和这一格已有的图完全一样：什么都不做
  const hash = createHash('sha256').update(bytes).digest('hex');
  const same = walk(join(root, dir)).find((q) => sha(q) === hash);
  if (same) return `✓ ${file} 和 ${rel(root, same)} 完全一样，没有改动`;

  const replaced: string[] = [];
  if (slot.tab !== 'screenshot') {
    for (const a of scanAssets(app).assets) {
      if (a.tab !== slot.tab || (slot.localized && a.lang !== lang)) continue;
      const ad = imageSize(a.bytes);
      if (ad && classify(a.tab, ad.width, ad.height)?.id === slot.id) { moveToReplaced(root, a.rel); replaced.push(a.rel); }
    }
  }
  const to = freeName(root, dir, file);
  mkdirSync(dirname(join(root, to)), { recursive: true });
  writeFileSync(join(root, to), bytes);
  return `✓ ${file} → ${to}  ${where}${replaced.length ? `，原来的 ${replaced.join('、')} 挪到 ${REPLACED}/` : ''}`;
}
