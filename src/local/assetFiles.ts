import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AppConfig, Config } from '../config.js';
import { ASSET_EXTS, type AssetTab, type AssetUpload } from '../partner/assets.js';
import { STEAM_LANGS } from './storeFiles.js';

/**
 * 本地布局（<assetsDir>/）：
 *   store/<语言>/*.png      商店宣传图：形象图片 920x430、小 462x174、主 1232x706、竖向 748x896、页面背景 1438x810
 *   library/<语言>/*.png    库资源：主页图片 3840x1240、宣传图 600x900、形象图片 920x430、徽标 1280x720
 *   screenshots/*.png       截图（≥1920x1080），所有语言共用
 * 文件名随意，类型按尺寸自动判断（和后台拖拽上传的规则一样）。
 */

export interface LocalAsset extends AssetUpload {
  hash: string;
}

const isImage = (f: string) => ASSET_EXTS.includes(f.split('.').pop()!.toLowerCase());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function scanDir(root: string, dir: string, tab: AssetTab, lang?: string): LocalAsset[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => isImage(f) && statSync(join(dir, f)).isFile()).sort().map((f) => {
    const bytes = readFileSync(join(dir, f));
    return { rel: relative(root, join(dir, f)).replace(/\\/g, '/'), filename: f, bytes, tab, lang, hash: sha(bytes) };
  });
}

export function scanAssets(app: AppConfig): { assets: LocalAsset[]; warnings: string[] } {
  const root = app.assets.dir;
  const assets: LocalAsset[] = [], warnings: string[] = [];
  for (const tab of ['store', 'library'] as const) {
    const base = join(root, tab);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const p = join(base, entry);
      if (!statSync(p).isDirectory()) { warnings.push(`${tab}/${entry}：图片要放在语言子目录里，例如 ${tab}/schinese/${entry}`); continue; }
      if (!STEAM_LANGS.includes(entry)) { warnings.push(`${tab}/${entry}/：不是 Steam 的语言名（例如 english、schinese），已跳过`); continue; }
      assets.push(...scanDir(root, p, tab, entry));
    }
  }
  assets.push(...scanDir(root, join(root, 'screenshots'), 'screenshot'));
  return { assets, warnings };
}

// ---- 上传记录：<stateDir>/assets/<app>.json，记录每个文件上传时的哈希 ----

export interface AssetRecord { hash: string; type?: string; uploadedAt: string }
export type AssetManifest = Record<string, AssetRecord>;

const manifestPath = (cfg: Config, app: AppConfig) => join(cfg.stateDir, 'assets', `${app.key}.json`);

export function readManifest(cfg: Config, app: AppConfig): AssetManifest {
  const p = manifestPath(cfg, app);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

export function writeManifest(cfg: Config, app: AppConfig, m: AssetManifest) {
  const p = manifestPath(cfg, app);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2));
}

export type AssetState = 'new' | 'changed' | 'same';

export const assetState = (a: LocalAsset, m: AssetManifest): AssetState => (!m[a.rel] ? 'new' : m[a.rel].hash === a.hash ? 'same' : 'changed');

export function assetStates(assets: LocalAsset[], m: AssetManifest) {
  return assets.map((a) => ({ asset: a, state: assetState(a, m) }));
}
