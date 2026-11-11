import type { Page } from 'playwright-core';
import { globToRegex, type AppConfig, type Config } from '../config.js';
import { gotoPartner, sleep } from '../browser.js';
import { applyFields, postForm, readFields, type FieldInfo, type FieldValue } from './form.js';
import { keepLanguages, norm, STEAM_LANGS, type Fields } from '../local/storeFiles.js';

/** 页面内部用的字段，同步它们没有意义（或者会出问题） */
export const BUILTIN_IGNORE = [
  'sessionid', 'MAX_FILE_SIZE', 'activetab', 'save_redirect', 'save_redirect#*', 'serialized_app_data',
  'rgGenres[sentinel]',
  '*_compl', // 自动补全输入框；真正提交的是同名不带 _compl 的隐藏字段
];

export function storeEditUrl(cfg: Config, app: AppConfig) {
  return cfg.storeEditUrl.replace('{appid}', String(app.appid));
}

export function filterIgnored(app: AppConfig, fields: FieldInfo[]): FieldInfo[] {
  const rules = [...BUILTIN_IGNORE, ...app.store.ignoreFields].map(globToRegex);
  return fields.filter((f) => !rules.some((r) => r.test(f.key)));
}

export async function loadStorePage(page: Page, cfg: Config, app: AppConfig): Promise<FieldInfo[]> {
  await gotoPartner(page, storeEditUrl(cfg, app));
  await sleep(cfg.delayMs);
  return filterIgnored(app, await readFields(page, cfg.formSelector));
}

/** 读后台所有字段，不按语言过滤 */
export async function fetchRemoteAll(page: Page, cfg: Config, app: AppConfig): Promise<Fields> {
  const info = await loadStorePage(page, cfg, app);
  return Object.fromEntries(info.map((f) => [f.key, f.value]));
}

export async function fetchRemote(page: Page, cfg: Config, app: AppConfig): Promise<Fields> {
  return keepLanguages(app, await fetchRemoteAll(page, cfg, app));
}

/**
 * 后台“支持的语言”表里勾了“界面”的语言（app[content][supported_languages][<语言>][supported]）。
 * 只返回有商店文本的语言（STEAM_LANGS）；后台表里还有很多只能标注支持、没有商店页文本的语言，忽略。
 */
export function supportedLanguages(fields: Fields): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const m = k.match(/^app\[content\]\[supported_languages\]\[([a-z_]+)\]\[supported\]$/);
    if (m && (v === true || v === 'true' || v === '1') && STEAM_LANGS.includes(m[1])) out.push(m[1]);
  }
  return STEAM_LANGS.filter((l) => out.includes(l));
}

export interface PushResult {
  saved: string[];
  missing: string[];
  /** 保存后重新读取，值和预期不一致的字段 */
  notPersisted: string[];
  status: number;
  after: Fields;
}

/** 打开编辑页 → 写入改动 → 提交整个表单 → 重新加载页面，确认值确实保存上了 */
export async function pushStore(page: Page, cfg: Config, app: AppConfig, changes: [string, FieldValue][]): Promise<PushResult> {
  await loadStorePage(page, cfg, app);
  const missing = await applyFields(page, cfg.formSelector, changes);
  const attempted = changes.filter(([k]) => !missing.includes(k));
  let status = 0;
  if (attempted.length) ({ status } = await postForm(page, cfg.formSelector));

  const after = await fetchRemote(page, cfg, app);
  const notPersisted = attempted.filter(([k, v]) => after[k] === undefined || norm(after[k]) !== norm(v)).map(([k]) => k);
  const saved = attempted.map(([k]) => k).filter((k) => !notPersisted.includes(k));
  return { saved, missing, notPersisted, status, after };
}
