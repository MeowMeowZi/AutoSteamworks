// 后台的图片位置（“槽位”）。数据照抄真实后台的 g_ImageTypes（2026-11-11 探查，见 .autosw/inspect/image-types.json），
// 尺寸判断照抄后台的 IsImageTypeValid：一般要求尺寸完全一致；库徽标只要宽或高一致；截图只要求不小于最小尺寸。
// 没收录：程序包形象图（App 用不到）、直播面板（不在本工具范围内）。
import type { AssetTab } from './partner/assets.js';

export interface Slot {
  id: string;
  tab: AssetTab;
  label: string;
  width: number;
  height: number;
  /** serialized_app_data.assets 里的 key */
  assetKey: string;
  localized: boolean;
  /** 后台标了 * 的必填项 */
  required: boolean;
  match: 'exact' | 'contained' | 'min';
  /** 在后台哪里能看到 */
  where: string;
}

const STORE = '商店页管理 → 图像资产 → 商店资产';
const LIBRARY = '商店页管理 → 图像资产 → 库资产';

export const SLOTS: Slot[] = [
  { id: 'header', tab: 'store', label: '形象图片', width: 920, height: 430, assetKey: 'header_image', localized: true, required: true, match: 'exact', where: STORE + ' → 形象图片' },
  { id: 'small_capsule', tab: 'store', label: '小宣传图', width: 462, height: 174, assetKey: 'small_capsule', localized: true, required: true, match: 'exact', where: STORE + ' → 小宣传图' },
  { id: 'main_capsule', tab: 'store', label: '主宣传图', width: 1232, height: 706, assetKey: 'main_capsule', localized: true, required: true, match: 'exact', where: STORE + ' → 主宣传图' },
  { id: 'vertical_capsule', tab: 'store', label: '竖向宣传图', width: 748, height: 896, assetKey: 'hero_capsule', localized: true, required: true, match: 'exact', where: STORE + ' → 竖向宣传图' },
  { id: 'page_background', tab: 'store', label: '页面背景', width: 1438, height: 810, assetKey: 'page_background_raw', localized: false, required: false, match: 'exact', where: STORE + ' → 页面背景' },
  { id: 'library_hero', tab: 'library', label: '库主页图片', width: 3840, height: 1240, assetKey: 'library_hero', localized: true, required: false, match: 'exact', where: LIBRARY + ' → 库主页图片' },
  { id: 'library_capsule', tab: 'library', label: '库宣传图', width: 600, height: 900, assetKey: 'library_capsule', localized: true, required: false, match: 'exact', where: LIBRARY + ' → 库宣传图' },
  { id: 'library_header', tab: 'library', label: '库形象图片', width: 920, height: 430, assetKey: 'library_header', localized: true, required: false, match: 'exact', where: LIBRARY + ' → 库形象图片' },
  { id: 'library_logo', tab: 'library', label: '库徽标', width: 1280, height: 720, assetKey: 'library_logo', localized: true, required: false, match: 'contained', where: LIBRARY + ' → 库徽标' },
  { id: 'screenshot', tab: 'screenshot', label: '截图', width: 1920, height: 1080, assetKey: 'screenshots', localized: false, required: false, match: 'min', where: '商店页管理 → 图像资产 → 截图资产' },
];

/** 按尺寸找槽位，规则和后台一样：同一页签里第一个匹配的 */
export function classify(tab: AssetTab, w: number, h: number): Slot | undefined {
  return SLOTS.find((s) => s.tab === tab && (
    s.match === 'min' ? w >= s.width && h >= s.height
      : s.match === 'contained' ? w === s.width || h === s.height
        : w === s.width && h === s.height));
}

/** 某个页签允许的尺寸，报错时提示用 */
export const sizesFor = (tab: AssetTab) =>
  SLOTS.filter((s) => s.tab === tab).map((s) => `${s.label} ${s.width}x${s.height}${s.match === 'min' ? ' 以上' : s.match === 'contained' ? '（宽或高一致即可）' : ''}`).join('，');

/**
 * 后台某个槽位某种语言现在存的图片路径（相对 CDN 的 "<hash>/<文件名>"）。
 * 本地化槽位：assets[key].image[lang]；页面背景这种不分语言的可能直接是字符串。
 */
export function remotePath(assets: Record<string, any> | undefined, slot: Slot, lang: string): string | undefined {
  const v = assets?.[slot.assetKey];
  if (!v) return undefined;
  if (typeof v === 'string') return v || undefined;
  const img = v.image ?? v;
  if (typeof img === 'string') return img || undefined;
  const p = slot.localized ? img[lang] : img[lang] ?? img.english ?? Object.values(img).find((x) => typeof x === 'string');
  return typeof p === 'string' && p ? p : undefined;
}

/** 后台截图数量（结构没在真实后台确认过，按数组或对象的条目数算） */
export function remoteScreenshotCount(assets: Record<string, any> | undefined): number | undefined {
  const v = assets?.screenshots;
  if (v === undefined) return assets ? 0 : undefined;
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return undefined;
}
