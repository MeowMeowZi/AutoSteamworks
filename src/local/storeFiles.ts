import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { globToRegex, type AppConfig } from '../config.js';
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

export function sameFieldValue(key: string, left?: FieldValue, right?: FieldValue): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (/^rgGenres\[\d+\]$/.test(key) && (left === 'true' || left === '1') && (right === 'true' || right === '1')) return true;
  return norm(left) === norm(right);
}

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
 * Demo（继承正式版的 App）的目录布局一样，但只放要覆盖的部分；没写的字段跟随正式版（见 readLocalLayers），
 * 所以对 Demo 来说删掉某个 key = 恢复跟随正式版。
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

const yamlFile = (app: AppConfig, loc?: { lang: string }) => (loc ? join(app.storeDir, loc.lang, FIELDS) : join(app.storeDir, COMMON));

// ---- App 自己的文件（Demo 只放覆盖的部分） ----

function readOwn(app: AppConfig): Fields {
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

function writeOwn(app: AppConfig, fields: Fields) {
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
  for (const lang of app.languages) {
    const dir = join(app.storeDir, lang);
    const b = perLang.get(lang);
    // 清掉旧的 .bbcode（线上已删除的字段、Demo 不再覆盖的字段不能在本地残留）；这种语言一个字段都没有时 _fields.yaml 也删掉
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((f) => f.endsWith(EXT))) rmSync(join(dir, f));
      if (!b) rmSync(join(dir, FIELDS), { force: true });
    }
    if (!b) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FIELDS), dumpYaml(b.yaml));
    for (const [path, text] of Object.entries(b.files)) writeFileSync(join(dir, path + EXT), text);
  }
}

// ---- 实际生效的本地值 ----

/** 本地有商店文本（Demo 看自己的 _common.yaml，拉取时一定会写） */
export function hasLocal(app: AppConfig) {
  return existsSync(join(app.storeDir, COMMON));
}

export interface LocalLayers {
  /** 实际生效的本地值 */
  local: Fields;
  /** App 自己文件里的值（Demo 的覆盖） */
  own: Fields;
  /** 继承来的值（只有 Demo 有）：正式版的本地值里、Demo 后台表单里也有的字段，不管有没有被覆盖 */
  inherited: Fields;
}

/**
 * 本地值分层读出来。
 * 普通 App：只有自己的文件。
 * Demo（app.inherits）：正式版的本地值里、Demo 快照（Demo 后台表单）里有的字段，再用 Demo 自己的覆盖盖上。
 * Demo 没有快照（没拉取过）时不知道 Demo 表单里有哪些字段，只有覆盖。
 */
export function readLocalLayers(app: AppConfig): LocalLayers {
  const own = readOwn(app);
  let inherited: Fields = {};
  const parent = app.inherits;
  const snap = parent && readSnapshot(app);
  if (parent && snap && hasLocal(parent)) {
    const p = readOwn(parent);
    inherited = Object.fromEntries(Object.keys(snap).filter((k) => k in p).map((k) => [k, p[k]]));
  }
  return { local: { ...inherited, ...own }, own, inherited };
}

export const readLocal = (app: AppConfig): Fields => readLocalLayers(app).local;

/**
 * 把拉取下来的值写到本地。
 * 普通 App：整个重写。
 * Demo：只写覆盖——值和正式版不同且不是空字符串，或者这个字段原来就有覆盖；其余跟随正式版。
 * “和正式版不同”= 和正式版的本地值、正式版上次同步时的值都不同：正式版本地改了还没上传时，
 * Demo 后台的旧值和正式版后台一样，算跟随正式版（正式版的改动之后会一起传到 Demo），不能写成覆盖把 Demo 定在旧值上。
 */
export function writeLocal(app: AppConfig, fields: Fields) {
  if (!app.inherits) return writeOwn(app, fields);
  const parent = hasLocal(app.inherits) ? readOwn(app.inherits) : {};
  const parentBase = readSnapshot(app.inherits) ?? {};
  const had = readOwn(app);
  const same = (k: string, v: FieldValue) => sameFieldValue(k, v, parent[k]) || (k in parent && sameFieldValue(k, v, parentBase[k]));
  writeOwn(app, Object.fromEntries(Object.entries(fields).filter(([k, v]) => k in had || (v !== '' && !same(k, v)))));
}

// ---- 快照：上一次 pull/push 时线上的值，用于三方对比 ----

export function readSnapshot(app: AppConfig): Fields | undefined {
  return existsSync(app.snapshotFile) ? JSON.parse(readFileSync(app.snapshotFile, 'utf8')) : undefined;
}

export function writeSnapshot(app: AppConfig, fields: Fields) {
  mkdirSync(dirname(app.snapshotFile), { recursive: true });
  writeFileSync(app.snapshotFile, JSON.stringify(fields, null, 2));
}

// ---- 改一个字段 ----

/**
 * 只改本地的一个字段（网页上手动编辑、还原、单独设置时用）。字段必须在实际生效的本地值里。
 * Demo 写到自己的覆盖文件：原来是继承的，就变成单独设置。yaml 用 Document 修改，保留注释和顺序。
 */
export function writeLocalField(app: AppConfig, key: string, value: FieldValue) {
  const { local, own } = readLocalLayers(app);
  if (!(key in local)) throw new Error(`本地没有字段 ${key}`);
  const loc = splitLocalized(key);
  const file = loc ? join(app.storeDir, loc.lang, loc.path + EXT) : undefined;
  // 已有的 .bbcode 照旧写；Demo 新加的覆盖按 store.files 决定放哪里
  if (file && (existsSync(file) || (!(key in own) && isFile(app, loc!.path) && typeof value === 'string'))) {
    if (typeof value !== 'string') throw new Error(`${key} 是文本字段`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
    return;
  }
  const yamlPath = yamlFile(app, loc);
  mkdirSync(dirname(yamlPath), { recursive: true });
  const parsed = YAML.parseDocument(existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : '');
  // 空文件或 {}：换成新的文档，免得写成一行的 { a: b } 格式
  const empty = !parsed.contents || (YAML.isMap(parsed.contents) && !parsed.contents.items.length);
  const doc: YAML.Document = empty ? new YAML.Document({}) : parsed;
  doc.set(loc ? loc.path : key, value);
  writeFileSync(yamlPath, doc.toString({ lineWidth: 0 }));
}

/** Demo 自己设置了这个字段（有覆盖） */
export const isOverridden = (app: AppConfig, key: string) => !!app.inherits && key in readOwn(app);

/** Demo：删掉一个字段的覆盖，恢复跟随正式版 */
export function clearOverride(app: AppConfig, key: string) {
  if (!app.inherits) throw new Error('只有继承了正式版的 App（Demo）才能恢复继承');
  const { own, inherited } = readLocalLayers(app);
  if (!(key in inherited)) throw new Error(`正式版本地没有 ${key}，不能恢复继承`);
  if (!(key in own)) return;
  const loc = splitLocalized(key);
  const file = loc && join(app.storeDir, loc.lang, loc.path + EXT);
  if (file && existsSync(file)) { rmSync(file); return; }
  const yamlPath = yamlFile(app, loc);
  const doc = YAML.parseDocument(readFileSync(yamlPath, 'utf8'));
  doc.delete(loc ? loc.path : key);
  writeFileSync(yamlPath, doc.toString({ lineWidth: 0 }));
}
