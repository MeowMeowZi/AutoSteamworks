import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { globToRegex, type AppConfig, type Config } from '../config.js';
import type { FieldValue } from '../partner/form.js';

export type Fields = Record<string, FieldValue>;

/** Steam 商店支持的本地化语言（API 名） */
export const STEAM_LANGS = [
  'english', 'schinese', 'tchinese', 'japanese', 'koreana', 'thai', 'arabic', 'indonesian', 'malay',
  'bulgarian', 'czech', 'danish', 'german', 'spanish', 'latam', 'greek', 'french', 'italian', 'hungarian',
  'dutch', 'norwegian', 'polish', 'portuguese', 'brazilian', 'romanian', 'russian', 'finnish', 'swedish',
  'turkish', 'vietnamese', 'ukrainian',
];

export const norm = (v: FieldValue) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v);

/**
 * 本地化字段 name 和本地路径互相转换：
 *   app[content][about][schinese]                    → schinese / about
 *   app[content][sysreqs][windows][min][notes][english] → english / sysreqs.windows.min.notes
 *   app[broadcast][title_custom][english]           → english / app.broadcast.title_custom
 * 不是 app[...][<语言>] 形式的字段都算“通用字段”，原样存在 _common.yaml。
 */
export function splitLocalized(name: string): { lang: string; path: string } | undefined {
  const m = name.match(/^app\[(.+)\]\[([a-z]+)\]$/);
  if (!m || !STEAM_LANGS.includes(m[2])) return undefined;
  const parts = m[1].split('][');
  if (parts.some((p) => p.includes('.') || p.includes('[') || p.includes(']'))) return undefined;
  const path = parts[0] === 'content' ? parts.slice(1).join('.') : 'app.' + parts.join('.');
  return { lang: m[2], path };
}

export function joinLocalized(lang: string, path: string): string {
  const parts = path.startsWith('app.') ? path.slice(4).split('.') : ['content', ...path.split('.')];
  return `app[${parts.join('][')}][${lang}]`;
}

/** 只保留 App 配置的语言的本地化字段，通用字段全部保留 */
export function keepLanguages(app: AppConfig, fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => {
    const loc = splitLocalized(k);
    return !loc || app.languages.includes(loc.lang);
  }));
}

/**
 * 本地布局（<storeDir>/）：
 *   _common.yaml              ← 和语言无关的字段（名称、链接、平台、分类、系统要求里的数字…）
 *   <语言>/about.bbcode …     ← store.files 匹配的长文本，一个字段一个文件
 *   <语言>/_fields.yaml       ← 该语言其余的字段
 * 从 yaml 里删掉某个 key = 不管这个字段（不会被推送）。
 */
const COMMON = '_common.yaml';
const FIELDS = '_fields.yaml';
const EXT = '.bbcode';

const isFile = (app: AppConfig, path: string) => app.store.files.some((g) => globToRegex(g).test(path));
const dumpYaml = (o: Record<string, unknown>) =>
  YAML.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))), { lineWidth: 0 });
const loadYaml = (p: string): Fields => {
  if (!existsSync(p)) return {};
  return Object.fromEntries(Object.entries(YAML.parse(readFileSync(p, 'utf8')) ?? {})
    .map(([k, v]) => [k, typeof v === 'boolean' ? v : norm(String(v ?? ''))]));
};

export function hasLocal(app: AppConfig) {
  return existsSync(join(app.storeDir, COMMON));
}

export function readLocal(app: AppConfig): Fields {
  const out: Fields = { ...loadYaml(join(app.storeDir, COMMON)) };
  for (const lang of app.languages) {
    const dir = join(app.storeDir, lang);
    if (!existsSync(dir)) continue;
    for (const [path, v] of Object.entries(loadYaml(join(dir, FIELDS)))) out[joinLocalized(lang, path)] = v;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(EXT))) {
      out[joinLocalized(lang, f.slice(0, -EXT.length))] = norm(readFileSync(join(dir, f), 'utf8'));
    }
  }
  return out;
}

export function writeLocal(app: AppConfig, fields: Fields) {
  mkdirSync(app.storeDir, { recursive: true });
  const common: Fields = {};
  const perLang = new Map<string, { yaml: Fields; files: Record<string, string> }>();
  for (const [k, v] of Object.entries(fields)) {
    const loc = splitLocalized(k);
    if (!loc) { common[k] = v; continue; }
    if (!app.languages.includes(loc.lang)) continue;
    const bucket = perLang.get(loc.lang) ?? { yaml: {}, files: {} };
    perLang.set(loc.lang, bucket);
    if (isFile(app, loc.path) && typeof v === 'string') bucket.files[loc.path] = v;
    else bucket.yaml[loc.path] = v;
  }
  writeFileSync(join(app.storeDir, COMMON), dumpYaml(common));
  for (const [lang, b] of perLang) {
    const dir = join(app.storeDir, lang);
    // 清掉旧的 .bbcode，避免线上已删除的字段在本地残留
    if (existsSync(dir)) for (const f of readdirSync(dir).filter((f) => f.endsWith(EXT))) rmSync(join(dir, f));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FIELDS), dumpYaml(b.yaml));
    for (const [path, text] of Object.entries(b.files)) writeFileSync(join(dir, path + EXT), text);
  }
}

// ---- 快照：上一次 pull/push 时线上的值，用于三方对比 ----

const snapPath = (cfg: Config, app: AppConfig) => join(cfg.stateDir, 'snapshots', `${app.key}.json`);

export function readSnapshot(cfg: Config, app: AppConfig): Fields | undefined {
  const p = snapPath(cfg, app);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
}

export function writeSnapshot(cfg: Config, app: AppConfig, fields: Fields) {
  const p = snapPath(cfg, app);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(fields, null, 2));
}

/**
 * 只改本地的一个字段（网页上手动编辑、还原时用）。
 * 字段必须已经在本地文件里；yaml 用 Document 修改，保留注释和顺序。
 */
export function writeLocalField(app: AppConfig, key: string, value: FieldValue) {
  if (!(key in readLocal(app))) throw new Error(`本地没有字段 ${key}`);
  const loc = splitLocalized(key);
  const file = loc ? join(app.storeDir, loc.lang, loc.path + EXT) : undefined;
  if (file && existsSync(file)) {
    if (typeof value !== 'string') throw new Error(`${key} 是文本字段`);
    writeFileSync(file, value);
    return;
  }
  const yamlPath = loc ? join(app.storeDir, loc.lang, FIELDS) : join(app.storeDir, COMMON);
  const doc = YAML.parseDocument(readFileSync(yamlPath, 'utf8'));
  doc.set(loc ? loc.path : key, value);
  writeFileSync(yamlPath, doc.toString({ lineWidth: 0 }));
}
