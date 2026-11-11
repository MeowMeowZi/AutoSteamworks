// 本地商店文本的规则检查。只检查确定的硬性规则和明显的问题，其余写在 STEAM_RULES.md 里给 AI 和人看。
import type { AppConfig } from './config.js';
import { joinLocalized, splitLocalized, type Fields } from './local/storeFiles.js';

export interface LintIssue {
  key: string;
  level: 'error' | 'warn';
  msg: string;
}

/**
 * 后台编辑器上显示的长度范围（2026-11-11 从真实页面确认：标注“长度：200-300 个字符”，
 * 超过 300 时输入框标红；计数用的是 JS 的 value.length）
 */
const LENGTH: Record<string, [min: number, max: number]> = { short_description: [200, 300] };

/** 必须成对出现的 BBCode 标签（[*] [hr] [img] 这类不需要闭合） */
const PAIRED = ['b', 'i', 'u', 'strike', 'h1', 'h2', 'h3', 'url', 'list', 'olist', 'quote', 'code', 'noparse', 'spoiler', 'table', 'tr', 'th', 'td', 'p'];

/** 至少要翻译的字段：english 有内容、其他语言为空时提示 */
const SHOULD_TRANSLATE = ['about', 'short_description'];

function checkTags(text: string): string | undefined {
  const stack: string[] = [];
  for (const m of text.matchAll(/\[(\/?)([a-z0-9]+)(?:=[^\]]*)?\]/gi)) {
    const [, close, raw] = m;
    const tag = raw.toLowerCase();
    if (!PAIRED.includes(tag)) continue;
    if (!close) { stack.push(tag); continue; }
    const top = stack.pop();
    if (top !== tag) return top ? `[${top}] 没有闭合就出现了 [/${tag}]` : `多余的 [/${tag}]`;
  }
  return stack.length ? `[${stack[stack.length - 1]}] 没有闭合` : undefined;
}

export function lint(app: AppConfig, fields: Fields): LintIssue[] {
  const out: LintIssue[] = [];
  for (const [key, v] of Object.entries(fields)) {
    const loc = splitLocalized(key);
    if (!loc || typeof v !== 'string') continue;
    const range = LENGTH[loc.path];
    if (range && v.trim()) {
      const len = v.length; // 和后台一样按 UTF-16 计数
      if (len > range[1]) out.push({ key, level: 'error', msg: `${len} 个字符，超过后台的上限 ${range[1]}` });
      else if (len < range[0]) out.push({ key, level: 'warn', msg: `${len} 个字符，后台建议 ${range[0]}-${range[1]}` });
    }
    const tagErr = checkTags(v);
    if (tagErr) out.push({ key, level: 'warn', msg: `BBCode：${tagErr}` });
  }
  for (const path of SHOULD_TRANSLATE) {
    const en = fields[joinLocalized('english', path)];
    if (typeof en !== 'string' || !en.trim()) continue;
    for (const lang of app.languages.filter((l) => l !== 'english')) {
      const key = joinLocalized(lang, path);
      const v = fields[key];
      if (typeof v === 'string' && !v.trim()) out.push({ key, level: 'warn', msg: 'english 有内容，这个语言还是空的' });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
