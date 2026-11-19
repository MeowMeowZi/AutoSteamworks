import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AppConfig, Config } from '../config.js';
import { readManifest } from './assetFiles.js';
import { imageSize } from './imageSize.js';
import { scanCells, type CellFile } from './imageCells.js';
import type { RemoteMeta } from '../partner/meta.js';

export const categories = { gameplay: '玩法展示', gamemenu: '游戏内菜单', cinematic: '电影式画面 / 过场动画', conceptart: '概念艺术' };
export const anchors = { BottomLeft: '左下', UpperCenter: '顶部居中', CenterCenter: '正中', BottomCenter: '底部居中' };

export type DraftValue =
  | { kind: 'survey'; descriptions: Record<string, string> }
  | { kind: 'logo'; anchor: keyof typeof anchors; width: number; height: number }
  | { kind: 'category'; sha1: string; category: keyof typeof categories }
  | { kind: 'icon'; requestType: 'icon' | 'clienticon'; filename: string; bytes: Buffer };
export interface DraftItem { id: string; label: string; preview: string; hash: string; value: DraftValue }

function dictionary(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(name + ' 应为键值表');
  return v as Record<string, unknown>;
}
export function draftItems(app: AppConfig, scannedShots?: CellFile[]) {
  const path = join(app.storeDir, '_steamworks.yaml');
  const cfg = existsSync(path) ? dictionary(YAML.parse(readFileSync(path, 'utf8')), '_steamworks.yaml') : {};
  const items: DraftItem[] = [];
  function add(id: string, label: string, preview: string, value: DraftValue) {
    const hash = createHash('sha256').update(String(app.appid)).update(value.kind === 'icon' ? value.bytes : JSON.stringify(value)).digest('hex');
    items.push({ id: '@draft/' + id, label, preview, hash, value });
  }
  if (cfg.aiDescription !== undefined) {
    const descriptions: Record<string, string> = {};
    for (const [lang, text] of Object.entries(dictionary(cfg.aiDescription, 'aiDescription'))) {
      if (!app.languages.includes(lang) || typeof text !== 'string' || !text.trim()) throw new Error('AI 披露语言或文案有误：' + lang);
      descriptions[lang] = text.trim();
    }
    if (Object.keys(descriptions).length) add('survey', '内容调查 · AI 商店页面描述',
      Object.entries(descriptions).map(([lang, s]) => lang + '：' + s).join('\n'), { kind: 'survey', descriptions });
  }
  if (cfg.logoPlacement !== undefined) {
    const { anchor, width, height } = dictionary(cfg.logoPlacement, 'logoPlacement');
    if (typeof anchor !== 'string' || !Object.hasOwn(anchors, anchor) || typeof width !== 'number' || typeof height !== 'number'
      || !(width > 0 && width <= 100 && height > 0 && height <= 100)) throw new Error('库徽标需要有效的锚点及 0 到 100 之间的宽高百分比');
    const pin = anchor as keyof typeof anchors;
    add('logo', '库徽标 · 放置工具', `${anchors[pin]}，宽 ${width}%，高 ${height}%`, { kind: 'logo', anchor: pin, width, height });
  }
  const entries = Object.entries(dictionary(cfg.screenshotCategories ?? {}, 'screenshotCategories'));
  const screenshots = scannedShots ?? (entries.length ? scanCells(app).screenshots : []);
  for (const [name, category] of entries) {
    if (!name || /[\\/:]/.test(name) || !/\.(png|jpe?g|webp|gif)$/i.test(name) || typeof category !== 'string' || !Object.hasOwn(categories, category)) throw new Error('截图文件名或类别有误：' + name);
    const file = screenshots.find(s => s.filename === name);
    if (!file) throw new Error('未找到有效的待分类截图：' + name);
    const sha1 = createHash('sha1').update(file.bytes).digest('hex');
    const key = category as keyof typeof categories;
    add('screenshot/' + name, '截图类别 · ' + name, categories[key], { kind: 'category', sha1, category: key });
  }
  for (const [name, type, label] of [['shortcut.png', 'clienticon', '快捷方式图标'], ['app.jpg', 'icon', '应用图标']] as const) {
    const path = join(app.assets.dir, 'client-icons', name);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path), size = imageSize(bytes);
    const valid = size && size.width === size.height && (type === 'icon'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && size.width === 184
      : bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && [256, 512].includes(size.width));
    if (!valid) throw new Error(name + (type === 'icon' ? ' 需要 184×184 JPG' : ' 需要 256×256 或 512×512 PNG'));
    add(type, label, `client-icons/${name} · ${size.width}×${size.height}`, { kind: 'icon', requestType: type, filename: name, bytes });
  }
  return items;
}

// Steam 截图以原图 SHA-1 命名；序号会随排序改变，每次保存前都重新匹配。
export function matchingShots(assets: Record<string, any>, sha1: string) {
  return Object.entries(assets.screenshots ?? {}).filter(([index, shot]: [string, any]) =>
    /^\d+$/.test(index) && typeof shot?.english === 'string' && shot.english.split('/').pop() === 'ss_' + sha1 + '.jpg');
}
export function logoMatches(position: any, value: Extract<DraftValue, { kind: 'logo' }>) {
  return position?.pinned_position === value.anchor && Number(position.width_pct) === value.width && Number(position.height_pct) === value.height;
}
export function draftRows(c: Config, app: AppConfig, meta: RemoteMeta | undefined, shots?: CellFile[]) {
  const manifest = readManifest(c, app);
  return draftItems(app, shots).map(({ id, label, preview, hash, value }) => {
    let synced = manifest[id]?.hash === hash;
    if (value.kind === 'category' && meta) {
      const matches = matchingShots(meta.assets, value.sha1);
      synced = matches.length === 1 && (matches[0][1] as any).category === value.category;
    }
    if (value.kind === 'logo' && meta) synced = logoMatches(meta.assets.library_logo?.logo_position, value);
    return { id, label, preview, synced };
  });
}
