// 后台状态快照：每次打开商店编辑页（store.ts 的 openEditPage）时顺便读出来，存到 <stateDir>/remote/<app>.json，网页用它显示“后台现在是什么样”。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { AppConfig, Config } from '../config.js';

export interface RemoteMeta {
  at: string;
  /** serialized_app_data.assets：各类图片在后台存的路径 */
  assets: Record<string, any>;
  /** 图片 CDN 地址前缀（从页面上的图片链接里取，国内是 queniuqe 的 CDN） */
  cdnBase?: string;
  /** 复选框的文字（页面上复选框是 a.fancyCheckbox 包着隐藏字段，文字在外面那层） */
  labels: Record<string, string>;
}

// 字符串形式传给 page.evaluate，避免 tsx 注入辅助函数
const READ_META = String.raw`((appid) => {
  const el = document.querySelector('[name=serialized_app_data]');
  let assets = {};
  try { assets = JSON.parse(el.value).assets || {}; } catch (e) {}
  const html = document.documentElement.innerHTML.split('\\/').join('/');
  const m = html.match(new RegExp('https://[^"\'\\s]+?/store_item_assets/steam/apps/' + appid + '/'));
  const labels = {};
  for (const a of document.querySelectorAll('a.fancyCheckbox')) {
    const input = a.querySelector('input[type=hidden][name]');
    const text = (a.innerText || '').replace(/\(\?\)/g, '').replace(/\s+/g, ' ').trim();
    if (input && text && !(input.name in labels)) labels[input.name] = text.slice(0, 60);
  }
  return { assets, cdnBase: m ? m[0] : undefined, labels };
})`;

/** 页面必须已经在商店编辑页上 */
async function readRemoteMeta(page: Page, app: AppConfig): Promise<RemoteMeta> {
  const r = (await page.evaluate(`${READ_META}(${JSON.stringify(String(app.appid))})`)) as Omit<RemoteMeta, 'at'>;
  return { at: new Date().toISOString(), ...r };
}

const metaPath = (cfg: Config, app: AppConfig) => join(cfg.stateDir, 'remote', `${app.key}.json`);

export function readMeta(cfg: Config, app: AppConfig): RemoteMeta | undefined {
  const p = metaPath(cfg, app);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
}

function writeMeta(cfg: Config, app: AppConfig, m: RemoteMeta) {
  const p = metaPath(cfg, app);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2));
}

/** 读一次并保存；失败不影响主流程。只给 openEditPage 用 */
export async function captureRemoteMeta(page: Page, cfg: Config, app: AppConfig) {
  try {
    writeMeta(cfg, app, await readRemoteMeta(page, app));
  } catch {
    // 页面结构变了之类，网页上只是少了后台状态
  }
}
