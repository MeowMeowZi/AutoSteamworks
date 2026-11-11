import type { Page } from 'playwright-core';
import type { AppConfig, Config } from '../config.js';
import { gotoPartner, sleep } from '../browser.js';

/**
 * 图形资源上传。完全复用后台页面自己的逻辑（2026-11 读过 game_admin.js 的 UploadImages）：
 * - 用页面的 g_ImageTypes + IsImageTypeValid 按尺寸判断图片属于哪一类（宣传图 / 库资源 / 截图）
 * - 和 UploadImages 一样构造 FormData：key = 类型路径 [+ '|' + 语言]，截图另带“是否适合所有年龄”
 * - POST 到 gameform 的保存地址 + ?activetab=tab_graphicalassets&json=1
 * 上传的是文件原始字节，不做任何转换。
 */

export type AssetTab = 'store' | 'library' | 'screenshot';

export interface AssetUpload {
  /** 本地相对路径，用于显示 */
  rel: string;
  filename: string;
  bytes: Buffer;
  tab: AssetTab;
  /** 本地化资源的语言（截图为 undefined） */
  lang?: string;
}

export interface AssetResult {
  rel: string;
  ok: boolean;
  type?: string;
  size?: string;
  key?: string;
  status?: number;
  error?: string;
  body?: string;
  /** 上传后从后台数据里确认到了变化 */
  verified?: boolean;
  warning?: string;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const ASSET_EXTS = Object.keys(MIME);

const UPLOAD_ONE = `(async (a) => {
  if (typeof g_ImageTypes === 'undefined' || !g_ImageTypes || typeof IsImageTypeValid !== 'function' || typeof g_sessionID !== 'string')
    return { ok: false, error: '页面上找不到上传所需的 g_ImageTypes / IsImageTypeValid / g_sessionID，后台页面可能改版了' };
  const bin = atob(a.b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: a.mime });
  let img;
  try { const bmp = await createImageBitmap(blob); img = { width: bmp.width, height: bmp.height }; bmp.close(); }
  catch (e) { return { ok: false, error: '无法解码图片: ' + e }; }
  const size = img.width + 'x' + img.height;
  const types = g_ImageTypes.filter((t) => t.tab === a.tab && !t.hidden && !t.deprecated && t.width !== 0 && IsImageTypeValid(img, t));
  if (!types.length) {
    const want = g_ImageTypes.filter((t) => t.tab === a.tab && !t.hidden && !t.deprecated && t.width !== 0)
      .map((t) => (t.label || t.name) + ' ' + t.width + 'x' + t.height + (t.enforce_min ? '+' : '')).join('，');
    return { ok: false, size, error: '尺寸 ' + size + ' 不匹配任何类型。可用：' + want };
  }
  const t = types[0];
  const fd = new FormData();
  let key = t.path, filename = a.filename;
  if (t.name === 'Screenshot') {
    key += '0|english[]';
    fd.append('params[' + filename + '][all_ages]', a.allAges ? '1' : '0');
    const ext = filename.match(/\\.[0-9a-z]+$/i)[0], idx = filename.lastIndexOf(ext);
    filename = filename.slice(0, idx) + (a.allAges ? '.AA1' : '') + ext;
  } else if (t.localized) {
    key += '|' + a.lang;
  }
  if (a.dryRun) return { ok: true, type: t.label || t.name, size, key };

  // 核对用：编辑页 serialized_app_data 里的 assets 对象，例如 assets.header_image.image.schinese = ".../header_schinese.jpg"
  // 类型路径里 'assets' 后面那段就是它在 assets 对象里的 key（header_image、screenshots、page_background_raw…）
  const parts = t.path.split('|');
  const assetKey = parts[parts.indexOf('assets') + 1];
  const readAssets = async () => {
    try {
      const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
      const m = html.match(/name="serialized_app_data"\\s+value="([^"]*)"/);
      if (!m) return null;
      const ta = document.createElement('textarea'); ta.innerHTML = m[1];
      return JSON.parse(ta.value).assets || {};
    } catch (e) { return null; }
  };
  const before = await readAssets();

  fd.append(key, blob, filename);
  fd.append('sessionid', g_sessionID);
  const form = document.getElementById('gameform');
  const url = form.action.split('?')[0] + '?activetab=tab_graphicalassets&json=1';
  const r = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' });
  const body = (await r.text()).slice(0, 2000);
  let json = null; try { json = JSON.parse(body); } catch (e) {}
  const res = { type: t.label || t.name, size, key, status: r.status, body };
  // 真实后台成功时返回 {"redirect":"...?SuccessMsg[0]=Changes+saved..."}，失败时重定向地址里带 ErrorMsg
  const errMsg = json && typeof json.redirect === 'string' && /[?&]ErrorMsg/.test(json.redirect)
    ? Array.from(new URL(json.redirect).searchParams).filter(([k]) => k.startsWith('ErrorMsg')).map(([, v]) => v).join('；') : '';
  if (!r.ok || errMsg || (json && (json.success === false || json.success === 0 || json.error)))
    return { ok: false, ...res, error: '后台返回失败' + (errMsg ? '：' + errMsg : '') };

  const after = await readAssets();
  if (!before || !after) return { ok: true, ...res, warning: '无法读取后台数据来核对，请到后台确认' };
  const pick = (o) => JSON.stringify(o[assetKey] === undefined ? null : o[assetKey]);
  if (pick(before) === pick(after)) {
    // 文件没改（--force 重传）时后台数据不变是正常的；文件改了却没变化才算失败
    return a.expectChange
      ? { ok: false, ...res, error: '后台返回成功，但 assets.' + assetKey + ' 没有变化' }
      : { ok: true, ...res, warning: '后台数据没有变化（和上次上传的是同一张图）' };
  }
  return { ok: true, ...res, verified: true };
})`;

/**
 * 删除后台的一张图（宣传图 / 库资源 / 页面背景）。照搬后台自己的“删除”链接（2026-11-11 探查）：
 * 每张已上传的图旁边有 <a onclick="SubmitQuickMessageUpdate({"app[assets][header_image][image][schinese]":"", ...image2x..., ...image2x_raw...})">删除</a>，
 * SubmitQuickMessageUpdate 把这些字段加进 #quick_message_update 表单（sessionid、save_redirect）再带上 activetab 提交到 save/<itemid>。
 * 要清空哪些字段直接从页面上的删除链接里读，不自己拼，所以只能删后台页面上真有删除按钮的图。
 */
const DELETE_ONE = `(async (a) => {
  const readAssets = async () => {
    try {
      const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
      const m = html.match(/name="serialized_app_data"\\s+value="([^"]*)"/);
      if (!m) return null;
      const ta = document.createElement('textarea'); ta.innerHTML = m[1];
      return JSON.parse(ta.value).assets || {};
    } catch (e) { return null; }
  };
  const prefix = 'app[assets][' + a.assetKey + ']';
  const want = a.lang ? prefix + '[image][' + a.lang + ']' : null;
  let fields = null;
  for (const el of document.querySelectorAll('[onclick*="SubmitQuickMessageUpdate"]')) {
    const m = (el.getAttribute('onclick') || '').match(/SubmitQuickMessageUpdate\\(\\s*(\\{[\\s\\S]*\\})\\s*\\)/);
    if (!m) continue;
    let obj; try { obj = JSON.parse(m[1]); } catch (e) { continue; }
    const keys = Object.keys(obj);
    if (!keys.length || !keys.every((k) => k.startsWith(prefix + '[') || k === prefix)) continue;
    if (want && !keys.includes(want)) continue;
    fields = obj; break;
  }
  if (!fields) return { ok: false, error: '后台页面上没有这张图的“删除”链接（可能已经删掉了）' };
  if (a.dryRun) return { ok: true, fields };
  const form = document.getElementById('quick_message_update');
  if (!form) return { ok: false, fields, error: '页面上找不到 #quick_message_update 表单，后台页面可能改版了' };
  const before = await readAssets();
  const body = new URLSearchParams();
  for (const el of form.querySelectorAll('input[name]')) body.append(el.name, el.value);
  const tab = document.getElementById('activetab');
  body.append('activetab', tab ? tab.value : 'tab_graphicalassets');
  for (const k in fields) body.append(k, fields[k]);
  const r = await fetch(form.action, { method: 'POST', body, credentials: 'same-origin' });
  const finalUrl = r.url || '';
  const errMsg = /[?&]ErrorMsg/.test(finalUrl)
    ? Array.from(new URL(finalUrl).searchParams).filter(([k]) => k.startsWith('ErrorMsg')).map(([, v]) => v).join('；') : '';
  if (!r.ok || errMsg) return { ok: false, fields, status: r.status, error: '后台返回失败' + (errMsg ? '：' + errMsg : '') };
  return { ok: true, fields, status: r.status, before, after: await readAssets() };
})`;

export interface DeleteTarget { assetKey: string; lang?: string }
export interface DeleteResult {
  ok: boolean;
  fields?: Record<string, string>;
  status?: number;
  error?: string;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
}

/** 逐个删除（dryRun 时只找删除链接）。调用前先 openAssetsPage；每删一张都重新打开页面，保证删除链接是最新的 */
export async function deleteAssets(page: Page, cfg: Config, app: AppConfig, targets: DeleteTarget[], dryRun: boolean) {
  const results: DeleteResult[] = [];
  for (const [i, t] of targets.entries()) {
    if (i > 0 && !dryRun) await openAssetsPage(page, cfg, app);
    results.push((await page.evaluate(`${DELETE_ONE}(${JSON.stringify({ ...t, dryRun })})`)) as DeleteResult);
    if (!dryRun) await sleep(cfg.delayMs);
  }
  return results;
}

export async function openAssetsPage(page: Page, cfg: Config, app: AppConfig) {
  const url = cfg.storeEditUrl.replace('{appid}', String(app.appid));
  await gotoPartner(page, url + (url.includes('?') ? '&' : '?') + 'activetab=tab_graphicalassets');
  await sleep(cfg.delayMs);
}

/** 逐个上传（或 dryRun 时只判断类型）。调用前先 openAssetsPage */
export async function uploadAssets(page: Page, cfg: Config, items: (AssetUpload & { expectChange: boolean })[], opts: { allAges?: boolean; dryRun: boolean }) {
  const results: AssetResult[] = [];
  for (const it of items) {
    const ext = it.filename.split('.').pop()!.toLowerCase();
    const arg = {
      b64: it.bytes.toString('base64'), mime: MIME[ext], filename: it.filename, tab: it.tab, lang: it.lang,
      allAges: opts.allAges, dryRun: opts.dryRun, expectChange: it.expectChange,
    };
    const r = (await page.evaluate(`${UPLOAD_ONE}(${JSON.stringify(arg)})`)) as Omit<AssetResult, 'rel'>;
    results.push({ rel: it.rel, ...r });
    if (!opts.dryRun && r.status) await sleep(cfg.delayMs);
  }
  return results;
}
