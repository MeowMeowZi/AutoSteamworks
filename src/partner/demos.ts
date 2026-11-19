// 找正式版的 Demo：后台商店页“关联的 Demo”输入框用的自动补全接口 GET /admin/store/suggest/Demo?term=<名称或 appid>（只读）。
// 返回 <ul><li id="suggest_Demo_<itemid>" class="app_Demo">名称 ( appid )[ (本地化名)]</li>…</ul>。
// 当前选中的机构不是 App 所属的机构时也能用（apps/associated 页面就看不到 Demo），所以不用切换机构。
import type { Page } from 'playwright-core';
import type { AppConfig, Config } from '../config.js';
import { openEditPage } from './store.js';

export interface DemoCandidate {
  appid: number;
  /** 商店 itemid（编辑页地址里的数字），正式版的“关联的 Demo”填的是它 */
  itemid: number;
  name: string;
  /** 后台在名称后面括号里给的本地化名 */
  localName?: string;
}

const decode = (s: string) => s.replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&amp;/g, '&').trim();

export function parseDemoSuggest(html: string): DemoCandidate[] {
  const out: DemoCandidate[] = [];
  for (const m of html.matchAll(/<li[^>]*\bid="suggest_Demo_(\d+)"[^>]*>([\s\S]*?)<\/li>/g)) {
    const text = decode(m[2]);
    const t = /^(.*?) \( (\d+) \)(?: \((.*)\))?$/.exec(text);
    if (!t) continue;
    out.push({ itemid: Number(m[1]), appid: Number(t[2]), name: t[1].trim(), localName: t[3]?.trim() || undefined });
  }
  return out;
}

/** 用 term（正式版名称或 Demo 的 appid）搜 Demo。先打开正式版的编辑页：确认登录，也让请求带上后台的 Cookie */
export async function findDemos(page: Page, cfg: Config, parent: AppConfig, term: string): Promise<DemoCandidate[]> {
  await openEditPage(page, cfg, parent);
  const origin = new URL(cfg.storeEditUrl.replace('{appid}', String(parent.appid))).origin;
  const r = await page.request.get(`${origin}/admin/store/suggest/Demo?term=${encodeURIComponent(term)}`);
  if (!r.ok()) throw new Error(`搜索 Demo 失败（HTTP ${r.status()}）`);
  return parseDemoSuggest(await r.text());
}
