import type { Page } from 'playwright-core';

/**
 * 通用表单读写：只按控件的 name 属性定位，不依赖页面布局。
 *
 * Steamworks 商店编辑页的真实数据在 #gameform 的隐藏字段里（每种语言一个，例如
 * app[content][about][schinese]），页面上的 textarea / ProseMirror 编辑器只是界面。
 * 所以这里读写隐藏字段，并用浏览器自己的 FormData 提交整个表单：等同于点“保存”，
 * 但不经过编辑器界面，界面就没有机会把我们写入的值覆盖掉。
 *
 * 字段 key：
 *   普通字段（含 hidden）  name            （同名的第 2 个起为 name#1、name#2…）
 *   单选组                 name            （值为选中项的 value）
 *   复选框                 name[=value]    （值为 true/false）
 *
 * 在浏览器里执行的脚本写成字符串，避免 tsx/esbuild 往函数里注入 __name 之类的辅助函数。
 */

export type FieldValue = string | boolean;

export interface FieldInfo {
  key: string;
  type: string;
  label: string;
  value: FieldValue;
}

const READ_FIELDS = `((sel) => {
  const form = document.querySelector(sel);
  if (!form) return null;
  const SKIP = new Set(['submit','button','reset','file','password','image']);
  const out = [], byKey = new Map(), counts = new Map();
  const labelOf = (el) => {
    if (el.type === 'hidden') return '';
    const l = el.labels && el.labels[0] ? el.labels[0].textContent : '';
    const t = (l || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').trim();
    return t.replace(/\\s+/g, ' ').slice(0, 80);
  };
  for (const el of Array.from(form.elements)) {
    const tag = el.tagName.toLowerCase();
    if (!el.name || !['input','textarea','select'].includes(tag) || el.disabled) continue;
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
    if (SKIP.has(type)) continue;
    const name = el.name;
    if (type === 'radio') {
      let f = byKey.get(name);
      if (!f) { f = { key: name, type, label: labelOf(el), value: '' }; byKey.set(name, f); out.push(f); }
      if (el.checked) f.value = el.value;
      continue;
    }
    if (type === 'checkbox') {
      const key = name + '[=' + el.value + ']';
      if (byKey.has(key)) continue;
      const f = { key, type, label: labelOf(el), value: !!el.checked };
      byKey.set(key, f); out.push(f);
      continue;
    }
    const n = counts.get(name) || 0; counts.set(name, n + 1);
    const key = n === 0 ? name : name + '#' + n;
    const f = { key, type, label: labelOf(el), value: el.value };
    byKey.set(key, f); out.push(f);
  }
  return out;
})`;

const APPLY_FIELDS = `((sel, changes) => {
  const form = document.querySelector(sel);
  const missing = [];
  const all = (name) => Array.from(form.elements).filter((e) => e.name === name);
  for (const [key, value] of changes) {
    let m = key.match(/^(.*)\\[=(.*)\\]$/);
    if (m && typeof value === 'boolean') {
      const el = all(m[1]).find((e) => e.type === 'checkbox' && e.value === m[2]);
      if (!el) { missing.push(key); continue; }
      el.checked = value; continue;
    }
    const radios = all(key).filter((e) => e.type === 'radio');
    if (radios.length) {
      const el = radios.find((e) => e.value === value);
      if (!el) { missing.push(key); continue; }
      el.checked = true; continue;
    }
    m = key.match(/^(.*)#(\\d+)$/);
    const name = m ? m[1] : key, idx = m ? Number(m[2]) : 0;
    const el = all(name).filter((e) => e.type !== 'radio' && e.type !== 'checkbox')[idx];
    if (!el) { missing.push(key); continue; }
    el.value = value;
  }
  return missing;
})`;

const POST_FORM = `(async (sel) => {
  const form = document.querySelector(sel);
  const r = await fetch(form.action, { method: 'POST', body: new FormData(form), credentials: 'same-origin' });
  return { status: r.status, url: r.url };
})`;

const call = (fn: string, ...args: unknown[]) => `${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`;

export async function readFields(page: Page, formSelector: string): Promise<FieldInfo[]> {
  const r = (await page.evaluate(call(READ_FIELDS, formSelector))) as FieldInfo[] | null;
  if (!r) throw new Error(`页面上找不到表单 ${formSelector}（当前页面: ${page.url()}）`);
  return r;
}

/** 把值写进表单（还没保存），返回找不到的字段 key */
export async function applyFields(page: Page, formSelector: string, changes: [string, FieldValue][]): Promise<string[]> {
  return page.evaluate(call(APPLY_FIELDS, formSelector, changes)) as Promise<string[]>;
}

/** 用 FormData 提交整个表单（包含所有未修改的字段，和点保存按钮提交的内容一致） */
export async function postForm(page: Page, formSelector: string): Promise<{ status: number; url: string }> {
  return page.evaluate(call(POST_FORM, formSelector)) as Promise<{ status: number; url: string }>;
}
